import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { groupHost, listedAssignments } from "./fixtures/native-codemode-groups.js";

type NativeTool = {
  name: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, call: { signal: AbortSignal; sessionID: string; agent: string; messageID: string; id: string }): Promise<unknown>;
};
const resultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const envelopeSchema = z.object({ ok: z.boolean(), result: z.unknown().optional() }).passthrough();
const contextSchema = z.object({ context: z.object({ availableAffordances: z.array(z.object({ id: z.string() })) }) });

async function register(options: Parameters<typeof nativeContext.setup>[0]["options"]) {
  const tools = new Map<string, NativeTool>();
  const stop = await nativeContext.setup({ options,
    tool: { async transform(callback) {
      callback({ add: tool => tools.set(tool.name, tool) });
      return { async dispose() { tools.clear(); } };
    } },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  });
  return { tools, stop };
}

async function invoke(tool: NativeTool | undefined, input: unknown) {
  assert.ok(tool);
  const result = await tool.execute(input, { signal: new AbortController().signal, sessionID: "ses_caller", agent: "build", messageID: "msg_test", id: "call_test" });
  const text = resultSchema.parse(result).content[0]?.text;
  assert.ok(text);
  return JSON.parse(text);
}

async function post(endpoint: { url: string; token: string }, body: unknown) {
  return fetch(endpoint.url, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("native affordances are available directly and through Code Mode", async () => {
  const state = groupHost();
  const bridge = await createV2ContextBridge(state.request);
  const native = await register(bridge);
  try {
    for (const name of ["openwork_context", "openwork_query", "openwork_execute"]) assert.equal(native.tools.get(name)?.options.codemode, true);
    const context = contextSchema.parse(await invoke(native.tools.get("openwork_context"), {}));
    assert.ok(context.context.availableAffordances.some(entry => entry.id === "session.group.move"));
    const moved = envelopeSchema.parse(await invoke(native.tools.get("openwork_execute"), { id: "session.group.move", args: { workspaceId: "ws1", sessionId: "move-a", groupId: "done" } }));
    assert.equal(moved.ok, true, "direct commands remain available");
    assert.equal(state.writes.length, 1);
  } finally { await native.stop(); await bridge.close(); }
});

test("Code Mode queries and commands preserve exceptions, host validation, confirmation and receipts", async () => {
  const state = groupHost();
  const bridge = await createV2ContextBridge(state.request);
  const native = await register(bridge);
  try {
    for (const name of ["openwork_context", "openwork_query", "openwork_execute"]) assert.equal(native.tools.get(name)?.options.codemode, true);
    for (const tool of native.tools.values()) if (tool.name.startsWith("browser_") || tool.name.startsWith("computer_") || tool.name.startsWith("drive_") || tool.name === "openwork_drive_upload" || tool.name === "openwork_gmail_draft" || tool.name === "openwork_outlook_draft") assert.equal(tool.options.codemode, false);
    const query = native.tools.get("openwork_query");
    const execute = native.tools.get("openwork_execute");
    const before = listedAssignments(await invoke(query, { id: "session.group.list", args: { workspaceId: "ws1" } }));
    for (const [sessionId, groupId] of Object.entries(before)) {
      if (sessionId === "keep" || groupId !== "working") continue;
      const moved = envelopeSchema.parse(await invoke(execute, { id: "session.group.move", args: { workspaceId: "ws1", sessionId, groupId: "done" } }));
      assert.equal(moved.ok, true);
    }
    const after = listedAssignments(await invoke(query, { id: "session.group.list", args: { workspaceId: "ws1" } }));
    assert.deepEqual(after, { keep: "working", "move-a": "done", "move-b": "done" });
    const unknown = envelopeSchema.parse(await invoke(execute, { id: "session.group.move", args: { workspaceId: "ws1", sessionId: "keep", groupId: "unknown" } }));
    assert.equal(unknown.ok, false);
    const unconfirmed = envelopeSchema.parse(await invoke(execute, { id: "session.group.remove", args: { workspaceId: "ws1", groupId: "done" } }));
    assert.equal(unconfirmed.ok, false);
    assert.equal(state.writes.length, 2);
  } finally { await native.stop(); await bridge.close(); }
});

test("browser credentials cannot run groups; host validation still guards Code Mode writes", async () => {
  const state = groupHost();
  const bridge = await createV2ContextBridge(state.request);
  const native = await register(bridge);
  try {
    const input = { id: "session.group.move", args: { workspaceId: "ws1", sessionId: "move-a", groupId: "done" } };
    const command = { name: "openwork_execute", sessionId: "ses_caller", input };
    assert.equal((await post({ ...bridge, token: bridge.browser.token }, command)).status, 401);
    assert.equal((await post(bridge, { ...command, input: { id: "extension.call" } })).status, 400);
    const moved = envelopeSchema.parse(await invoke(native.tools.get("openwork_execute"), input));
    assert.equal(moved.ok, true);
    assert.equal(state.writes.length, 1);
  } finally { await native.stop(); await bridge.close(); }
});
