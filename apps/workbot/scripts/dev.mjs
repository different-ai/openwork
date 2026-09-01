/**
 * Work Bot dev launcher: build the embedded OpenWork server bundle when it is
 * missing, start the Vite renderer, then launch the Electron shell against it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const serverBundle = resolve(repoRoot, "apps", "server", "dist", "embedded.js");

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5183;
const startUrl = `http://127.0.0.1:${devPort}`;

function run(command, args, options = {}) {
  return spawn(command, args, { stdio: "inherit", ...options });
}

function runOnce(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = run(command, args, options);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(undefined);
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

async function waitForVite(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
  }
  throw new Error(`Vite dev server did not become ready at ${url}`);
}

if (!existsSync(serverBundle)) {
  console.log("[workbot-dev] Building openwork-server (embedded bundle missing)…");
  await runOnce(pnpmCmd, ["--filter", "openwork-server", "build"], { cwd: repoRoot });
}

console.log(`[workbot-dev] Starting Vite on ${startUrl}`);
const vite = run(pnpmCmd, ["exec", "vite", "--port", String(devPort)], {
  cwd: appRoot,
  env: { ...process.env, PORT: String(devPort) },
});

let electron = null;
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && electron.exitCode === null) electron.kill();
  if (vite.exitCode === null) vite.kill();
  process.exit(code);
}

vite.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[workbot-dev] Vite exited (${code ?? "signal"}).`);
    shutdown(code ?? 1);
  }
});

try {
  await waitForVite(startUrl);
} catch (error) {
  console.error(`[workbot-dev] ${error instanceof Error ? error.message : error}`);
  shutdown(1);
}

console.log("[workbot-dev] Launching Work Bot…");
electron = run(pnpmCmd, ["exec", "electron", "./electron/main.mjs"], {
  cwd: appRoot,
  env: {
    ...process.env,
    WORKBOT_START_URL: startUrl,
    OPENWORK_DEV_MODE: "1",
  },
});

electron.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
