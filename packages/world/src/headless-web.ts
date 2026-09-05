import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  desktopBootstrapPath,
  globalOpencodeConfigDir,
  opencodeDbCandidates,
  openworkEnvStorePath,
  openworkServerConfigPath,
  openworkServerDataDir,
} from "@openwork/paths";
import {
  buildHeadlessCorsOrigins,
  buildHeadlessRuntimeManifest,
  buildHeadlessServerLaunch,
  buildOpenworkServerArgs,
  mergeHeadlessServerConfig,
  normalizeDenTarget,
  resolveHeadlessRuntimeManifestPath,
  resolveHeadlessServerConfigPath,
  resolveHeadlessTokens,
} from "./headless-web-helpers.ts";
import type { ChildProcess } from "node:child_process";
import type { HeadlessRuntimeManifest, HeadlessWebState } from "./headless-web-helpers.ts";
import { assertWorldName } from "./store.ts";

const DEFAULT_WEB_PORT = "5178";
const DEFAULT_SERVER_PORT = "8778";
const DEFAULT_DEN_TARGET = "https://app.openworklabs.com";

export interface HeadlessWebLaunchOptions {
  repoRoot: string;
  name: string;
  state: HeadlessWebState;
  workspace?: string;
  allowSharedState?: boolean;
  replace?: boolean;
  keepTokens?: boolean;
  rotateTokens?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface HeadlessWebHandle {
  manifest: HeadlessRuntimeManifest;
  reused: boolean;
  waitForExit(): Promise<string>;
  detach(): Promise<void>;
  stop(): Promise<void>;
}

export interface HeadlessWorldRuntimePaths {
  directory: string;
  runtimeManifestPath: string;
  serverConfigPath: string;
  webLogPath: string;
  headlessLogPath: string;
  /** Sessions database for the world's managed OpenCode engine. */
  opencodeDbPath: string;
}

export interface InstalledProductionHeadlessState {
  bootstrapPath: string;
  dataDir: string;
  envStorePath: string;
  homeDir: string;
  opencodeDb: string;
  opencodeConfigDir: string;
  serverConfigPath: string;
  serverStatePath: string;
  serverTokenStorePath: string;
  workspaceStatePath: string;
  token: string;
  hostToken: string;
  workspace: string;
}

export interface HeadlessClientConnection {
  url: string;
  port: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, host, () => server.close(() => done(true)));
  });
}

async function getFreePort(host: string): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }
      server.close(() => done(address.port));
    });
  });
}

async function resolvePort(value: string | undefined, host: string): Promise<number> {
  if (value) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 && await isPortFree(parsed, host)) {
      return parsed;
    }
  }
  return getFreePort(host);
}

async function probeOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function probeStack(manifest: HeadlessRuntimeManifest): Promise<boolean> {
  return await probeOk(manifest.healthUrl) && await probeOk(manifest.webUrl);
}

export function headlessRuntimeIsHealthy(manifest: HeadlessRuntimeManifest): Promise<boolean> {
  return headlessRuntimeProcessesAreOwned(manifest)
    ? probeStack(manifest)
    : Promise.resolve(false);
}

