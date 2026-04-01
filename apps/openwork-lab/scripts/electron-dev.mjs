import { spawn } from "node:child_process";

const port = process.env.OPENWORK_LAB_PORT || "3016";
const url = `http://127.0.0.1:${port}`;

function run(command, args, extraEnv = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
}

async function waitForUrl(target, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch {
      // ignore until ready
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(`Timed out waiting for ${target}`);
}

const web = run("pnpm", ["run", "dev:web"]);
let electron;

const shutdown = (code = 0) => {
  if (electron && !electron.killed) electron.kill("SIGTERM");
  if (!web.killed) web.kill("SIGTERM");
  process.exit(code);
};

web.on("exit", (code) => {
  if (!electron) {
    process.exit(code ?? 0);
  }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await waitForUrl(url);
  electron = run("pnpm", ["exec", "electron", "electron/main.mjs"], {
    OPENWORK_LAB_START_URL: url,
  });
  electron.on("exit", (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
