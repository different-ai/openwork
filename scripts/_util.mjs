import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { realpathSync, statSync } from "node:fs";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

export function makeClient({ baseUrl, directory }) {
  return createOpencodeClient({
    baseUrl,
    directory,
    responseStyle: "data",
    throwOnError: true,
  });
}

export async function findFreePort() {
  const server = net.createServer();
  server.unref();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();

  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to allocate a free port");
  }

  const port = addr.port;
  server.close();
  return port;
}

export async function spawnOpencodeServe({
  directory,
  hostname = "127.0.0.1",
  port,
  corsOrigins = [],
}) {
  assert.ok(directory && directory.trim(), "directory is required");
  assert.ok(Number.isInteger(port) && port > 0, "port must be a positive integer");

  const cwd = realpathSync(directory);
  const args = ["serve", "--hostname", hostname, "--port", String(port)];
  for (const origin of corsOrigins) {
    args.push("--cors", origin);
  }

  const child = spawn("opencode", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      // Make it explicit we're a non-TUI client.
      OPENCODE_CLIENT: "openwork-test",
    },
  });

  const baseUrl = `http://${hostname}:${port}`;

  // If the process dies early, surface stderr.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  async function waitForExit(ms) {
    return Promise.race([
      once(child, "exit").then(() => true),
      new Promise((r) => setTimeout(() => r(false), ms)),
    ]);
  }

  return {
    cwd,
    baseUrl,
    child,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }

      const exited = await waitForExit(2500);
      if (exited) {
        return;
      }

      // Force kill.
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }

      await waitForExit(2500);
    },
    getStderr() {
      return stderr;
    },
  };
}

export async function waitForHealthy(client, { timeoutMs = 10_000, pollMs = 250 } = {}) {
  const start = Date.now();
  let lastError;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = await client.global.health();
      assert.equal(health.healthy, true);
      assert.ok(typeof health.version === "string");
      return health;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for /global/health: ${msg}`);
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (typeof raw.type === "string") {
    return { type: raw.type, properties: raw.properties };
  }

  if (raw.payload && typeof raw.payload === "object" && typeof raw.payload.type === "string") {
    return { type: raw.payload.type, properties: raw.payload.properties };
  }

  return null;
}

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args.set(key, value);
  }
  return args;
}

export function canWriteWorkspace(directory) {
  try {
    const stat = statSync(directory);
    return stat && stat.isDirectory();
  } catch {
    return false;
  }
}