function processCommand(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function commandHasArgument(command: string, value: string): boolean {
  return command.includes(value) || command.includes(JSON.stringify(value));
}

function runtimePort(value: string): string {
  return new URL(value).port;
}

function isOwnedRuntimeProcess(
  manifest: HeadlessRuntimeManifest,
  pid: number,
  kind: "web" | "server" | "supervisor",
): boolean {
  const command = processCommand(pid);
  if (!command) return false;
  if (kind === "web") {
    return command.includes("vite")
      && commandHasArgument(command, "@openwork/app")
      && commandHasArgument(command, runtimePort(manifest.webUrl));
  }
  if (kind === "server") {
    return command.includes("apps/server/src/cli.ts")
      && commandHasArgument(command, manifest.serverConfigPath)
      && commandHasArgument(command, runtimePort(manifest.openworkUrl));
  }
  return command.includes("headless-monitor.mjs")
    && commandHasArgument(command, manifest.runtimeManifestPath);
}

async function killOwnedRuntimeProcess(
  manifest: HeadlessRuntimeManifest,
  pid: number | null | undefined,
  kind: "web" | "server" | "supervisor",
): Promise<void> {
  if (!pid || pid <= 0 || pid === process.pid || !isOwnedRuntimeProcess(manifest, pid, kind)) return;
  const signal = (value: NodeJS.Signals): void => {
    try {
      process.kill(-pid, value);
    } catch {
      try {
        process.kill(pid, value);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  await delay(500);
  if (isOwnedRuntimeProcess(manifest, pid, kind)) signal("SIGKILL");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isOwnedRuntimeProcess(manifest, pid, kind)) {
    await delay(50);
  }
  if (isOwnedRuntimeProcess(manifest, pid, kind)) {
    throw new Error(`Owned headless ${kind} process ${pid} did not stop.`);
  }
}

function parsedWorld(value: unknown): HeadlessRuntimeManifest["world"] {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  if (value.state !== "isolated" && value.state !== "installed-production") return undefined;
  const launchId = typeof value.launchId === "string" ? value.launchId : undefined;
  return {
    name: value.name,
    state: value.state,
    ...(launchId === undefined ? {} : { launchId }),
  };
}

function parsedPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseRuntimeManifest(value: unknown): HeadlessRuntimeManifest | null {
  if (!isRecord(value) || value.mode !== "local-server" || !isRecord(value.pids)) return null;
  const requiredStrings = [
    "webUrl",
    "openworkUrl",
    "healthUrl",
    "workspace",
    "token",
    "hostToken",
    "serverConfigPath",
    "runtimeManifestPath",
    "webLogPath",
    "headlessLogPath",
    "notes",
    "startedAt",
  ];
  if (requiredStrings.some((key) => typeof value[key] !== "string")) return null;
  const launcher = parsedPid(value.pids.launcher) ?? parsedPid(value.pid);
  if (!launcher) return null;
  const denTarget = value.denTarget === null || typeof value.denTarget === "string" ? value.denTarget : null;
  const denApiUrl = value.denApiUrl === null || typeof value.denApiUrl === "string" ? value.denApiUrl : null;
  return {
    mode: "local-server",
    webUrl: String(value.webUrl),
    openworkUrl: String(value.openworkUrl),
    healthUrl: String(value.healthUrl),
    workspace: String(value.workspace),
    token: String(value.token),
    hostToken: String(value.hostToken),
    serverConfigPath: String(value.serverConfigPath),
    runtimeManifestPath: String(value.runtimeManifestPath),
    webLogPath: String(value.webLogPath),
    headlessLogPath: String(value.headlessLogPath),
    denTarget,
    denApiUrl,
    notes: String(value.notes),
    startedAt: String(value.startedAt),
    pid: parsedPid(value.pid) ?? launcher,
    pids: {
      launcher,
      web: parsedPid(value.pids.web),
      openworkServer: parsedPid(value.pids.openworkServer),
    },
    ...(parsedPid(value.supervisorPid) === null ? {} : { supervisorPid: parsedPid(value.supervisorPid) }),
    ...(parsedWorld(value.world) ? { world: parsedWorld(value.world) } : {}),
  };
}

export function resolveHeadlessWorldRuntimePaths(
  repoRootInput: string,
  name: string,
): HeadlessWorldRuntimePaths {
  assertWorldName(name);
  const repoRoot = resolve(repoRootInput);
  if (name === "dev-headless") {
    const directory = join(repoRoot, "tmp");
    return {
      directory,
      runtimeManifestPath: resolveHeadlessRuntimeManifestPath(repoRoot),
      serverConfigPath: resolveHeadlessServerConfigPath(repoRoot),
      webLogPath: join(directory, "dev-web.log"),
      headlessLogPath: join(directory, "dev-headless.log"),
      opencodeDbPath: join(directory, "dev-headless-opencode.db"),
    };
  }
  const directory = join(repoRoot, "tmp", "worlds", "runtime", name);
  return {
    directory,
    runtimeManifestPath: join(directory, "runtime.json"),
    serverConfigPath: join(directory, "server.json"),
    webLogPath: join(directory, "web.log"),
    headlessLogPath: join(directory, "server.log"),
    opencodeDbPath: join(directory, "opencode.db"),
  };
}

/**
 * Engine data for an `isolated` world. Only the sessions database moves: the
 * default engine otherwise opens the same ~/.local/share/opencode/opencode.db
 * as the installed desktop app, so both processes contend for one SQLite
 * writer and the world's sessions land in the person's history. Provider
 * credentials and the engine log stay where they are so the world keeps
 * working with the person's configured providers. An explicit OPENCODE_DB wins.
 */
export function isolatedHeadlessEngineEnv(
  runtimePaths: Pick<HeadlessWorldRuntimePaths, "opencodeDbPath">,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const explicit = env.OPENCODE_DB?.trim();
  return { OPENCODE_DB: explicit || runtimePaths.opencodeDbPath };
}

export async function readHeadlessRuntimeManifest(path: string): Promise<HeadlessRuntimeManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseRuntimeManifest(parsed);
  } catch {
    return null;
  }
}

function spawnLogged(
  command: string,
  args: string[],
  logPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const logFd = openSync(logPath, "w");
  try {
    return spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
}

function waitForSpawn(child: ChildProcess, label: string): Promise<void> {
  return new Promise((done, reject) => {
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(new Error(`${label} failed to spawn: ${error.message}`));
    };
    const onSpawn = (): void => {
      child.off("error", onError);
      done();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

async function requirePath(path: string, kind: "directory" | "file", label: string): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  const valid = kind === "directory" ? metadata?.isDirectory() : metadata?.isFile();
  if (!valid) {
    throw new Error(`${label} is unavailable at ${path}. Start the installed production OpenWork desktop once and confirm its local state exists.`);
  }
}

function credentials(value: unknown): { token: string; hostToken: string } | null {
  if (!isRecord(value) || !isRecord(value.credentials)) return null;
  const token = value.credentials.clientToken;
  const hostToken = value.credentials.hostToken;
  return typeof token === "string" && token.length > 0 && typeof hostToken === "string" && hostToken.length > 0
    ? { token, hostToken }
    : null;
}

function firstWorkspace(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidates = [value.workspaces, value.workspacePaths, value.items];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry === "string" && entry.trim()) return entry;
      if (isRecord(entry) && typeof entry.path === "string" && entry.path.trim()) return entry.path;
    }
  }
  return null;
}

export async function resolveInstalledProductionHeadlessState(options: {
  env?: NodeJS.ProcessEnv;
  fallbackWorkspace: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): Promise<InstalledProductionHeadlessState> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(`Live shared installed-production state is currently supported only on macOS; received ${platform}.`);
  }
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const userDataDir = join(homeDir, "Library", "Application Support", "com.differentai.openwork");
  const pathOptions = { env, homeDir, platform };
  const dataDir = openworkServerDataDir(pathOptions);
  const serverConfigPath = openworkServerConfigPath(pathOptions);
  const envStorePath = openworkEnvStorePath(pathOptions);
  const bootstrapPath = desktopBootstrapPath(pathOptions);
  const opencodeConfigDir = globalOpencodeConfigDir(pathOptions);
  const serverTokenStorePath = join(userDataDir, "openwork-server-tokens.json");
  const serverStatePath = join(userDataDir, "openwork-server-state.json");
  const workspaceStatePath = join(userDataDir, "openwork-workspaces.json");
  const dbCandidates = opencodeDbCandidates({ ...pathOptions, defaultChannel: "latest" });
  let opencodeDb: string | null = null;
  for (const candidate of dbCandidates) {
    if ((await stat(candidate).catch(() => null))?.isFile()) {
      opencodeDb = candidate;
      break;
    }
  }
  for (const [path, kind, label] of [
    [dataDir, "directory", "Installed production OpenWork data directory"],
    [opencodeConfigDir, "directory", "Installed production OpenCode config directory"],
    [workspaceStatePath, "file", "Installed production workspace state"],
    [serverTokenStorePath, "file", "Installed production server token store"],
    [serverStatePath, "file", "Installed production server state"],
    [serverConfigPath, "file", "Installed production server config"],
    [envStorePath, "file", "Installed production environment store"],
    [bootstrapPath, "file", "Installed production desktop bootstrap"],
  ] satisfies Array<[string, "directory" | "file", string]>) {
    await requirePath(path, kind, label);
  }
  if (!opencodeDb) {
    throw new Error(`Installed production OpenCode database is unavailable. Checked channel-aware candidates: ${dbCandidates.join(", ")}.`);
  }
  const tokenJson: unknown = JSON.parse(await readFile(serverTokenStorePath, "utf8"));
  const resolvedCredentials = credentials(tokenJson);
  if (!resolvedCredentials) throw new Error(`Installed production server credentials are unavailable in ${serverTokenStorePath}.`);
  const workspaceJson: unknown = JSON.parse(await readFile(workspaceStatePath, "utf8"));
  return {
    bootstrapPath,
    dataDir,
    envStorePath,
    homeDir,
    opencodeDb,
    opencodeConfigDir,
    serverConfigPath,
    serverStatePath,
    serverTokenStorePath,
    workspaceStatePath,
    ...resolvedCredentials,
    workspace: firstWorkspace(workspaceJson) ?? options.fallbackWorkspace,
  };
}

