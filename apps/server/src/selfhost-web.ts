/**
 * `openwork-server web`: run the OpenWork web UI and API from one process on
 * one origin, with a server-managed OpenCode engine. This is the self-host
 * path (`npm i -g openwork-server && openwork-server web`).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { openworkServerDataDir } from "@openwork/paths";

export const OPENCODE_GITHUB_REPO = "anomalyco/opencode";
const NPM_PACKAGE = "openwork-server";
const UPDATE_CHECK_TIMEOUT_MS = 3_000;

export type SelfhostLogger = (message: string) => void;

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Where the published package lives. The npm launcher (bin/openwork-server.mjs)
 * passes it explicitly; a compiled binary run directly sits at
 * <root>/dist/bin/openwork-server; in a source checkout there is no package.
 */
export async function resolvePackageRoot(input: {
  env: NodeJS.ProcessEnv;
  execPath: string;
}): Promise<string | null> {
  const explicit = input.env.OPENWORK_PACKAGE_ROOT?.trim();
  if (explicit && await isDirectory(explicit)) return resolve(explicit);
  const fromBinary = resolve(dirname(input.execPath), "..", "..");
  if (await isFile(join(fromBinary, "package.json")) && await isDirectory(join(fromBinary, "web"))) {
    return fromBinary;
  }
  return null;
}

/** The static UI bundle: explicit env, bundled `web/`, or apps/app/dist in a checkout. */
export async function resolveWebRoot(input: {
  env: NodeJS.ProcessEnv;
  packageRoot: string | null;
  sourceDir: string;
}): Promise<string | null> {
  const candidates = [
    input.env.OPENWORK_WEB_ROOT?.trim(),
    input.packageRoot ? join(input.packageRoot, "web") : undefined,
    resolve(input.sourceDir, "..", "..", "app", "dist"),
  ];
  for (const candidate of candidates) {
    if (candidate && await isFile(join(candidate, "index.html"))) return resolve(candidate);
  }
  return null;
}

/** OpenCode plugins shipped next to the compiled binary. Null in a checkout (the ts path is used). */
export async function resolveBundledPluginDir(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) return null;
  const dir = join(packageRoot, "dist", "opencode-plugins");
  return await isFile(join(dir, "openwork-extensions-preview.js")) ? dir : null;
}

export function opencodeReleaseAsset(platform: NodeJS.Platform, arch: string): string | null {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "darwin-arm64": return "opencode-darwin-arm64.zip";
    case "darwin-x64": return "opencode-darwin-x64-baseline.zip";
    case "linux-x64": return "opencode-linux-x64-baseline.tar.gz";
    case "linux-arm64": return "opencode-linux-arm64.tar.gz";
    case "win32-x64": return "opencode-windows-x64-baseline.zip";
    case "win32-arm64": return "opencode-windows-arm64.zip";
    default: return null;
  }
}

export function opencodeReleaseUrl(version: string, asset: string, repo = OPENCODE_GITHUB_REPO): string {
  return `https://github.com/${repo}/releases/download/v${version.replace(/^v/, "")}/${asset}`;
}

export function readBinaryVersion(bin: string): string | null {
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0 || !result.stdout) return null;
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout);
    return match?.[1] ?? result.stdout.trim();
  } catch {
    return null;
  }
}

export function engineInstallDir(dataDir: string, version: string): string {
  return join(dataDir, "engines", `opencode-${version}`);
}

async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(root, entry.name), name);
    if (found) return found;
  }
  return null;
}

/**
 * Windows ships bsdtar as System32\tar.exe, which extracts .zip. A Git Bash or
 * MSYS PATH puts GNU tar first instead: it cannot read .zip and treats a
 * drive-letter path such as C:\... as a remote host ("Cannot connect to C:").
 */
function tarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot?.trim() || process.env.windir?.trim() || "C:\\Windows";
  const bsdtar = join(systemRoot, "System32", "tar.exe");
  return existsSync(bsdtar) ? bsdtar : "tar";
}

