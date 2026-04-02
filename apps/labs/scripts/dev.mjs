import { spawn } from "node:child_process";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";

const rendererPort = 3340;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const localUrl = "http://127.0.0.1:4096";

const children = [];
let shuttingDown = false;
let runtime = null;

function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  runtime?.server.close();
  runtime = null;

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

async function ensureLocalServer() {
  try {
    const client = createOpencodeClient({ baseUrl: localUrl });
    await client.global.health();
    return;
  } catch {
    runtime = await createOpencode({ port: 4096 });
  }
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

try {
  await ensureLocalServer();

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

  await waitForRenderer(rendererUrl);

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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  cleanup(1);
}
