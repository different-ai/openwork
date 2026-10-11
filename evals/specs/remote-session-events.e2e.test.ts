import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  remoteSessionEvents, object, records, string, WORKSPACE_ID, SUBSCRIPTION_ID_META_KEY,
  type GatewayListener,
} from "../worlds/remote-session-events.ts";

const test = spec.world(remoteSessionEvents, {
  timeout: 600_000,
  needs: { commands: ["pnpm", "node", "bun"] },
  resources: { surfaces: [], services: ["den"] },
});

// Real HTTP, authentication, database and SDK notifications; synthetic runner, not native execution.
test("an owner watches a private registered-runner receipt and recovers offline progress without replay", async ({ world, step, evidence }) => {
  let computerId = "";
  let commandId = "";
  let uri = "";
  const sessionId = "synthetic_events_native_session";
  const finalText = "Synthetic wire runner finished while the MCP client was offline.";
  const create = () => world.remote("owner", "create", {
    target: "registered", computerId, workspaceId: WORKSPACE_ID,
    idempotencyKey: "synthetic-events-stable-admission", title: "Private receipt proof",
    prompt: "Synthetic private prompt; no model or native engine is started.",
  });

  await step("before: an owner's agent has no receipt URI or subscription capability by default", async () => {
    expect(await world.eventsFeature()).toMatchObject({ default: false, enabled: false });
    const discovery = await world.rpc("owner", "server/discover");
    expect(discovery.status).toBe(200);
    expect(object(object(object(discovery.body.result).capabilities).resources).subscribe).not.toBe(true);
    const refused = await world.remote("owner", "create", { target: "registered" });
    expect(refused.isError).toBe(true);
    expect(refused.body.statusResourceUri).toBeUndefined();
    expect(refused.body.commandId).toBeUndefined();
    evidence.recordAssertionEvidence("Receipt events start off", `Default=false, enabled=false; MCP discovery HTTP ${discovery.status} has no resource subscribe; offload=${refused.body.error}, no command or status URI`, true);
  });

  await step("when the owner registers a wire runner, the administrator can separately enable its receipt events", async () => {
    expect((await world.rollout(true)).status).toBe(200);
    expect((await world.register("owner")).status).toBe(200);
    expect((await world.inventory("owner")).status).toBe(200);
    const targets = await world.remote("owner", "targets", {});
    expect(targets.isError).toBe(false);
    const computers = records(targets.body.computers);
    expect(computers).toHaveLength(1);
    expect(computers[0]).toMatchObject({ kind: "registered", online: true });
    computerId = string(computers[0].computerId);
    const before = await create();
    expect(before).toMatchObject({ isError: false, body: { target: "registered", state: "queued" } });
    expect(before.body.statusResourceUri).toBeUndefined();
    commandId = string(before.body.commandId);
    uri = `openwork://remote-sessions/commands/${commandId}`;
    const disabled = await world.listen("owner", uri);
    try { expect(disabled.status).toBe(400); expect((await disabled.next())?.error).toBeDefined(); }
    finally { await disabled.close(); }
    expect((await world.eventsRollout(true)).status).toBe(200);
    evidence.recordAssertionEvidence("Registration and receipt rollout are independent", `Target registration/inventory HTTP 200; 1 online registered computer; events-off create queued ${commandId} without URI, exact-URI listen HTTP 400; platform admin enabled events HTTP 200`, true);
  });

  await step("after: retrying the owner's task adds a stable status URI without enqueueing another command", async () => {
    const retried = await create();
    expect(retried).toMatchObject({ isError: false, body: { commandId, computerId, target: "registered", statusResourceUri: uri } });
    const work = await world.work("owner");
    expect(work).toMatchObject({ status: 200, body: { items: [{ kind: "remote_session_create", commandId }] } });
    expect(records(object(work.body).items)).toHaveLength(1);
    evidence.recordAssertionEvidence("Events do not dispatch work", `Same idempotency key returns the original ${commandId} and exact ${uri}; real runner work HTTP 200 contains exactly 1 native-create assignment`, true);
  });

  const listener = await step("then the owner receives acknowledgment first and immediately reads the pending receipt", async () => {
    const opened = await world.listen("owner", uri);
    expect(opened.status).toBe(200);
    acknowledged(await opened.next(), opened.id, uri);
    const pending = receipt((await world.rpc("owner", "resources/read", { uri })).body, uri);
    expect(pending).toMatchObject({ commandId, state: "pending", sessionId: null });
    expect(JSON.stringify(pending)).not.toContain("Synthetic private prompt");
    evidence.recordAssertionEvidence("The actual SDK honors only the requested receipt", `First SSE frame acknowledged subscription ${opened.id} with exactly 1 URI; immediate resources/read: pending, sessionId=null, cacheScope=private, ttlMs=0; no prompt in receipt`, true);
    return opened;
  });

  await step("after: the runner's authenticated completion invalidates only that receipt and reveals its canonical session", async () => {
    expect((await world.claim("owner", commandId)).status).toBe(200);
    const complete = await world.complete("owner", commandId, {
      status: "delivered", sessionId, workspaceId: WORKSPACE_ID, resultSummary: "Synthetic runner receipt",
    });
    expect(complete).toMatchObject({ status: 200, body: { command: { id: commandId, status: "delivered", sessionId } } });
    const updated = object(await listener.next());
    expect(updated.method).toBe("notifications/resources/updated");
    expect(updated.params).toEqual({ uri, _meta: { [SUBSCRIPTION_ID_META_KEY]: listener.id } });
    expect(receipt((await world.rpc("owner", "resources/read", { uri })).body, uri)).toMatchObject({ commandId, state: "delivered", sessionId });
    evidence.recordAssertionEvidence("Notifications are URI-only invalidation, not receipts", `Runner claim/completion HTTP 200; update contains only the exact URI and subscription ${listener.id}; reread delivered with canonical runner-reported ${sessionId}`, true);
  });

  const reconnected = await step("when the owner's client disconnects, reconnecting reads the latest offline final answer", async () => {
    await listener.close();
    expect((await world.report("owner", commandId, { status: "running", engine: "v2", messageCount: 1, observedAt: Date.now() })).status).toBe(200);
    expect((await world.report("owner", commandId, { status: "idle", engine: "v2", finalText, messageCount: 2, observedAt: Date.now() + 1 })).status).toBe(200);
    const opened = await world.listen("owner", uri);
    expect(opened.status).toBe(200);
    acknowledged(await opened.next(), opened.id, uri);
    expect(receipt((await world.rpc("owner", "resources/read", { uri })).body, uri)).toMatchObject({ state: "delivered", sessionId, session: { status: "idle", engine: "v2", finalText, messageCount: 2 } });
    evidence.recordAssertionEvidence("Reconnect reads current durable state without needing replay", `First listener canceled; offline running and idle callbacks HTTP 200; new subscription ${opened.id} acknowledged first; immediate private uncached read has idle, 2 messages and the offline final text`, true);
    return opened;
  });

  await step("then another member and another organization cannot read or acknowledge a watch on the owner's URI", async () => {
    const denied: string[] = [];
    for (const persona of ["otherMember", "otherOrg"]) {
      const read = await world.rpc(persona, "resources/read", { uri });
      expect(read.body.error).toBeDefined();
      expect(read.body.result).toBeUndefined();
      const foreign = await world.listen(persona, uri);
      try {
        const first = object(await foreign.next());
        expect(first.error).toBeDefined();
        expect(first.method).not.toBe("notifications/subscriptions/acknowledged");
        denied.push(`${persona}: read HTTP ${read.status} RPC error, watch HTTP ${foreign.status} no ack`);
      } finally { await foreign.close(); }
    }
    evidence.recordAssertionEvidence("Both member and organization boundaries protect the receipt", denied.join("; "), true);
  });

  await step("after: killing events closes the watch but leaves the owner's durable command and polling intact", async () => {
    const before = await world.remote("owner", "read", { commandId });
    expect((await world.eventsRollout(true, true)).status).toBe(200);
    const ending = await stopped(reconnected);
    const denied = await world.listen("owner", uri);
    try { expect(denied.status).toBe(400); expect((await denied.next())?.error).toBeDefined(); }
    finally { await denied.close(); }
    const after = await world.remote("owner", "read", { commandId });
    expect(after.isError).toBe(false);
    const { statusResourceUri: ignored, ...beforePolling } = before.body;
    void ignored;
    expect(after.body).toEqual(beforePolling);
    expect(after.body).toMatchObject({ commandId, state: "delivered", sessionId, session: { status: "idle", finalText } });
    expect((await world.work("owner")).body).toMatchObject({ items: [] });
    evidence.recordAssertionEvidence("The kill switch removes watching, not admitted work", `Events kill HTTP 200; active watch ${ending} within 30s; new listen HTTP 400; durable MCP polling returns the unchanged delivered command/session/final text; runner has 0 extra commands`, true);
  });
});

