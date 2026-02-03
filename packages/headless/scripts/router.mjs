import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 10_000, pollMs = 250) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw lastError ?? new Error("Timed out waiting for daemon");
}

async function runCli(args, dataDir) {
  const child = spawn("node", [cliPath, ...args], {
    env: {
      ...process.env,
      OPENWRK_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(stderr.trim() || `openwrk failed with code ${code}`);
  }
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

const root = await mkdtemp(join(tmpdir(), "openwrk-router-"));
const dataDir = join(root, "data");
const workspaceA = join(root, "ws-a");
const workspaceB = join(root, "ws-b");
await mkdir(workspaceA, { recursive: true });
await mkdir(workspaceB, { recursive: true });

const daemonPort = await findFreePort();
const opencodePort = await findFreePort();
const daemonUrl = `http://127.0.0.1:${daemonPort}`;

const daemon = spawn(
  "node",
  [
    cliPath,
    "daemon",
    "run",
    "--data-dir",
    dataDir,
    "--daemon-host",
    "127.0.0.1",
    "--daemon-port",
    String(daemonPort),
    "--opencode-port",
    String(opencodePort),
  ],
  {
    env: {
      ...process.env,
      OPENWRK_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  await waitFor(`${daemonUrl}/health`);

  const addedA = await runCli(["workspace", "add", workspaceA, "--json"], dataDir);
  const addedB = await runCli(["workspace", "add", workspaceB, "--json"], dataDir);
  const idA = addedA.workspace.id;
  const idB = addedB.workspace.id;

  const status1 = await runCli(["daemon", "status", "--json"], dataDir);
  const pid1 = status1.opencode.pid;

  const pathA = await runCli(["workspace", "path", idA, "--json"], dataDir);
  const pathB = await runCli(["workspace", "path", idB, "--json"], dataDir);

  assert.equal(pathA.path.directory, workspaceA);
  assert.equal(pathB.path.directory, workspaceB);

  const status2 = await runCli(["daemon", "status", "--json"], dataDir);
  const pid2 = status2.opencode.pid;
  assert.equal(pid1, pid2);

  const disposed = await runCli(["instance", "dispose", idA, "--json"], dataDir);
  assert.equal(disposed.disposed, true);

  const pathA2 = await runCli(["workspace", "path", idA, "--json"], dataDir);
  assert.equal(pathA2.path.directory, workspaceA);

  await runCli(["daemon", "stop", "--json"], dataDir);
  await Promise.race([once(daemon, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);

  console.log(JSON.stringify({ ok: true, dataDir, daemonUrl, workspaces: [idA, idB] }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error), daemonUrl },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  try {
    await runCli(["daemon", "stop", "--json"], dataDir);
  } catch {
    // ignore
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
