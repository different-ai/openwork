import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const readPort = () => {
  const value = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 5173;
};

const hostOverride = process.env.OPENWORK_DEV_HOST?.trim() || null;
const port = readPort();
const baseUrls = (hostOverride ? [hostOverride] : ["127.0.0.1", "localhost"]).map((host) => `http://${host}:${port}`);

const fetchWithTimeout = async (url, { timeoutMs = 1200 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
};

const killProcessTree = (child) => {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    // Best-effort: kill process + children.
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // ignore
    }
    return;
  }

  // If spawned detached, pid is also the process group id.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  // Escalate if it doesn't stop quickly.
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 1500);
  timer.unref?.();
};

const holdOpenUntilSignal = ({ uiChild } = {}) => {
  // Node 25+ may exit with a non-zero status when it detects an unsettled
  // top-level await. We avoid top-level await entirely and keep the event loop
  // alive with a timer until Tauri stops the dev process.
  const timer = setInterval(() => {}, 60_000);

   let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;

    if (uiChild) {
      killProcessTree(uiChild);
    }

    clearInterval(timer);
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

const portHasHttpServer = async (baseUrl) => {
  try {
    await fetchWithTimeout(baseUrl, { timeoutMs: 900 });
    return true;
  } catch {
    return false;
  }
};

const looksLikeVite = async (baseUrl) => {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/@vite/client`, { timeoutMs: 1200 });
    if (!res.ok) return false;

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("javascript")) return true;

    const body = await res.text();
    return body.includes("import.meta.hot") || body.includes("@vite/client");
  } catch {
    return false;
  }
};

const runPrepareSidecars = () => {
  const prepareScript = resolve(fileURLToPath(new URL("./prepare-sidecar.mjs", import.meta.url)));
  const args = [prepareScript];
  if (process.env.OPENWORK_SIDECAR_FORCE_BUILD !== "0") {
    args.push("--force");
  }
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const runUiDevServer = () => {
  const child = spawn(pnpmCmd, ["-w", "dev:ui"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      // Make sure vite sees the intended port.
      PORT: String(port),
    },
  });

  const forwardSignal = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });

  return child;
};

runPrepareSidecars();

const main = async () => {
  let detectedViteUrl = null;
  for (const candidate of baseUrls) {
    if (await looksLikeVite(candidate)) {
      detectedViteUrl = candidate;
      break;
    }
  }

  if (detectedViteUrl) {
    console.log(`[openwork] UI dev server already running at ${detectedViteUrl} (reusing).`);
    holdOpenUntilSignal();
    return;
  }

  let portInUse = false;
  for (const candidate of baseUrls) {
    if (await portHasHttpServer(candidate)) {
      portInUse = true;
      break;
    }
  }

  if (portInUse) {
    console.error(
      `[openwork] Port ${port} is in use, but it does not look like a Vite dev server.\n` +
        `Set PORT to a free port (e.g. PORT=5174) or stop the process using port ${port}.`
    );
    process.exit(1);
  }

  console.log(`[openwork] Starting UI dev server on port ${port}...`);
  const uiChild = runUiDevServer();
  holdOpenUntilSignal({ uiChild });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