function acknowledged(frame: unknown, id: number, uri: string) {
  expect(frame).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
  expect(object(frame).params).toEqual({ notifications: { resourceSubscriptions: [uri] }, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } });
}
function receipt(envelope: Record<string, unknown>, uri: string) {
  expect(envelope.error).toBeUndefined();
  const result = object(envelope.result);
  expect(result).toMatchObject({ resultType: "complete", cacheScope: "private", ttlMs: 0 });
  const contents = records(result.contents);
  expect(contents).toHaveLength(1);
  expect(contents[0]).toMatchObject({ uri, mimeType: "application/json" });
  return object(JSON.parse(string(contents[0].text)));
}
async function stopped(listener: GatewayListener) {
  try {
    const frame = await listener.next(30_000);
    if (frame) {
      expect(frame.id).toBe(listener.id);
      expect(frame.result).toMatchObject({ resultType: "complete", _meta: { [SUBSCRIPTION_ID_META_KEY]: listener.id } });
      expect(await listener.next()).toBeNull();
    }
    return frame ? "returned SDK complete then EOF" : "ended at EOF";
  } catch (error) {
    // Den's failed-closed HTTP stream can terminate instead of sending the SDK's graceful result.
    // Never count our own bounded wait/abort, invalid JSON or an assertion failure as closure.
    if (!(error instanceof TypeError) || error.message !== "terminated") throw error;
    return "terminated at the HTTP boundary";
  } finally { await listener.close(); }
}
