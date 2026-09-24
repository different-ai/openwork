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
const assistant = (id = "msg_answer", created = 2, completed = 3): NativeV2Message => ({
  id, type: "assistant", agent: "build", model, tokens, cost: 0.02, time: { created, completed }, finish: "stop",
  content: [{ type: "reasoning", text: "private" }, { type: "text", text: "Native answer" }, { type: "tool", id: "call_read", name: "read", time: { created, ran: created, completed }, state: { status: "completed", input: { path: "fixture" }, content: [{ type: "text", text: "observed" }, { type: "file", uri: "file:///fixture/result.png", mime: "image/png" }], metadata: { structuredContent: { ok: true } } } }],
});
function event(type: string, seq: number, data: Record<string, unknown> = {}): NativeV2Event {
  return { id: `evt_${seq}`, type, created: seq, durable: { aggregateID: sid, seq, version: 1 }, data: { sessionID: sid, ...data } };
}

async function fixture(t: TestContext, apiContract: "beta19271" | "native-2" = "beta19271") {
  const session: NativeV2Session = { id: sid, agent: "build", model, location: { directory: "/fixture" }, projectID: "project_fixture", tokens, cost: 0, time: { created: 1, updated: 3 } };
  const history: NativeV2Message[] = [], log: NativeV2Event[] = [], inbox: NativeV2Receipt[] = [], permissions: NativeV2Permission[] = [];
  const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const state: {
    history: NativeV2Message[]; log: NativeV2Event[]; inbox: NativeV2Receipt[]; permissions: NativeV2Permission[];
    active: boolean; finish: boolean; lose: boolean; persist: boolean; readFailure: boolean; seen: typeof seen;
    session: NativeV2Session; models: typeof catalogModel[]; skills: typeof skill[]; effect: "allow" | "deny" | "ask"; revokeAfterRead: boolean;
  } = {
    history, log, inbox, permissions, seen, active: false, finish: true, lose: false, persist: true, readFailure: false,
    session, models: [catalogModel], skills: [skill], effect: "allow", revokeAfterRead: false,
  };
  let clock = 0;
  const timestamp = (fallback: number) => apiContract === "native-2" ? clock = Math.max(clock, state.history.at(-1)?.time.created ?? 0) + 1 : fallback;
  const wireReceipt = (receipt: NativeV2Receipt) => {
    if (apiContract !== "native-2") return receipt;
    const { timeCreated, ...item } = receipt;
    return { ...item, time: { created: timeCreated } };
  };
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
      state.session.outcome = type === "session.execution.succeeded" ? "succeeded" : "interrupted";
      state.session.time.idle = timestamp(4);
      if (apiContract === "native-2") state.history.push({ id: `msg_idle_${clock}`, type: "idle", time: { created: clock }, outcome: state.session.outcome });
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
    if (local === "/model") return send({ data: state.models });
    if (local === "/model/default") return send({ data: catalogModel });
    if (local === "/agent/build" || local === "/agent/worker") return send({ data: { id: local.slice("/agent/".length), permissions: [] } });
    if (local === "/skill") {
      const skills = state.skills;
      if (state.revokeAfterRead) state.skills = [];
      return send({ data: skills });
    }
    if (local === `/session/${sid}/model`) {
      const value = body.model;
      assert.ok(value && typeof value === "object" && "providerID" in value && typeof value.providerID === "string" && "id" in value && typeof value.id === "string");
      const selected = { providerID: value.providerID, id: value.id, ...("variant" in value && typeof value.variant === "string" ? { variant: value.variant } : {}) };
      const previous = state.session.model;
      state.session.model = selected;
      const created = timestamp(0);
      state.history.push({ id: `msg_model_${created}`, type: "model-switched", model: selected, previous, time: { created } });
      return send(undefined, 204);
    }
    if (local === `/session/${sid}/agent`) {
      assert.equal(typeof body.agent, "string");
      const previous = state.session.agent;
      state.session.agent = String(body.agent);
      const created = timestamp(0);
      state.history.push({ id: apiContract === "native-2" ? `msg_agent_${created}` : "msg_switched", type: "agent-switched", agent: String(body.agent), previous, time: { created } });
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
    if (local === `/session/${sid}/inbox`) return send({ data: state.inbox.map(wireReceipt) });
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
      const receipt: NativeV2Receipt = { id: body.id, sessionID: sid, type, delivery: body.delivery, timeCreated: timestamp(1), payload: { text: body.text, ...(skills ? { skills } : {}), ...(typeof body.metadata === "object" && body.metadata !== null ? { metadata: Object.fromEntries(Object.entries(body.metadata)) } : {}) } };
      if (state.persist) {
        state.inbox.push(receipt); emit("session.inbox.enqueued", { inboxID: receipt.id, item: receipt });
        if (body.resume) {
          emit("session.execution.started"); state.active = true;
          for (const item of state.inbox) {
            state.history.push({ id: item.id, type: item.type, ...item.payload, time: { created: item.timeCreated } });
            emit("session.inbox.delivered", { inboxID: item.id });
          }
          state.inbox = [];
          const reply = assistant(apiContract === "native-2" ? `${receipt.id}_answer` : undefined, timestamp(2), timestamp(3));
          if (reply.type === "assistant") { reply.agent = state.session.agent ?? "build"; reply.model = state.session.model ?? model; }
          if (!state.finish) delete reply.time.completed;
          state.history.push(reply);
          emit("session.step.started", { assistantMessageID: reply.id });
          if (state.finish) { emit("session.execution.succeeded"); state.active = false; }
        }
      }
      if (state.lose) return res.destroy();
      return send({ data: wireReceipt(receipt) });
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
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, workspaceId: "ws_fixture", token: "fixture", defaultModel: { providerId: "fixture", modelId: "text" }, apiContract };
  return { state, emit, options, client: createHeadlessThreadClientV2(options), native: createNativeV2Client(options) };
}

