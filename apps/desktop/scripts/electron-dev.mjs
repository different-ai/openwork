import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronHelperDir = resolve(desktopRoot, "resources", "helpers");
const defaultDevDataDir = resolve(
  process.env.HOME ?? process.env.USERPROFILE ?? repoRoot,
  ".openwork",
  "openwork-orchestrator-dev",
);

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeCmd = process.execPath;
const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;
const explicitStartUrl = process.env.OPENWORK_ELECTRON_START_URL?.trim() || "";
const startUrl = explicitStartUrl || `http://localhost:${devPort}`;
const viteProbeUrls = explicitStartUrl
  ? [explicitStartUrl]
  : [
      `http://127.0.0.1:${devPort}`,
      `http://[::1]:${devPort}`,
      `http://localhost:${devPort}`,
    ];

function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: needsShell(command),
    ...options,
  });
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: needsShell(command),
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeHost(host, port) {
  return new Promise((resolveCheck) => {
    const socket = net.createConnection({ host, port });
    const onDone = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveCheck(ready);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => onDone(true));
    socket.once("timeout", () => onDone(false));
    socket.once("error", () => onDone(false));
  });
}

async function looksLikeVite(url) {
  try {
    const response = await fetchWithTimeout(`${url}/@vite/client`);
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes("@vite/client") || body.includes("import.meta.hot");
  } catch {
    return false;
  }
}

async function portIsOpenForVite(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const port = Number.parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10);
    if (!Number.isFinite(port)) return false;
    return probeHost(host, port);
  } catch {
    return false;
  }
}

async function waitForVite(url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const candidate of [url, ...viteProbeUrls].filter(Boolean)) {
      if (await looksLikeVite(candidate)) {
        return candidate;
      }
    }
    for (const candidate of [url, ...viteProbeUrls].filter(Boolean)) {
      if (await portIsOpenForVite(candidate)) {
        return candidate;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for Vite dev server at ${viteProbeUrls.join(", ")}`);
}

function signalTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // ignore
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

function restoreTerminal() {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // ignore
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (clean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveWait(clean);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function waitForChildren(children, timeoutMs) {
  const results = await Promise.all(children.map((child) => waitForExit(child, timeoutMs)));
  return results.every(Boolean);
}

let uiChild = null;
let electronChild = null;
let stopping = false;

async function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  restoreTerminal();

  const children = [electronChild, uiChild].filter(Boolean);
  for (const child of children) signalTree(child, "SIGINT");

  const stoppedCleanly = await waitForChildren(children, 2_000);
  if (!stoppedCleanly) {
    for (const child of children) signalTree(child, "SIGTERM");
    await waitForChildren(children, 1_000);
  }

  restoreTerminal();
  process.exit(exitCode);
}

process.once("SIGINT", () => void stopAll(130));
process.once("SIGTERM", () => void stopAll(143));

if (process.env.OPENWORK_ELECTRON_SKIP_SHARED_PREPARE !== "1") {
  runSync(nodeCmd, [resolve(__dirname, "prepare-sidecar.mjs"), "--force", "--outdir", electronSidecarDir], { cwd: desktopRoot });
  runSync(nodeCmd, [resolve(__dirname, "prepare-computer-use-helper.mjs"), "--force", "--outdir", electronHelperDir], { cwd: desktopRoot });
}

// Build the server TS → JS so Electron can import it in-process
console.log("[electron-dev] Building openwork-server (tsc)...");
runSync(pnpmCmd, ["--filter", "openwork-server", "build"], { cwd: repoRoot });

const initialProbeUrls = [startUrl, ...viteProbeUrls].filter(Boolean);
let viteReady = false;
for (const candidate of initialProbeUrls) {
  if (await looksLikeVite(candidate)) {
    viteReady = true;
    break;
  }
}

if (!viteReady) {
  for (const candidate of initialProbeUrls) {
    if (await portIsOpenForVite(candidate)) {
      viteReady = true;
      break;
    }
  }
}

if (!viteReady) {
  uiChild = run(pnpmCmd, ["-w", "dev:ui"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(devPort),
      OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE ?? "1",
      OPENWORK_DATA_DIR: process.env.OPENWORK_DATA_DIR ?? defaultDevDataDir,
    },
  });
}

const resolvedStartUrl = await waitForVite(startUrl);

// Optional Electron CDP for external debugging / raw CDP clients.
// NOT required for the built-in browser (uses native webContents APIs).
// Set OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9823 to enable.
const cdpPortRaw = process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "";
const cdpPort = cdpPortRaw === "" || cdpPortRaw === "0" ? "" : cdpPortRaw;

electronChild = run(pnpmCmd, ["exec", "electron", "./electron/main.mjs"], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE ?? "1",
    OPENWORK_DATA_DIR: process.env.OPENWORK_DATA_DIR ?? defaultDevDataDir,
    OPENWORK_ELECTRON_START_URL: resolvedStartUrl,
    ...(cdpPort ? { OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: cdpPort } : {}),
  },
});

if (cdpPort) {
  console.log(`[openwork] Electron CDP exposed at http://127.0.0.1:${cdpPort}`);
}

electronChild.on("exit", (code) => {
  if (stopping) return;
  void stopAll(code ?? 0);
});
