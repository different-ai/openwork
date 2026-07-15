import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const desktopScriptsRoot = path.join(desktopRoot, "scripts");
const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
const electronCli = desktopRequire.resolve("electron/cli.js");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export function resolveDemoRoot(env = process.env) {
  return env.OPENWORK_ELECTRON_DEMO_ROOT?.trim() || path.join(os.tmpdir(), "openwork-two-electron-demo");
}

const demoRoot = resolveDemoRoot();
const appProfiles = {
  admin: {
    appIdentifier: "com.differentai.openwork.demo.admin",
    appName: "OpenWork Demo A",
    bootstrapName: "admin-bootstrap.json",
    cdpFlag: "--admin-cdp",
    cdpPort: "9923",
    label: "demo-a",
    portFlag: "--admin-port",
    port: "5273",
    requireSignin: false,
  },
  consumer: {
    appIdentifier: "com.differentai.openwork.demo.consumer",
    appName: "OpenWork Demo B",
    bootstrapName: "consumer-bootstrap.json",
    cdpFlag: "--consumer-cdp",
    cdpPort: "9924",
    label: "demo-b",
    portFlag: "--consumer-port",
    port: "5274",
    requireSignin: true,
  },
};

function profilePaths(runRoot, profile) {
  const root = path.join(runRoot, profile.label);
  return {
    appDataDir: path.join(root, "appdata"),
    bootstrapPath: path.join(root, profile.bootstrapName),
    cacheHome: path.join(root, "xdg-cache"),
    configHome: path.join(root, "xdg-config"),
    dataDir: path.join(root, "openwork-data"),
    dataHome: path.join(root, "xdg-data"),
    envStorePath: path.join(root, "openwork-env.json"),
    homeDir: path.join(root, "home"),
    localAppDataDir: path.join(root, "local-appdata"),
    opencodeConfigDir: path.join(root, "opencode-config"),
    root,
    stateHome: path.join(root, "xdg-state"),
    userDataDir: path.join(root, "electron-userdata"),
  };
}

function packagedExecutable(profile) {
  if (process.platform !== "darwin") return null;
  const outputName = profile.label === "demo-a" ? "dist-electron-demo-a" : "dist-electron-demo-b";
  const architectureDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
  return path.join(
    desktopRoot,
    outputName,
    architectureDirectory,
    `${profile.appName}.app`,
    "Contents",
    "MacOS",
    profile.appName,
  );
}

export async function createDemoRun(root = demoRoot) {
  await mkdir(root, { recursive: true });
  const runRoot = await mkdtemp(path.join(root, "run-"));
  const admin = profilePaths(runRoot, appProfiles.admin);
  const consumer = profilePaths(runRoot, appProfiles.consumer);
  await Promise.all([
    ...[admin, consumer].flatMap((profile) => [
      mkdir(profile.userDataDir, { recursive: true }),
      mkdir(profile.appDataDir, { recursive: true }),
      mkdir(profile.localAppDataDir, { recursive: true }),
      mkdir(profile.opencodeConfigDir, { recursive: true }),
      mkdir(profile.dataDir, { recursive: true }),
      mkdir(profile.homeDir, { recursive: true }),
      mkdir(profile.configHome, { recursive: true }),
      mkdir(profile.dataHome, { recursive: true }),
      mkdir(profile.cacheHome, { recursive: true }),
      mkdir(profile.stateHome, { recursive: true }),
    ]),
  ]);
  return { admin, consumer, runRoot };
}