export function installedProductionHeadlessEnv(state: InstalledProductionHeadlessState): NodeJS.ProcessEnv {
  return {
    HOME: state.homeDir,
    USERPROFILE: state.homeDir,
    XDG_CONFIG_HOME: join(state.homeDir, ".config"),
    XDG_DATA_HOME: join(state.homeDir, ".local", "share"),
    XDG_CACHE_HOME: join(state.homeDir, ".cache"),
    XDG_STATE_HOME: join(state.homeDir, ".local", "state"),
    OPENWORK_DATA_DIR: state.dataDir,
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: state.bootstrapPath,
    OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "0",
    OPENWORK_DESKTOP_WORKSPACE_STATE_PATH: state.workspaceStatePath,
    OPENWORK_DEV_SHARED_STATE: "1",
    OPENWORK_ENV_STORE: state.envStorePath,
    OPENWORK_SERVER_CONFIG: state.serverConfigPath,
    OPENWORK_SERVER_STATE_PATH: state.serverStatePath,
    OPENWORK_SERVER_TOKEN_STORE_PATH: state.serverTokenStorePath,
    OPENCODE_DB: state.opencodeDb,
    OPENCODE_CONFIG_DIR: state.opencodeConfigDir,
  };
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]";
}

export function assertHeadlessLaunchSafety(
  state: HeadlessWebState,
  env: NodeJS.ProcessEnv,
): void {
  if (state !== "installed-production") return;
  if (
    readBool(env.OPENWORK_REMOTE_ACCESS)
    || Boolean(env.OPENWORK_PUBLIC_HOST?.trim())
    || !isLoopbackHost(env.VITE_HOST)
    || !isLoopbackHost(env.HOST)
  ) {
    throw new Error(
      "LIVE SHARED PRODUCTION STATE headless worlds require loopback-only access; OPENWORK_REMOTE_ACCESS, OPENWORK_PUBLIC_HOST, and non-loopback HOST/VITE_HOST values are refused.",
    );
  }
}

