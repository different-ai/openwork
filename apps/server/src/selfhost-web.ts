/**
 * `openwork-server web`: run the OpenWork web UI and API from one process on
 * one origin, with a server-managed OpenCode v2 engine. This is the self-host
 * path (`npm i -g openwork-server && openwork-server web`).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { openworkServerDataDir } from "@openwork/paths";

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
  return await isFile(join(dir, "openwork-context-v2.js")) ? dir : null;
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
