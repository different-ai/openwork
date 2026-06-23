import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
    cdpPort: "9823",
    label: "demo-a",
    portFlag: "--admin-port",
    port: "5173",
    requireSignin: false,
    userDataName: "admin-userdata",
  },
  consumer: {
    appIdentifier: "com.differentai.openwork.demo.consumer",
    appName: "OpenWork Demo B",
    bootstrapName: "consumer-bootstrap.json",
    cdpFlag: "--consumer-cdp",
    cdpPort: "9824",
    label: "demo-b",
    portFlag: "--consumer-port",
    port: "5174",
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
    console.log(`Usage: pnpm dev:electron:two [options]\n\nStarts two isolated Electron dev instances for a local Den demo.\n\nOptions:\n  --reset                 Delete demo profile data before launching\n  --reset-only            Delete demo profile data and exit\n  --den-web-url <url>     Den Web URL (default: http://localhost:3005)\n  --den-api-url <url>     Den API URL (default: http://localhost:8788)\n  --admin-port <port>     Demo A Vite port (default: 5173)\n  --consumer-port <port>  Demo B Vite port (default: 5174)\n  --admin-cdp <port>      Demo A Electron CDP port (default: 9823)\n  --consumer-cdp <port>   Demo B Electron CDP port (default: 9824)\n`);
    return;
  }

  if (flag("--reset") || flag("--reset-only")) {
    await resetDemoData();
    console.log(`Reset demo data at ${demoRoot}`);
  }
  if (flag("--reset-only")) return;

  const denWebUrl = argValue("--den-web-url", "http://localhost:3005");
  const denApiUrl = argValue("--den-api-url", "http://localhost:8788");
  const adminPort = argValue(appProfiles.admin.portFlag, appProfiles.admin.port);
  const consumerPort = argValue(appProfiles.consumer.portFlag, appProfiles.consumer.port);
  const adminCdp = argValue(appProfiles.admin.cdpFlag, appProfiles.admin.cdpPort);
  const consumerCdp = argValue(appProfiles.consumer.cdpFlag, appProfiles.consumer.cdpPort);
  const adminBootstrap = path.join(demoRoot, appProfiles.admin.bootstrapName);
  const consumerBootstrap = path.join(demoRoot, appProfiles.consumer.bootstrapName);

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
