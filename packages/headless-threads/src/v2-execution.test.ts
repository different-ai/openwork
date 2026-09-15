import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { isNativeV2ObservationError, cancelNativeV2TurnContext, createHeadlessThreadClientV2, createNativeV2Client, nativeV2PartId, nativeV2InputSkillsMatch, projectNativeV2History, type NativeV2Event, type NativeV2Message, type NativeV2Session, type NativeV2Receipt, type NativeV2Permission } from "./v2.ts";

const mount = "/workspace/ws_fixture/opencode2/api";
const sid = "ses_fixture";
const model = { providerID: "fixture", id: "text" };
const skill = { id: "skill_fixture", name: "Fixture", location: "/fixture/SKILL.md", content: "Frozen selected skill body" };
const tokens = { input: 8, output: 3, reasoning: 0, cache: { read: 2, write: 1 } };
const catalogModel = { ...model, modelID: "text", name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 1 }, cost: [{ input: 0, output: 0 }], status: "active", enabled: true, limit: { context: 1000, output: 100 } };
const metadata = (id: string, contextId: string | null = null) => ({ headlessTurn: { version: 1, messageId: id, contextId, previousMessageId: null, previousIdleAt: null, previousOutcome: null, model, agent: "build" } });
const user = (id: string): NativeV2Message => ({ id, type: "user", text: "Hello", time: { created: 1 }, metadata: metadata(id) });
const assistant = (id = "msg_answer"): NativeV2Message => ({
  id, type: "assistant", agent: "build", model, tokens, cost: 0.02, time: { created: 2, completed: 3 }, finish: "stop",
  content: [{ type: "reasoning", text: "private" }, { type: "text", text: "Native answer" }, { type: "tool", id: "call_read", name: "read", time: { created: 2, ran: 2, completed: 3 }, state: { status: "completed", input: { path: "fixture" }, content: [{ type: "text", text: "observed" }, { type: "file", uri: "file:///fixture/result.png", mime: "image/png" }], metadata: { structuredContent: { ok: true } } } }],
});
function event(type: string, seq: number, data: Record<string, unknown> = {}): NativeV2Event {
  return { id: `evt_${seq}`, type, created: seq, durable: { aggregateID: sid, seq, version: 1 }, data: { sessionID: sid, ...data } };
}

