import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerConfig } from "../src/types.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Run alone: isolates HOME/XDG before importing the host. The session is
// imported through the real engine API, so the engine itself validates every
// fixture row against its own message schema, then session.read reads it back.
test("session.read detail full returns what the real v2 engine stores", { timeout: 90_000 }, async (t) => {
  try { await access(binary); } catch {
    t.skip("needs: pinned OpenCode v2 binary; set OPENWORK_TEST_OPENCODE2");
    return;
  }
  const pinned: unknown = JSON.parse(await readFile(new URL("../../../constants.json", import.meta.url), "utf8"));
  assert.ok(record(pinned) && typeof pinned.opencodeV2Version === "string");
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout, new RegExp(`\\bv${pinned.opencodeV2Version.replaceAll(".", "\\.")}\\b`));
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-read-detail-")));
  const overrides = {
    HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENWORK_OPENCODE2_BIN: binary,
    OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_ENGINE_V2_CHAT: "1", OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
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
    host: "127.0.0.1", port: 0, token: "detail-test-client", hostToken: "detail-test-host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "ws_detail", name: "Detail fixture", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated",
    logFormat: "json", logRequests: false,
  };
  const server = await startServer(config);
  cleanup.push(() => server.stop());
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const bridge = await createV2ContextBridge(request);
  cleanup.push(() => bridge.close());
  const call = async (args: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(bridge.url, { method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "openwork_query", input: { id: "session.read", args: { workspaceId: "ws_detail", sessionId: "ses_detail", ...args } } }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const query = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const body = await call(args);
    assert.ok(record(body) && record(body.result), JSON.stringify(body));
    return body.result;
  };
  const deadline = Date.now() + 60_000;
  while (true) {
    const status = await request("/experimental/engine-v2-preview/status");
    if (record(status) && status.running === true) break;
    if (Date.now() >= deadline) throw new Error("Owned native engine did not start");
    await delay(2000);
  }
  const native = "/workspace/ws_detail/opencode2/api";
  const created = await request(`${native}/session`, { method: "POST", body: JSON.stringify({ location: { directory } }) });
  assert.ok(record(created) && record(created.data));
  const model = { id: "claude-opus", providerID: "anthropic" };
  const long = "L".repeat(9_000);
  await request(`${native}/experimental/session/import`, { method: "POST", body: JSON.stringify({
    info: { ...created.data, id: "ses_detail" }, location: { directory },
    messages: [
      { id: "msg_detail_01", type: "user", time: { created: 1_000 }, text: "Run the tests and fix what fails." },
      { id: "msg_detail_02", type: "assistant", time: { created: 1_001, completed: 1_009 }, agent: "build", model,
        finish: "tool-calls", cost: 0.02, tokens: { input: 120, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
        content: [
          { type: "reasoning", text: "Start with the test suite.", time: { created: 1_002, completed: 1_003 } },
          { type: "text", text: "Running the tests." },
          { type: "tool", id: "call_shell", name: "shell", time: { created: 1_003, ran: 1_004, completed: 1_005 },
            state: { status: "completed", input: { command: "pnpm test" }, metadata: { exit: 1 }, content: [{ type: "text", text: "1 failed" }] } },
          { type: "tool", id: "call_read", name: "read", time: { created: 1_005, ran: 1_006, completed: 1_007 },
            state: { status: "error", input: { path: "missing.ts" }, error: { type: "ToolError", message: "ENOENT: missing.ts" } } },
          { type: "tool", id: "call_big", name: "read", time: { created: 1_007, ran: 1_007, completed: 1_008 },
            state: { status: "completed", input: { path: "big.txt" }, content: [{ type: "text", text: long }] } },
        ] },
      { id: "msg_detail_03", type: "assistant", time: { created: 1_010, completed: 1_011 }, agent: "build", model, finish: "stop",
        content: [{ type: "text", text: "Fixed: the test now passes." }] },
      { id: "msg_detail_04", type: "idle", time: { created: 1_012 }, outcome: "succeeded" },
    ],
  }) });

  const text = await query({});
  assert.deepEqual((Array.isArray(text.messages) ? text.messages : []).filter(record).map((message) => message.text),
    ["Run the tests and fix what fails.", "Running the tests.", "Fixed: the test now passes."], "default read is unchanged");

  const full = await query({ detail: "full" });
  assert.equal(full.detail, "full");
  assert.equal(full.engine, "v2");
  const messages = (Array.isArray(full.messages) ? full.messages : []).filter(record);
  assert.deepEqual(messages.map((message) => [message.id, message.type]), [
    ["msg_detail_01", "user"], ["msg_detail_02", "assistant"], ["msg_detail_03", "assistant"], ["msg_detail_04", "idle"]]);
  const turn = messages[1];
  assert.ok(turn);
  assert.deepEqual([turn.agent, turn.model, turn.finish, turn.cost, turn.truncated],
    ["build", { providerId: "anthropic", modelId: "claude-opus" }, "tool-calls", 0.02, true]);
  assert.deepEqual(turn.tokens, { input: 120, output: 40, reasoning: 10, cache: { read: 0, write: 0 } });
  const content = (Array.isArray(turn.content) ? turn.content : []).filter(record);
  assert.deepEqual(content.slice(0, 4), [
    { type: "reasoning", text: "Start with the test suite.", time: { created: 1_002, completed: 1_003 } },
    { type: "text", text: "Running the tests." },
    { type: "tool", id: "call_shell", name: "shell", status: "completed", input: { command: "pnpm test" }, output: "1 failed",
      metadata: { exit: 1 }, time: { created: 1_003, ran: 1_004, completed: 1_005 } },
    { type: "tool", id: "call_read", name: "read", status: "error", input: { path: "missing.ts" },
      error: { type: "ToolError", message: "ENOENT: missing.ts" }, time: { created: 1_005, ran: 1_006, completed: 1_007 } },
  ]);
  assert.match(String(content[4]?.output), /^L{4000}…\[\+5000 chars; read this message by messageId for more\]$/);
  assert.deepEqual(messages[3], { id: "msg_detail_04", type: "idle", time: { created: 1_012 }, outcome: "succeeded" });

  const newest = await query({ detail: "full", count: 2 });
  assert.deepEqual((Array.isArray(newest.messages) ? newest.messages : []).filter(record).map((message) => message.id), ["msg_detail_03", "msg_detail_04"]);
  const oldest = await query({ detail: "full", count: 1, from: "start" });
  assert.deepEqual((Array.isArray(oldest.messages) ? oldest.messages : []).filter(record).map((message) => message.id), ["msg_detail_01"]);

  const one = await query({ messageId: "msg_detail_02" });
  assert.ok(record(one.message));
  const oneContent = (Array.isArray(one.message.content) ? one.message.content : []).filter(record);
  assert.equal(oneContent[4]?.output, long, "a messageId read returns the whole tool output");
  assert.equal(one.message.truncated, undefined);
  const missing = await call({ messageId: "msg_nope" });
  assert.ok(record(missing));
  assert.deepEqual([missing.ok, missing.error], [false, "Message msg_nope was not found in session ses_detail"]);

  await bridge.close();
  await server.stop();
  // Stop flushes the engine's buffered file logger; absence before flush is not evidence.
  const log = await readFile(join(root, "data", "opencode", "log", "opencode.log"), "utf8");
  assert.ok(!log.includes("schema rejection"), "the real engine accepted every fixture row");
});