test("native-2 idle markers require matching host bindings and a consistent observation", async (t) => {
  const { state, options } = await fixture(t);
  state.session.time.idle = 4; state.session.outcome = "succeeded";
  const idle: NativeV2Message = { id: "msg_idle", type: "idle", time: { created: 4 }, outcome: "succeeded" };
  state.history.push(user("msg_user"), assistant(), idle);
  assert.deepEqual(projectNativeV2History(state.history, state.session, true).ambiguousTurns, ["msg_user"]);
  assert.equal(projectNativeV2History(state.history, state.session, true, "native-2").turnOutcomes.msg_user, "succeeded");
  assert.deepEqual(projectNativeV2History([...state.history.slice(0, -1), { ...idle, outcome: "interrupted" }], state.session, true, "native-2").ambiguousTurns, ["msg_user"]);
  let activeReads = 0;
  const client = createHeadlessThreadClientV2({ ...options, apiContract: "native-2", fetch: async (input, init) => {
    if (new URL(input).pathname.endsWith("/session/active") && activeReads++ === 0) return Response.json({ data: { [sid]: { type: "running" } } });
    return fetch(input, init);
  } });
  assert.equal((await client.getThreadSnapshot(sid)).native?.turnOutcomes.msg_user, "succeeded");
  assert.equal(activeReads, 2);
  assert.equal(state.seen.some((request) => request.method === "POST"), false);
  const blocked = createHeadlessThreadClientV2({ ...options, apiContract: "native-2", fetch: async (input, init) => new URL(input).pathname.endsWith("/session/active")
    ? Response.json({ data: { [sid]: { type: "running" } } }) : fetch(input, init) });
  await assert.rejects(blocked.getThreadSnapshot(sid), { code: "snapshot_unconfirmed", method: "GET" });
});