export function resolveHeadlessClientConnection(input: {
  state: HeadlessWebState;
  env: NodeJS.ProcessEnv;
  openworkUrl: string;
  openworkPort: number;
  token: string;
}): HeadlessClientConnection {
  if (input.state === "installed-production") {
    return {
      url: input.openworkUrl,
      port: String(input.openworkPort),
      token: input.token,
    };
  }
  return {
    url: input.env.VITE_OPENWORK_URL ?? input.openworkUrl,
    port: input.env.VITE_OPENWORK_PORT ?? String(input.openworkPort),
    token: input.env.VITE_OPENWORK_TOKEN ?? input.token,
  };
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null) return;
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct kill.
    }
  }
  child.kill(signal);
}

function childProcessGroupIsAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function stopAcquiredChild(child: ChildProcess): Promise<void> {
  if (!childProcessGroupIsAlive(child)) return;
  killChild(child, "SIGTERM");
  let deadline = Date.now() + 2_000;
  while (Date.now() < deadline && childProcessGroupIsAlive(child)) await delay(50);
  if (!childProcessGroupIsAlive(child)) return;
  killChild(child, "SIGKILL");
  deadline = Date.now() + 2_000;
  while (Date.now() < deadline && childProcessGroupIsAlive(child)) await delay(50);
  if (childProcessGroupIsAlive(child)) {
    throw new Error(`Acquired headless process group ${child.pid ?? "unknown"} did not stop.`);
  }
}

