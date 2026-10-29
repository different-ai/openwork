import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

// A stand-in engine: it fails its first start when asked to, and exits on
// request, so the preview's own restart path runs without a real engine.
function fakeEngine(failFirstStartMarker: string | null) {
  return `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
const marker = ${JSON.stringify(failFirstStartMarker)};
if (marker && !existsSync(marker)) {
  writeFileSync(marker, "");
  console.log("engine output that must stay local: " + ${JSON.stringify(homedir())});
  process.exit(1);
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/info") return Response.json({ version: "2.0.26", pid: process.pid });
  if (path === "/api/model" || path === "/api/mcp" || path === "/api/provider") return Response.json({ data: [] });
  if (path === "/test/exit") {
    setTimeout(() => process.exit(3), 10);
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 404 });
}});
console.log("server listening on http://127.0.0.1:" + server.port);
`;
}

type Captured = { message: string; route?: string };

async function profile(failFirstStart: boolean, run: (config: ServerConfig, captured: Captured[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-restart-"));
  const binary = join(root, "fake-engine");
  const environment = {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_OPENCODE2_BIN: binary,
    // Chats run on v2, the case where a missing engine strands the app.
    OPENWORK_ENGINE_V2_PREVIEW: "chat",
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  const previousTelemetry = globalThis.__openworkDesktopTelemetry;
  const captured: Captured[] = [];
  Object.assign(process.env, environment);
  globalThis.__openworkDesktopTelemetry = {
    captureException: (error, context) => {
      captured.push({ message: error instanceof Error ? error.message : String(error), route: context?.route });
      return true;
    },
  };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  try {
    await mkdir(environment.XDG_CONFIG_HOME);
    await writeFile(binary, fakeEngine(failFirstStart ? join(root, "failed-once") : null), { mode: 0o700 });
    await run(config, captured);
  } finally {
    globalThis.__openworkDesktopTelemetry = previousTelemetry;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const waits = { engineRestartMs: 20, engineRestartMaxMs: 200 };

test("an engine that exits on its own is reported once and started again", { timeout: 30_000 }, async () => {
  await profile(false, async (config, captured) => {
    const engine = createEngineV2Preview({ config, waits });
    try {
      await waitFor(() => engine.status().running, "the first engine is running");
      const first = engine.status().pid;
      const connection = engine.connection();
      assert.ok(connection);
      await fetch(new URL("/test/exit", connection.url));
      await waitFor(() => engine.status().running && engine.status().pid !== first, "a new engine replaces the one that exited");
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().lastError, undefined, "a healthy restart clears the exit error");
      assert.deepEqual(captured.map(event => event.route), ["engine.v2.exit"]);
      assert.match(captured[0]!.message, /^OpenCode v2 stopped unexpectedly: OpenCode v2 server exited with code 3$/);
    } finally { await engine.stop(); }
  });
});

test("a failed start is reported by its first line and retried until the engine runs", { timeout: 30_000 }, async () => {
  await profile(true, async (config, captured) => {
    const engine = createEngineV2Preview({ config, waits });
    try {
      await waitFor(() => engine.status().running, "a retried start succeeds");
      assert.equal(engine.status().chatRouting, true, "chats stay on v2");
      assert.equal(engine.status().lastError, undefined);
      assert.deepEqual(captured.map(event => event.route), ["engine.v2.start"]);
      assert.match(captured[0]!.message, /^OpenCode v2 did not start: OpenCode v2 server exited with code 1$/);
      assert.doesNotMatch(captured[0]!.message, /engine output/, "engine output never leaves the machine");
    } finally { await engine.stop(); }
  });
});

test("a stopped engine is not started again", { timeout: 30_000 }, async () => {
  await profile(false, async (config) => {
    const engine = createEngineV2Preview({ config, waits });
    await waitFor(() => engine.status().running, "the engine is running");
    await engine.stop();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(engine.status().running, false);
    assert.equal(engine.connection(), undefined);
  });
});