test("native-2 completed receipts survive switches and rejected skill preflight without replay", async (t) => {
  const { client, state, options } = await fixture(t, "native-2");
  const initial = { messageId: "msg_first", prompt: "Hello", skills: [{ id: skill.id }], agent: "build", model: { providerId: model.providerID, modelId: model.id } };
  const first = await client.sendTurn(sid, initial);
  assert.ok(first.messageId === initial.messageId);
  const completed = await client.waitForThread(sid, { since: first, timeoutMs: 2000 });
  assert.equal(completed.outcome, "settled");
  const firstReply = completed.snapshot.messages.find((item) => item.id === `${first.messageId}_answer`);
  assert.ok(firstReply);
  const firstIdle = state.history.at(-1); assert.ok(firstIdle?.type === "idle");
  const selectedModel = { ...model, id: "alternate" };
  state.models.push({ ...catalogModel, ...selectedModel, modelID: selectedModel.id });
  state.skills = [];
  const input = { messageId: "msg_followup", prompt: "Continue", context: "Reference", skills: [{ id: skill.id }], agent: "worker", model: { providerId: selectedModel.providerID, modelId: selectedModel.id } };
  await assert.rejects(client.sendTurn(sid, input), { code: "skill_unavailable" });
  assert.deepEqual(state.history.map((item) => item.type), ["user", "assistant", "idle", "model-switched", "agent-switched"]);
  assert.deepEqual(state.inbox, []);
  assert.deepEqual(state.seen.filter((item) => /\/(prompt|synthetic)$/.test(item.path)).map((item) => item.body.id), [first.messageId]);
  const preserved = await client.getThreadSnapshot(sid);
  assert.deepEqual(preserved.native?.ambiguousTurns, []);
  assert.equal(preserved.native?.turnOutcomes[first.messageId], "succeeded");
  assert.deepEqual(preserved.messages.find((item) => item.id === firstReply.id), firstReply);
  const annotation: NativeV2Message = { id: "msg_instruction", type: "system", text: "Instructions updated", time: { created: 7 } };
  state.history.push(annotation);
  const recovered = createHeadlessThreadClientV2(options);
  const reads = state.seen.length;
  assert.equal((await recovered.retryTurn(sid, initial)).alreadyPresent, true);
  assert.equal((await recovered.waitForThread(sid, { since: first, timeoutMs: 2000 })).outcome, "settled");
  assert.ok(state.seen.slice(reads).every((item) => item.method === "GET" && !/\/(skill|permission)$/.test(item.path)));
  state.skills = [skill];
  const followup = await recovered.sendTurn(sid, input);
  assert.ok(followup.messageId === input.messageId);
  assert.equal(followup.alreadyPresent, false);
  const admitted = state.history.find((item) => item.id === followup.messageId); assert.ok(admitted?.type === "user");
  assert.deepEqual(admitted.metadata?.headlessTurn, {
    version: 1, messageId: input.messageId, contextId: `${input.messageId}_context`, skillIds: [skill.id],
    previousMessageId: annotation.id, previousIdleAt: firstIdle.time.created, previousOutcome: firstIdle.outcome, model: selectedModel, agent: input.agent,
  });
  const result = await recovered.waitForThread(sid, { since: followup, timeoutMs: 2000 });
  assert.equal(result.outcome, "settled");
  assert.deepEqual(result.snapshot.native?.ambiguousTurns, []);
  assert.deepEqual(result.snapshot.native?.turnOutcomes, { [first.messageId]: "succeeded", [followup.messageId]: "succeeded" });
  assert.deepEqual(result.snapshot.messages.find((item) => item.id === firstReply.id), firstReply);
  assert.equal(result.snapshot.messages.find((item) => item.id === `${followup.messageId}_answer`)?.parentId, followup.messageId);
  assert.deepEqual(result.snapshot.messages.find((item) => item.id === `${followup.messageId}_answer`)?.model, input.model);
  assert.deepEqual(state.history.filter((item) => item.type === "assistant").map((item) => [item.agent, item.model]), [[initial.agent, model], [input.agent, selectedModel]]);
  assert.deepEqual(state.seen.filter((item) => /\/(prompt|synthetic)$/.test(item.path)).map((item) => [item.body.id, item.body.delivery, item.body.resume]), [
    [first.messageId, "steer", true], [`${input.messageId}_context`, "steer", false], [followup.messageId, "steer", true],
  ]);
});

