import { execFile, spawn } from "node:child_process";
import { constants, existsSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { allocateFreePort, allocateFreePorts, listTargets, waitForCdp } from "@openwork/cdp";
import { ensureDenStack } from "../../../runner/den-stack.ts";
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

interface KillLocalPidOptions {
  graceMs?: number;
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

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidIsAlive(pid)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return !pidIsAlive(pid);
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
      await waitForCdp(cdpUrl, { timeoutMs: 1_000 });
      const targets = await listTargets(cdpUrl);
      if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) return;
      lastDetail = `saw ${targets.length} targets, none were pages`;
    } catch (error) {
      lastDetail = messageText(error);
    }
    await delay(POLL_INTERVAL_MS);
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
    `${JSON.stringify({ baseUrl: bootstrap.baseUrl, apiBaseUrl: bootstrap.apiBaseUrl, requireSignin: bootstrap.requireSignin }, null, 2)}\n`,
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
  const response = await fetch(`${cleanUrl(webUrl)}/api/runtime-config`);
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

export function electronSurfaceEnv(paths: ElectronProfilePaths, options: ElectronSurfaceEnvOptions): Record<string, string> {
  // Provenance: mirrors scripts/dev-two-electron-demo.mjs demoEnv() so local
  // eval Electron surfaces stay fully isolated from the user's real desktop app.
  return {
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
  if (!pidIsAlive(pid)) return false;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const sentGroup = signalProcessGroup(pid, "SIGINT");
  const sentDirect = sentGroup ? true : signalPid(pid, "SIGINT");
  if (sentGroup) options.log?.(`Sent SIGINT to process group ${pid}`);
  else if (sentDirect) options.log?.(`Sent SIGINT to pid ${pid}`);
  if (await waitUntilGone(pid, graceMs)) return true;
  const killedGroup = signalProcessGroup(pid, "SIGKILL");
  if (!killedGroup) signalPid(pid, "SIGKILL");
  options.log?.(`Sent SIGKILL to pid ${pid}`);
  await waitUntilGone(pid, 1_000);
  return true;
}

export function createLocalHost(options: LocalHostOptions): DisposableHost {
  const rootDir = options.rootDir ?? join(options.repoRoot, "evals", "results", ".surfaces");
  const log = options.log;
  const spawnedSurfaces = new Set<SurfaceHandle>();


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

  return {
    kind: "local",

    async spawnElectron(name: string, opts: ElectronSurfaceOptions = {}): Promise<SurfaceHandle> {
      await prepareSharedElectronResources(options.repoRoot, log);
      const profileRoot = join(rootDir, `${sanitizeSlug(name)}-${timestamp()}-${process.pid}`);
      const paths = electronProfilePaths(profileRoot);
      await ensureElectronProfile(paths);
      await writeBootstrap(paths.bootstrapPath, opts.bootstrap);
      const [port, cdpPort] = await allocateFreePorts(2);
      if (port === undefined || cdpPort === undefined) throw new Error("Could not allocate Electron Vite/CDP ports.");
      const appName = `OpenWork Eval ${name}`;
      const appIdentifier = `com.differentai.openwork.eval.${sanitizeSlug(name)}`;
      const isolationEnv = electronSurfaceEnv(paths, { appName, appIdentifier, port, cdpPort });
      const env: NodeJS.ProcessEnv = { ...process.env, ...isolationEnv, ...opts.env };
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
      log(`Starting local Electron surface ${name} (Vite :${port}, CDP :${cdpPort})...`);
      const spawned = spawnDetached(pnpmCommand(), ["dev:electron"], { cwd: options.repoRoot, env, logPath });
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      try {
        await waitForCdpOrExit("Electron", cdpUrl, spawned, logPath, true);
      } catch (error) {
        await killLocalPid(spawned.pid, { log });
        throw error;
      }
      const handle: SurfaceHandle = {
        name,
        kind: "electron",
        hostKind: "local",
        cdpUrl,
        pid: spawned.pid,
        profileDir: profileRoot,
        meta: { vitePort: String(port), log: logPath },
      };
      spawnedSurfaces.add(handle);
      return handle;
    },

    async spawnChrome(name: string, opts: ChromeSurfaceOptions = {}): Promise<SurfaceHandle> {
      const profileRoot = join(rootDir, `${sanitizeSlug(name)}-${timestamp()}-${process.pid}`);
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
      if (handle.kind === "electron" && handle.profileDir) {
        await rm(handle.profileDir, { recursive: true, force: true });
      }
      spawnedSurfaces.delete(handle);
    },

    async stop(): Promise<void> {
      for (const handle of [...spawnedSurfaces]) await this.disposeSurface(handle);
    },

    async [Symbol.asyncDispose](): Promise<void> {
      for (const handle of [...spawnedSurfaces]) {
        await this.disposeSurface(handle)
          .catch((error: unknown) => log(`Local surface ${handle.name} cleanup failed: ${messageText(error)}`));
      }
    },
  };
}