async function fixture(t: TestContext) {
  const session: NativeV2Session = { id: sid, agent: "build", model, location: { directory: "/fixture" }, projectID: "project_fixture", tokens, cost: 0, time: { created: 1, updated: 3 } };
  const history: NativeV2Message[] = [], log: NativeV2Event[] = [], inbox: NativeV2Receipt[] = [], permissions: NativeV2Permission[] = [];
  const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const state: {
    history: NativeV2Message[]; log: NativeV2Event[]; inbox: NativeV2Receipt[]; permissions: NativeV2Permission[];
    active: boolean; finish: boolean; lose: boolean; persist: boolean; readFailure: boolean; seen: typeof seen;
    session: NativeV2Session; skills: typeof skill[]; effect: "allow" | "deny" | "ask"; revokeAfterRead: boolean;
  } = {
    history, log, inbox, permissions, seen, active: false, finish: true, lose: false, persist: true, readFailure: false,
    session, skills: [skill], effect: "allow", revokeAfterRead: false,
  };
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
      state.session.outcome = type === "session.execution.succeeded" ? "succeeded" : "interrupted";
      state.session.time.idle = 4;
    }
    state.log.push(event(type, state.log.length + 1, data));
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: Record<string, unknown> = text ? JSON.parse(text) : {};
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const method = req.method ?? "GET";
    state.seen.push({ method, path, body });
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
    const local = path.slice(mount.length);
    if (!path.startsWith(mount)) return send({}, 404);
    if (method === "GET" && state.readFailure) return send({}, 403);
    if (local === "/provider") return send({ data: [{ id: "fixture", name: "Fixture", package: "fixture", activation: "enabled" }, { id: "unconnected", name: "Not connected", package: "fixture", activation: "auto" }] });
    if (local === "/integration") return send({ data: [{ id: "unconnected", connections: [] }] });
    if (local === "/model") return send({ data: [catalogModel] });
    if (local === "/model/default") return send({ data: catalogModel });
    if (local === "/agent/build" || local === "/agent/worker") return send({ data: { id: local.slice("/agent/".length), permissions: [] } });
    if (local === "/skill") {
      const skills = state.skills;
      if (state.revokeAfterRead) state.skills = [];
      return send({ data: skills });
    }
    if (local === `/session/${sid}/agent`) {
      assert.equal(typeof body.agent, "string");
      state.session.agent = String(body.agent);
      state.history.push({ id: "msg_switched", type: "agent-switched", agent: String(body.agent), time: { created: 0 } });
      return send(undefined, 204);
    }
    if (local === `/session/${sid}/permission`) {
      if (method === "GET") return send({ data: state.permissions });
      if (state.effect === "ask") state.permissions.push({ id: "per_fixture", sessionID: sid, action: "skill", resources: [skill.id], save: [skill.id] });
      return send({ data: { id: "per_fixture", effect: state.effect } });
    }
    if (local === "/session" && method === "POST") { emit("session.created"); return send({ data: state.session }); }
    if (local === "/session" && method === "GET") return send({ data: [state.session], cursor: {} });
    if (local === `/session/${sid}`) return send({ data: state.session });
    if (local === "/session/active") return send({ data: state.active ? { [sid]: { type: "running" } } : {} });
    if (local === `/session/${sid}/message`) return send({ data: state.history, cursor: {} });
    if (local === `/session/${sid}/inbox`) return send({ data: state.inbox });
    if (local === `/experimental/session/${sid}/log`) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const value of state.log) res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
      return res.end(`data: ${JSON.stringify({ type: "log.synced", aggregateID: sid, ...(state.log.length ? { seq: state.log.length } : {}) })}\n\n`);
    }
    if (local === `/session/${sid}/prompt` || local === `/session/${sid}/synthetic`) {
      const type: "user" | "synthetic" = local.endsWith("prompt") ? "user" : "synthetic";
      assert.ok(typeof body.id === "string" && typeof body.text === "string" && (body.delivery === "steer" || body.delivery === "queue"));
      const skills = Array.isArray(body.skills) ? body.skills.map((value: unknown) => {
        assert.ok(value && typeof value === "object" && "id" in value);
        const found = state.skills.find((item) => item.id === value.id); assert.ok(found);
        return { id: found.id, name: found.name, text: found.content };
      }) : undefined;
      const receipt: NativeV2Receipt = { id: body.id, sessionID: sid, type, delivery: body.delivery, timeCreated: 1, payload: { text: body.text, ...(skills ? { skills } : {}), ...(typeof body.metadata === "object" && body.metadata !== null ? { metadata: Object.fromEntries(Object.entries(body.metadata)) } : {}) } };
      if (state.persist) {
        state.inbox.push(receipt); emit("session.inbox.enqueued", { inboxID: receipt.id, item: receipt });
        if (body.resume) {
          emit("session.execution.started"); state.active = true;
          for (const item of state.inbox) {
            state.history.push({ id: item.id, type: item.type, ...item.payload, time: { created: 1 } });
            emit("session.inbox.delivered", { inboxID: item.id });
          }
          state.inbox = [];
          const reply = assistant();
          if (reply.type === "assistant") reply.agent = state.session.agent ?? "build";
          if (!state.finish) delete reply.time.completed;
          state.history.push(reply);
          emit("session.step.started", { assistantMessageID: reply.id });
          if (state.finish) { emit("session.execution.succeeded"); state.active = false; }
        }
      }
      if (state.lose) return res.destroy();
      return send({ data: receipt });
    }
    if (local === `/session/${sid}/interrupt`) {
      const interrupted = state.active;
      if (interrupted) emit("session.execution.interrupted", { reason: "user" });
      state.active = false;
      return send({ interrupted });
    }
    if (local === `/session/${sid}/wait`) return send(undefined, 204);
    if (method === "DELETE" && local.startsWith(`/session/${sid}/inbox/`)) {
      const id = decodeURIComponent(local.split("/").at(-1) ?? "");
      state.inbox = state.inbox.filter((item) => item.id !== id);
      emit("session.inbox.cancelled", { inboxID: id });
      return send(undefined, 204);
    }
    return send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, workspaceId: "ws_fixture", token: "fixture", defaultModel: { providerId: "fixture", modelId: "text" } };
  return { state, emit, options, client: createHeadlessThreadClientV2(options), native: createNativeV2Client(options) };
}