test("native-2 annotated idle boundaries keep exact attribution and reject foreign or mismatched evidence", () => {
  const input = user("msg_user"), reply = assistant(); assert.ok(reply.type === "assistant");
  const idle: NativeV2Message = { id: "msg_idle", type: "idle", time: { created: 4 }, outcome: "succeeded" };
  const selectedModel = { ...model, id: "alternate" };
  const switched: NativeV2Message = { id: "msg_model", type: "model-switched", model: selectedModel, previous: model, time: { created: 5 } };
  const agent: NativeV2Message = { id: "msg_agent", type: "agent-switched", agent: "worker", previous: "build", time: { created: 6 } };
  const annotation: NativeV2Message = { id: "msg_instruction", type: "system", text: "Instructions updated", time: { created: 7 } };
  const annotations = [switched, agent, annotation];
  const history = [input, reply, idle, ...annotations];
  const session: NativeV2Session = { id: sid, agent: "worker", model: selectedModel, location: { directory: "/fixture" }, projectID: "fixture", cost: 0, tokens, outcome: "succeeded", time: { created: 0, updated: 7, idle: 4 } };
  const assertUnconfirmed = (messages: NativeV2Message[]) => {
    const projection = projectNativeV2History(messages, session, true, "native-2");
    assert.ok(projection.ambiguousTurns.includes(input.id));
    assert.equal(projection.turnOutcomes[input.id], undefined);
    assert.equal(projection.inputSkills[input.id], undefined);
    assert.equal(projection.messages.find((item) => item.id === reply.id)?.parentId, null);
  };
  assert.deepEqual(projectNativeV2History(history, session, true).ambiguousTurns, [input.id]);
  for (const outcome of ["succeeded", "failed", "interrupted"] satisfies Array<NonNullable<NativeV2Session["outcome"]>>) {
    const projection = projectNativeV2History([input, reply, { ...idle, outcome }, ...annotations], { ...session, outcome }, true, "native-2");
    assert.equal(projection.turnOutcomes[input.id], outcome);
    assert.equal(projection.messages.find((item) => item.id === reply.id)?.parentId, input.id);
  }
  for (const foreign of [
    { ...user("msg_foreign_user"), metadata: undefined, time: { created: 8 } },
    { id: "msg_foreign_context", type: "synthetic", text: "Unadmitted", time: { created: 8 } },
    { id: "msg_foreign_skill", type: "skill", skill: skill.id, name: skill.name, text: skill.content, time: { created: 8 } },
    { ...annotation, id: "msg_claimed_system", metadata: { headlessTurn: null } },
    { ...annotation, id: "msg_attached_system", skills: [{ id: skill.id, name: skill.name }] },
    { ...switched, id: "msg_claimed_switch", metadata: { headlessTurn: null } },
    { ...agent, id: "msg_attached_switch", skills: [{ id: skill.id, name: skill.name }] },
    { ...idle, id: "msg_extra_idle" },
    assistant("msg_after_idle"),
    { id: "msg_compaction", type: "compaction", status: "completed", reason: "auto", summary: "Summary", recent: "Recent", time: { created: 8 } },
  ] satisfies NativeV2Message[]) assertUnconfirmed([...history, foreign]);
  for (const marker of [{ ...idle, time: { created: 5 } }, { ...idle, outcome: "interrupted" }] satisfies NativeV2Message[]) {
    assertUnconfirmed([input, reply, marker, ...annotations]);
  }
  assertUnconfirmed([input, reply, idle, { ...switched, time: { created: 3 } }, agent, annotation]);
  for (const mismatched of [
    { ...reply, agent: "worker" }, { ...reply, model: selectedModel }, { ...reply, model: { ...model, variant: "high" } },
    { ...reply, time: { created: 2, completed: 5 } },
  ]) assertUnconfirmed([input, mismatched, idle, ...annotations]);
  const binding = { ...metadata("msg_followup").headlessTurn, previousMessageId: annotation.id, previousIdleAt: 4, previousOutcome: "succeeded", agent: "worker", model: selectedModel };
  const followup: NativeV2Message = { ...user("msg_followup"), time: { created: 8 }, metadata: { headlessTurn: binding } };
  const pending = projectNativeV2History([...history, followup], session, false, "native-2");
  assert.deepEqual(pending.turnOutcomes, { [input.id]: "succeeded" });
  assert.deepEqual(pending.ambiguousTurns, []);
  for (const captured of [{ ...binding, previousIdleAt: 5 }, { ...binding, previousOutcome: "interrupted" }]) {
    assertUnconfirmed([...history, { ...followup, metadata: { headlessTurn: captured } }]);
  }
  const staleTail = projectNativeV2History([...history, { ...followup, metadata: { headlessTurn: { ...binding, previousMessageId: idle.id } } }], session, false, "native-2");
  assert.ok(staleTail.ambiguousTurns.includes(followup.id));
  assert.equal(staleTail.inputSkills[followup.id], undefined);
});

