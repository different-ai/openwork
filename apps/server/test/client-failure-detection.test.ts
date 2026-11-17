import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createManagedOpencodeServer } from "../src/managed-opencode.js";
import { serve } from "../src/serve-node.js";
import { startServer } from "../src/server.js";
import type { ClientFailure } from "../src/telemetry.js";
import { createLocalManagedMcpConnection, startLocalManagedMcpAuthorization } from "../src/local-managed-mcp.js";
import type { ServerConfig } from "../src/types.js";

async function capture(run: (failures: ClientFailure[], directory: string) => Promise<void>) {
  const previous = globalThis.__openworkClientFailureReport;
  const failures: ClientFailure[] = [];
  const directory = await mkdtemp(join(tmpdir(), "client-detection-"));
  globalThis.__openworkClientFailureReport = (failure) => { failures.push(failure); };
  try { await run(failures, directory); } finally {
    globalThis.__openworkClientFailureReport = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("real engine startup rejection builds only the fixed engine failure", () => capture(async (failures, directory) => {
  await assert.rejects(createManagedOpencodeV2Server({ bin: join(directory, "missing-engine"), rootDir: directory, historyDatabase: join(directory, "history.db"), bootTimeoutMs: 500 }));
  assert.deepEqual(failures, [{ component: "engine", phase: "start", reason: "unknown" }]);
}));

test("legacy engine startup failure and unexpected child exit use the same fixed contract", { skip: process.platform === "win32" }, () => capture(async (failures, directory) => {
  await assert.rejects(createManagedOpencodeServer({ bin: join(directory, "missing"), cwd: directory, port: 12345, timeoutMs: 100 }));
  assert.deepEqual(failures, [{ component: "engine", phase: "start", reason: "unknown" }]);
  failures.length = 0;
  const binary = join(directory, "legacy-engine");
  await writeFile(binary, `#!/usr/bin/env node
console.log('opencode server listening on http://127.0.0.1:12345');
setTimeout(() => process.exit(9), 50);
`, { mode: 0o755 });
  const exited = new Promise<void>((resolve) => { globalThis.__openworkClientFailureReport = (failure) => { failures.push(failure); resolve(); }; });
  const engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, port: 12345, timeoutMs: 2000 });
  try {
    await exited;
    assert.deepEqual(failures, [{ component: "engine", phase: "run", reason: "exit_nonzero", exitCode: 9 }]);
  } finally { await engine.close(); }
}));

test("real engine child exit after health records run and bounded exit code", { skip: process.platform === "win32" }, () => capture(async (failures, directory) => {
  const binary = join(directory, "engine");
  await writeFile(binary, `#!/usr/bin/env node
import('node:http').then(({ createServer }) => {
  const server = createServer((request, response) => {
    if (request.url === '/exit') { response.end('{}'); setTimeout(() => process.exit(7), 10); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({version:'1.0.0',pid:process.pid}));
  });
  server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
});
`, { mode: 0o755 });
  let exited: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => { exited = resolve; });
  const engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: directory, historyDatabase: join(directory, "history.db"), bootTimeoutMs: 5000, onExit: () => exited?.() });
  try {
    await engine.fetchJson("/exit");
    await exit;
    assert.deepEqual(failures, [{ component: "engine", phase: "run", reason: "exit_nonzero", exitCode: 7 }]);
  } finally { await engine.close(); }
}));

test("real local server startup rejection reports local_server; normal stop is not a crash", () => capture(async (failures, directory) => {
  const config: ServerConfig = {
    host: "203.0.113.10", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: true,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  await assert.rejects(startServer(config));
  assert.deepEqual(failures, [{ component: "local_server", phase: "start", reason: "unknown" }]);
  failures.length = 0;
  const listener = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  await listener.stop();
  assert.deepEqual(failures, []);
}));

test("local MCP failed handshake reports no connection identity or response text", () => capture(async (failures, directory) => {
  const previous = process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS;
  process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS = "1";
  const endpoint = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("private upstream body", { status: 500 }) });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 12345, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "workspace", name: "Workspace", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    localManagedMcpVaultKey: async () => Buffer.alloc(32, 1),
  };
  try {
    await createLocalManagedMcpConnection(config, { workspaceId: "workspace", name: "private-connection", serverUrl: `http://127.0.0.1:${endpoint.port}/mcp`, oauth: {} });
    await assert.rejects(startLocalManagedMcpAuthorization(config, "workspace", "private-connection"));
    assert.deepEqual(failures, [{ component: "mcp_connection", phase: "connect", reason: "unknown" }]);
  } finally {
    await endpoint.stop();
    if (previous === undefined) delete process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS;
    else process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS = previous;
  }
}));