export function headlessRuntimeProcessesAreOwned(manifest: HeadlessRuntimeManifest): boolean {
  const webPid = manifest.pids.web;
  const serverPid = manifest.pids.openworkServer;
  return webPid !== null
    && serverPid !== null
    && isOwnedRuntimeProcess(manifest, webPid, "web")
    && isOwnedRuntimeProcess(manifest, serverPid, "server");
}

async function removeRuntimeManifest(manifest: HeadlessRuntimeManifest): Promise<void> {
  await unlink(manifest.runtimeManifestPath).catch((error: unknown) => {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
      throw error;
    }
  });
}

async function stopManifest(manifest: HeadlessRuntimeManifest): Promise<void> {
  await killOwnedRuntimeProcess(manifest, manifest.pids.web, "web");
  await killOwnedRuntimeProcess(manifest, manifest.pids.openworkServer, "server");
  await killOwnedRuntimeProcess(manifest, manifest.supervisorPid, "supervisor");
  await removeRuntimeManifest(manifest);
}

export function stopHeadlessRuntime(manifest: HeadlessRuntimeManifest): Promise<void> {
  return stopManifest(manifest);
}

async function waitForHealthy(manifest: HeadlessRuntimeManifest): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await probeStack(manifest)) return;
    await delay(500);
  }
  throw new Error(`Headless web did not become healthy; inspect ${manifest.webLogPath} and ${manifest.headlessLogPath}.`);
}

async function waitForOwnedRuntimeExit(manifest: HeadlessRuntimeManifest): Promise<string> {
  while (headlessRuntimeProcessesAreOwned(manifest)) await delay(500);
  const webRunning = manifest.pids.web !== null
    && isOwnedRuntimeProcess(manifest, manifest.pids.web, "web");
  const serverRunning = manifest.pids.openworkServer !== null
    && isOwnedRuntimeProcess(manifest, manifest.pids.openworkServer, "server");
  return `headless process exited (web=${webRunning ? "running" : "stopped"}, server=${serverRunning ? "running" : "stopped"})`;
}

export async function monitorHeadlessRuntime(runtimeManifestPath: string): Promise<void> {
  const manifest = await readHeadlessRuntimeManifest(runtimeManifestPath);
  if (!manifest || manifest.runtimeManifestPath !== runtimeManifestPath) return;
  await waitForOwnedRuntimeExit(manifest);
  await killOwnedRuntimeProcess(manifest, manifest.pids.web, "web");
  await killOwnedRuntimeProcess(manifest, manifest.pids.openworkServer, "server");
  await removeRuntimeManifest(manifest);
}