test("native-2 annotated idle observations still reconcile activity, outcome and unfinished replies", async (t) => {
  const { state, options, client } = await fixture(t, "native-2");
  state.session.time.idle = 4; state.session.outcome = "succeeded";
  const reply = assistant(); assert.ok(reply.type === "assistant");
  state.history = [user("msg_user"), reply, { id: "msg_idle", type: "idle", time: { created: 4 }, outcome: "succeeded" },
    { id: "msg_switched", type: "agent-switched", agent: "worker", previous: "build", time: { created: 5 } },
    { id: "msg_instruction", type: "system", text: "Instructions updated", time: { created: 6 } }];
  state.session.agent = "worker";
  let activeReads = 0;
  const observer = createHeadlessThreadClientV2({ ...options, fetch: async (url, init) => {
    if (new URL(url).pathname.endsWith("/active") && ++activeReads === 1) return Response.json({ data: { [sid]: { type: "running" } } });
    return fetch(url, init);
  } });
  assert.equal((await observer.getThreadSnapshot(sid)).native?.turnOutcomes.msg_user, "succeeded");
  assert.equal(activeReads, 2);
  for (const inconsistent of ["active", "idle-time", "outcome", "unfinished-reply", "running-tool"]) {
    state.active = inconsistent === "active";
    state.session.time.idle = inconsistent === "idle-time" ? 5 : 4;
    state.session.outcome = inconsistent === "outcome" ? "failed" : "succeeded";
    if (inconsistent === "unfinished-reply") delete reply.time.completed;
    else reply.time.completed = 3;
    const tool = reply.content.find((part) => part.type === "tool"); assert.ok(tool?.type === "tool");
    if (inconsistent === "running-tool") { tool.state = { status: "running", input: { path: "fixture" }, metadata: {} }; delete tool.time.completed; }
    await assert.rejects(client.getThreadSnapshot(sid), { code: "snapshot_unconfirmed", method: "GET" });
  }
  assert.ok(state.seen.every((item) => item.method === "GET"));
});

