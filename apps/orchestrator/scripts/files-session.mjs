import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");
const serverCliPath = resolve(__dirname, "..", "..", "server", "src", "cli.ts");

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => reject(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url, timeoutMs = 10_000, pollMs = 200) {
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }
  throw lastError ?? new Error("Timed out waiting for endpoint");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${payload?.message ? ` ${payload.message}` : ""}`);
  }
  return payload;
}

async function runCli(args) {
  const child = spawn("node", [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
    throw new Error(stderr.trim() || `openwork CLI failed with code ${code}`);
  }

  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

const root = await mkdtemp(join(tmpdir(), "openwork-file-session-"));
const workspace = join(root, "workspace");
await mkdir(join(workspace, "notes"), { recursive: true });
await writeFile(join(workspace, "notes", "remote.md"), "hello from remote\n", "utf8");

const port = await findFreePort();
const token = "test-client-token";
const hostToken = "test-host-token";
const openworkUrl = `http://127.0.0.1:${port}`;

const server = spawn(
  "bun",
  [
    serverCliPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--workspace",
    workspace,
    "--approval",
    "auto",
    "--token",
    token,
    "--host-token",
    hostToken,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let serverStderr = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  serverStderr += chunk;
});

try {
  await waitFor(`${openworkUrl}/health`);

  const workspaces = await fetchJson(`${openworkUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const workspaceId = workspaces?.items?.[0]?.id;
  assert.ok(workspaceId, "workspace id should be available");

  const created = await runCli([
    "files",
    "session",
    "create",
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--workspace-id",
    workspaceId,
    "--write",
    "--json",
  ]);
  const sessionId = created?.session?.id;
  assert.ok(sessionId, "session id should be created");
  assert.equal(created.session.workspaceId, workspaceId);
  assert.equal(created.session.canWrite, true);

  const snapshot = await runCli([
    "files",
    "catalog",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--json",
  ]);
  const catalogItem = snapshot.items.find((item) => item.path === "notes/remote.md");
  assert.ok(catalogItem, "catalog should include notes/remote.md");

  const firstRead = await runCli([
    "files",
    "read",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--path",
    "notes/remote.md",
    "--json",
  ]);
  assert.equal(firstRead.items[0].ok, true);
  const firstRevision = firstRead.items[0].revision;
  const firstContent = Buffer.from(firstRead.items[0].contentBase64, "base64").toString("utf8");
  assert.equal(firstContent, "hello from remote\n");

  const wrote = await runCli([
    "files",
    "write",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--path",
    "notes/remote.md",
    "--content",
    "updated by openwork cli\n",
    "--if-match",
    firstRevision,
    "--json",
  ]);
  assert.equal(wrote.items[0].ok, true);
  const updatedRevision = wrote.items[0].revision;

  const diskContent = await readFile(join(workspace, "notes", "remote.md"), "utf8");
  assert.equal(diskContent, "updated by openwork cli\n");

  await writeFile(join(workspace, "notes", "remote.md"), "changed outside session\n", "utf8");
  const staleWrite = await runCli([
    "files",
    "write",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--path",
    "notes/remote.md",
    "--content",
    "should conflict\n",
    "--if-match",
    updatedRevision,
    "--json",
  ]);
  assert.equal(staleWrite.items[0].ok, false);
  assert.equal(staleWrite.items[0].code, "conflict");

  const mkdirResult = await runCli([
    "files",
    "mkdir",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--path",
    "notes/archive",
    "--json",
  ]);
  assert.equal(mkdirResult.items[0].ok, true);

  const renameResult = await runCli([
    "files",
    "rename",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--from",
    "notes/remote.md",
    "--to",
    "notes/archive/remote.md",
    "--json",
  ]);
  assert.equal(renameResult.items[0].ok, true);

  const deleteResult = await runCli([
    "files",
    "delete",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--path",
    "notes/archive/remote.md",
    "--json",
  ]);
  assert.equal(deleteResult.items[0].ok, true);

  const events = await runCli([
    "files",
    "events",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--since",
    "0",
    "--json",
  ]);
  const eventTypes = new Set(events.items.map((item) => item.type));
  assert.ok(eventTypes.has("write"), "events should include write");
  assert.ok(eventTypes.has("rename"), "events should include rename");
  assert.ok(eventTypes.has("delete"), "events should include delete");

  const closed = await runCli([
    "files",
    "session",
    "close",
    sessionId,
    "--openwork-url",
    openworkUrl,
    "--token",
    token,
    "--json",
  ]);
  assert.equal(closed.ok, true);

  console.log(JSON.stringify({ ok: true, openworkUrl, workspaceId, sessionId }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stderr: serverStderr.trim() || undefined,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 3000))]);
  }
  await rm(root, { recursive: true, force: true });
}
