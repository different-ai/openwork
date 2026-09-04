import { execFile, spawn } from "node:child_process";
import { constants, existsSync, openSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { allocateFreePort, allocateFreePorts, listTargets, waitForCdp } from "@openwork/cdp";
import {
  desktopBootstrapPath,
  globalOpencodeConfigDir,
  opencodeDbCandidates,
  openworkEnvStorePath,
  openworkServerConfigPath,
  openworkServerDataDir,
} from "@openwork/paths";
import { ensureDenStack } from "./den-stack.ts";
import type { ChildProcess } from "node:child_process";
import type { DisposableHost, SurfaceHandle, ElectronSurfaceOptions, ChromeSurfaceOptions, DenServiceOptions, DenServiceHandle, ShareLinks } from "./types.ts";

type OrgMode = "single_org" | "multi_org";

export interface LocalHostOptions {
  repoRoot: string;
  rootDir?: string;
  log(message: string): void;
}

export interface ElectronProfilePaths {
  appDataDir: string;
  bootstrapPath: string;
  cacheHome: string;
  configHome: string;
  dataDir: string;
  dataHome: string;
  envStorePath: string;
  homeDir: string;
  localAppDataDir: string;
  opencodeConfigDir: string;
  root: string;
  stateHome: string;
  userDataDir: string;
}

export interface InstalledProductionDesktopState {
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
}

export interface InstalledProductionDesktopStateOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

interface ElectronSurfaceEnvOptions {
  appName: string;
  appIdentifier: string;
  port: number;
  cdpPort: number;
}

interface SpawnedDetached {
  child: ChildProcess;
  pid: number;
}

interface SpawnDetachedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}

const liveProfileRoots = new Set<string>();

export function registerLiveProfileRoot(profileRoot: string): void {
  liveProfileRoots.add(resolve(profileRoot));
}

export function unregisterLiveProfileRoot(profileRoot: string): void {
  liveProfileRoots.delete(resolve(profileRoot));
}

interface KillLocalPidOptions {
  graceMs?: number;
  log?: (message: string) => void;
}

export interface FreePortOptions {
  log?: (message: string) => void;
}

const CDP_WAIT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const DEFAULT_CHROME_START_URL = "about:blank";
const DEFAULT_DARWIN_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME_BINARIES = ["google-chrome", "chromium", "chromium-browser"];

let prepareSharedResourcesPromise: Promise<void> | null = null;

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "surface";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function executableOnPath(name: string, env: NodeJS.ProcessEnv, platform: string): string | null {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) return null;
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  for (const entry of rawPath.split(pathDelimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function windowsChromeCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.ProgramFiles]
    .filter(isNonEmptyString);
  return roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"));
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return false;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return false;
  }
}

function processGroupIsAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidIsAlive(pid) && !processGroupIsAlive(pid)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return !pidIsAlive(pid) && !processGroupIsAlive(pid);
}

function listeningPids(port: number): Promise<number[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile(
      "lsof",
      [`-tiTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        const code = isRecord(error) ? error.code : null;
        if (error && code !== 1 && code !== "1") {
          reject(error);
          return;
        }
        const pids = stdout.split(/\s+/)
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0);
        resolve([...new Set(pids)]);
      },
    );
  });
}

function processGroupId(pid: number): Promise<number | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const pgid = Number(stdout.trim());
      resolve(Number.isInteger(pgid) && pgid > 1 ? pgid : null);
    });
  });
}

/** Ensure no process is listening on a local TCP port, killing stale owners. */
export async function freePort(port: number, { log }: FreePortOptions = {}): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Port must be an integer from 1 to 65535, got ${port}.`);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const deadline = Date.now() + 10_000;
  const currentProcessGroup = await processGroupId(process.pid);
  let pids = await listeningPids(port);
  while (pids.length > 0 && Date.now() < deadline) {
    for (const pid of pids) {
      if (pid === process.pid) throw new Error(`Refusing to kill the current process listening on port ${port}.`);
      const listenerGroup = await processGroupId(pid);
      const killPid = listenerGroup !== null && currentProcessGroup !== null && listenerGroup !== currentProcessGroup
        ? listenerGroup
        : pid;
      const groupDetail = killPid === pid ? "" : ` in process group ${killPid}`;
      log?.(`Port ${port} is still held by listener pid ${pid}${groupDetail}; stopping it.`);
      await killLocalPid(killPid, { graceMs: 1_000, log });
    }
    await delay(100);
    pids = await listeningPids(port);
  }
  if (pids.length > 0) {
    throw new Error(`Port ${port} is still held by listener pid${pids.length === 1 ? "" : "s"} ${pids.join(", ")} after cleanup.`);
  }
}

async function tailLines(filePath: string, lineCount: number): Promise<string> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).slice(-lineCount).join("\n");
  } catch (error) {
    return `Could not read ${filePath}: ${messageText(error)}`;
  }
}

