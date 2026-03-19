import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const readLinuxReleaseInfo = () => {
  try {
    const content = readFileSync("/etc/os-release", "utf8");
    const values = new Map();
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      const rawValue = line.slice(separator + 1).trim();
      const value = rawValue.replace(/^"|"$/g, "");
      values.set(key, value);
    }
    return {
      id: values.get("ID") ?? "",
      like: values.get("ID_LIKE") ?? "",
      prettyName: values.get("PRETTY_NAME") ?? values.get("NAME") ?? "Linux",
    };
  } catch {
    return { id: "", like: "", prettyName: "Linux" };
  }
};

const getLinuxDesktopDependencyHint = () => {
  const release = readLinuxReleaseInfo();
  const family = `${release.id} ${release.like}`.toLowerCase();

  if (family.includes("arch")) {
    return "Install the missing desktop dependency and retry:\n  sudo pacman -S --needed webkit2gtk-4.1";
  }

  if (family.includes("ubuntu") || family.includes("debian")) {
    return (
      "Install the missing desktop dependencies and retry:\n" +
      "  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
    );
  }

  if (family.includes("fedora") || family.includes("rhel")) {
    return (
      "Install the missing desktop dependencies and retry:\n" +
      "  sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel"
    );
  }

  return `Install WebKitGTK 4.1 development packages for ${release.prettyName} so pkg-config can resolve both webkit2gtk-4.1 and javascriptcoregtk-4.1, then retry.`;
};

const ensureLinuxDesktopDependencies = () => {
  if (process.platform !== "linux") return;

  const requiredPkgConfigs = ["webkit2gtk-4.1", "javascriptcoregtk-4.1"];
  const missing = requiredPkgConfigs.filter((pkg) => {
    const result = spawnSync("pkg-config", ["--exists", pkg], { stdio: "ignore" });
    return result.status !== 0;
  });

  if (missing.length === 0) return;

  console.error(
    "[openwork] Missing Linux desktop system dependencies required by Tauri:\n" +
      `  ${missing.join(", ")}\n\n` +
      `${getLinuxDesktopDependencyHint()}\n\n` +
      "If you only need the web UI, run `pnpm dev:ui`."
  );
  process.exit(1);
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
ensureLinuxDesktopDependencies();

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