function extractArchive(archive: string, asset: string, destination: string): void {
  const useUnzip = asset.endsWith(".zip") && process.platform !== "win32";
  const command = useUnzip ? "unzip" : tarCommand();
  // Relative paths keep drive letters out of tar's archive argument.
  const cwd = dirname(archive);
  const target = relative(cwd, destination) || ".";
  const args = useUnzip ? ["-q", archive, "-d", destination] : ["-xf", basename(archive), "-C", target];
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status} while extracting ${asset}`);
}

const RENAME_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Rename, retrying while Windows still holds the file. Right after the new
 * engine runs `--version`, antivirus scanning or the exiting process's image
 * handle can keep opencode.exe locked for a few seconds, and a plain rename
 * fails with EBUSY and stops the server on first run.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform;
    renameImpl?: (from: string, to: string) => Promise<void>;
    delaysMs?: readonly number[];
  } = {},
): Promise<void> {
  const renameImpl = options.renameImpl ?? rename;
  const delays = (options.platform ?? process.platform) === "win32"
    ? options.delaysMs ?? [100, 250, 500, 1_000, 2_000, 4_000, 8_000]
    : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const delay = delays[attempt];
      if (delay === undefined || !code || !RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Make sure the pinned OpenCode version is installed under the data dir and
 * return its path. An explicit OPENWORK_OPENCODE_BIN always wins (bring your
 * own engine); otherwise the version the server was released with is
 * downloaded once and reused.
 */
export async function ensureManagedEngine(input: {
  env: NodeJS.ProcessEnv;
  expectedVersion: string;
  dataDir?: string;
  log: SelfhostLogger;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<{ bin: string; installedVersion: string | null; source: "env" | "installed" | "downloaded" }> {
  const explicit = input.env.OPENWORK_OPENCODE_BIN?.trim();
  if (explicit) {
    return { bin: explicit, installedVersion: readBinaryVersion(explicit), source: "env" };
  }
  const version = input.expectedVersion.replace(/^v/, "");
  const dataDir = input.dataDir ?? openworkServerDataDir({ env: input.env });
  const installDir = engineInstallDir(dataDir, version);
  const binaryName = (input.platform ?? process.platform) === "win32" ? "opencode.exe" : "opencode";
  const bin = join(installDir, binaryName);
  if (await isFile(bin)) {
    const installedVersion = readBinaryVersion(bin);
    if (installedVersion === version) return { bin, installedVersion, source: "installed" };
    input.log(`Installed engine at ${bin} reports ${installedVersion ?? "unknown"}; expected ${version}. Reinstalling.`);
    await rm(installDir, { recursive: true, force: true });
  }

  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const asset = opencodeReleaseAsset(platform, arch);
  if (!asset) {
    throw new Error(`No OpenCode release asset for ${platform}-${arch}. Install OpenCode yourself and set OPENWORK_OPENCODE_BIN.`);
  }
  const repo = input.env.OPENWORK_OPENCODE_GITHUB_REPO?.trim() || OPENCODE_GITHUB_REPO;
  const url = input.env.OPENWORK_OPENCODE_DOWNLOAD_URL?.trim() || opencodeReleaseUrl(version, asset, repo);
  input.log(`Downloading OpenCode ${version} (${asset}) from ${url}`);

  const stagingDir = join(tmpdir(), `openwork-engine-${randomBytes(6).toString("hex")}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    const archive = join(stagingDir, asset);
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    const extractDir = join(stagingDir, "extract");
    await mkdir(extractDir, { recursive: true });
    extractArchive(archive, asset, extractDir);
    const extracted = await findFile(extractDir, binaryName);
    if (!extracted) throw new Error(`Archive ${asset} did not contain ${binaryName}`);
    await mkdir(dirname(bin), { recursive: true });
    const partial = `${bin}.partial`;
    await renameWithRetry(extracted, partial, { platform });
    if (platform !== "win32") await chmod(partial, 0o755);
    const downloadedVersion = readBinaryVersion(partial);
    if (downloadedVersion !== version) {
      await rm(partial, { force: true });
      throw new Error(`Downloaded OpenCode reports ${downloadedVersion ?? "no version"}; expected ${version}.`);
    }
    await renameWithRetry(partial, bin, { platform });
    input.log(`Installed OpenCode ${version} to ${bin}`);
    return { bin, installedVersion: downloadedVersion, source: "downloaded" };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** OpenCode's global config folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (all platforms). */
