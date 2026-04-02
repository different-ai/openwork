import { spawn } from "node:child_process";

const rendererPort = 3340;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

const children = [];
let shuttingDown = false;

function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(exitCode), 120);
}

function spawnLogged(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  children.push(child);
  return child;
}

async function waitForRenderer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Ignore until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

const vite = spawnLogged("pnpm", [
  "exec",
  "vite",
  "--host",
  "0.0.0.0",
  "--port",
  String(rendererPort),
  "--strictPort",
]);

vite.on("exit", (code) => {
  if (!shuttingDown) {
    cleanup(code ?? 1);
  }
});

try {
  await waitForRenderer(rendererUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  cleanup(1);
}

const electron = spawnLogged(
  "pnpm",
  ["exec", "electron", "./electron/main.mjs"],
  {
    ...process.env,
    LABS_RENDERER_URL: rendererUrl,
  },
);

electron.on("exit", (code) => {
  cleanup(code ?? 0);
});