async function waitForPageTarget(cdpUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastDetail = "no page targets yet";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await waitForCdp(cdpUrl, {
        timeoutMs: Math.min(1_000, Math.max(0, timeoutMs - (Date.now() - startedAt))),
      });
      const targets = await listTargets(cdpUrl, {
        timeoutMs: Math.min(1_000, Math.max(0, timeoutMs - (Date.now() - startedAt))),
      });
      if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) return;
      lastDetail = `saw ${targets.length} targets, none were pages`;
    } catch (error) {
      lastDetail = messageText(error);
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, timeoutMs - (Date.now() - startedAt))));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a page target at ${cdpUrl} (${lastDetail})`);
}

function spawnDetached(command: string, args: string[], { cwd, env, logPath }: SpawnDetachedOptions): SpawnedDetached {
  const logFd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    shell: needsShell(command),
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not spawn ${command}.`);
  return { child, pid: child.pid };
}

function chromeArgs(cdpPort: number, profileDir: string, startUrl: string, headless: boolean): string[] {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    // Avoid the Daytona preview h2 stall when ~28 dev chunks multiplex; h1.1 loads them, while plain-http local Den never negotiates h2.
    "--disable-http2",
    startUrl,
  ];
  return headless ? ["--headless=new", ...args] : args;
}

async function waitForCdpOrExit(label: string, cdpUrl: string, spawned: SpawnedDetached, logPath: string, requirePageTarget = false): Promise<void> {
  let exitDetail: string | null = null;
  const exitPromise = new Promise<void>((_resolve, reject) => {
    spawned.child.once("exit", async (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
      exitDetail = detail;
      const tail = await tailLines(logPath, 40);
      reject(new Error(`${label} process ${spawned.pid} stopped before CDP was ready (${detail}). Last 40 lines of ${logPath}:\n${tail}`));
    });
  });
  const livenessPromise = new Promise<void>((_resolve, reject) => {
    const timer = setInterval(async () => {
      if (exitDetail || pidIsAlive(spawned.pid)) return;
      clearInterval(timer);
      const tail = await tailLines(logPath, 40);
      reject(new Error(`${label} process ${spawned.pid} is not alive before CDP was ready. Last 40 lines of ${logPath}:\n${tail}`));
    }, POLL_INTERVAL_MS);
    timer.unref();
  });
  await Promise.race([
    (requirePageTarget ? waitForPageTarget(cdpUrl, CDP_WAIT_TIMEOUT_MS) : waitForCdp(cdpUrl, { timeoutMs: CDP_WAIT_TIMEOUT_MS })).catch(async (error) => {
      const tail = await tailLines(logPath, 40);
      throw new Error(`${messageText(error)}. Last 40 lines of ${logPath}:\n${tail}`);
    }),
    exitPromise,
    livenessPromise,
  ]);
}