async function writeRuntimeManifest(manifest: HeadlessRuntimeManifest): Promise<void> {
  const temporaryPath = `${manifest.runtimeManifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, manifest.runtimeManifestPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function startRuntimeSupervisor(
  manifest: HeadlessRuntimeManifest,
  repoRoot: string,
): ChildProcess {
  return spawn(
    process.execPath,
    [join(repoRoot, "packages", "world", "bin", "headless-monitor.mjs"), manifest.runtimeManifestPath],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "ignore",
      detached: true,
    },
  );
}

async function ensureRuntimeSupervisor(
  manifest: HeadlessRuntimeManifest,
  repoRoot: string,
): Promise<{ manifest: HeadlessRuntimeManifest; supervisor: ChildProcess | null }> {
  if (
    manifest.supervisorPid
    && isOwnedRuntimeProcess(manifest, manifest.supervisorPid, "supervisor")
  ) {
    return { manifest, supervisor: null };
  }
  const supervisor = startRuntimeSupervisor(manifest, repoRoot);
  try {
    await waitForSpawn(supervisor, "headless supervisor");
    const supervised: HeadlessRuntimeManifest = {
      ...manifest,
      supervisorPid: supervisor.pid ?? null,
    };
    await writeRuntimeManifest(supervised);
    return { manifest: supervised, supervisor };
  } catch (error) {
    killChild(supervisor, "SIGTERM");
    throw error;
  }
}

export async function launchHeadlessWeb(options: HeadlessWebLaunchOptions): Promise<HeadlessWebHandle> {
  if (options.state === "installed-production" && options.allowSharedState !== true) {
    throw new Error("Refusing LIVE SHARED PRODUCTION STATE launch without explicit --allow-shared-state opt-in.");
  }
  const repoRoot = resolve(options.repoRoot);
  const env = options.env ?? process.env;
  assertWorldName(options.name);
  assertHeadlessLaunchSafety(options.state, env);
  const runtimePaths = resolveHeadlessWorldRuntimePaths(repoRoot, options.name);
  await mkdir(runtimePaths.directory, { recursive: true });
  const runtimeManifestPath = runtimePaths.runtimeManifestPath;
  const existing = await readHeadlessRuntimeManifest(runtimeManifestPath);
  const existingHealthy = existing ? await headlessRuntimeIsHealthy(existing) : false;
  const existingState = existing?.world?.state ?? "isolated";
  const existingName = existing?.world?.name ?? (options.name === "dev-headless" ? "dev-headless" : null);
  if (
    existing
    && existingHealthy
    && existingState === options.state
    && existingName === options.name
    && options.replace !== true
  ) {
    const adopted: HeadlessRuntimeManifest = existing.world?.launchId
      ? existing
      : {
          ...existing,
          world: {
            name: options.name,
            state: options.state,
            launchId: randomUUID(),
          },
        };
    await writeRuntimeManifest(adopted);
    const supervised = await ensureRuntimeSupervisor(adopted, repoRoot);
    supervised.supervisor?.unref();
    return {
      manifest: supervised.manifest,
      reused: true,
      waitForExit: () => waitForOwnedRuntimeExit(supervised.manifest),
      async detach() {},
      async stop() { await stopManifest(supervised.manifest); },
    };
  }
  if (existing) await stopManifest(existing);

  const remoteAccessEnabled = readBool(env.OPENWORK_REMOTE_ACCESS);
  const host = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
  const viteHost = env.VITE_HOST ?? env.HOST ?? host;
  const publicHost = env.OPENWORK_PUBLIC_HOST ?? null;
  const clientHost = publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
  const declaredWorkspace = resolve(options.workspace ?? env.OPENWORK_WORKSPACE ?? repoRoot);
  const productionState = options.state === "installed-production"
    ? await resolveInstalledProductionHeadlessState({ env, fallbackWorkspace: declaredWorkspace })
    : null;
  const workspace = productionState?.workspace ?? declaredWorkspace;
  const openworkPort = await resolvePort(env.OPENWORK_PORT ?? DEFAULT_SERVER_PORT, "127.0.0.1");
  const webPort = await resolvePort(env.OPENWORK_WEB_PORT ?? DEFAULT_WEB_PORT, "127.0.0.1");
  const rotateTokens = options.rotateTokens === true || (options.replace === true && options.keepTokens !== true);
  const resolvedTokens = productionState ?? resolveHeadlessTokens({
    envToken: env.OPENWORK_TOKEN,
    envHostToken: env.OPENWORK_HOST_TOKEN,
    previous: rotateTokens ? null : existing,
    generate: randomUUID,
  });
  const serverConfigPath = productionState?.serverConfigPath
    ?? (options.name === "dev-headless" && env.OPENWORK_DEV_HEADLESS_WEB_CONFIG
      ? resolveHeadlessServerConfigPath(repoRoot, env.OPENWORK_DEV_HEADLESS_WEB_CONFIG)
      : runtimePaths.serverConfigPath);
  if (!productionState) {
    const existingConfig = await readFile(serverConfigPath, "utf8").catch(() => null);
    await writeFile(
      serverConfigPath,
      `${JSON.stringify(mergeHeadlessServerConfig(existingConfig, workspace), null, 2)}\n`,
      "utf8",
    );
  }
  const webLogPath = runtimePaths.webLogPath;
  const headlessLogPath = runtimePaths.headlessLogPath;
  const openworkUrl = `http://${clientHost}:${openworkPort}`;
  const webUrl = `http://${clientHost}:${webPort}`;
  const denProxyEnabled = env.OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY === undefined
    ? true
    : readBool(env.OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY);
  const denTarget = denProxyEnabled ? normalizeDenTarget(env.OPENWORK_DEV_DEN_PROXY_TARGET) : null;
  const denApiUrl = denTarget ? `${webUrl}/api/den` : null;
  const clientConnection = resolveHeadlessClientConnection({
    state: options.state,
    env,
    openworkUrl,
    openworkPort,
    token: resolvedTokens.token,
  });
  const viteEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENWORK_DEV_MODE: "1",
    HOST: viteHost,
    PORT: String(webPort),
    VITE_OPENWORK_URL: clientConnection.url,
    VITE_OPENWORK_PORT: clientConnection.port,
    VITE_OPENWORK_TOKEN: clientConnection.token,
    VITE_OPENWORK_FORCE_ENV_SETTINGS: "1",
    VITE_OPENWORK_DEPLOYMENT: env.VITE_OPENWORK_DEPLOYMENT ?? "web",
    ...(denTarget && denApiUrl ? {
      OPENWORK_DEV_HEADLESS_DEN_TARGET: denTarget,
      VITE_DEN_API_BASE_URL: env.VITE_DEN_API_BASE_URL ?? denApiUrl,
      ...(denTarget === DEFAULT_DEN_TARGET ? {} : { VITE_DEN_BASE_URL: env.VITE_DEN_BASE_URL ?? denTarget }),
    } : {}),
  };
  const headlessEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENWORK_DEV_MODE: "1",
    ...(productionState ? installedProductionHeadlessEnv(productionState) : isolatedHeadlessEngineEnv(runtimePaths, env)),
    ...(productionState ? {} : { OPENWORK_WORKSPACE: workspace }),
    OPENWORK_HOST: host,
    OPENWORK_REMOTE_ACCESS: remoteAccessEnabled ? "1" : "0",
    OPENWORK_PORT: String(openworkPort),
    OPENWORK_TOKEN: resolvedTokens.token,
    OPENWORK_HOST_TOKEN: resolvedTokens.hostToken,
    OPENWORK_SERVER_CONFIG: serverConfigPath,
    OPENWORK_MANAGE_OPENCODE: "1",
    OPENWORK_OPENCODE_BIN: env.OPENWORK_OPENCODE_BIN ?? "opencode",
  };
  const pnpmExecPath = env.npm_execpath?.trim();
  const pnpmCommand = pnpmExecPath ? env.npm_node_execpath?.trim() || "node" : "pnpm";
  const pnpmArgs = pnpmExecPath ? [pnpmExecPath] : [];
  const acquiredChildren: ChildProcess[] = [];
  let acquiredManifest: HeadlessRuntimeManifest | null = null;
  let acquiredSupervisor: ChildProcess | null = null;
  const launchId = randomUUID();
  const provisionalManifest = (
    webPid: number | null,
    openworkServerPid: number | null,
  ): HeadlessRuntimeManifest => buildHeadlessRuntimeManifest({
    webUrl,
    openworkUrl,
    workspace,
    token: resolvedTokens.token,
    hostToken: resolvedTokens.hostToken,
    serverConfigPath,
    runtimeManifestPath,
    webLogPath,
    headlessLogPath,
    denTarget,
    webPid,
    openworkServerPid,
    world: { name: options.name, state: options.state, launchId },
  });
  try {
    const webProcess = spawnLogged(pnpmCommand, [...pnpmArgs,
      "--filter",
      "@openwork/app",
      "exec",
      "vite",
      "--host",
      viteHost,
      "--port",
      String(webPort),
      "--strictPort",
    ], webLogPath, repoRoot, viteEnv);
    acquiredChildren.push(webProcess);
    acquiredManifest = provisionalManifest(webProcess.pid ?? null, null);
    const serverLaunch = buildHeadlessServerLaunch(repoRoot, buildOpenworkServerArgs({
      host,
      port: openworkPort,
      configPath: serverConfigPath,
      corsOrigins: buildHeadlessCorsOrigins({ webUrl, webPort }),
    }));
    const serverProcess = spawnLogged(serverLaunch.command, serverLaunch.args, headlessLogPath, repoRoot, headlessEnv);
    acquiredChildren.push(serverProcess);
    let manifest = provisionalManifest(
      webProcess.pid ?? null,
      serverProcess.pid ?? null,
    );
    acquiredManifest = manifest;
    await Promise.all([
      waitForSpawn(webProcess, "headless web"),
      waitForSpawn(serverProcess, "openwork-server"),
    ]);
    await writeRuntimeManifest(manifest);
    await waitForHealthy(manifest);
    const supervised = await ensureRuntimeSupervisor(manifest, repoRoot);
    manifest = supervised.manifest;
    acquiredManifest = manifest;
    acquiredSupervisor = supervised.supervisor;
    const children = [...acquiredChildren];
    const supervisor = acquiredSupervisor;
    let stopped = false;
    return {
      manifest,
      reused: false,
      waitForExit: () => waitForOwnedRuntimeExit(manifest),
      async detach() {
        for (const child of children) child.unref();
        supervisor?.unref();
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await Promise.all(children.map(stopAcquiredChild));
        if (supervisor) await stopAcquiredChild(supervisor);
        await stopManifest(manifest);
      },
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const child of acquiredChildren) {
      await stopAcquiredChild(child).catch((cleanupError: unknown) => {
        cleanupErrors.push(messageText(cleanupError));
      });
    }
    if (acquiredSupervisor) {
      await stopAcquiredChild(acquiredSupervisor).catch((cleanupError: unknown) => {
        cleanupErrors.push(messageText(cleanupError));
      });
    }
    const failedManifest = acquiredManifest;
    if (cleanupErrors.length > 0 && failedManifest) {
      await writeRuntimeManifest(failedManifest).catch((manifestError: unknown) => {
        cleanupErrors.push(`ownership manifest publish failed: ${messageText(manifestError)}`);
      });
    } else if (failedManifest) {
      await removeRuntimeManifest(failedManifest);
    } else if (cleanupErrors.length === 0) {
      await unlink(runtimeManifestPath).catch(() => {});
    }
    const cleanupDetail = cleanupErrors.length === 0
      ? ""
      : ` Cleanup could not confirm ownership release: ${cleanupErrors.join("; ")}.`;
    throw new Error(`${messageText(error)} Headless server: ${openworkUrl}; web: ${webUrl}.${cleanupDetail}`);
  }
}