export function existingDemoRun(runRoot) {
  return {
    admin: profilePaths(runRoot, appProfiles.admin),
    consumer: profilePaths(runRoot, appProfiles.consumer),
    runRoot,
  };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function flag(name) {
  return process.argv.includes(name);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function portIsAvailable(port) {
  return new Promise((resolveCheck) => {
    const server = net.createServer();
    server.once("error", () => resolveCheck(false));
    server.once("listening", () => {
      server.close(() => resolveCheck(true));
    });
    server.listen(Number(port), "127.0.0.1");
  });
}

async function assertDemoPortsAvailable(entries) {
  for (const [label, port] of entries) {
    if (!(await portIsAvailable(port))) {
      throw new Error(
        `${label} port ${port} is already in use. Stop that process or rerun with a different ${label.includes("A") ? "--admin" : "--consumer"}-${label.includes("CDP") ? "cdp" : "port"}.`,
      );
    }
  }
}

function processIdsListeningOnPort(port) {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

export function parseDemoProcessIds(
  output,
  {
    demoRootPath = demoRoot,
    repoRootPath = repoRoot,
    currentPid = process.pid,
    parentPid = process.ppid,
  } = {},
) {
  return output
    .split("\n")
    .filter((line) =>
      line.includes(demoRootPath) ||
      (line.includes(repoRootPath) &&
        (line.includes("dev-two-electron-demo.mjs") || line.includes("demo:electron"))),
    )
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((value) =>
      Number.isInteger(value) && value > 0 && value !== currentPid && value !== parentPid,
    );
}

function processIdsUsingDemoRoot() {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["axeww", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseDemoProcessIds(output);
  } catch {
    return [];
  }
}

function processGroupId(pid) {
  if (process.platform === "win32") return null;
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const groupId = Number(output.trim());
    return Number.isInteger(groupId) && groupId > 1 ? groupId : null;
  } catch {
    return null;
  }
}

function signalDemoProcesses(pids, signal) {
  const currentGroupId = processGroupId(process.pid);
  const groups = new Set(
    [...pids]
      .map((pid) => processGroupId(pid))
      .filter((groupId) => groupId && groupId !== currentGroupId),
  );

  for (const groupId of groups) {
    try {
      process.kill(-groupId, signal);
    } catch {}
  }

  for (const pid of pids) {
    if (groups.has(processGroupId(pid))) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function existingDemoProcessIds(ports) {
  return new Set([
    ...ports.flatMap((port) => processIdsListeningOnPort(port)),
    ...processIdsUsingDemoRoot(),
  ]);
}

async function waitForDemoProcessesStopped(ports, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existingDemoProcessIds(ports).size === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return existingDemoProcessIds(ports).size === 0;
}

async function stopExistingDemoProcesses(ports) {
  let pids = existingDemoProcessIds(ports);
  if (pids.size === 0) return;

  signalDemoProcesses(pids, "SIGINT");
  if (await waitForDemoProcessesStopped(ports, 4_000)) return;

  pids = existingDemoProcessIds(ports);
  signalDemoProcesses(pids, "SIGTERM");
  if (await waitForDemoProcessesStopped(ports, 2_000)) return;

  pids = existingDemoProcessIds(ports);
  signalDemoProcesses(pids, "SIGKILL");
  await waitForDemoProcessesStopped(ports, 1_000);
}

async function waitForDemoPortsAvailable(entries, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let allAvailable = true;
    for (const [, port] of entries) {
      if (!(await portIsAvailable(port))) {
        allAvailable = false;
        break;
      }
    }
    if (allAvailable) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await assertDemoPortsAvailable(entries);
}

function prepareSharedElectronResources() {
  runSync(
    process.execPath,
    [
      path.join(desktopScriptsRoot, "prepare-sidecar.mjs"),
      "--force",
      "--outdir",
      path.join(desktopRoot, "resources", "sidecars"),
    ],
    { cwd: desktopRoot },
  );
  runSync(
    process.execPath,
    [
      path.join(desktopScriptsRoot, "prepare-computer-use-helper.mjs"),
      "--force",
      "--outdir",
      path.join(desktopRoot, "resources", "helpers"),
    ],
    { cwd: desktopRoot },
  );
}

function startElectron(profile, env, built, packaged) {
  const packagedCommand = packaged ? packagedExecutable(profile) : null;
  if (packaged && (!packagedCommand || !existsSync(packagedCommand))) {
    throw new Error(`${profile.appName} is not packaged. Run pnpm demo:electron:build first.`);
  }
  const command = packagedCommand || (built ? process.execPath : pnpmCmd);
  const args = packagedCommand
    ? []
    : built
      ? [
        electronCli,
        ...(env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN === "1" ? ["--use-mock-keychain"] : []),
        "./electron/main.mjs",
      ]
      : ["dev:electron"];
  const child = spawn(command, args, {
    cwd: built ? desktopRoot : repoRoot,
    env: { ...process.env, ...env },
    // Keep the app's output attached directly to the launch destination. A
    // background launcher may exit after opening both apps; inherited streams
    // remain valid, while launcher-owned pipes become EPIPE and Electron turns
    // the resulting uncaught exception into a blocking native alert.
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });

  const prefix = `[${profile.label}]`;
  child.once("error", (error) => {
    if (stopping) return;
    console.error(`${prefix} failed to start: ${error.message}`);
    void stopAll(1);
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    const detail = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
    console.error(`${prefix} stopped with ${detail}`);
    void stopAll(signal ? 1 : (code ?? 0));
  });

  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGINT");
    } else {
      child.kill("SIGINT");
    }
  } catch {
    child.kill("SIGINT");
  }
}

let stopping = false;
let children = [];

async function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  if (children.length === 0) {
    process.exit(exitCode);
  }
  for (const child of children) stopChild(child);
  setTimeout(() => process.exit(exitCode), 1500).unref();
}

async function writeBootstrap(filePath, requireSignin, baseUrl, apiBaseUrl, brandAppName) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ baseUrl, apiBaseUrl, requireSignin, brandAppName }, null, 2)}\n`,
    "utf8",
  );
}

export async function resetDemoData(root = demoRoot) {
  await rm(root, { recursive: true, force: true });
}

export function demoEnv(profile, paths, port, cdpPort) {
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
    OPENWORK_ELECTRON_APP_IDENTIFIER: profile.appIdentifier,
    OPENWORK_ELECTRON_APP_NAME: profile.appName,
    OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: cdpPort,
    OPENWORK_ELECTRON_SKIP_SHARED_PREPARE: "1",
    OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
    OPENWORK_ELECTRON_USERDATA: paths.userDataDir,
    PORT: port,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_STATE_HOME: paths.stateHome,
  };
}

async function main() {
  if (flag("--help") || flag("-h")) {
    console.log(
      `Usage: pnpm dev:electron:two [options]\n\nStarts two isolated Electron instances for a local Den demo.\n\nOptions:\n  --built                 Launch the prebuilt renderer without Vite\n  --packaged              Launch the distinct Demo A and Demo B app bundles\n  --prepare-only          Create both profiles without opening the apps\n  --run-root <path>       Launch a profile pair previously created with --prepare-only\n  --reset                 Delete demo profile data before launching\n  --reset-only            Delete demo profile data and exit\n  --den-web-url <url>     Den Web URL (default: http://localhost:3005)\n  --den-api-url <url>     Den API URL (default: http://localhost:8788)\n  --admin-port <port>     Demo A Vite port (default: 5273)\n  --consumer-port <port>  Demo B Vite port (default: 5274)\n  --admin-cdp <port>      Demo A Electron CDP port (default: 9923)\n  --consumer-cdp <port>   Demo B Electron CDP port (default: 9924)\n`,
    );
    return;
  }

  const built = flag("--built");
  const packaged = flag("--packaged");
  const prepareOnly = flag("--prepare-only");
  const requestedRunRoot = argValue("--run-root", "").trim();
  if (packaged && !built) {
    throw new Error("--packaged requires --built.");
  }
  if (prepareOnly && requestedRunRoot) {
    throw new Error("--prepare-only cannot be combined with --run-root.");
  }
  const denWebUrl = argValue("--den-web-url", "http://localhost:3005");
  const denApiUrl = argValue("--den-api-url", "http://localhost:8788");
  const adminPort = argValue(appProfiles.admin.portFlag, appProfiles.admin.port);
  const consumerPort = argValue(appProfiles.consumer.portFlag, appProfiles.consumer.port);
  const adminCdp = argValue(appProfiles.admin.cdpFlag, appProfiles.admin.cdpPort);
  const consumerCdp = argValue(appProfiles.consumer.cdpFlag, appProfiles.consumer.cdpPort);
  const portEntries = built
    ? [["Demo A CDP", adminCdp], ["Demo B CDP", consumerCdp]]
    : [["Demo A", adminPort], ["Demo B", consumerPort], ["Demo A CDP", adminCdp], ["Demo B CDP", consumerCdp]];

  if (flag("--reset") || flag("--reset-only")) {
    await stopExistingDemoProcesses(portEntries.map(([, port]) => port));
    await waitForDemoPortsAvailable(portEntries);
    await resetDemoData();
    console.log(`Reset demo data at ${demoRoot}`);
  }
  if (flag("--reset-only")) return;

  if (prepareOnly) {
    const preparedRun = await createDemoRun();
    await writeBootstrap(
      preparedRun.admin.bootstrapPath,
      appProfiles.admin.requireSignin,
      denWebUrl,
      denApiUrl,
      appProfiles.admin.appName,
    );
    await writeBootstrap(
      preparedRun.consumer.bootstrapPath,
      appProfiles.consumer.requireSignin,
      denWebUrl,
      denApiUrl,
      appProfiles.consumer.appName,
    );
    console.log(preparedRun.runRoot);
    return;
  }

  if (requestedRunRoot) {
    await stopExistingDemoProcesses(portEntries.map(([, port]) => port));
    await waitForDemoPortsAvailable(portEntries);
  }
  await assertDemoPortsAvailable(portEntries);

  if (built && !existsSync(path.join(repoRoot, "apps", "app", "dist", "index.html"))) {
    throw new Error("The desktop renderer is not built. Run pnpm --filter @openwork/desktop build:electron first.");
  }

  const demoRun = requestedRunRoot
    ? existingDemoRun(path.resolve(requestedRunRoot))
    : await createDemoRun();
  if (!requestedRunRoot) {
    await writeBootstrap(
      demoRun.admin.bootstrapPath,
      appProfiles.admin.requireSignin,
      denWebUrl,
      denApiUrl,
      appProfiles.admin.appName,
    );
    await writeBootstrap(
      demoRun.consumer.bootstrapPath,
      appProfiles.consumer.requireSignin,
      denWebUrl,
      denApiUrl,
      appProfiles.consumer.appName,
    );
  } else if (!existsSync(demoRun.admin.bootstrapPath) || !existsSync(demoRun.consumer.bootstrapPath)) {
    throw new Error("--run-root must point to a profile pair created with --prepare-only.");
  }

  if (!built) prepareSharedElectronResources();

  children = [
    startElectron(appProfiles.admin, demoEnv(appProfiles.admin, demoRun.admin, adminPort, adminCdp), built, packaged),
    startElectron(
      appProfiles.consumer,
      demoEnv(appProfiles.consumer, demoRun.consumer, consumerPort, consumerCdp),
      built,
      packaged,
    ),
  ];

  console.log("\nTwo Electron demo is starting.");
  console.log(`Den Web:       ${denWebUrl}`);
  console.log(`Den API:       ${denApiUrl}`);
  console.log(`Renderer:      ${built ? "prebuilt" : "Vite"}`);
  if (!built) {
    console.log(`Demo A URL:    http://localhost:${adminPort}`);
    console.log(`Demo B URL:    http://localhost:${consumerPort}`);
  }
  console.log(`Demo A CDP:    http://127.0.0.1:${adminCdp}`);
  console.log(`Demo B CDP:    http://127.0.0.1:${consumerCdp}`);
  console.log(`Demo A folder: ${demoRun.admin.root}`);
  console.log(`  Electron:    ${demoRun.admin.userDataDir}`);
  console.log(`  OpenWork:    ${demoRun.admin.dataDir}`);
  console.log(`Demo B folder: ${demoRun.consumer.root}`);
  console.log(`  Electron:    ${demoRun.consumer.userDataDir}`);
  console.log(`  OpenWork:    ${demoRun.consumer.dataDir}`);
  const denStartup =
    adminPort === appProfiles.admin.port && consumerPort === appProfiles.consumer.port
      ? "pnpm demo:den"
      : `OPENWORK_EXTRA_APP_PORTS=${adminPort},${consumerPort} pnpm dev:den`;
  console.log(`Den startup:   ${denStartup}`);
  console.log("Press Ctrl-C to stop both instances.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("SIGINT", () => void stopAll(130));
  process.once("SIGTERM", () => void stopAll(143));

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    void stopAll(1);
  });
}