async function runPrepareScript(scriptPath: string, outDir: string, desktopRoot: string): Promise<void> {
  try {
    await access(scriptPath, constants.R_OK);
  } catch {
    throw new Error(`Required Electron prepare helper is missing: ${scriptPath}`);
  }
  await new Promise<void>((resolveRun, reject) => {
    execFile(process.execPath, [scriptPath, "--force", "--outdir", outDir], { cwd: desktopRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Electron shared resource prepare failed for ${scriptPath}: ${stderr || error.message}`));
        return;
      }
      resolveRun();
    });
  });
}

async function prepareSharedElectronResources(repoRoot: string, log: (message: string) => void): Promise<void> {
  if (process.env.OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED === "1") return;
  if (!prepareSharedResourcesPromise) {
    prepareSharedResourcesPromise = (async () => {
      const desktopRoot = join(repoRoot, "apps", "desktop");
      const scriptsRoot = join(desktopRoot, "scripts");
      log("Preparing shared Electron sidecars/helpers once for local eval surfaces...");
      await runPrepareScript(join(scriptsRoot, "prepare-sidecar.mjs"), join(desktopRoot, "resources", "sidecars"), desktopRoot);
      await runPrepareScript(join(scriptsRoot, "prepare-computer-use-helper.mjs"), join(desktopRoot, "resources", "helpers"), desktopRoot);
    })();
  }
  await prepareSharedResourcesPromise;
}

async function ensureElectronProfile(paths: ElectronProfilePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.userDataDir, { recursive: true }),
    mkdir(paths.appDataDir, { recursive: true }),
    mkdir(paths.localAppDataDir, { recursive: true }),
    mkdir(paths.opencodeConfigDir, { recursive: true }),
    mkdir(paths.dataDir, { recursive: true }),
    mkdir(paths.homeDir, { recursive: true }),
    mkdir(paths.configHome, { recursive: true }),
    mkdir(paths.dataHome, { recursive: true }),
    mkdir(paths.cacheHome, { recursive: true }),
    mkdir(paths.stateHome, { recursive: true }),
  ]);
}

async function writeBootstrap(filePath: string, bootstrap: ElectronSurfaceOptions["bootstrap"]): Promise<void> {
  if (!bootstrap) return;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(bootstrap, null, 2)}\n`,
    "utf8",
  );
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isOrgMode(value: unknown): value is OrgMode {
  return value === "single_org" || value === "multi_org";
}

async function runtimeOrgMode(webUrl: string): Promise<OrgMode> {
  const response = await fetch(`${cleanUrl(webUrl)}/api/runtime-config`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`runtime-config returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (isRecord(body) && isOrgMode(body.orgMode)) return body.orgMode;
  throw new Error("runtime-config response did not include orgMode");
}

export function electronProfilePaths(root: string): ElectronProfilePaths {
  return {
    appDataDir: join(root, "appdata"),
    bootstrapPath: join(root, "bootstrap.json"),
    cacheHome: join(root, "xdg-cache"),
    configHome: join(root, "xdg-config"),
    dataDir: join(root, "openwork-data"),
    dataHome: join(root, "xdg-data"),
    envStorePath: join(root, "openwork-env.json"),
    homeDir: join(root, "home"),
    localAppDataDir: join(root, "local-appdata"),
    opencodeConfigDir: join(root, "opencode-config"),
    root,
    stateHome: join(root, "xdg-state"),
    userDataDir: join(root, "electron-userdata"),
  };
}

/**
 * Where the HOST keeps pnpm's self-managed versions. The surface's fresh HOME
 * hides this cache, and pnpm (packageManager pin vs the global binary) then
 * re-downloads its pinned version from the network on EVERY spawn — observed
 * on a Daytona sandbox as a 21MB download per Electron spawn that, when it
 * failed once, degenerated into a self-sustaining recursive `pnpm add pnpm`
 * cascade that outlived the spec run. Pointing PNPM_HOME at the host's real
 * pnpm home keeps version redirection local and instant.
 */
function hostPnpmHome(): string | null {
  const configured = process.env.PNPM_HOME?.trim();
  if (configured) return configured;
  if (process.platform === "darwin") return join(homedir(), "Library", "pnpm");
  if (process.platform === "linux") {
    const dataHome = process.env.XDG_DATA_HOME?.trim();
    return join(dataHome || join(homedir(), ".local", "share"), "pnpm");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData ? join(localAppData, "pnpm") : null;
  }
  return null;
}

export function electronSurfaceEnv(
  paths: ElectronProfilePaths,
  options: ElectronSurfaceEnvOptions,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const pnpmHome = hostPnpmHome();
  // Give local eval Electron surfaces isolated app data, config, and identity so
  // they cannot affect the user's real desktop app.
  return {
    ...(pnpmHome ? { PNPM_HOME: pnpmHome } : {}),
    APPDATA: paths.appDataDir,
    HOME: paths.homeDir,
    LOCALAPPDATA: paths.localAppDataDir,
    OPENWORK_DATA_DIR: paths.dataDir,
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: paths.bootstrapPath,
    OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1",
    OPENWORK_DEV_MODE: "1",
    OPENWORK_ENV_STORE: paths.envStorePath,
    OPENCODE_CONFIG_DIR: paths.opencodeConfigDir,
    VITE_DISABLE_OPENWORK_MODELS: "1",
    OPENWORK_ELECTRON_APP_IDENTIFIER: options.appIdentifier,
    OPENWORK_ELECTRON_APP_NAME: options.appName,
    OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: String(options.cdpPort),
    OPENWORK_ELECTRON_SKIP_SHARED_PREPARE: "1",
    OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
    OPENWORK_ELECTRON_USERDATA: paths.userDataDir,
    PORT: String(options.port),
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_STATE_HOME: paths.stateHome,
    ...overrides,
  };
}

export function liveSharedProductionStateEnv(state: InstalledProductionDesktopState): Record<string, string> {
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

async function requireInstalledPath(path: string, kind: "directory" | "file", label: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`${label} is unavailable at ${path}. Start the installed production OpenWork desktop once and confirm its local state exists.`);
  }
  const matches = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!matches) throw new Error(`${label} at ${path} is not a ${kind}.`);
}

/** Resolve installed production stores without launching, copying, linking, or mutating them. */
export async function resolveInstalledProductionDesktopState(
  options: InstalledProductionDesktopStateOptions = {},
): Promise<InstalledProductionDesktopState> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(`Live shared installed-production state is currently supported only on macOS; received ${platform}.`);
  }
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const dataDir = openworkServerDataDir({ env, homeDir, platform });
  await requireInstalledPath(dataDir, "directory", "Installed production OpenWork data directory");
  const userDataDir = join(homeDir, "Library", "Application Support", "com.differentai.openwork");
  const workspaceStatePath = join(userDataDir, "openwork-workspaces.json");
  const serverTokenStorePath = join(userDataDir, "openwork-server-tokens.json");
  const serverStatePath = join(userDataDir, "openwork-server-state.json");
  const serverConfigPath = openworkServerConfigPath({ env, homeDir, platform });
  const envStorePath = openworkEnvStorePath({ env, homeDir, platform });
  const bootstrapPath = desktopBootstrapPath({ env, homeDir, platform, userDataDir });
  const opencodeConfigDir = globalOpencodeConfigDir({ env, homeDir, platform });
  for (const [path, label] of [
    [workspaceStatePath, "Installed production workspace state"],
    [serverTokenStorePath, "Installed production server token store"],
    [serverStatePath, "Installed production server state"],
    [serverConfigPath, "Installed production server config"],
    [envStorePath, "Installed production environment store"],
    [bootstrapPath, "Installed production desktop bootstrap"],
  ]) {
    await requireInstalledPath(path, "file", label);
  }
  await requireInstalledPath(opencodeConfigDir, "directory", "Installed production OpenCode config directory");

  const candidates = opencodeDbCandidates({
    env,
    homeDir,
    platform,
    defaultChannel: "latest",
  });
  let opencodeDb: string | undefined;
  for (const candidate of candidates) {
    const metadata = await stat(candidate).catch(() => null);
    if (metadata?.isFile()) {
      opencodeDb = candidate;
      break;
    }
  }
  if (!opencodeDb) {
    throw new Error(
      `Installed production OpenCode database is unavailable. Checked channel-aware candidates: ${candidates.join(", ")}.`,
    );
  }
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
  };
}

export function resolveChromeBinary(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const configured = env.CHROME_BIN?.trim();
  if (configured) return configured;
  if (platform === "darwin") return DEFAULT_DARWIN_CHROME;
  if (platform === "linux") {
    for (const name of LINUX_CHROME_BINARIES) {
      const resolved = executableOnPath(name, env, platform);
      if (resolved) return resolved;
    }
    throw new Error(`Could not resolve Chrome binary on linux. Set CHROME_BIN or put one of ${LINUX_CHROME_BINARIES.join(", ")} on PATH.`);
  }
  if (platform === "win32") {
    for (const candidate of windowsChromeCandidates(env)) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error("Could not resolve Chrome binary on win32. Set CHROME_BIN or install Google Chrome in a standard location.");
  }
  throw new Error(`Could not resolve Chrome binary on unsupported platform ${platform}. Set CHROME_BIN.`);
}

export async function killLocalPid(pid: number, options: KillLocalPidOptions = {}): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const rootWasAlive = pidIsAlive(pid);
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const sentGroup = signalProcessGroup(pid, "SIGINT");
  const sentDirect = !sentGroup && rootWasAlive ? signalPid(pid, "SIGINT") : false;
  if (!sentGroup && !sentDirect) return false;
  if (sentGroup) options.log?.(`Sent SIGINT to process group ${pid}`);
  if (sentDirect && !sentGroup) options.log?.(`Sent SIGINT to pid ${pid}`);
  if (await waitUntilGone(pid, graceMs)) return true;
  const killedGroup = signalProcessGroup(pid, "SIGKILL");
  const killedDirect = pidIsAlive(pid) ? signalPid(pid, "SIGKILL") : false;
  if (killedGroup) options.log?.(`Sent SIGKILL to process group ${pid}`);
  else if (killedDirect) options.log?.(`Sent SIGKILL to pid ${pid}`);
  await waitUntilGone(pid, 1_000);
  return true;
}

export function ownedSurfaceFilePaths(handle: SurfaceHandle): string[] {
  return handle.kind === "electron" && handle.profileDir && handle.meta?.profileOwner !== "caller"
    ? [handle.profileDir]
    : [];
}

export async function removeOwnedSurfaceFiles(handle: SurfaceHandle): Promise<void> {
  for (const path of ownedSurfaceFilePaths(handle)) {
    await rm(path, { recursive: true, force: true });
  }
}

/** Stop a detached eval Electron only when its process environment still names its isolated profile. */
export async function stopOwnedElectronSurface(pid: number, profileDir: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || !profileDir.trim()) {
    throw new Error("Detached Electron ownership requires a valid pid and profile directory.");
  }
  const processDescription = await new Promise<string>((resolveDescription, reject) => {
    execFile("ps", ["eww", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) {
        reject(new Error(`Detached Electron process ${pid} is not running.`));
        return;
      }
      resolveDescription(stdout);
    });
  });
  if (!processDescription.includes(`OPENWORK_ELECTRON_USERDATA=${join(profileDir, "electron-userdata")}`)) {
    throw new Error(`Refusing to stop pid ${pid}: it does not own the expected eval Electron profile.`);
  }
  await killLocalPid(pid);
  await rm(profileDir, { recursive: true, force: true });
}

export async function pruneStaleSurfaceProfiles(
  rootDir: string,
  options: {
    live?: ReadonlySet<string>;
    log?: (message: string) => void;
    kill?: (path: string) => Promise<void>;
  },
): Promise<{ removed: string[]; kept: string[] }> {
  const entries = await readdir(rootDir).catch(() => []);
  const removed: string[] = [];
  const kept: string[] = [];
  const live = options.live ?? liveProfileRoots;
  const kill = options.kill ?? ((path: string) => new Promise<void>((done) => {
    execFile("pkill", ["-f", path], () => done());
  }));
  for (const entry of entries) {
    const path = resolve(rootDir, entry);
    if (live.has(path)) {
      kept.push(path);
      continue;
    }
    await kill(path);
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  options.log?.(`Cleared ${removed.length} stale profile director${removed.length === 1 ? "y" : "ies"} in ${rootDir} (kept ${kept.length} live).`);
  return { removed, kept };
}

function explicitPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1") return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function surfacePorts(handle: SurfaceHandle): number[] {
  const ports = new Set<number>();
  const fromUrl = explicitPort(handle.cdpUrl);
  if (fromUrl !== null) ports.add(fromUrl);
  for (const value of [handle.meta?.vitePort, handle.meta?.cdpPort]) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports];
}

export function createLocalHost(options: LocalHostOptions): DisposableHost {
  // Surface profiles become the Electron process HOME. node-gyp/electron-rebuild
  // generate Makefiles with unquoted include paths under that HOME, so a repo
  // checkout on a path containing spaces breaks every native rebuild. The env
  // override lets such machines park surfaces on a space-free path (e.g. /tmp).
  const surfacesRootOverride = process.env.OPENWORK_EVAL_SURFACES_DIR?.trim();
  const rootDir = options.rootDir ?? (surfacesRootOverride
    ? surfacesRootOverride
    : join(options.repoRoot, "evals", "results", ".surfaces", String(process.pid)));
  const log = options.log;
  const spawnedSurfaces = new Set<SurfaceHandle>();
  const denPorts = new Set<number>();

  async function disposeKnownPorts(handle: SurfaceHandle): Promise<void> {
    for (const port of surfacePorts(handle)) await freePort(port, { log });
  }

  async function disposeDenPorts(): Promise<void> {
    for (const port of denPorts) await freePort(port, { log });
    denPorts.clear();
  }


// Containers (Daytona sandboxes) cannot use Chromium's SUID sandbox: the helper
// binary in a mounted pnpm store is not root-owned, and Electron aborts with
// "The SUID sandbox helper binary was found, but is not configured correctly".
// The desktop honours ELECTRON_EXTRA_LAUNCH_ARGS (apps/desktop/electron/main.mjs),
// so pass the container-safe switches when we detect a sandbox.
function insideContainerSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.DAYTONA_SANDBOX_ID ?? "").trim().length > 0) return true;
  if ((env.OPENWORK_EVAL_CONTAINER_ELECTRON ?? "").trim() === "1") return true;
  return existsSync("/daytona-secrets") || existsSync("/daytona-artifacts");
}

function containerLaunchArgs(existing: string | undefined): string | undefined {
  if (!insideContainerSandbox()) return existing;
  const needed = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"];
  const present = (existing ?? "").split(/\s+/).filter((entry) => entry.length > 0);
  for (const arg of needed) if (!present.includes(arg)) present.push(arg);
  return present.join(" ");
}


/**
 * Spawning a desktop has environment preconditions that only this component can
 * reasonably own. Callers should not have to know that Electron needs a live X
 * server, or that a previous run's process may still hold a port.
 */
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function displayAnswers(display: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("xdpyinfo", ["-display", display], (error) => resolve(!error));
  });
}

async function ensureDisplay(repoRoot: string, env: NodeJS.ProcessEnv, log: (message: string) => void): Promise<void> {
  const display = (env.DISPLAY ?? "").trim();
  if (!display) return;
  if (await displayAnswers(display)) return;
  // A stale /tmp/.X11-unix socket is not proof the server is alive: Electron
  // exits with "Missing X server or $DISPLAY", which looks like a hung renderer.
  const starter = join(repoRoot, ".devcontainer", "start-daytona-vnc.sh");
  if (!existsSync(starter)) {
    log(`Display ${display} is not answering and ${starter} is missing; Electron will fail to start.`);
    return;
  }
  log(`Display ${display} is not answering; starting the virtual display...`);
  spawnDetached("bash", [starter], { cwd: repoRoot, env, logPath: join(repoRoot, "evals", "results", "virtual-display.log") });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleepMs(2_000);
    if (await displayAnswers(display)) {
      log(`Display ${display} is live.`);
      return;
    }
  }
  log(`Display ${display} still not answering after 60s; Electron will fail to start.`);
}

/**
 * Kill Electron processes from earlier runs of THIS host's surfaces, and delete
 * the profile directories they left behind.
 *
 * Disposal removes a profile on the happy path, but every killed or failed run
 * leaks one at ~50MB. Twenty-seven of them filled a 10GB sandbox to 99%, and the
 * symptom was not "disk full" — it was the renderer failing to answer
 * `Runtime.evaluate` for 240s, which reads exactly like a broken app. Pruning
 * here is cheap and keeps that failure from being invented again.
 */
  return {
    kind: "local",
    workspaceRoot: options.repoRoot,

    async signal(_surface: SurfaceHandle, pid: number, signal: "SIGSTOP" | "SIGCONT"): Promise<void> {
      process.kill(pid, signal);
    },

    async spawnElectron(name: string, opts: ElectronSurfaceOptions = {}): Promise<SurfaceHandle> {
      if (opts.prepareSharedResources !== false) {
        await prepareSharedElectronResources(options.repoRoot, log);
      }
      const spawnEnvForChecks: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
      if (insideContainerSandbox() && (spawnEnvForChecks.DISPLAY ?? "").trim().length === 0) spawnEnvForChecks.DISPLAY = ":99";
      await ensureDisplay(options.repoRoot, spawnEnvForChecks, log);
      if (opts.profileDir !== undefined && !opts.profileDir.trim()) {
        throw new Error("Electron profileDir must not be empty.");
      }
      const callerOwnedProfile = opts.profileDir !== undefined;
      if (!callerOwnedProfile) await pruneStaleSurfaceProfiles(rootDir, { live: liveProfileRoots, log });
      const profileRoot = opts.profileDir ?? resolve(rootDir, `${sanitizeSlug(name)}-${timestamp()}-${process.pid}`);
      if (!callerOwnedProfile) registerLiveProfileRoot(profileRoot);
      const paths = electronProfilePaths(profileRoot);
      await ensureElectronProfile(paths);
      await writeBootstrap(paths.bootstrapPath, opts.bootstrap);
      const [port, cdpPort] = await allocateFreePorts(2);
      if (port === undefined || cdpPort === undefined) throw new Error("Could not allocate Electron Vite/CDP ports.");
      const appName = `OpenWork Eval ${name}`;
      const appIdentifier = `com.differentai.openwork.eval.${sanitizeSlug(name)}`;
      const isolationEnv = electronSurfaceEnv(paths, { appName, appIdentifier, port, cdpPort }, opts.env);
      const env: NodeJS.ProcessEnv = { ...process.env, ...isolationEnv };
      const launchArgs = containerLaunchArgs(env.ELECTRON_EXTRA_LAUNCH_ARGS);
      if (launchArgs !== undefined) env.ELECTRON_EXTRA_LAUNCH_ARGS = launchArgs;
      // appendSwitch() in the main process runs too late for the SUID sandbox
      // check (it aborts in a child before our JS switches apply), so disable
      // the sandbox at process start the way Electron documents.
      if (insideContainerSandbox()) env.ELECTRON_DISABLE_SANDBOX = "1";
      // Sandbox exec sessions do not export DISPLAY, but Xvfb is running on :99
      // (see .devcontainer/start-daytona-electron.sh). Without it Electron
      // segfaults instead of opening a window.
      if (insideContainerSandbox() && (env.DISPLAY ?? "").trim().length === 0) env.DISPLAY = ":99";
      const logPath = join(profileRoot, "electron.log");
      const packagedBinary = opts.devCommand === undefined
        ? process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()
        : undefined;
      let spawned: SpawnedDetached;
      if (packagedBinary) {
        await access(packagedBinary, constants.F_OK).catch(() => {
          throw new Error(`OPENWORK_EVAL_ELECTRON_BINARY does not exist: ${packagedBinary}`);
        });
        log(`Starting local Electron surface ${name} from packaged binary ${packagedBinary} (CDP :${cdpPort})...`);
        spawned = spawnDetached(packagedBinary, [], { cwd: options.repoRoot, env, logPath });
      } else {
        log(`Starting local Electron surface ${name} (Vite :${port}, CDP :${cdpPort})...`);
        spawned = spawnDetached(pnpmCommand(), [opts.devCommand ?? "dev:electron"], { cwd: options.repoRoot, env, logPath });
      }
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      try {
        await waitForCdpOrExit("Electron", cdpUrl, spawned, logPath, true);
      } catch (error) {
        await killLocalPid(spawned.pid, { log });
        await Promise.all([
          freePort(port, { log }),
          freePort(cdpPort, { log }),
        ]).catch((cleanupError: unknown) => log(`Electron port cleanup failed: ${messageText(cleanupError)}`));
        throw error;
      }
      const handle: SurfaceHandle = {
        name,
        kind: "electron",
        hostKind: "local",
        cdpUrl,
        pid: spawned.pid,
        profileDir: profileRoot,
        meta: { vitePort: String(port), cdpPort: String(cdpPort), log: logPath, profileRoot, profileOwner: callerOwnedProfile ? "caller" : "host" },
      };
      spawnedSurfaces.add(handle);
      return handle;
    },

    async spawnChrome(name: string, opts: ChromeSurfaceOptions = {}): Promise<SurfaceHandle> {
      await pruneStaleSurfaceProfiles(rootDir, { live: liveProfileRoots, log });
      const profileRoot = resolve(rootDir, `${sanitizeSlug(name)}-${timestamp()}-${process.pid}`);
      registerLiveProfileRoot(profileRoot);
      const profileDir = join(profileRoot, "chrome-profile");
      await mkdir(profileDir, { recursive: true });
      const cdpPort = await allocateFreePort();
      const binary = resolveChromeBinary(process.env, process.platform);
      const startUrl = opts.startUrl ?? DEFAULT_CHROME_START_URL;
      const logPath = join(profileRoot, "chrome.log");
      const env: NodeJS.ProcessEnv = { ...process.env };
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      const launch = async (headless: boolean): Promise<SpawnedDetached> => {
        const spawned = spawnDetached(binary, chromeArgs(cdpPort, profileDir, startUrl, headless), { cwd: profileRoot, env, logPath });
        await writeFile(join(profileDir, "openwork-eval-chrome.pid"), `${spawned.pid}\n`, "utf8");
        try {
          await waitForCdpOrExit("Chrome", cdpUrl, spawned, logPath);
        } catch (error) {
          await killLocalPid(spawned.pid, { log });
          await freePort(cdpPort, { log })
            .catch((cleanupError: unknown) => log(`Chrome port cleanup failed: ${messageText(cleanupError)}`));
          throw error;
        }
        return spawned;
      };
      let spawned: SpawnedDetached;
      try {
        spawned = await launch(opts.headless === true || process.env.OPENWORK_EVAL_CHROME_HEADLESS === "1");
      } catch (error) {
        if (!messageText(error).includes("SIGTRAP")) throw error;
        log(`Chrome surface ${name} exited with SIGTRAP under the windowed launch; retrying with --headless=new.`);
        spawned = await launch(true);
      }
      const handle: SurfaceHandle = {
        name,
        kind: "chrome",
        hostKind: "local",
        cdpUrl,
        pid: spawned.pid,
        profileDir,
        meta: { cdpPort: String(cdpPort), log: logPath, profileRoot },
      };
      spawnedSurfaces.add(handle);
      return handle;
    },

    async startDen(opts: DenServiceOptions = {}): Promise<DenServiceHandle> {
      if (opts.seed === "none") {
        log("seed:none requested; local Den stack currently keeps the Acme demo seed, so continuing with the default seed.");
      }
      await ensureDenStack({ log, cdpCandidates: [], skipApp: true, orgMode: opts.orgMode });
      const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
      const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim();
      if (!apiUrl || !webUrl) throw new Error("Den stack did not export OPENWORK_EVAL_DEN_API_URL / OPENWORK_EVAL_DEN_WEB_URL.");
      const orgMode = await runtimeOrgMode(webUrl);
      const apiPort = explicitPort(apiUrl);
      const webPort = explicitPort(webUrl);
      if (apiPort !== null) denPorts.add(apiPort);
      if (webPort !== null) denPorts.add(webPort);
      return { webUrl, apiUrl, orgMode, hostKind: "local" };
    },

    async share(): Promise<ShareLinks> {
      const links: ShareLinks = [];
      const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim();
      const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
      if (webUrl) links.push({ label: "Den Web", url: webUrl });
      if (apiUrl) links.push({ label: "Den API", url: apiUrl });
      return links;
    },

    async disposeSurface(handle: SurfaceHandle): Promise<void> {
      if (handle.pid !== undefined) {
        await killLocalPid(handle.pid, { log });
      }
      await disposeKnownPorts(handle);
      await removeOwnedSurfaceFiles(handle);
      if (handle.meta?.profileOwner !== "caller" && handle.meta?.profileRoot) unregisterLiveProfileRoot(handle.meta.profileRoot);
      spawnedSurfaces.delete(handle);
    },

    async stop(): Promise<void> {
      for (const handle of [...spawnedSurfaces]) await this.disposeSurface(handle);
      await disposeDenPorts();
    },

    async [Symbol.asyncDispose](): Promise<void> {
      for (const handle of [...spawnedSurfaces]) {
        await this.disposeSurface(handle)
          .catch((error: unknown) => log(`Local surface ${handle.name} cleanup failed: ${messageText(error)}`));
      }
      await disposeDenPorts()
        .catch((error: unknown) => log(`Local Den port cleanup failed: ${messageText(error)}`));
    },
  };
}
