import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createV2ReadAdapter } from "../src/opencode-v2-read-adapter.js";
import type { ServerConfig } from "../src/types.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Run alone: isolate HOME/XDG before importing the host, just like the managed
// native worker tests. All messages are imported through the actual engine API.
test("semantic search pages real v2 histories of 150, 200, 201, 400 and 450 messages", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch {
    t.skip("needs: pinned OpenCode 2.0.26 binary; set OPENWORK_TEST_OPENCODE2");
    return;
  }
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout, /\bv2\.0\.26\b/);
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-message-paging-")));
  const overrides = {
    HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENWORK_OPENCODE2_BIN: binary,
    OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_ENGINE_V2_CHAT: "1", OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const cleanup: Array<() => unknown> = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, "project");
  await mkdir(directory);
  const { startServer } = await import("../src/server.js");
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "paging-test-client", hostToken: "paging-test-host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "ws_paging", name: "Paging fixture", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated",
    logFormat: "json", logRequests: false,
  };
  const server = await startServer(config);
  cleanup.push(() => server.stop());
  const requests: Array<{ path: string; status: number; ids: unknown[] }> = [];
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    requests.push({ path, status: response.status,
      ids: record(body) && Array.isArray(body.data) ? body.data.filter(record).map(row => row.id) : [] });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const bridge = await createV2ContextBridge(request);
  cleanup.push(() => bridge.close());
  const query = async (id: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(bridge.url, { method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "openwork_query", input: { id, args } }), signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const deadline = Date.now() + 60_000;
  while (true) {
    const status = await request("/experimental/engine-v2-preview/status");
    if (record(status) && status.running === true) break;
    if (Date.now() >= deadline) throw new Error("Owned native engine did not start");
    await delay(2000);
  }
  const native = "/workspace/ws_paging/opencode2/api";
  const created = await request(`${native}/session`, { method: "POST", body: JSON.stringify({ location: { directory } }) });
  assert.ok(record(created) && record(created.data));
  const sizes = [150, 200, 201, 400, 450];
  const messageId = (size: number, index: number) => `msg_paging_${size}_${String(index).padStart(4, "0")}`;
  for (const size of sizes) {
    await request(`${native}/experimental/session/import`, { method: "POST", body: JSON.stringify({
      info: { ...created.data, id: `ses_paging_${size}` }, location: { directory },
      messages: Array.from({ length: size }, (_, index) => ({
        id: messageId(size, index), type: "user", time: { created: 100_000 + index }, text: `paging-needle-${size}-${index}.`,
      })),
    }) });
  }
  const adapter = createV2ReadAdapter(request);
  for (const size of sizes) {
    const count = Math.min(size, 400);
    const offset = size - count;
    const before = requests.length;
    const searched = await query("session.search", { workspaceId: "ws_paging", query: `paging-needle-${size}-${offset}.`, match: "phrase" });
    assert.ok(record(searched) && record(searched.result) && Array.isArray(searched.result.results));
    assert.equal(searched.result.messageLimit, 400);
    assert.equal(searched.result.results.length, 1, "finds the oldest message in the requested window, not only the first native page");
    assert.ok(record(searched.result.results[0]));
    assert.equal(searched.result.results[0].sessionId, `ses_paging_${size}`);
    const pages = requests.slice(before).filter(item => item.path.includes(`/ses_paging_${size}/message?`));
    const ids = pages.flatMap(page => page.ids);
    assert.deepEqual(ids, Array.from({ length: count }, (_, index) => messageId(size, size - index - 1)));
    assert.ok(pages.every(page => page.status === 200 && Number(new URL(page.path, "http://engine").searchParams.get("limit")) <= 200));
    const rows = await adapter(`/workspace/ws_paging/opencode/session/ses_paging_${size}/message?limit=400`);
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows.map(row => record(row) && record(row.info) ? row.info.id : null), [...ids].reverse());
    const read = await query("session.read", { workspaceId: "ws_paging", sessionId: `ses_paging_${size}`, from: "end", count: 100 });
    assert.ok(record(read) && record(read.result) && Array.isArray(read.result.messages));
    assert.equal(read.result.returned, 100);
    assert.deepEqual(read.result.messages.filter(record).map(row => row.id),
      Array.from({ length: 100 }, (_, index) => messageId(size, size - 100 + index)));
    console.log(`GREEN history=${size}: default search loaded ${count}, native pages=${pages.map(page => page.ids.length).join("+")}, chronological newest-${count}, end-read=100`);
  }
  const excluded = await query("session.search", { workspaceId: "ws_paging", query: "paging-needle-450-49.", match: "phrase" });
  assert.ok(record(excluded) && record(excluded.result) && Array.isArray(excluded.result.results));
  assert.equal(excluded.result.results.length, 0, "does not search older than the requested newest 400");
  assert.equal(requests.filter(item => item.path.includes("/opencode2/") && item.status >= 400).length, 0);
  await bridge.close();
  await server.stop();
  // Stop flushes the engine's buffered file logger; absence before flush is not evidence.
  const log = await readFile(join(root, "data", "opencode", "log", "opencode.log"), "utf8");
  assert.ok(!log.includes("schema rejection"), "real engine emitted no schema rejection");
  console.log("GREEN native HTTP errors=0; engine schema rejections=0 (flushed log)");
});
