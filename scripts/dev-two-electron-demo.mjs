import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const desktopScriptsRoot = path.join(desktopRoot, "scripts");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const demoRoot =
  process.env.OPENWORK_ELECTRON_DEMO_ROOT?.trim() ||
  path.join(os.homedir(), ".openwork", "two-electron-demo");
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
    userDataName: "admin-userdata",
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
    userDataName: "consumer-userdata",
  },
};

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

function processIdsUsingDemoRoot() {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["axeww", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .filter((line) => line.includes(demoRoot))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== process.pid && value !== process.ppid);
  } catch {
    return [];
  }
}

function stopExistingDemoProcesses(ports) {
  const pids = new Set([
    ...ports.flatMap((port) => processIdsListeningOnPort(port)),
    ...processIdsUsingDemoRoot(),
  ]);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGINT");
    } catch {}
  }
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

function startElectron(label, env) {
  const child = spawn(pnpmCmd, ["dev:electron"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const prefix = `[${label}]`;
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix} ${chunk}`));
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

async function writeBootstrap(filePath, requireSignin, baseUrl, apiBaseUrl) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ baseUrl, apiBaseUrl, requireSignin }, null, 2)}\n`,
    "utf8",
  );
}

async function resetDemoData() {
  await rm(demoRoot, { recursive: true, force: true });
}

function demoEnv(profile, bootstrapPath, port, cdpPort) {
  const userDataDir = path.join(demoRoot, profile.userDataName);
  return {
    OPENWORK_DATA_DIR: path.join(userDataDir, "openwork-orchestrator-data"),
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: bootstrapPath,
    OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1",
    VITE_DISABLE_OPENWORK_MODELS: "1",
    OPENWORK_ELECTRON_APP_IDENTIFIER: profile.appIdentifier,
    OPENWORK_ELECTRON_APP_NAME: profile.appName,
    OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: cdpPort,
    OPENWORK_ELECTRON_SKIP_SHARED_PREPARE: "1",
    OPENWORK_ELECTRON_USERDATA: userDataDir,
    PORT: port,
  };
}

async function main() {
  if (flag("--help") || flag("-h")) {
    console.log(`Usage: pnpm dev:electron:two [options]\n\nStarts two isolated Electron dev instances for a local Den demo.\n\nOptions:\n  --reset                 Delete demo profile data before launching\n  --reset-only            Delete demo profile data and exit\n  --den-web-url <url>     Den Web URL (default: http://localhost:3005)\n  --den-api-url <url>     Den API URL (default: http://localhost:8788)\n  --admin-port <port>     Demo A Vite port (default: 5273)\n  --consumer-port <port>  Demo B Vite port (default: 5274)\n  --admin-cdp <port>      Demo A Electron CDP port (default: 9923)\n  --consumer-cdp <port>   Demo B Electron CDP port (default: 9924)\n`);
    return;
  }

  const denWebUrl = argValue("--den-web-url", "http://localhost:3005");
  const denApiUrl = argValue("--den-api-url", "http://localhost:8788");
  const adminPort = argValue(appProfiles.admin.portFlag, appProfiles.admin.port);
  const consumerPort = argValue(appProfiles.consumer.portFlag, appProfiles.consumer.port);
  const adminCdp = argValue(appProfiles.admin.cdpFlag, appProfiles.admin.cdpPort);
  const consumerCdp = argValue(appProfiles.consumer.cdpFlag, appProfiles.consumer.cdpPort);
  const portEntries = [
    ["Demo A", adminPort],
    ["Demo B", consumerPort],
    ["Demo A CDP", adminCdp],
    ["Demo B CDP", consumerCdp],
  ];

  if (flag("--reset") || flag("--reset-only")) {
    stopExistingDemoProcesses(portEntries.map(([, port]) => port));
    await waitForDemoPortsAvailable(portEntries);
    await resetDemoData();
    console.log(`Reset demo data at ${demoRoot}`);
  }
  if (flag("--reset-only")) return;

  const adminBootstrap = path.join(demoRoot, appProfiles.admin.bootstrapName);
  const consumerBootstrap = path.join(demoRoot, appProfiles.consumer.bootstrapName);

  await assertDemoPortsAvailable(portEntries);

  await writeBootstrap(adminBootstrap, appProfiles.admin.requireSignin, denWebUrl, denApiUrl);
  await writeBootstrap(consumerBootstrap, appProfiles.consumer.requireSignin, denWebUrl, denApiUrl);
  await mkdir(path.join(demoRoot, appProfiles.admin.userDataName), { recursive: true });
  await mkdir(path.join(demoRoot, appProfiles.consumer.userDataName), { recursive: true });

  prepareSharedElectronResources();

  children = [
    startElectron(appProfiles.admin.label, demoEnv(appProfiles.admin, adminBootstrap, adminPort, adminCdp)),
    startElectron(appProfiles.consumer.label, demoEnv(appProfiles.consumer, consumerBootstrap, consumerPort, consumerCdp)),
  ];

  console.log("\nTwo Electron demo is starting.");
  console.log(`Den Web:       ${denWebUrl}`);
  console.log(`Den API:       ${denApiUrl}`);
  console.log(`Demo A URL:    http://localhost:${adminPort}`);
  console.log(`Demo B URL:    http://localhost:${consumerPort}`);
  console.log(`Demo A CDP:    http://127.0.0.1:${adminCdp}`);
  console.log(`Demo B CDP:    http://127.0.0.1:${consumerCdp}`);
  console.log(`Demo A data:   ${path.join(demoRoot, appProfiles.admin.userDataName)}`);
  console.log(`Demo B data:   ${path.join(demoRoot, appProfiles.consumer.userDataName)}`);
  const denStartup =
    adminPort === appProfiles.admin.port && consumerPort === appProfiles.consumer.port
      ? "pnpm demo:den"
      : `OPENWORK_EXTRA_APP_PORTS=${adminPort},${consumerPort} pnpm dev:den`;
  console.log(`Den startup:   ${denStartup}`);
  console.log("Press Ctrl-C to stop both instances.\n");
}

process.once("SIGINT", () => void stopAll(130));
process.once("SIGTERM", () => void stopAll(143));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  void stopAll(1);
});