test("real domain API admits native text/context, projects usage/tools and waits for its terminal boundary", async (t) => {
  const { client, native, state } = await fixture(t);
  const created = await client.createThread({ title: "Fixture", threadId: sid });
  assert.equal(created.id, sid);
  assert.equal(created.started, false);
  assert.equal(Object.hasOwn(state.seen.find((request) => request.method === "POST" && request.path.endsWith("/session"))?.body ?? {}, "metadata"), false);
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

test("native instruction annotations preserve a follow-up's exact input boundary", () => {
  const first = user("msg_first"), firstReply = assistant("msg_first_reply");
  const reply = assistant("msg_followup_reply");
  reply.time = { created: 7, completed: 8 };
  const session: NativeV2Session = { id: sid, location: { directory: "/fixture" }, projectID: "fixture", cost: 0, tokens, outcome: "succeeded", time: { created: 0, updated: 9, idle: 9 } };
  const annotation: NativeV2Message = { id: "msg_instruction", type: "system", text: "Instructions updated", time: { created: 5 } };
  const binding = { headlessTurn: { ...metadata("msg_followup", "msg_followup_context").headlessTurn, previousMessageId: firstReply.id, previousIdleAt: 4, previousOutcome: "succeeded" } };
  const context: NativeV2Message = { id: "msg_followup_context", type: "synthetic", text: "Reference", metadata: binding, time: { created: 6 } };
  const followup: NativeV2Message = { ...user("msg_followup"), metadata: binding, time: { created: 6 } };
  for (const inputs of [
    [annotation, context, followup],
    [context, annotation, followup],
    [annotation, { ...followup, metadata: { headlessTurn: { ...binding.headlessTurn, contextId: null } } }],
  ] satisfies NativeV2Message[][]) {
    const history = [first, firstReply, ...inputs, reply];
    const projection = projectNativeV2History(history, session, true);
    assert.equal(projection.messages.at(-1)?.parentId, followup.id);
    assert.equal(projection.turnOutcomes[followup.id], "succeeded");
    assert.deepEqual(projection.inputSkills[followup.id], []);
    assert.equal(projection.messages.length, history.length, "annotations remain in history");
  }
  for (const foreign of [
    user("msg_foreign"),
    { id: "msg_foreign_context", type: "synthetic", text: "Unadmitted", time: { created: 5 } },
    { ...annotation, metadata: { headlessTurn: null } },
    { ...annotation, skills: [{ id: skill.id, name: skill.name }] },
  ] satisfies NativeV2Message[]) {
    const projection = projectNativeV2History([first, firstReply, foreign, context, followup, reply], session, true);
    assert.ok(projection.ambiguousTurns.includes(followup.id));
    assert.equal(projection.messages.at(-1)?.parentId, null);
    assert.equal(projection.inputSkills[followup.id], undefined);
  }
  const attachedContext = { ...context, skills: [{ id: skill.id, name: skill.name }] };
  assert.ok(projectNativeV2History([first, firstReply, attachedContext, followup, reply], session, true).ambiguousTurns.includes(followup.id));
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
  const sessionMetadata = { displayOwner: "synthetic-owner", headlessTurn: { forged: true } };
  const thread = await client.createThread({ title: "Selected skill", threadId: sid, prompt: "Hello", skills: [{ id: skill.id }, { id: skill.id }], metadata: sessionMetadata });
  assert.deepEqual(state.seen.find((item) => item.method === "POST" && item.path.endsWith("/session"))?.body.metadata, sessionMetadata);
  assert.equal(thread.started, true);
  const posted = state.seen.find((item) => item.path.endsWith("/prompt")); assert.ok(posted);
  assert.equal(posted.body.text, "Hello");
  assert.equal(JSON.stringify(posted.body.metadata).includes("forged"), false);
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
  const context = state.inbox.find((item) => item.id === contextId); assert.ok(context?.type === "synthetic");
  const annotation: NativeV2Message = { id: "msg_instruction", type: "system", text: "Instructions updated", time: { created: 1 } };
  state.history = [annotation];
  assert.deepEqual((await client.getThreadSnapshot(sid)).native?.inputSkills, { [messageId]: [{ id: skill.id }] });
  state.history.push({ ...context.payload, id: contextId, type: "synthetic", time: { created: 1 } }, { ...annotation, id: "msg_next_instruction" });
  state.inbox = [pending];
  assert.deepEqual((await client.getThreadSnapshot(sid)).native?.inputSkills, { [messageId]: [{ id: skill.id }] });
  state.history.push({ ...annotation, id: "msg_unconfirmed", metadata: { headlessTurn: null } });
  assert.deepEqual((await client.getThreadSnapshot(sid)).native?.inputSkills, {});
  state.history = [];
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
  const interruptedRead = await observer.waitUntilIdle(sid, { timeoutMs: 40, pollIntervalMs: 5 });
  assert.equal(interruptedRead.outcome, "timeout");
  assert.deepEqual(interruptedRead.snapshot.native?.pendingInputIds, ["msg_pending"]);
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

test("input write boundary leaves preflight failures prepared and preserves Stop", async (t) => {
  const { options, state } = await fixture(t);
  let prepared = true, marks = 0, historyReads = 0;
  const client = createHeadlessThreadClientV2({ ...options, fetch: async (url, init) => {
    const path = new URL(url).pathname;
    if (prepared && path.endsWith("/message") && ++historyReads === 4) throw new Error("Fixture observation unavailable");
    if (/\/(prompt|synthetic)$/.test(path)) assert.equal(marks, 1);
    return fetch(url, init);
  } });
  const input = { messageId: "msg_preflight", prompt: "Hello", beforeInput: async () => { await Promise.resolve(); marks++; } };
  await assert.rejects(client.sendTurn(sid, input), { method: "GET" });
  assert.equal(marks, 0);
  assert.equal(state.seen.filter((item) => item.method !== "GET").length, 0);
  assert.equal((await client.abortThread(sid)).accepted, true);
  prepared = false;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.sendTurn(sid, { ...input, signal: cancelled.signal }));
  assert.equal(marks, 0);
  await assert.rejects(client.sendTurn(sid, { ...input, beforeInput: async () => { throw new Error("Fixture persistence unavailable"); } }), /Fixture persistence unavailable/);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 0);
  await client.sendTurn(sid, input);
  assert.equal(marks, 1);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 1);
});

test("paired context keeps its own uncertainty and cannot replay after preflight failure", async (t) => {
  for (const lost of [false, true]) {
    const { options, state } = await fixture(t);
    let marks = 0;
    const client = createHeadlessThreadClientV2({ ...options, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (marks && !lost && init?.method === "GET" && path.endsWith("/active")) throw new Error("Fixture observation unavailable");
      if (/\/(prompt|synthetic)$/.test(path)) assert.equal(marks, 1);
      return fetch(url, init);
    } });
    state.lose = lost; state.persist = !lost;
    const input = { messageId: "msg_context_boundary", prompt: "Hello", context: "Reference", beforeInput: async () => { await Promise.resolve(); marks++; } };
    await assert.rejects(client.sendTurn(sid, input), lost ? { code: "admission_unknown" } : { method: "GET" });
    assert.equal(marks, 1);
    const observer = createHeadlessThreadClientV2(options);
    if (lost) await assert.rejects(observer.abortThread(sid), { code: "stop_unconfirmed" });
    else assert.equal((await observer.abortThread(sid)).accepted, true);
    await assert.rejects(observer.sendTurn(sid, input), { code: "admission_unknown" });
    assert.equal(state.seen.filter((item) => item.path.endsWith("/synthetic")).length, 1);
    assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 0);
  }
  const { options, state } = await fixture(t);
  let release = () => {}, entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let generation = 1, boundaries = 0, intents = 0;
  const client = createHeadlessThreadClientV2({ ...options, onIntent: () => { intents++; }, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (init?.method === "POST" && new URL(url).pathname.endsWith("/synthetic")) { entered(); await held; }
    return response;
  } });
  const input = { messageId: "msg_context_generation", prompt: "Hello", context: "Reference", beforeInput: async () => {
    boundaries++;
    if (generation !== 1) throw Object.assign(new Error("Generation changed"), { code: "readiness_changed" });
  } };
  const sending = assert.rejects(client.sendTurn(sid, input), { code: "readiness_changed" });
  await reached;
  assert.equal(boundaries, 1);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 0);
  generation = 2;
  release();
  await sending;
  assert.equal(boundaries, 2);
  assert.equal(intents, 1);
  assert.deepEqual(state.inbox.map((item) => item.id), ["msg_context_generation_context"]);
  const observer = createHeadlessThreadClientV2(options);
  await assert.rejects(observer.sendTurn(sid, input), { code: "admission_unknown" });
  await assert.rejects(observer.retryTurn(sid, input), { code: "admission_unknown" });
  assert.equal(state.seen.filter((item) => item.path.endsWith("/synthetic")).length, 1);
  assert.equal(state.seen.filter((item) => item.path.endsWith("/prompt")).length, 0);
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
