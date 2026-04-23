import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");

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

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
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

function killTree(child) {
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
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

let uiChild = null;
let electronChild = null;
let stopping = false;

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  killTree(electronChild);
  killTree(uiChild);
  process.exit(exitCode);
}

process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));

runSync(nodeCmd, [resolve(__dirname, "prepare-sidecar.mjs"), "--force"], { cwd: desktopRoot });

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
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PORT: String(devPort),
      OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE ?? "1",
    },
  });
}

const resolvedStartUrl = await waitForVite(startUrl);

// Default Electron CDP on a stable dev port so chrome-devtools MCP / raw CDP
// clients can attach without each launch picking a random port. Override with
// OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=<port> or set to "0" to disable.
const defaultCdpPort = "9823";
const cdpPortRaw = process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? defaultCdpPort;
const cdpPort = cdpPortRaw === "" || cdpPortRaw === "0" ? "" : cdpPortRaw;

electronChild = run(pnpmCmd, ["exec", "electron", "./electron/main.mjs"], {
  cwd: desktopRoot,
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE ?? "1",
    OPENWORK_ELECTRON_START_URL: resolvedStartUrl,
    ...(cdpPort ? { OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: cdpPort } : {}),
  },
});

if (cdpPort) {
  console.log(`[openwork] Electron CDP exposed at http://127.0.0.1:${cdpPort}`);
}

electronChild.on("exit", (code) => {
  stopAll(code ?? 0);
});
