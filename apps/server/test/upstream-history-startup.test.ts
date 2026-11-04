import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "bun:sqlite";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";
import { proxyOpencodeRequest } from "../src/server.js";

test("source startup tests resolve workspace dependencies without a package build", () => {
  const entry = import.meta.resolve("@openwork/enterprise-mcp-client");
  assert.ok(entry.endsWith("/src/index.ts"), `expected the development source export, received ${entry}`);
});

// A stand-in only for the startup contract: report the exact database the
// managed child received. Native conversion is covered by the real-engine proof.
const engineSource = `#!${process.execPath}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/api/info') return Response.json({ version: '2.2.0', pid: process.pid });
  if (path === '/test/database') return Response.json({ database: process.env.OPENCODE_DB });
  if (path === '/api/session/active') return Response.json({ data: {} });
  return Response.json({ data: [] });
}});
console.log('server listening on http://127.0.0.1:' + server.port);
`;

for (const existingV2 of [false, true]) {
  test(`direct startup ignores retired copy state and fences (${existingV2 ? "existing v2" : "original v1"})`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-upstream-start-"));
    const state = join(root, "opencode-v2", "state");
    const source = join(root, "original.db");
    const legacy = join(state, "opencode.db");
    const binary = join(root, "engine");
    const environment = {
      HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
      OPENCODE_DB: source, OPENWORK_OPENCODE2_BIN: binary, OPENWORK_ENGINE_V2_PREVIEW: "chat",
    };
    const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const config: ServerConfig = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1_000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    try {
      await mkdir(state, { recursive: true });
      await writeFile(binary, engineSource, { mode: 0o700 });
      const original = new Database(source);
      original.exec("CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('original-chat')");
      original.close();
      if (existingV2) {
        const db = new Database(legacy);
        db.exec(`CREATE TABLE session_v2 (id TEXT); INSERT INTO session_v2 VALUES ('native-v2-chat');
          CREATE TABLE openwork_history_copy (session_id TEXT, completed INTEGER);
          INSERT INTO openwork_history_copy VALUES ('unfinished-copy', 0)`);
        db.close();
      }
      const fence = join(state, "history-copy.pending");
      await writeFile(fence, "History copy must finish before the engine opens this database.\n");
      const staging = join(root, "opencode-v2", "history-copy");
      await mkdir(staging);
      await writeFile(join(staging, "source.db"), "retained recovery copy");
      await writeFile(join(root, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true,
        automaticHistoryCopy: true, v1HistoryCopyStartedAt: 1, historyCopyResult: { state: "error", error: "Not enough free disk space" } }));
      const preview = createEngineV2Preview({ config });
      try {
        const deadline = Date.now() + 15_000;
        while (!preview.status().running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(preview.status().running, true, preview.status().lastError);
        assert.equal(preview.status().chatRouting, true);
        assert.equal("migration" in preview.status(), false);
        const connection = preview.connection();
        assert.ok(connection, "a retired copy marker never hides a live engine");
        const response = await fetch(new URL("/test/database", connection.url));
        assert.deepEqual(await response.json(), { database: existingV2 ? legacy : source });
        assert.equal(readEngineV2PreviewState(config).enabled, true);
        assert.equal("v1HistoryCopyStartedAt" in readEngineV2PreviewState(config), false);
        assert.equal(await readFile(fence, "utf8"), "History copy must finish before the engine opens this database.\n");
        assert.equal(await readFile(join(staging, "source.db"), "utf8"), "retained recovery copy");
        if (!existingV2) {
          assert.ok(preview.status().v1UnavailableReason);
          await assert.rejects(preview.setChatRouting(false), { code: "engine_v1_history_adopted" });
          await assert.rejects(preview.setEnabled(false), { code: "engine_v1_history_adopted" });
          const url = new URL("http://localhost/opencode/session");
          await assert.rejects(proxyOpencodeRequest({ config, url, proxyPath: url.pathname,
            request: new Request(url, { method: "POST", body: "{}" }) }), { code: "engine_v1_history_adopted" });
          assert.equal(preview.status().chatRouting, true);
        } else {
          assert.equal(preview.status().v1UnavailableReason, undefined);
          await preview.setChatRouting(false);
          assert.equal(preview.status().chatRouting, false, "separate unconverted v1 histories keep their existing switch behavior");
        }
      } finally { await preview.stop(); }
      if (existingV2) {
        const db = new Database(legacy);
        db.exec("DELETE FROM session_v2");
        db.close();
        const restarted = createEngineV2Preview({ config });
        try {
          const deadline = Date.now() + 15_000;
          while (!restarted.status().running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(restarted.status().running, true, restarted.status().lastError);
          const connection = restarted.connection();
          assert.ok(connection);
          assert.deepEqual(await (await fetch(new URL("/test/database", connection.url))).json(), { database: legacy },
            "deleting the last v2 chat must not resurrect the original v1 store on restart");
        } finally { await restarted.stop(); }
      } else {
        delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
        await writeFile(join(root, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false }));
        const enableOnly = createEngineV2Preview({ config: { ...config, engineAutoUpgrade: false }, deferStart: true });
        try {
          const status = await enableOnly.setEnabled(true);
          assert.equal(status.chatRouting, true, "enable-only adoption must also select v2 routing");
        } finally { await enableOnly.stop(); }
        await writeFile(binary, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
        await writeFile(join(root, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true,
          engineOrigin: "fresh", engineForced: true }));
        const failed = createEngineV2Preview({ config, waits: { engineRestartMs: 60_000 } });
        try {
          const deadline = Date.now() + 15_000;
          while (!failed.status().lastError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.ok(failed.status().lastError);
          assert.ok(failed.status().v1UnavailableReason);
          assert.equal(failed.status().chatRouting, true, "a failure after adoption never falls back to blocked v1 writes");
          assert.equal(failed.status().enabled, true);
        } finally { await failed.stop(); }
      }
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
}