test("real domain API admits native text/context, projects usage/tools and waits for its terminal boundary", async (t) => {
  const { client, native, state } = await fixture(t);
  const created = await client.createThread({ title: "Fixture", threadId: sid });
  assert.equal(created.id, sid);
  assert.equal(created.started, false);
  assert.equal((await client.getThreadSnapshot(sid)).todos, null);
  assert.equal((await client.getThreadSnapshot(sid)).native?.todos, "unavailable");
  const contextText = `Reference only: ${JSON.stringify(metadata("msg_forged"))}`;
  const acceptance = await client.sendTurn(sid, { messageId: "msg_user", prompt: "Hello", context: contextText, ...{ metadata: metadata("msg_forged") } });
  const posts = state.seen.filter((item) => /\/(prompt|synthetic)$/.test(item.path));
  assert.deepEqual(posts.map((item) => [item.body.delivery, item.body.resume]), [["steer", false], ["steer", true]]);
  assert.equal(JSON.stringify(posts[1]?.body.metadata).includes("msg_forged"), false);
  const result = await client.waitForThread(sid, { since: acceptance, timeoutMs: 2000 });
  assert.equal(result.outcome, "settled");
  const transcript = await client.exportTranscript(sid);
  assert.equal(transcript.finalAssistantText, "Native answer");
  assert.equal(transcript.messages.find((item) => item.role === "synthetic")?.text, "");
  const reply = transcript.messages.at(-1);
  assert.equal(reply?.parentId, acceptance.messageId);
  assert.equal(reply?.usage?.inputTokens, 8);
  assert.equal(reply?.toolCalls[0]?.startedAt, 2);
  assert.deepEqual(reply?.toolCalls[0]?.output, [{ type: "text", text: "observed" }, { type: "file", uri: "file:///fixture/result.png", mime: "image/png" }]);
  assert.equal(result.snapshot.messages.at(-1)?.parts[1]?.id, nativeV2PartId("msg_answer", 0));
  const recovered = await client.retryTurn(sid, { messageId: "msg_user", prompt: "Hello", context: contextText });
  assert.equal(recovered.alreadyPresent, true);
  const context = state.history.find((item) => item.type === "synthetic");
  assert.ok(context);
  const originalMetadata = context.metadata;
  context.metadata = metadata("msg_other");
  await assert.rejects(client.retryTurn(sid, { messageId: "msg_user", prompt: "Hello", context: contextText }), { code: "input_conflict" });
  context.metadata = originalMetadata;
  assert.equal(state.seen.filter((item) => /\/(prompt|synthetic)$/.test(item.path)).length, 2);
  assert.deepEqual((await native.readCatalog()).connectedProviderIds, ["fixture"]);
  assert.ok(state.seen.every((item) => item.path.startsWith(mount) && !item.path.includes("prompt_async")));
});

