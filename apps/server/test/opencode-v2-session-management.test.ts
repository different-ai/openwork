import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { groupHost } from "./fixtures/native-codemode-groups.js";

const commandIds = ["session.archive", "session.pin", "session.rename", "session.set_model"];
const requestSchema = z.object({
  kind: z.enum(["context", "command"]),
  input: z.object({ id: z.string(), args: z.record(z.string(), z.unknown()).optional(), origin: z.object({ sessionId: z.string() }) }).optional(),
});
const contextSchema = z.object({ context: z.object({ availableAffordances: z.array(z.object({ id: z.string() })) }) });

async function fixture(receipt: unknown = { ok: true, result: { ok: true } }) {
  const host = groupHost();
  const commands: unknown[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    if (path !== "/experimental/ui-control/request") return host.request(path, init);
    const request = requestSchema.parse(JSON.parse(String(init?.body)));
    if (request.kind === "context") return { ok: true, context: { revision: 9, availableAffordances: [
      ...commandIds.map(id => ({ id, kind: "command", executor: { kind: "openwork" } })),
      { id: "session.delete", kind: "command", executor: { kind: "openwork" } },
      { id: "composer.send", kind: "command", executor: { kind: "openwork" } },
    ] } };
    commands.push(request.input);
    return receipt;
  });
  return {
    bridge, commands,
    async call(name: string, input: unknown) {
      return fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, input, sessionId: "ses_caller" }) });
    },
  };
}

test("V2 advertises exactly the restored renderer session commands, not unrelated writes", async () => {
  const f = await fixture();
  try {
    const response = await f.call("openwork_context", {});
    assert.equal(response.status, 200);
    const context = contextSchema.parse(await response.json());
    const advertised = context.context.availableAffordances.map(action => action.id);
    for (const id of commandIds) assert.ok(advertised.includes(id), `${id} is discoverable`);
    assert.ok(!advertised.includes("session.delete"));
    assert.ok(!advertised.includes("composer.send"));
    assert.deepEqual(f.commands, []);
  } finally { await f.bridge.close(); }
});

for (const [id, args] of [
  ["session.archive", { sessionId: "ses_target", archived: true }],
  ["session.archive", { sessionId: "ses_target", archived: false }],
  ["session.pin", { sessionId: "ses_target" }],
  ["session.rename", { sessionId: "ses_target", title: "Revised task" }],
  ["session.set_model", { sessionId: "ses_target", workspaceId: "ws1", providerId: "provider", modelId: "model", variant: null }],
] satisfies Array<[string, Record<string, unknown>]>) {
  test(`V2 forwards ${id} ${JSON.stringify(args)} with the trusted requester and preserves the receipt`, async () => {
    const receipt = { ok: true, id, result: { ok: true, sessionId: "ses_target" }, revision: 9 };
    const f = await fixture(receipt);
    try {
      const response = await f.call("openwork_execute", { id, args, origin: { sessionId: "ses_forged" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), receipt);
      assert.deepEqual(f.commands, [{ id, args, origin: { sessionId: "ses_caller" } }]);
    } finally { await f.bridge.close(); }
  });
}

for (const code of ["target_working", "self_archive_while_working", "verification_failed"]) {
  test(`V2 preserves the renderer's ${code} refusal rather than claiming success`, async () => {
    const receipt = { ok: false, id: "session.archive", code, error: "The target cannot be archived.", hint: "Leave it running." };
    const f = await fixture(receipt);
    try {
      const response = await f.call("openwork_execute", { id: "session.archive", args: { sessionId: "ses_target", archived: true } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), receipt);
    } finally { await f.bridge.close(); }
  });
}

test("V2 still refuses unrelated writes, query-channel writes and browser credentials", async () => {
  const f = await fixture();
  try {
    for (const id of ["session.delete", "composer.send", "extension.call", "session.open", "workspace.reload_sessions"]) {
      assert.equal((await f.call("openwork_execute", { id })).status, 400);
    }
    const queried = await f.call("openwork_query", { id: "session.pin", args: { sessionId: "ses_target" } });
    assert.equal(queried.status, 200);
    assert.equal(z.object({ ok: z.boolean() }).parse(await queried.json()).ok, false);
    const browser = await fetch(f.bridge.url, { method: "POST", headers: { authorization: `Bearer ${f.bridge.browser.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "openwork_execute", input: { id: "session.pin", args: { sessionId: "ses_target" } } }) });
    assert.equal(browser.status, 401);
    assert.deepEqual(f.commands, []);
  } finally { await f.bridge.close(); }
});
