import { spawn } from "node:child_process";
import net from "node:net";

const devPort = Number.parseInt(process.env.PORT ?? "", 10);
const port = Number.isFinite(devPort) && devPort > 0 ? devPort : 5173;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const sharedEnv = {
  ...process.env,
  OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE ?? "1",
  PORT: String(port),
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(hosts, portNumber, timeoutMs = 120000) {
  const startedAt = Date.now();
  let lastError = "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    for (const host of hosts) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection({ host, port: portNumber });
          socket.once("connect", () => {
            socket.end();
            resolve(undefined);
          });
          socket.once("error", (error) => {
            socket.destroy();
            reject(error);
          });
        });
        return;
      } catch (error) {
        lastError = `${host}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await wait(250);
  }

  throw new Error(`Timed out waiting for Vite dev server on port ${portNumber} (${lastError})`);
}

function startProcess(label, args) {
  const child = spawn(pnpmCommand, args, {
    stdio: "inherit",
    env: sharedEnv,
  });

  child.once("error", (error) => {
    console.error(`[${label}] failed to start: ${error.message}`);
  });

  return child;
}

const vite = startProcess("vite", ["--filter", "@different-ai/openwork-ui", "dev"]);

let electron = null;
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (electron && electron.exitCode === null && electron.signalCode === null) {
    electron.kill("SIGTERM");
  }
  if (vite.exitCode === null && vite.signalCode === null) {
    vite.kill("SIGTERM");
  }

  setTimeout(() => {
    if (electron && electron.exitCode === null && electron.signalCode === null) {
      electron.kill("SIGKILL");
    }
    if (vite.exitCode === null && vite.signalCode === null) {
      vite.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 2000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

vite.once("exit", (code, signal) => {
  if (shuttingDown) return;
  if (!electron) {
    console.error(`[vite] exited before Electron started (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    shutdown(code ?? 1);
    return;
  }
  console.error(`[vite] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  shutdown(code ?? 1);
});

try {
  console.log(`[dev] waiting for Vite on http://127.0.0.1:${port}`);
  await waitForPort(["127.0.0.1", "localhost", "::1"], port);
  console.log("[dev] starting Electron desktop shell");
  electron = startProcess("electron", ["--filter", "@different-ai/openwork", "dev"]);
  electron.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[electron] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    shutdown(code ?? 0);
  });
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
}