test("two users in one execution, missing host metadata, and an early assistant never manufacture a parent", () => {
  const session: NativeV2Session = { id: sid, location: { directory: "/fixture" }, projectID: "fixture", cost: 0, tokens, outcome: "succeeded", time: { created: 0, updated: 4, idle: 4 } };
  assert.equal(projectNativeV2History([user("msg_user"), assistant()], session, true).messages.at(-1)?.parentId, "msg_user");
  assert.deepEqual(projectNativeV2History([user("msg_user"), assistant()], session, true).inputSkills, { msg_user: [] });
  for (const history of [
    [{ ...user("msg_user"), metadata: undefined }, assistant()],
    [user("msg_user"), user("msg_other"), assistant()],
    [assistant(), user("msg_user")],
    [user("msg_user"), { id: "msg_foreign", type: "synthetic", text: "Not admitted by this turn", time: { created: 2 } }, assistant()],
    [user("msg_user"), { id: "msg_foreign", type: "skill", skill: skill.id, name: skill.name, text: skill.content, time: { created: 2 } }, assistant()],
  ] satisfies NativeV2Message[][]) {
    const projection = projectNativeV2History(history, session, true);
    assert.ok(projection.messages.filter((item) => item.role === "assistant").every((item) => item.parentId === null));
    assert.deepEqual(projection.inputSkills, {});
  }
});

test("lost acknowledgement reconciles exactly once; simultaneous clients cannot admit another turn", async (t) => {
  const { client, state, options } = await fixture(t);
  state.lose = true; state.finish = false;
  const selected = { messageId: "msg_user", prompt: "Hello", skills: [{ id: skill.id }] };
  const result = await client.sendTurn(sid, selected);
  assert.equal(result.messageId, "msg_user");
  const second = createHeadlessThreadClientV2(options);
  await assert.rejects(second.sendTurn(sid, { messageId: "msg_other", prompt: "Hello" }), { code: "session_busy" });
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
  state.skills = []; state.effect = "deny";
  const reads = state.seen.length;
  const frozen = await second.getThreadSnapshot(sid);
  assert.deepEqual(frozen.native?.inputSkills, { msg_user: [{ id: skill.id }] });
  assert.equal(nativeV2InputSkillsMatch(frozen, selected.messageId, selected.skills), true);
  assert.equal((await second.retryTurn(sid, selected)).alreadyPresent, true);
  assert.ok(state.seen.slice(reads).every((item) => item.method === "GET" && !item.path.endsWith("/skill") && !item.path.endsWith("/permission")));
  await client.abortThread(sid);
  assert.equal((await client.waitForThread(sid, { since: result, timeoutMs: 2000 })).outcome, "aborted");
  await assert.rejects(client.retryTurn(sid, selected), { code: "continuation_required" });
  assert.equal(state.history.filter((item) => item.type === "assistant").length, 1);
  assert.ok(!state.seen.some((item) => item.method === "DELETE" && item.path.includes("/message")));
});

test("optional initial prompt carries deduplicated skill IDs; recovery binds both metadata and native attachments", async (t) => {
  const { client, state, options } = await fixture(t);
  const thread = await client.createThread({ title: "Selected skill", threadId: sid, prompt: "Hello", skills: [{ id: skill.id }, { id: skill.id }] });
  assert.equal(thread.started, true);
  const posted = state.seen.find((item) => item.path.endsWith("/prompt")); assert.ok(posted);
  assert.equal(posted.body.text, "Hello");
  assert.deepEqual(posted.body.skills, [{ id: skill.id }]);
  assert.ok(!JSON.stringify(posted.body).includes(skill.content));
  const messageId = posted.body.id; assert.equal(typeof messageId, "string");
  const admitted = state.history.find((item) => item.id === messageId); assert.ok(admitted?.type === "user");
  const binding = admitted.metadata?.headlessTurn;
  assert.ok(binding && typeof binding === "object" && "skillIds" in binding);
  assert.deepEqual(binding.skillIds, [skill.id]);
  const recovered = createHeadlessThreadClientV2(options);
  const selected = { messageId: String(messageId), prompt: "Hello", skills: [{ id: skill.id }] };
  const frozen = await client.getThreadSnapshot(sid);
  assert.deepEqual(frozen.native?.inputSkills, { [selected.messageId]: selected.skills });
  assert.equal(nativeV2InputSkillsMatch(frozen, selected.messageId, selected.skills), true);
  assert.equal(nativeV2InputSkillsMatch(frozen, "msg_absent", []), false);
  assert.equal(nativeV2InputSkillsMatch(frozen, selected.messageId, []), false);
  assert.equal(nativeV2InputSkillsMatch(frozen, selected.messageId, [{ id: "other_skill" }]), false);
  assert.equal((await recovered.retryTurn(sid, selected)).alreadyPresent, true);
  for (const skills of [[], [{ id: "other_skill" }]]) await assert.rejects(recovered.sendTurn(sid, { ...selected, skills }), { code: "input_conflict" });
  admitted.skills = [{ id: "other_skill", name: "Other", text: "Other body" }];
  await assert.rejects(recovered.sendTurn(sid, selected), { code: "input_conflict" });
  assert.deepEqual((await client.getThreadSnapshot(sid)).native?.inputSkills, {});
  assert.equal((await client.getThreadSnapshot(sid)).messages.find((item) => item.role === "assistant")?.parentId, null);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
});