export function opencodeGlobalConfigDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(xdgConfig, "opencode");
}

export function opencodePluginDepsArchive(packageRoot: string, opencodeVersion: string): string {
  return join(packageRoot, "dist", `opencode-plugin-deps-${opencodeVersion.replace(/^v/, "")}.tgz`);
}

const OPENCODE_INSTALL_STATE = ["node_modules", "package.json", "package-lock.json"] as const;

export type PluginDepsSeedResult =
  | { seeded: true; durationMs: number }
  | { seeded: false; reason: "no-archive" | "already-set-up" | "failed"; error?: string };

/**
 * OpenCode blocks the first folder load on `npm install @opencode-ai/plugin`
 * into its global config folder whenever plugins are configured, and OpenWork
 * always configures plugins: 10-15 s on Windows. The npm package ships that
 * exact install pre-resolved; on a fresh profile (no node_modules, manifest or
 * lockfile yet) unpack it so OpenCode finds the dependency already installed.
 * Any existing install state is left to OpenCode. Never throws: on failure
 * OpenCode installs as before.
 */
export async function seedOpencodePluginDeps(input: {
  archive: string;
  configDir: string;
  now?: () => number;
}): Promise<PluginDepsSeedResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  if (!await isFile(input.archive)) return { seeded: false, reason: "no-archive" };
  for (const name of OPENCODE_INSTALL_STATE) {
    if (existsSync(join(input.configDir, name))) return { seeded: false, reason: "already-set-up" };
  }
  let staging: string | null = null;
  try {
    await mkdir(input.configDir, { recursive: true });
    staging = await mkdtemp(join(input.configDir, ".openwork-plugin-deps-"));
    extractArchive(input.archive, basename(input.archive), staging);
    // node_modules first: if this stops part-way, OpenCode sees an
    // incomplete lockfile and runs its own install, as it would have.
    for (const name of OPENCODE_INSTALL_STATE) {
      await renameWithRetry(join(staging, name), join(input.configDir, name));
    }
    return { seeded: true, durationMs: Math.max(0, now() - startedAt) };
  } catch (error) {
    return { seeded: false, reason: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

type PersistedTokens = { token: string; hostToken: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedTokens(value: unknown): value is PersistedTokens {
  if (!isRecord(value)) return false;
  const { token, hostToken } = value;
  return typeof token === "string" && token.length > 0 && typeof hostToken === "string" && hostToken.length > 0;
}

/**
 * Tokens for the web deployment survive restarts so the desktop app's
 * "connect custom remote" and any saved browser state keep working.
 */
export async function loadOrCreateWebTokens(input: {
  env: NodeJS.ProcessEnv;
  dataDir?: string;
}): Promise<PersistedTokens & { path: string; created: boolean }> {
  const dataDir = input.dataDir ?? openworkServerDataDir({ env: input.env });
  const path = join(dataDir, "web-tokens.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isPersistedTokens(parsed)) return { ...parsed, path, created: false };
  } catch {
    // Missing or unreadable: mint below.
  }
  const tokens: PersistedTokens = {
    token: randomBytes(32).toString("hex"),
    hostToken: randomBytes(32).toString("hex"),
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  return { ...tokens, path, created: true };
}

export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, "").split("-")[0]?.split(".").map((part) => Number(part) || 0) ?? [];
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version.replace(/^v/, ""));
}

/** Best-effort: returns the newer published version, or null when current, unknown, or offline. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function checkForUpdate(input: {
  currentVersion: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): Promise<string | null> {
  if (input.env.OPENWORK_NO_UPDATE_CHECK === "1" || !isReleaseVersion(input.currentVersion)) return null;
  try {
    const response = await (input.fetchImpl ?? fetch)(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const latest = isRecord(body) && typeof body.version === "string" ? body.version : null;
    if (!latest || !isReleaseVersion(latest)) return null;
    return compareSemver(latest, input.currentVersion) > 0 ? latest : null;
  } catch {
    return null;
  }
}

export function updateHint(latest: string): string {
  return `Update available: openwork-server ${latest}. Run: npm i -g ${NPM_PACKAGE}@latest`;
}

/** Open a URL in the default browser without blocking; failures are ignored. */
export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser available; the URL is printed anyway.
  }
}