test("pending recovery exposes frozen IDs only for a verified host-bound inbox prompt", async (t) => {
  const { client, native, state } = await fixture(t);
  const messageId = "msg_pending_skill", contextId = `${messageId}_context`;
  const binding = { headlessTurn: { ...metadata(messageId, contextId).headlessTurn, skillIds: [skill.id] } };
  await native.admitInput(sid, { id: contextId, type: "synthetic", text: "Reference", metadata: binding, delivery: "steer", resume: false });
  await native.admitInput(sid, { id: messageId, type: "user", text: "Hello", metadata: binding, skills: [{ id: skill.id }], delivery: "steer", resume: false });
  state.skills = [];
  const reads = state.seen.length;
  const snapshot = await client.getThreadSnapshot(sid);
  assert.deepEqual(snapshot.native?.inputSkills, { [messageId]: [{ id: skill.id }] });
  assert.equal(nativeV2InputSkillsMatch(snapshot, messageId, [{ id: skill.id }]), true);
  assert.equal(nativeV2InputSkillsMatch(snapshot, messageId, []), false);
  assert.equal(nativeV2InputSkillsMatch(snapshot, contextId, []), false);
  assert.ok(state.seen.slice(reads).every((item) => item.method === "GET" && !item.path.endsWith("/skill")));
  await assert.rejects(client.sendTurn(sid, { messageId, prompt: "Hello", context: "Reference", skills: [{ id: "other" }] }), { code: "input_conflict" });
  const pending = state.inbox.find((item) => item.id === messageId); assert.ok(pending?.type === "user");
  const context = state.inbox.find((item) => item.id === contextId); assert.ok(context);
  for (const payload of [
    { ...pending.payload, metadata: undefined },
    { ...pending.payload, metadata: { headlessTurn: { ...binding.headlessTurn, skillIds: ["other"] } } },
    { ...pending.payload, agents: [{ name: "foreign" }] },
    { ...pending.payload, skills: [{ id: skill.id, name: skill.name, mention: { start: 0, end: 1, text: "H" } }] },
  ]) {
    state.inbox = [context, { ...pending, payload }];
    assert.deepEqual((await client.getThreadSnapshot(sid)).native?.inputSkills, {});
  }
  const plain = await fixture(t);
  await plain.native.admitInput(sid, { id: "msg_plain", type: "user", text: "Hello", metadata: metadata("msg_plain"), resume: false });
  const textOnly = await plain.client.getThreadSnapshot(sid);
  assert.deepEqual(textOnly.native?.inputSkills, { msg_plain: [] });
  assert.equal(nativeV2InputSkillsMatch(textOnly, "msg_plain"), true);
  plain.state.inbox.push({ id: "msg_foreign", sessionID: sid, type: "user", delivery: "queue", timeCreated: 1, payload: { text: "Foreign" } });
  assert.deepEqual((await plain.client.getThreadSnapshot(sid)).native?.inputSkills, {});
});

test("native snapshots reconcile delivery overlap without replay and bound persistent overlap", async (t) => {
  const { client, state, options } = await fixture(t);
  state.finish = false;
  const acceptance = await client.sendTurn(sid, { messageId: "msg_overlap", prompt: "Hello", skills: [{ id: skill.id }] });
  const admitted = state.history.find((item) => item.id === acceptance.messageId); assert.ok(admitted?.type === "user");
  const receipt = { id: admitted.id, sessionID: sid, type: "user", timeCreated: 1, delivery: "steer", payload: { text: admitted.text, metadata: admitted.metadata, skills: admitted.skills } };
  let reads = 0, overlaps = 1;
  const observer = createHeadlessThreadClientV2({ ...options, fetch: async (url, init) => {
    assert.equal(init?.method, "GET");
    if (new URL(url).pathname.endsWith("/inbox") && ++reads <= overlaps) return Response.json({ data: [receipt] });
    return fetch(url, init);
  } });
  const snapshot = await observer.getThreadSnapshot(sid);
  assert.equal(reads, 2);
  assert.equal(nativeV2InputSkillsMatch(snapshot, admitted.id, [{ id: skill.id }]), true);
  reads = 0; overlaps = Infinity;
  await assert.rejects(observer.getThreadSnapshot(sid), { code: "snapshot_unconfirmed" });
  assert.equal(reads, 3);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
});

test("native observation failures remain unknown and recover without replay or cancellation", async (t) => {
  const { client, options, state } = await fixture(t);
  const since = await client.sendTurn(sid, { messageId: "msg_observation", prompt: "Hello" });
  let mode = "slow";
  let activeReads = 0;
  const observer = createHeadlessThreadClientV2({ ...options, fetch: async (url, init) => {
    assert.equal(init?.method, "GET");
    if (new URL(url).pathname.endsWith("/active")) {
      activeReads++;
      if (mode === "slow") await new Promise<void>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (mode === "unavailable" || mode === "once") {
        if (mode === "once") mode = "ready";
        return Response.json({}, { status: 503 });
      }
      if (mode === "forbidden") return Response.json({}, { status: 403 });
      if (mode === "idle-then-unavailable") { mode = "unavailable"; return Response.json({ data: {} }); }
    }
    return fetch(url, init);
  } });
  for (mode of ["slow", "unavailable"]) {
    await assert.rejects(observer.waitForThread(sid, { since, timeoutMs: 40, pollIntervalMs: 5 }), (error: unknown) => {
      assert.equal(isNativeV2ObservationError(error), true);
      assert.ok(error instanceof Error && "code" in error && error.code === "observation_unavailable");
      return true;
    });
  }
  state.inbox.push({ id: "msg_pending", sessionID: sid, type: "synthetic", delivery: "queue", timeCreated: 5, payload: { text: "Pending" } });
  mode = "idle-then-unavailable";
  await assert.rejects(observer.waitUntilIdle(sid, { timeoutMs: 40, pollIntervalMs: 5 }), { code: "observation_unavailable" });
  state.inbox = [];
  mode = "forbidden";
  const before = activeReads;
  await assert.rejects(observer.waitForThread(sid, { since, timeoutMs: 500, pollIntervalMs: 5 }), { status: 403 });
  assert.equal(activeReads, before + 1);
  mode = "once";
  assert.equal((await observer.waitForThread(sid, { since, timeoutMs: 1000, pollIntervalMs: 5 })).outcome, "settled");
  mode = "slow";
  const controller = new AbortController();
  const waiting = observer.waitUntilIdle(sid, { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/interrupt")).length, 0);
});

test("context-only recovery cancels only a verified idle host binding, never foreign work", async (t) => {
  const { native, state } = await fixture(t);
  const messageId = "msg_context_only", contextId = `${messageId}_context`;
  const input = { messageId, prompt: "Hello", context: "Reference", agent: "build", model: { providerId: model.providerID, modelId: model.id } };
  await native.admitInput(sid, { id: contextId, type: "synthetic", text: input.context, metadata: metadata(messageId, contextId), delivery: "steer", resume: false });
  const context = state.inbox[0]; assert.ok(context);
  for (const foreign of ["active", "binding", "inbox", "history", "body"]) {
    state.active = foreign === "active";
    state.inbox = foreign === "inbox" ? [context, { ...context, id: "msg_foreign" }] : foreign === "binding" ? [{ ...context, payload: { ...context.payload, metadata: metadata("msg_foreign", contextId) } }] : [context];
    state.history = foreign === "history" ? [user("msg_foreign")] : [];
    assert.equal(await cancelNativeV2TurnContext(native, sid, { ...input, ...(foreign === "body" ? { context: "Different" } : {}) }), false);
    assert.equal(state.seen.filter((item) => item.method === "DELETE" || item.path.endsWith("/interrupt")).length, 0);
  }
  state.active = false; state.inbox = [context]; state.history = [];
  assert.equal(await cancelNativeV2TurnContext(native, sid, input), true);
  assert.equal(await cancelNativeV2TurnContext(native, sid, input), false);
  assert.deepEqual(state.seen.filter((item) => item.method !== "GET").map((item) => [item.method, item.path]), [["POST", `${mount}/session/${sid}/synthetic`], ["DELETE", `${mount}/session/${sid}/inbox/${contextId}`]]);
  assert.equal(state.inbox.length, 0);
});

test("missing, revoked, denied and ask skills never park context or submit a user prompt, for each current role", async (t) => {
  for (const agent of ["build", "worker"]) {
    for (const effect of ["missing", "revoked", "deny", "ask"]) {
      const { client, native, state } = await fixture(t);
      if (effect === "revoked") assert.equal((await native.listSkills()).length, 1);
      if (effect === "missing" || effect === "revoked") state.skills = [];
      else if (effect === "deny" || effect === "ask") state.effect = effect;
      await assert.rejects(client.sendTurn(sid, { messageId: "msg_skill", prompt: "Hello", context: "Reference", agent, skills: [{ id: skill.id }] }), {
        code: effect === "ask" ? "skill_permission_required" : effect === "deny" ? "skill_denied" : "skill_unavailable",
      });
      assert.ok(!state.seen.some((item) => /\/(prompt|synthetic|reply)$/.test(item.path)));
      const permission = state.seen.find((item) => item.method === "POST" && item.path.endsWith("/permission"));
      if (effect === "ask" || effect === "deny") assert.deepEqual(permission?.body, { action: "skill", resources: [skill.id], save: [skill.id], agent });
      else assert.equal(permission, undefined);
      if (effect === "ask") assert.equal((await native.listPermissions(sid))[0]?.id, "per_fixture");
    }
  }
  // Revocation after successful preflight still blocks the actual prompt.
  // The already parked context remains explicitly stoppable, not an unknown POST.
  const { client, state } = await fixture(t);
  state.revokeAfterRead = true;
  await assert.rejects(client.sendTurn(sid, { messageId: "msg_revoked", prompt: "Hello", context: "Reference", skills: [{ id: skill.id }] }), { code: "skill_unavailable" });
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 0);
  assert.equal(state.inbox.length, 1);
  assert.equal((await client.abortThread(sid)).accepted, true);
  assert.equal(state.inbox.length, 0);
});

test("unknown admission stays blocked, recovery never resends, and unsupported masks perform no writes", async (t) => {
  const { client, state } = await fixture(t);
  await assert.rejects(client.sendTurn(sid, { prompt: "Hello", tools: { shell: false } }), { code: "unsupported_tool_mask" });
  await assert.rejects(client.sendTurn(sid, { prompt: "Hello", ...{ noReply: true } }), { code: "unsupported_no_reply" });
  await assert.rejects(client.createThread({ title: "Setup", prompt: "Hello", ...{ noReply: true } }), { code: "unsupported_no_reply" });
  assert.equal(state.seen.length, 0);
  state.lose = true; state.persist = false;
  await assert.rejects(client.sendTurn(sid, { messageId: "msg_user", prompt: "Hello" }), { code: "admission_unknown" });
  await assert.rejects(client.retryTurn(sid, { messageId: "msg_user", prompt: "Hello" }), { code: "admission_unknown" });
  state.readFailure = true;
  await assert.rejects(client.sendTurn(sid, { messageId: "msg_user", prompt: "Hello" }), { status: 403 });
  state.readFailure = false;
  await assert.rejects(client.sendTurn(sid, { messageId: "msg_other", prompt: "Hello" }), { code: "admission_unknown" });
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
  const recovered = await fixture(t);
  recovered.state.readFailure = true;
  await assert.rejects(recovered.client.retryTurn(sid, { messageId: "msg_saved", prompt: "Hello" }), { status: 403 });
  recovered.state.readFailure = false;
  await assert.rejects(recovered.client.sendTurn(sid, { messageId: "msg_next", prompt: "Hello" }), { code: "admission_unknown" });
  await assert.rejects(recovered.client.retryTurn(sid, { messageId: "msg_saved", prompt: "Hello" }), { code: "admission_unknown" });
  await assert.rejects(recovered.client.sendTurn(sid, { messageId: "msg_next", prompt: "Hello" }), { code: "admission_unknown" });
  await assert.rejects(recovered.client.abortThread(sid), { code: "stop_unconfirmed" });
  recovered.state.history = [{ ...user("msg_saved"), text: "Different payload" }];
  await assert.rejects(recovered.client.abortThread(sid), { code: "input_conflict" });
  assert.equal(recovered.state.seen.filter((item) => item.path.endsWith("/prompt")).length, 0);
});

test("idle is not settled while pending; Stop cancels only the inbox and verifies it is empty", async (t) => {
  const { client, native, state, options } = await fixture(t);
  await native.admitInput(sid, { id: "msg_pending", type: "synthetic", text: "Pending" });
  assert.equal((await client.waitUntilIdle(sid, { timeoutMs: 100, pollIntervalMs: 5 })).outcome, "timeout");
  const stopped = await Promise.all([client.abortThread(sid), createHeadlessThreadClientV2(options).abortThread(sid)]);
  assert.ok(stopped.every((result) => result.accepted));
  assert.equal(state.seen.filter((item) => item.path.endsWith("/interrupt")).length, 1);
  assert.equal(state.inbox.length, 0);
  assert.equal((await client.waitUntilIdle(sid, { timeoutMs: 2000 })).outcome, "settled");
  assert.ok(state.seen.some((item) => item.method === "DELETE" && item.path.endsWith("/inbox/msg_pending")));
});

test("concurrent client instances share admission; idle placeholders do not settle and native failure does", async (t) => {
  const { client, options, state } = await fixture(t);
  state.finish = false;
  const other = createHeadlessThreadClientV2(options);
  const results = await Promise.allSettled([
    client.sendTurn(sid, { messageId: "msg_first", prompt: "Hello" }),
    other.sendTurn(sid, { messageId: "msg_second", prompt: "Hello" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
  state.active = false;
  assert.equal((await client.waitForThread(sid, { since: { messageId: "msg_first", messageCountBefore: 0 }, timeoutMs: 100, pollIntervalMs: 5 })).outcome, "timeout");
  const reply = state.history.at(-1);
  assert.ok(reply?.type === "assistant");
  reply.error = { type: "fixture_failure", message: "Fixture provider refused" };
  reply.time.completed = 3;
  state.session.time.idle = 4;
  state.session.outcome = "failed";
  const failed = await client.waitForThread(sid, { since: { messageId: "msg_first", messageCountBefore: 0 }, timeoutMs: 2000 });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.terminalError?.message, "Fixture provider refused");
  await assert.rejects(client.retryTurn(sid, { messageId: "msg_first", prompt: "Hello" }), { code: "continuation_required" });
  assert.equal(state.history.length, 2);
});
