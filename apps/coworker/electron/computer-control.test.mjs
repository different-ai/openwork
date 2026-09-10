import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createVoice, installVoicePermissions } from "./voice.mjs";
import { assertComputerToolContext, assertPrivateComputerDiscussion, COMPUTER_DENY, COMPUTER_TOOLS, COMPUTER_PROTOCOL, createComputerControl, trustedComputerSender } from "./computer-control.mjs";

const result = (state, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(state) }] });
const payload = (value) => JSON.parse(value.content.find((part) => part.type === "text").text);
const observationResult = (id = "observation") => ({ ...result({ ok: true, observation_id: id }),
  content: [...result({ ok: true, observation_id: id }).content, { type: "image", mimeType: "image/png", data: "IMAGE_DATA" }] });
const postStatus = (value) => value.content.filter((part) => part.type === "text").map((part) => JSON.parse(part.text)).find((part) => part.post_observation)?.post_observation;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const openArgs = { app_id: "com.example.editor", mode: "assist", purpose: "Edit the requested document" };
const approvalState = (patch = {}) => ({ kind: "state", id: "native-ui", phase: "approval", appName: "Editor", appID: openArgs.app_id,
  pid: 123, task: openArgs.purpose, mode: openArgs.mode, windows: [{ id: 12, title: "Document" }], ...patch });
const watchFrame = (patch = {}) => ({ kind: "frame", id: "native-ui", sequence: 1, capturedAt: 1000,
  width: 1, height: 1, mimeType: "image/png", data: "iVBORw0KGgoAAA==", ...patch });

function fixture(overrides = {}) {
  const sent = [];
  const channels = [];
  const notifications = [];
  const discussions = new Map(["scout:one", "scout:two", "editor:one"].map((key) => [key, true]));
  const controller = new AbortController();
  let connects = 0;
  let closes = 0;
  let setups = 0;
  let active = true;
  let sequence = 0;
  let workspace = "workspace-scout";
  let executionId;
  let messageId = "user";
  let directory = "/workspace/scout";
  let readinessReads = 0;
  let discussionReads = 0;
  const transport = {
    async notifyUi(value) { notifications.push(value); await overrides.notifyUi?.(value); },
    async callTool(name, args, options) {
      sent.push({ name, args, options });
      if (overrides.callTool) return overrides.callTool(name, args, options);
      if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "active", window_title: "Document", expires_in_seconds: 900 });
      if (name === "computer_close_session") return result({ ok: true, state: "closed" });
      if (name === "computer_observe") return observationResult();
      return result({ ok: true, state: "active", purpose: openArgs.purpose });
    },
    async close() { closes++; await overrides.close?.(); },
  };
  const adapter = { id: "this-mac", label: "This Mac", placement: "desktop", protocol: COMPUTER_PROTOCOL,
    readiness: async () => { readinessReads++; return { readiness: "ready", detail: "Native service ready.", permissions: { accessibility: true, screenRecording: true } }; }, setup: async () => { setups++; },
    connect: async (channel) => { connects++; channels.push(channel); if (overrides.connect) await overrides.connect(); return transport; } };
  const broker = createComputerControl({ adapters: [adapter, ...(overrides.adapters ?? [])], cleanupMs: 20, operationMs: overrides.operationMs ?? 1000, pollMs: 2,
    onRevoke: overrides.onRevoke,
    now: overrides.now,
    discussionFor: async (slug, threadId) => {
      discussionReads++;
      await overrides.discussionFor?.(slug, threadId);
      if (!discussions.get(`${slug}:${threadId}`)) throw new Error("Not a saved private discussion.");
      return { workspaceId: slug === "scout" ? workspace : `workspace-${slug}`, directory: slug === "scout" ? directory : `/workspace/${slug}` };
    },
    resolveContext: async (slug, context, expected) => {
      await overrides.resolveContext?.(slug, context, expected);
      const assertActive = () => { if (!active || controller.signal.aborted) throw new Error("Native call stopped."); };
      assertActive();
      return { entry: { id: executionId ?? `execution-${slug}-${context.sessionID}`, messageId, workspaceId: `workspace-${slug}` }, ...(context.sessionID === "worker" && overrides.delegatedOrigin ? { origin: { threadId: overrides.delegatedOrigin } } : {}), signal: controller.signal, assertActive };
    },
  });
  const scope = { slug: "scout", threadId: "one" };
  const snapshot = () => broker.snapshot(scope);
  const enable = async (targetId = "this-mac", selected = scope) => broker.configure({ ...selected, expectedRevision: (await broker.snapshot(selected)).revision, enabled: true, targetId });
  const request = (name, args = {}, selected = scope) => ({ name: `coworker_computer_${name}`, args, context: { sessionID: selected.threadId, messageID: "assistant", callID: `call-${++sequence}`, directory: `/workspace/${selected.slug}` } });
  const execute = (name, args = {}, selected = scope) => broker.execute(selected.slug, request(name, args, selected));
  return { broker, adapter, sent, scope, snapshot, enable, request, execute, controller, discussions, notifications,
    emit: (value, index = channels.length - 1) => channels[index].onUi(value), disconnect: () => channels.at(-1).onClose(),
    reads: () => ({ readinessReads, discussionReads }), changeDirectory: () => { directory = "/replacement"; },
    setExecution: (id, message) => { executionId = id; messageId = message; },
    setActive: (value) => { active = value; }, changeWorkspace: () => { workspace = "replacement"; }, counts: () => ({ connects, closes, setups }) };
}

function cloudFixture({ id = "remote-fixture", readiness = async () => ({ readiness: "ready", detail: "The remote computer is ready." }) } = {}) {
  const sent = [];
  let connects = 0;
  let closes = 0;
  let setups = 0;
  const adapter = { id, label: "Remote fixture", placement: "cloud", protocol: COMPUTER_PROTOCOL, readiness,
    setup: async () => { setups++; }, connect: async () => {
      connects++;
      return { callTool: async (name, args) => {
        sent.push({ name, args });
        if (name === "computer_open_session") return result({ ok: true, session_id: "remote-session", state: "active" });
        if (name === "computer_observe") return observationResult();
        return result({ ok: true, state: name === "computer_close_session" ? "closed" : "active" });
      }, close: async () => { closes++; } };
    } };
  return { adapter, sent, counts: () => ({ connects, closes, setups }) };
}

test("saved discussion membership wins over the selected tab; all non-private work is denied", () => {
  const scope = { slug: "scout", threadId: "one", savedIds: ["one"], workerIds: [], workers: [], groups: [], assignments: [], owners: [] };
  assert.doesNotThrow(() => assertPrivateComputerDiscussion(scope));
  for (const patch of [
    { savedIds: [] }, { workerIds: ["one"] }, { workers: [{ threadId: "one" }] },
    { groups: [{ participantThreadIds: { scout: "one" } }] }, { assignments: [{ runs: [{ threadId: "one" }] }] },
    ...["assignment", "worker", "group", "consultation", "coordinator"].map((kind) => ({ owners: [{ kind, conversationId: "one" }] })),
    { owners: [{ kind: "private", conversationId: "another" }] },
  ]) assert.throws(() => assertPrivateComputerDiscussion({ ...scope, ...patch }), /actual saved private/);
  assert.deepEqual(Object.keys(COMPUTER_DENY), Object.keys(COMPUTER_TOOLS));
  assert.ok(Object.values(COMPUTER_DENY).every((enabled) => enabled === false));
});

test("delegated computer control requires origin opt-in, cannot transfer a session and uses fresh Worker execution leases", async () => {
  const revoked = [];
  const f = fixture({ delegatedOrigin: "one", onRevoke: (scope) => revoked.push(scope) });
  await assert.rejects(f.broker.delegationScope(f.scope), /Allow computer access/);
  await f.enable();
  const pin = await f.broker.delegationScope(f.scope);
  assert.equal(pin.targetId, "this-mac"); pin.assertActive();
  await f.execute("open", openArgs);
  await assert.rejects(f.broker.delegationScope(f.scope), /finish its current native session/);
  await assert.rejects(f.execute("open", openArgs, { slug: "scout", threadId: "worker" }), /earlier turn still owns/);
  await f.broker.endTurn({ id: "execution-scout-one", state: "succeeded" });
  assert.equal(f.counts().closes, 1);
  const worker = { slug: "scout", threadId: "worker" };
  await f.execute("open", openArgs, worker);
  assert.equal(f.counts().connects, 2);
  assert.equal(f.sent.filter((item) => item.name === "computer_open_session").length, 2);
  await f.broker.endTurn({ id: "execution-scout-worker", state: "succeeded" });
  f.setExecution("worker-next", "worker-next-message");
  const stale = payload(await f.execute("act", { observation_id: "old", action: { type: "press", ref: "old" } }, worker));
  assert.equal(stale.ok, false); assert.match(stale.message, /approved app session/);
  assert.equal(f.sent.some((item) => item.name === "computer_act"), false);
  await f.broker.stop({ ...f.scope, expectedRevision: (await f.snapshot()).revision });
  assert.throws(pin.assertActive, /permission or target changed/);
  assert.ok(revoked.some((scope) => scope.threadId === "one" && scope.surface === "computer"));
  await f.broker.reset(true);
});

test("native context must match the exact active tool, input, workspace, message and user execution", () => {
  const input = { slug: "scout", context: { sessionID: "one", messageID: "assistant", callID: "call", directory: "/workspace/scout" }, name: "coworker_computer_open", args: openArgs,
    workspaceId: "workspace-scout", active: true,
    entry: { personRequest: true, continuation: false, sentAt: 1, state: "running", workspaceId: "workspace-scout", messageId: "user", owner: { slug: "scout", threadId: "one", conversationId: "one", kind: "private" } },
    snapshot: { threadId: "one", directory: "/workspace/scout", messages: [
      { id: "user", role: "user", parts: [{ type: "text", text: "Edit it" }] },
      { id: "assistant", role: "assistant", parentId: "user", completedAt: null, parts: [{ type: "tool", callId: "call", tool: "coworker_computer_open", toolStatus: "running", toolInput: openArgs }] },
    ] } };
  assert.doesNotThrow(() => assertComputerToolContext(input));
  const mutations = [
    (value) => { value.active = false; }, (value) => { value.entry.personRequest = false; },
    (value) => { value.entry.continuation = true; }, (value) => { value.entry.state = "cancelled"; },
    (value) => { value.entry.owner.kind = "worker"; }, (value) => { value.workspaceId = "another"; },
    (value) => { value.context.directory = "/elsewhere"; }, (value) => { value.context.sessionID = "two"; },
    (value) => { value.context.callID = "invented"; }, (value) => { value.snapshot.messages[0].parts[0].synthetic = true; },
    (value) => { value.snapshot.messages[1].completedAt = 10; },
    (value) => { value.snapshot.messages[1].parts[0].tool = "bash"; },
    (value) => { value.snapshot.messages[1].parts[0].toolStatus = "completed"; },
    (value) => { value.snapshot.messages[1].parts[0].toolInput.mode = "control"; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(input); changed.args = structuredClone(openArgs); mutate(changed); assert.throws(() => assertComputerToolContext(changed), /exact running tool/); }
});

test("calls waiting in the first ownership lookup or grant lookup cannot inherit Stop and re-enable, even for a Worker", async () => {
  for (const worker of [false, true]) for (const lookup of ["resolve", "discussion"]) {
    const entered = deferred(); const released = deferred();
    let hold = false;
    const wait = async (stage) => {
      if (hold && lookup === stage) { hold = false; entered.resolve(); await released.promise; }
    };
    const f = fixture({ delegatedOrigin: worker ? "one" : undefined,
      resolveContext: () => wait("resolve"), discussionFor: () => wait("discussion") });
    const enabled = await f.enable();
    hold = true;
    const call = f.request("open", openArgs, worker ? { slug: "scout", threadId: "worker" } : f.scope);
    const opening = f.broker.execute("scout", call);
    const rejected = assert.rejects(opening, /revoked.*admitted/);
    await entered.promise;
    await f.broker.stop({ ...f.scope, expectedRevision: enabled.revision });
    await f.enable();
    released.resolve(); await rejected;
    assert.equal(f.counts().connects, 0); assert.deepEqual(f.notifications, []);
    assert.equal((await f.snapshot()).enabled, true, "the stale request must not revoke the new grant");
    await f.broker.reset(true);
  }
});

test("permission changes in another discussion do not abort an admitted active computer call", async () => {
  const entered = deferred(); const released = deferred();
  let hold = false;
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") return result({ ok: true, state: "active", session_id: "native-session" });
    if (hold && name === "computer_observe") { entered.resolve(); await released.promise; }
    return result({ ok: true, observation_id: "fresh", state: name === "computer_close_session" ? "closed" : "active" });
  } });
  await f.enable();
  const other = { slug: "scout", threadId: "two" };
  const otherGrant = await f.enable("this-mac", other);
  await f.execute("open", openArgs);
  hold = true; const observing = f.execute("observe"); await entered.promise;
  await f.broker.stop({ ...other, expectedRevision: otherGrant.revision });
  released.resolve();
  assert.equal(payload(await observing).ok, true);
  assert.equal(f.counts().closes, 0); assert.equal((await f.snapshot()).enabled, true);
  await f.broker.reset(true);
});

test("computer IPC accepts only the actual main window at the expected renderer URL", () => {
  const contents = { mainFrame: { url: "http://localhost:5173/#discussion" } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(trustedComputerSender(event, contents, "http://localhost:5173/"), true);
  assert.equal(trustedComputerSender(event, { mainFrame: contents.mainFrame }, "http://localhost:5173/"), false);
  assert.equal(trustedComputerSender({ ...event, senderFrame: { url: contents.mainFrame.url } }, contents, "http://localhost:5173/"), false);
  for (const url of ["http://localhost:9999/", "https://example.test/", "http://localhost:5173/other", "file:///other/index.html"]) assert.equal(trustedComputerSender(event, contents, url), false);
});

test("discussion opt-in approves only a matching single-window admitted open, including an explicitly delegated Worker", async () => {
  for (const worker of [false, true]) {
    const opened = deferred();
    const f = fixture({ delegatedOrigin: worker ? "one" : undefined,
      callTool: async (name) => {
        if (name === "computer_observe") return observationResult();
        if (name !== "computer_open_session") return result({ ok: true, state: "closed" });
        f.emit(approvalState()); f.emit(approvalState());
        return opened.promise;
      },
      notifyUi: async (value) => {
        if (value.action !== "approve") return;
        f.emit(approvalState({ phase: "working", windowTitle: "Document", canContinue: true }));
        opened.resolve(result({ ok: true, state: "active", session_id: "native-session" }));
      },
    });
    await f.enable();
    const native = await f.execute("open", { ...openArgs, pid: 123 }, worker ? { slug: "scout", threadId: "worker" } : f.scope);
    assert.equal(payload(native).ok, true);
    assert.deepEqual(f.notifications, [{ id: "native-ui", action: "approve", windowId: 12 }]);
    const presentation = await f.broker.presentation({ ...f.scope, visible: true });
    assert.equal(presentation.id, "native-ui");
    assert.equal(presentation.phase, "working");
    assert.equal(presentation.appID, undefined);
    assert.equal(presentation.pid, undefined);
    assert.equal(JSON.stringify(native).includes("native-ui"), false);
    await assert.rejects(f.execute("open", { ...openArgs, skipConsent: true }), /broker/);
    await f.broker.reset(true);
  }
});

test("autoapproval rejects mismatched, malformed, expired, revoked and replaced opening contexts", async () => {
  for (const scenario of ["app", "pid", "mode", "purpose", "windows", "duplicates", "inactive", "abort", "timeout", "workspace", "directory", "execution", "revoked"]) {
    const opened = deferred(); const entered = deferred();
    const f = fixture({ operationMs: scenario === "timeout" ? 10 : 1000, callTool: async (name) => {
      if (name === "computer_open_session") { entered.resolve(); return opened.promise; }
      return result({ ok: true, state: "closed" });
    } });
    await f.enable();
    const opening = f.execute("open", { ...openArgs, pid: 123 });
    await entered.promise;
    const patches = { app: { appID: "com.example.other" }, pid: { pid: 456 }, mode: { mode: "control" }, purpose: { task: "Another task" },
      windows: { windows: [{ id: 12, title: "One" }, { id: 13, title: "Two" }] }, duplicates: { windows: [{ id: 12, title: "One" }, { id: 12, title: "One" }] } };
    if (scenario === "inactive") f.setActive(false);
    if (scenario === "abort") f.controller.abort();
    if (scenario === "timeout") await new Promise((resolve) => setTimeout(resolve, 15));
    if (scenario === "workspace") f.changeWorkspace();
    if (scenario === "directory") f.changeDirectory();
    if (scenario === "execution") f.setExecution("replacement", "replacement-message");
    const revoking = scenario === "revoked" ? f.broker.revoke(f.scope) : null;
    f.emit(approvalState(patches[scenario]));
    await tick(); await tick();
    assert.equal(f.notifications.some((value) => value.action === "approve"), false, scenario);
    opened.resolve(result({ ok: true, state: "active", session_id: "native-session" }));
    await opening; await revoking;
    await f.broker.reset(true);
  }
  const f = fixture(); await f.enable(); await f.execute("discover");
  f.emit(approvalState());
  assert.equal(await f.broker.presentation({ ...f.scope, visible: true }), null, "discovery cannot introduce an approval");
  assert.deepEqual(f.notifications, []);
  await f.broker.reset(true);
});

test("the in-app chooser uses the native ID and offered window, never renderer session identity or the first of many", async () => {
  const opened = deferred(); const entered = deferred();
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_observe") return observationResult();
    if (name === "computer_open_session") { entered.resolve(); return opened.promise; }
    return result({ ok: true, state: "closed" });
  }, notifyUi: async (value) => {
    if (value.action === "approve") {
      f.emit(approvalState({ phase: "working", canContinue: true }));
      opened.resolve(result({ ok: true, state: "active", session_id: "native-session" }));
    }
  } });
  await f.enable(); const opening = f.execute("open", openArgs); await entered.promise;
  f.emit(approvalState({ windows: [{ id: 12, title: "One" }, { id: 13, title: "Two", secret: "DROP" }] }));
  const read = { ...f.scope, visible: true };
  assert.deepEqual((await f.broker.presentation(read)).windows, [{ id: 12, title: "One" }, { id: 13, title: "Two" }]);
  assert.equal(f.notifications.some((value) => value.action === "approve"), false);
  for (const patch of [{ id: "stale" }, { windowId: 999 }, { sessionId: "native-session" }, { threadId: "two" }]) {
    await assert.rejects(f.broker.interact({ ...f.scope, id: "native-ui", action: "approve", windowId: 13, ...patch }));
  }
  assert.equal(f.notifications.some((value) => value.action === "approve"), false);
  await f.broker.interact({ ...f.scope, id: "native-ui", action: "approve", windowId: 13 });
  await opening;
  assert.deepEqual(f.notifications.filter((value) => value.action === "approve"), [{ id: "native-ui", action: "approve", windowId: 13 }]);
  await f.broker.interact({ ...f.scope, id: "native-ui", action: "takeover" });
  f.emit(approvalState({ phase: "paused", canContinue: false }));
  await assert.rejects(f.broker.interact({ ...f.scope, id: "native-ui", action: "resume" }), /native phase/);
  f.emit(approvalState({ phase: "paused", canContinue: true }));
  await f.broker.interact({ ...f.scope, id: "native-ui", action: "resume" });
  assert.deepEqual(f.notifications.filter((value) => ["takeover", "resume"].includes(value.action)).map((value) => value.action), ["takeover", "resume"]);
  await f.broker.reset(true);
});

test("takeover dispatches promptly and resume tolerates ordinary state replacements without revoking on harmless phase changes", async () => {
  for (const changed of ["status", "working", "cannot-continue", "takeover"]) {
    const entered = deferred(); const released = deferred();
    let hold = false;
    const f = fixture({ discussionFor: async () => {
      if (hold) { hold = false; entered.resolve(); await released.promise; }
    }, callTool: async (name) => {
      if (name === "computer_open_session") {
        f.emit(approvalState({ windows: [{ id: 12, title: "One" }, { id: 13, title: "Two" }] }));
        f.emit(approvalState({ phase: "working", canContinue: true }));
        return result({ ok: true, state: "active", session_id: "native-session" });
      }
      return result({ ok: true, observation_id: "fresh", state: name === "computer_close_session" ? "closed" : "active" });
    } });
    await f.enable(); await f.execute("open", openArgs);
    const reads = f.reads();
    hold = true;
    const taking = f.broker.interact({ ...f.scope, id: "native-ui", action: "takeover" });
    assert.equal(f.notifications.at(-1).action, "takeover", "takeover does not await an ownership lookup");
    f.emit(approvalState({ phase: "paused", canContinue: true, status: "The person took over." }));
    await taking;
    assert.deepEqual(f.reads(), reads);
    const taken = f.notifications.length;
    await f.broker.interact({ ...f.scope, id: "native-ui", action: "takeover" });
    assert.equal(f.notifications.length, taken, "already paused satisfies takeover");
    const resuming = f.broker.interact({ ...f.scope, id: "native-ui", action: "resume" });
    const done = changed === "status" ? resuming : assert.rejects(resuming, /no control was resumed/);
    await entered.promise;
    f.emit(approvalState({ phase: changed === "working" ? "working" : "paused", canContinue: changed !== "cannot-continue", status: "Ordinary native update" }));
    if (changed === "takeover") await f.broker.interact({ ...f.scope, id: "native-ui", action: "takeover" });
    released.resolve(); await done;
    assert.equal(f.notifications.filter((value) => value.action === "resume").length, changed === "status" ? 1 : 0);
    assert.equal(f.counts().closes, 0); assert.equal((await f.snapshot()).enabled, true);
    await f.broker.reset(true);
  }
});

test("presentation polls never probe, enter the tool queue or expose watch frames to the model; storage is bounded and scoped", async () => {
  let clock = 1000;
  let hold = false;
  const observed = deferred(); const observing = deferred();
  const f = fixture({ now: () => clock, callTool: async (name) => {
    if (name === "computer_open_session") {
      f.emit(approvalState({ windows: [{ id: 12, title: "One" }, { id: 13, title: "Two" }] }));
      f.emit(approvalState({ phase: "working" }));
      return result({ ok: true, state: "active", session_id: "native-session", expires_in_seconds: 900 });
    }
    if (name === "computer_observe") {
      if (!hold) return observationResult();
      observing.resolve(); return observed.promise;
    }
    return result({ ok: true, state: "closed" });
  } });
  await f.enable(); await f.execute("open", openArgs);
  hold = true;
  const observation = f.execute("observe"); await observing.promise;
  const reads = f.reads(); const count = f.sent.length;
  const input = { ...f.scope, visible: true };
  await f.broker.presentation(input);
  f.emit(watchFrame());
  for (let sequence = 1; sequence <= 70; sequence++) f.emit({ kind: "input", id: "native-ui", sequence, at: clock, action: "click", phase: "dispatched", x: 0.5, y: 0.25, text: "DO_NOT_EXPOSE", key: "secret" });
  const view = await f.broker.presentation(input);
  assert.deepEqual(view.frame, { sequence: 1, capturedAt: 1000, width: 1, height: 1, mimeType: "image/png", data: watchFrame().data });
  assert.equal(view.inputs.length, 64); assert.equal(view.inputs[0].sequence, 7);
  assert.equal(JSON.stringify(view).includes("DO_NOT_EXPOSE"), false);
  view.inputs.length = 0; view.frame.data = "RENDERER_MUTATION";
  for (const patch of [{ id: "foreign" }, { sequence: 0 }, { sequence: 2, data: "not a png" }, { sequence: 2, width: 9000 },
    { sequence: 2, data: `iVBORw0KGgo${"A".repeat(4 * 1024 * 1024)}` }, { sequence: 2, capturedAt: Infinity }]) f.emit(watchFrame(patch));
  f.emit({ kind: "input", id: "native-ui", sequence: 71, at: clock, action: "click", phase: "dispatched", x: 1.1 });
  const unchanged = await f.broker.presentation(input);
  assert.equal(unchanged.frame.sequence, 1); assert.equal(unchanged.inputs.length, 64);
  assert.equal(await f.broker.presentation({ slug: "scout", threadId: "two", visible: true }), null);
  assert.equal(f.sent.length, count); assert.deepEqual(f.reads(), reads);
  assert.ok(f.notifications.every((value) => value.action === "watch"));
  clock += 1501;
  f.emit(watchFrame({ sequence: 2 }));
  assert.equal((await f.broker.presentation(input)).frame, undefined, "heartbeat expiry drops the last frame before watching again");
  f.emit(watchFrame({ sequence: 3 }));
  assert.equal((await f.broker.presentation({ ...input, visible: false })).frame, undefined);
  f.emit(watchFrame({ sequence: 4 }));
  assert.equal((await f.broker.presentation(input)).frame, undefined, "hidden capture cannot reappear");
  observed.resolve(result({ ok: true, observation_id: "model-observation" }));
  assert.equal(JSON.stringify(await observation).includes(watchFrame().data), false);
  f.emit(approvalState({ phase: "paused", canContinue: true }));
  f.emit(watchFrame({ sequence: 5 }));
  assert.equal((await f.broker.presentation(input)).frame, undefined);
  f.emit(approvalState({ phase: "closed" }));
  assert.equal(await f.broker.presentation(input), null);
  f.emit(watchFrame({ sequence: 6 }));
  await tick();
  await f.broker.reset(true);
});

test("denial clears UI data, revokes the discussion and never auto-retries; old helper IDs cannot leak into a later discussion", async () => {
  const opened = deferred(); const entered = deferred();
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") { entered.resolve(); return opened.promise; }
    return result({ ok: true, state: "closed" });
  }, notifyUi: async (value) => {
    if (value.action === "deny") opened.resolve(result({ ok: false, code: "access_denied", next: "human_takeover" }, true));
  } });
  await f.enable(); const opening = f.execute("open", openArgs); await entered.promise;
  f.emit(approvalState({ windows: [{ id: 12, title: "One" }, { id: 13, title: "Two" }] }));
  await f.broker.interact({ ...f.scope, id: "native-ui", action: "deny" });
  assert.equal((await opening).isError, true);
  assert.equal((await f.snapshot()).enabled, false);
  assert.equal(await f.broker.presentation({ ...f.scope, visible: true }), null);
  await assert.rejects(f.execute("open", openArgs), /disabled/);
  const other = { slug: "scout", threadId: "two" };
  await f.enable("this-mac", other); await f.execute("discover", {}, other);
  f.emit(approvalState(), 0); f.emit(watchFrame(), 0);
  assert.equal(await f.broker.presentation({ ...other, visible: true }), null);
  assert.deepEqual(f.notifications, [{ id: "native-ui", action: "deny" }]);
  await f.broker.reset(true);
});

test("changed identities, helper exit and expiry clear presentation; pending or uncertain UI actions never replay", async () => {
  for (const stop of ["identity", "exit", "expiry", "uncertain"]) {
    let clock = 1000;
    const entered = deferred(); const continuing = deferred();
    const f = fixture({ now: () => clock, callTool: async (name) => {
      if (name === "computer_open_session") {
        f.emit(approvalState({ windows: [{ id: 12, title: "One" }, { id: 13, title: "Two" }] }));
        f.emit(approvalState({ phase: "working" }));
        return result({ ok: true, state: "active", session_id: "native-session", expires_in_seconds: 1 });
      }
      if (name === "computer_observe") return observationResult();
      return result({ ok: true, state: "closed" });
    }, notifyUi: async (value) => {
      if (value.action !== "resume") return;
      entered.resolve(); await continuing.promise; throw new Error("Notification delivery is uncertain.");
    } });
    await f.enable(); await f.execute("open", openArgs);
    const read = { ...f.scope, visible: true };
    await f.broker.presentation(read); f.emit(watchFrame());
    assert.equal((await f.broker.presentation(read)).frame.sequence, 1);
    if (stop === "identity") f.emit(approvalState({ id: "replacement-ui", phase: "working" }));
    if (stop === "exit") f.disconnect();
    if (stop === "expiry") clock += 1000;
    if (stop === "uncertain") {
      f.emit(approvalState({ phase: "paused", canContinue: true }));
      const input = { ...f.scope, id: "native-ui", action: "resume" };
      const resuming = f.broker.interact(input);
      await entered.promise;
      await assert.rejects(f.broker.interact(input), /already pending/);
      continuing.resolve();
      await assert.rejects(resuming, /uncertain/);
      assert.equal(f.notifications.filter((value) => value.action === "resume").length, 1);
    }
    assert.equal(await f.broker.presentation(read), null, stop);
    await assert.rejects(f.broker.interact({ ...f.scope, id: "native-ui", action: "takeover" }));
    f.emit(watchFrame({ sequence: 99 }));
    assert.equal(await f.broker.presentation(read), null, stop);
    await f.broker.reset(true);
  }
});

test("voice microphone grants are audio-only and belong to the exact app main frame", async () => {
  const contents = { mainFrame: { url: "file:///coworker/index.html#discussion" } };
  let request, check;
  const session = { setPermissionRequestHandler: (fn) => { request = fn; }, setPermissionCheckHandler: (fn) => { check = fn; } };
  let asks = 0;
  const access = deferred();
  const voice = createVoice({ getSession: () => null, getBaseUrl: () => "https://den.invalid", platform: "darwin",
    systemPreferences: { getMediaAccessStatus: () => "not-determined", askForMediaAccess: async () => { asks++; return access.promise; } } });
  installVoicePermissions(session, () => ({ webContents: contents }), () => "file:///coworker/index.html", voice);
  const details = { isMainFrame: true, requestingUrl: contents.mainFrame.url, mediaType: "audio" };
  const clipboardDetails = { isMainFrame: true, requestingUrl: contents.mainFrame.url };
  let copied;
  assert.equal(check(contents, "clipboard-sanitized-write", "file://", clipboardDetails), true);
  request(contents, "clipboard-sanitized-write", (value) => { copied = value; }, clipboardDetails);
  assert.equal(copied, true);
  for (const [sender, frame] of [
    [contents, { ...clipboardDetails, isMainFrame: false }],
    [contents, { ...clipboardDetails, requestingUrl: "file:///other.html" }],
    [contents, { isMainFrame: true }],
    [contents, { requestingUrl: clipboardDetails.requestingUrl }],
    [contents, undefined],
    [null, { embeddingOrigin: "file://" }],
    [{ mainFrame: contents.mainFrame }, clipboardDetails],
  ]) {
    assert.equal(check(sender, "clipboard-sanitized-write", "file://", frame), false);
    request(sender, "clipboard-sanitized-write", (value) => { copied = value; }, frame);
    assert.equal(copied, false);
  }
  for (const permission of ["clipboard-read", "notifications", "fullscreen"]) {
    assert.equal(check(contents, permission, "file://", clipboardDetails), false);
    request(contents, permission, (value) => { copied = value; }, clipboardDetails);
    assert.equal(copied, false);
  }
  assert.equal(asks, 0);
  assert.equal(check(contents, "media", "file://", details), false);
  const permission = voice.microphone();
  access.resolve(true);
  assert.deepEqual(await permission, { granted: true });
  assert.equal(asks, 1);
  assert.equal(check(contents, "media", "file://", details), true);
  let granted;
  request(contents, "media", (value) => { granted = value; }, { isMainFrame: true, requestingUrl: details.requestingUrl, mediaTypes: ["audio"] });
  assert.equal(granted, true);
  for (const changed of [{ isMainFrame: false }, { requestingUrl: "file:///other.html" }, { requestingUrl: "https://example.test" }, { mediaType: "video" }, { mediaType: "unknown" }, { mediaTypes: ["audio", "video"] }]) {
    assert.equal(check(contents, "media", "file://", { ...details, ...changed }), false);
  }
  assert.equal(check({ mainFrame: contents.mainFrame }, "media", "file://", details), false);
  request(contents, "media", (value) => { granted = value; }, { ...details, mediaType: undefined, mediaTypes: ["audio", "video"] });
  assert.equal(granted, false);
  voice.reset();
  assert.equal(check(contents, "media", "file://", details), false);
  assert.equal(check(contents, "clipboard-sanitized-write", "file://", clipboardDetails), true);
  request(contents, "clipboard-sanitized-write", (value) => { copied = value; }, clipboardDetails);
  assert.equal(copied, true);
  const late = voice.microphone(); voice.reset();
  assert.deepEqual(await late, { granted: false });
});

test("native voice uses the pinned account, validates bounds, and really closes cancelled HTTP requests", async (t) => {
  const arrived = [];
  const closed = [];
  let entered = deferred();
  let disconnected = deferred();
  let mode = "ready";
  const server = createServer((request, response) => {
    arrived.push({ url: request.url, auth: request.headers.authorization, org: request.headers["x-openwork-org-id"] });
    request.resume();
    if (request.url === "/v1/voice") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ access: mode })); return; }
    if (mode === "unavailable") { response.writeHead(403, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "voice_membership_required", message: "private-provider-secret" })); return; }
    if (mode === "transcribe") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ text: "Hello", key: "must-not-cross" })); return; }
    if (mode === "speech") { response.setHeader("content-type", "audio/mpeg"); response.end(Buffer.from("mp3-fixture")); return; }
    if (mode === "oversized") { response.setHeader("content-type", "audio/mpeg"); response.end(Buffer.alloc(2 * 1024 * 1024 + 1)); return; }
    const done = disconnected;
    response.on("close", () => { closed.push(request.url); done.resolve(); });
    entered.resolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let session = { baseUrl, token: "member-session-fixture", orgId: "org-fixture" };
  const voice = createVoice({ getSession: () => session, getBaseUrl: () => baseUrl, timeoutMs: 1000 });
  t.after(() => voice.reset());
  assert.deepEqual(await voice.status(), { access: "ready" });
  mode = "membership_required";
  assert.equal((await voice.status()).access, "membership_required");
  mode = "transcribe";
  assert.deepEqual(await voice.transcribe({ requestId: randomUUID(), data: "YQ==", format: "webm" }), { text: "Hello" });
  mode = "speech";
  assert.deepEqual(await voice.speech({ requestId: randomUUID(), text: "Hello" }), { data: Buffer.from("mp3-fixture").toString("base64"), mimeType: "audio/mpeg" });
  assert.equal(arrived.every((entry) => entry.auth === "Bearer member-session-fixture" && entry.org === "org-fixture"), true);
  const before = arrived.length;
  for (const input of [{ data: "YQ=", format: "webm" }, { data: "YQ==", format: "video" }, { data: "A".repeat(4 * 1024 * 1024 + 4), format: "wav" }]) {
    await assert.rejects(voice.transcribe({ requestId: randomUUID(), ...input }), /voice_invalid_request/);
  }
  await assert.rejects(voice.speech({ requestId: randomUUID(), text: "a".repeat(601) }), /voice_invalid_request/);
  assert.equal(arrived.length, before);
  mode = "oversized";
  await assert.rejects(voice.speech({ requestId: randomUUID(), text: "Hello" }), /voice_payload_too_large/);
  mode = "unavailable";
  await assert.rejects(voice.speech({ requestId: randomUUID(), text: "Hello" }), (error) => error.message.startsWith("voice_membership_required:") && !error.message.includes("secret"));
  mode = "hold";
  for (const changeAccount of [false, true]) {
    entered = deferred(); disconnected = deferred();
    const id = randomUUID();
    const pending = voice.speech({ requestId: id, text: "Wait" });
    const rejected = assert.rejects(pending, /voice_request_cancelled/);
    await entered.promise;
    if (changeAccount) { voice.reset(); session = null; } else await voice.cancel(id);
    await rejected;
    let timer;
    try { await Promise.race([disconnected.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("HTTP request remained open")), 2000); })]); }
    finally { clearTimeout(timer); }
  }
  assert.equal(closed.length, 2);
  assert.equal((await voice.status()).access, "sign_in");
  session = { baseUrl: `${baseUrl}/wrong`, token: "never-send", orgId: "other" };
  assert.equal((await voice.status()).access, "unavailable");
});

test("opt-in and revisions isolate conversations and coworkers; remote never falls back to local", async () => {
  const f = fixture();
  await assert.rejects(f.broker.setup({ permission: "mcp" }), /Choose Accessibility/);
  await f.broker.setup({ permission: "accessibility" });
  const setup = await f.snapshot();
  assert.deepEqual(setup.permissions, { accessibility: true, screenRecording: true });
  assert.equal(setup.enabled, false);
  assert.equal(setup.session, null);
  assert.deepEqual(f.counts(), { connects: 0, closes: 0, setups: 1 });
  await assert.rejects(f.execute("discover"), /disabled/);
  assert.equal((await f.enable("remote")).enabled, false);
  const remote = await f.snapshot();
  assert.equal(remote.targetId, "remote"); assert.equal(remote.readiness, "unavailable");
  assert.equal(remote.permissions, undefined, "another target cannot borrow this Mac's verified permissions");
  assert.match(remote.detail, /compatible remote service/);
  await assert.rejects(f.execute("discover"), /disabled/);
  assert.equal(f.counts().connects, 0);
  const enabled = await f.enable();
  await assert.rejects(f.broker.stop({ ...f.scope, expectedRevision: enabled.revision - 1 }), /settings changed/);
  await f.execute("open", openArgs);
  await assert.rejects(f.broker.setup({ permission: "screenRecording" }), /Stop computer control/);
  for (const other of [{ slug: "scout", threadId: "two" }, { slug: "editor", threadId: "one" }]) {
    assert.equal((await f.broker.snapshot(other)).session, null);
    await assert.rejects(f.enable("this-mac", other), /Another discussion/);
    await assert.rejects(f.execute("observe", {}, other), /disabled/);
  }
  assert.equal((await f.snapshot()).session.windowTitle, "Document");
  await f.broker.reset(true);
});

test("trusted adapters require unique target IDs and the exact computer protocol", () => {
  const { adapter } = fixture();
  for (const adapters of [[], [adapter, adapter], [{ ...adapter, protocol: "another-protocol" }], [{ ...adapter, protocol: undefined }], [{ ...adapter, placement: "browser" }], [{ ...adapter, id: "remote" }]]) {
    assert.throws(() => createComputerControl({ adapters }), /adapter|protocol|reserved/i);
  }
  assert.doesNotThrow(() => createComputerControl({ adapter }));
});

test("an injected remote target pins all calls and setup to that adapter without local fallback", async () => {
  const cloud = cloudFixture();
  const f = fixture({ adapters: [cloud.adapter] });
  const snapshot = await f.enable(cloud.adapter.id);
  assert.equal(snapshot.targetId, cloud.adapter.id);
  assert.equal(snapshot.detail, "The remote computer is ready.");
  assert.deepEqual(snapshot.targets.map((item) => item.id), ["this-mac", cloud.adapter.id]);
  await f.broker.setup({ targetId: cloud.adapter.id, permission: "accessibility" });
  assert.equal(cloud.counts().setups, 1); assert.equal(f.counts().setups, 0);
  await f.execute("open", openArgs);
  await f.execute("observe", { include_image: false });
  const action = f.request("act", { observation_id: "remote-observation", action: { type: "press", ref: "button" } });
  await f.broker.execute("scout", action);
  assert.equal(cloud.sent.at(-1).args.session_id, "remote-session");
  assert.equal(f.counts().connects, 0); assert.equal(f.sent.length, 0);
  await f.enable("this-mac");
  assert.equal(cloud.counts().closes, 1);
  assert.equal(f.counts().connects, 0, "switching a target must not open a replacement session");
  await assert.rejects(f.broker.execute("scout", action), /another computer/);
  await f.execute("discover");
  assert.equal(f.counts().connects, 1);
  await f.broker.reset(true);
});

test("unavailable, failing and incompatible remote readiness never routes calls to this Mac", async () => {
  for (const readiness of [
    async () => ({ readiness: "unavailable", detail: "Remote session is disconnected." }),
    async () => { throw new Error("Remote readiness failed"); },
    async () => ({ readiness: "invented", detail: "Invalid status" }),
  ]) {
    const cloud = cloudFixture({ id: "remote", readiness });
    const f = fixture({ adapters: [cloud.adapter] });
    const snapshot = await f.enable("remote");
    assert.equal(snapshot.targetId, "remote"); assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.readiness, "unavailable");
    assert.doesNotMatch(snapshot.detail, /This Mac/);
    await assert.rejects(f.execute("discover"), /disabled/);
    assert.equal(f.counts().connects, 0); assert.equal(cloud.counts().connects, 0);
  }
  const cloud = cloudFixture();
  const f = fixture({ adapters: [{ ...cloud.adapter, connect: async () => { throw new Error("The remote computer disconnected before admission."); } }] });
  await f.enable(cloud.adapter.id);
  assert.equal(payload(await f.execute("open", openArgs)).code, "operation_interrupted");
  assert.equal((await f.snapshot()).targetId, cloud.adapter.id);
  assert.equal(f.counts().connects, 0);
});

test("target changes cannot release an uncertain remote lease or silently select the local computer", async () => {
  const cloud = cloudFixture();
  const f = fixture({ adapters: [{ ...cloud.adapter, connect: async () => {
    const connection = await cloud.adapter.connect();
    return { ...connection, close: async () => { throw new Error("Remote session revocation is unconfirmed, despite HTTP disconnect."); } };
  } }] });
  await f.enable(cloud.adapter.id); await f.execute("open", openArgs);
  const changed = await f.enable("this-mac");
  assert.equal(changed.targetId, cloud.adapter.id);
  assert.equal(changed.enabled, false); assert.equal(changed.cleanupPending, true);
  assert.equal(f.counts().connects, 0);
  await assert.rejects(f.execute("discover"), /disabled/);
});

test("paused open keeps the tool and native Continue panel alive, then requires a fresh observation", async () => {
  const polling = deferred();
  let continued = false;
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "paused", next: "human_takeover", window_title: "Document" });
    if (name === "computer_session_status") {
      polling.resolve();
      return result({ ok: true, state: continued ? "active" : "paused", phase: continued ? "ready" : "waiting-for-person", next: continued ? "observe" : "human_takeover" });
    }
    return result({ ok: true, ...(name === "computer_observe" ? { observation_id: "fresh" } : {}), state: name === "computer_close_session" ? "closed" : "active" });
  } });
  await f.enable();
  let finished = false;
  const opening = f.execute("open", { ...openArgs, mode: "control" }).then((value) => { finished = true; return value; });
  await polling.promise;
  const live = await f.snapshot();
  assert.equal(live.session.state, "paused"); assert.equal(live.session.phase, "waiting-for-person");
  assert.equal(finished, false); assert.equal(f.counts().closes, 0);
  continued = true;
  const opened = await opening;
  assert.equal(payload(opened).state, "active"); assert.equal(payload(opened).fresh_observation_required, true);
  const action = { observation_id: "stale", action: { type: "press", ref: "button" } };
  assert.equal(payload(await f.execute("act", action)).code, "observation_required");
  assert.equal(f.sent.filter((item) => item.name === "computer_act").length, 0);
  await f.execute("observe", { include_image: false });
  await f.execute("act", { ...action, observation_id: "fresh" });
  assert.equal(f.sent.filter((item) => item.name === "computer_act").length, 1);
  assert.ok(f.sent.every((item) => !/resume|continue/.test(item.name)));
  await f.broker.endTurn({ id: "execution-scout-one" });
});

test("native Stop, explicit Stop, native cancellation and timeout interrupt a paused handoff", async () => {
  for (const stop of ["native-stop", "ui-stop", "cancel", "timeout", "inactive-call", "status-error"]) {
    const polling = deferred();
    let nativeStop = false;
    const f = fixture({ operationMs: stop === "timeout" ? 80 : 1000, callTool: async (name) => {
      if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "paused", next: "human_takeover" });
      if (name === "computer_session_status") {
        polling.resolve();
        if (stop === "status-error") return result({ ok: false, code: "status_failed" }, true);
        return nativeStop ? result({ ok: false, code: "session_unavailable" }, true) : result({ ok: true, state: "paused", next: "human_takeover" });
      }
      return result({ ok: true, state: "closed" });
    } });
    await f.enable();
    const opening = f.execute("open", { ...openArgs, mode: "control" });
    await polling.promise;
    if (stop === "native-stop") nativeStop = true;
    if (stop === "ui-stop") await f.broker.stop({ ...f.scope, expectedRevision: (await f.snapshot()).revision });
    if (stop === "cancel") f.controller.abort(new Error("Native tool cancelled"));
    if (stop === "inactive-call") f.setActive(false);
    const stopped = await opening;
    assert.equal(stopped.isError, true, stop);
    assert.equal(payload(stopped).code, stop === "native-stop" ? "session_unavailable" : stop === "status-error" ? "status_failed" : "handoff_interrupted", stop);
    const snapshot = await f.snapshot();
    assert.equal(snapshot.enabled, false, stop); assert.equal(snapshot.session, null, stop);
    assert.equal(f.counts().closes, 1, stop);
  }
});

test("takeover observed between calls waits in the next tool without replaying a stale action", async () => {
  let continued = false;
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "active" });
    if (name === "computer_observe") return observationResult();
    if (name === "computer_session_status") {
      return result({ ok: true, state: continued ? "active" : "paused", next: continued ? "observe" : "human_takeover" });
    }
    return result({ ok: true, state: "closed" });
  } });
  await f.enable(); await f.execute("open", openArgs);
  assert.equal((await f.snapshot()).session.state, "paused");
  let finished = false;
  const acting = f.execute("act", { observation_id: "before-takeover", action: { type: "press", ref: "button" } }).then((value) => { finished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(finished, false);
  continued = true;
  assert.equal(payload(await acting).code, "observation_required");
  assert.equal(f.sent.filter((item) => item.name === "computer_act").length, 0);
  assert.equal((await f.snapshot()).session.state, "active");
  await f.broker.endTurn({ id: "execution-scout-one" });
});

test("Continue and cancellation after an action preserve its receipt without redispatch", async () => {
  for (const cancel of [false, true]) {
    const polling = deferred();
    let continued = false;
    const receipt = result({ ok: false, code: "input_uncertain", state: "paused", next: "human_takeover", receipt: { status: "uncertain", dispatched: true } }, true);
    const f = fixture({ callTool: async (name) => {
      if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "active" });
      if (name === "computer_observe") return observationResult();
      if (name === "computer_act") return receipt;
      if (name === "computer_session_status") {
        polling.resolve();
        return result({ ok: true, state: continued ? "active" : "paused", next: continued ? "observe" : "human_takeover" });
      }
      return result({ ok: true, state: "closed" });
    } });
    await f.enable(); await f.execute("open", openArgs);
    const call = f.request("act", { observation_id: "observed", action: { type: "press", ref: "button" } });
    const acting = f.broker.execute("scout", call);
    await polling.promise;
    if (cancel) f.controller.abort(); else continued = true;
    const response = await acting;
    assert.deepEqual(response.content[0], receipt.content[0]);
    assert.equal(JSON.parse(response.content[1].text).actions_replayed, false);
    assert.equal(f.sent.filter((item) => item.name === "computer_act").length, 1);
    if (!cancel) {
      assert.deepEqual(await f.broker.execute("scout", call), response);
      assert.equal(payload(await f.execute("act", call.args)).code, "observation_required");
    }
    await f.broker.reset(true);
  }
});

test("stop revokes immediately, serializes a late open, and retains uncertain cleanup", async () => {
  const opened = deferred();
  const dispatched = deferred();
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") { dispatched.resolve(); return opened.promise; }
    return result({ ok: true, state: "closed" });
  } });
  await f.enable();
  const opening = f.execute("open", openArgs);
  await dispatched.promise;
  const stopped = await f.broker.stop({ ...f.scope, expectedRevision: (await f.snapshot()).revision });
  assert.equal(stopped.enabled, false); assert.equal(stopped.cleanupPending, true);
  await assert.rejects(f.execute("discover"), /disabled/);
  opened.resolve(result({ ok: true, session_id: "late-session", state: "active" }));
  const late = await opening;
  assert.equal(payload(late).session_id, "late-session", "the native open receipt remains intact");
  assert.equal(postStatus(late).ok, false);
  assert.equal(f.sent.some((item) => item.name === "computer_observe"), false);
  await tick();
  assert.equal((await f.snapshot()).session, null);
  assert.ok(f.counts().closes >= 1);
});

test("a connect that acknowledges after revoke is closed without opening a native session", async () => {
  const connecting = deferred();
  const started = deferred();
  const f = fixture({ connect: async () => { started.resolve(); await connecting.promise; } });
  await f.enable();
  const opening = f.execute("open", openArgs);
  await started.promise;
  const stopped = await f.broker.stop({ ...f.scope, expectedRevision: (await f.snapshot()).revision });
  assert.equal(stopped.cleanupPending, true);
  connecting.resolve();
  await opening; await tick();
  assert.equal(f.sent.length, 0); assert.equal(f.counts().closes, 1);
  assert.equal((await f.snapshot()).cleanupPending, undefined);
});

test("unconfirmed helper shutdown during connection setup never claims to release the machine", async () => {
  const f = fixture({ connect: async () => { throw new AggregateError([new Error("setup"), new Error("shutdown")], "Shutdown was not confirmed"); } });
  await f.enable();
  assert.equal(payload(await f.execute("open", openArgs)).code, "operation_interrupted");
  assert.equal((await f.snapshot()).cleanupPending, true);
  await assert.rejects(f.enable("this-mac", { slug: "scout", threadId: "two" }), /Another discussion/);
  assert.equal((await f.broker.stop({ ...f.scope, expectedRevision: (await f.snapshot()).revision })).cleanupPending, true);
});

test("native errors and uncertain dispatch receipts are preserved and never replayed", async () => {
  const uncertain = result({ ok: false, code: "input_failed", receipt: { status: "uncertain", dispatched: true }, next: "observe" }, true);
  const f = fixture({ callTool: async (name) => name === "computer_open_session" ? result({ ok: true, session_id: "native-session", state: "active" }) : name === "computer_act" ? uncertain : name === "computer_observe" ? observationResult() : result({ ok: true, state: "closed" }) });
  await f.enable(); await f.execute("open", openArgs);
  const call = f.request("act", { observation_id: "observed", action: { type: "press", ref: "ref" } });
  assert.deepEqual(await f.broker.execute("scout", call), uncertain);
  assert.deepEqual(await f.broker.execute("scout", call), uncertain);
  const actions = f.sent.filter((item) => item.name === "computer_act");
  assert.equal(actions.length, 1);
  assert.match(actions[0].args.request_id, /^[a-f0-9]{64}$/);
  assert.equal(actions[0].args.session_id, "native-session");
  await assert.rejects(f.broker.execute("scout", { ...call, args: { ...call.args, action: { type: "press", ref: "changed" } } }), /different input/);
  await assert.rejects(f.execute("act", { ...call.args, request_id: "model-random" }), /broker/);
  await f.broker.reset(true);
});

test("native operations serialize and another enabled discussion cannot borrow the connection", async () => {
  const observing = deferred();
  const observed = deferred();
  let hold = false;
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "active" });
    if (name === "computer_observe") {
      if (!hold) return observationResult();
      observing.resolve(); return observed.promise;
    }
    return result({ ok: true, state: "active" });
  } });
  const other = { slug: "scout", threadId: "two" };
  await f.enable(); await f.enable("this-mac", other); await f.execute("open", openArgs);
  hold = true;
  const observation = f.execute("observe");
  await observing.promise;
  const action = f.execute("act", { observation_id: "observed", action: { type: "press", ref: "button" } });
  const rejected = assert.rejects(f.execute("discover", {}, other), /Another discussion/);
  await tick();
  assert.equal(f.sent.filter((item) => item.name === "computer_act").length, 0);
  observed.resolve(result({ ok: true, observation_id: "observed" }));
  await Promise.all([observation, action, rejected]);
  assert.deepEqual(f.sent.map((item) => item.name), ["computer_open_session", "computer_observe", "computer_observe", "computer_act"]);
  assert.equal(f.counts().connects, 1);
  await f.broker.reset(true);
});

test("native approval denial is preserved verbatim and requires a fresh person enable", async () => {
  const denied = result({ ok: false, code: "permission_denied", message: "The person declined.", next: "human_takeover" }, true);
  const f = fixture({ callTool: async () => denied });
  await f.enable();
  assert.deepEqual(await f.execute("open", openArgs), denied);
  assert.equal((await f.snapshot()).enabled, false);
  await assert.rejects(f.execute("open", openArgs), /disabled/);
  assert.equal(f.sent.length, 1);
});

test("native cancellation can beat HTTP admission and prevents a delayed call from opening", async () => {
  let hold = false;
  const blocked = deferred();
  const entered = deferred();
  const f = fixture({ discussionFor: async () => { if (hold) { entered.resolve(); await blocked.promise; } } });
  await f.enable();
  hold = true;
  const call = f.request("open", openArgs);
  const opening = f.broker.execute("scout", call);
  await entered.promise;
  assert.equal(payload(await f.broker.execute("scout", { ...call, cancel: true })).code, "cancelled");
  blocked.resolve(); hold = false;
  await assert.rejects(opening, /disabled/);
  await f.enable();
  await assert.rejects(f.broker.execute("scout", call), /cancelled before admission/);
  assert.equal(f.counts().connects, 0);
});

test("native Stop observed in status revokes opt-in rather than reopening a session", async () => {
  const stopped = result({ ok: false, code: "session_unavailable", message: "Stopped by the person." }, true);
  const f = fixture({ callTool: async (name) => name === "computer_open_session" ? result({ ok: true, session_id: "native-session", state: "active" }) : name === "computer_observe" ? observationResult() : stopped });
  await f.enable(); await f.execute("open", openArgs);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.enabled, false); assert.equal(snapshot.session, null);
  await assert.rejects(f.execute("open", openArgs), /disabled/);
  assert.equal(f.counts().connects, 1);
});

test("transport failure during act is uncertain, disables the grant, and cannot replay", async () => {
  const f = fixture({ callTool: async (name) => {
    if (name === "computer_open_session") return result({ ok: true, session_id: "native-session", state: "active" });
    if (name === "computer_observe") return observationResult();
    if (name === "computer_act") throw new Error("Lost the response after dispatch");
    return result({ ok: true, state: "closed" });
  } });
  await f.enable(); await f.execute("open", openArgs);
  const call = f.request("act", { observation_id: "observed", action: { type: "click", x: 2, y: 3 } });
  const first = await f.broker.execute("scout", call);
  assert.equal(payload(first).code, "dispatch_uncertain");
  await assert.rejects(f.broker.execute("scout", call), /disabled/);
  await f.enable();
  assert.deepEqual(await f.broker.execute("scout", call), first);
  assert.equal(f.sent.filter((item) => item.name === "computer_act").length, 1);
});

test("unconfirmed close keeps the machine reserved until an explicit cleanup succeeds", async () => {
  let broken = true;
  const f = fixture({ close: async () => { if (broken) throw new Error("Not confirmed"); } });
  await f.enable(); await f.execute("open", openArgs);
  const stopped = await f.broker.stop({ ...f.scope, expectedRevision: (await f.snapshot()).revision });
  assert.equal(stopped.cleanupPending, true); assert.equal(stopped.session.state, "stopping");
  assert.equal(stopped.targets[0].available, false);
  await assert.rejects(f.enable("this-mac", { slug: "scout", threadId: "two" }), /Another discussion/);
  broken = false;
  const cleared = await f.broker.stop({ ...f.scope, expectedRevision: stopped.revision });
  assert.equal(cleared.cleanupPending, undefined); assert.equal(cleared.session, null);
});

test("turn cleanup reports failure and reset refuses to announce or run a successful replacement", async () => {
  let failed = true;
  const f = fixture({ close: async () => { if (failed) throw new Error("Session revocation failed"); } });
  await f.enable(); await f.execute("open", openArgs);
  await assert.rejects(f.broker.endTurn({ id: "execution-scout-one" }), /revocation could not be confirmed.*Use Stop/);
  let restarted = false;
  const reset = await f.broker.reset(false, async () => { restarted = true; });
  assert.deepEqual(reset, { confirmed: false }); assert.equal(restarted, false);
  assert.equal((await f.snapshot()).cleanupPending, true);
  failed = false;
  assert.deepEqual(await f.broker.reset(false, async () => "replacement"), { confirmed: true, value: "replacement" });
});

test("native Stop before a status poll revokes opt-in when cleanup or the close tool finds the ended session", async () => {
  for (const viaTool of [false, true]) {
    const f = fixture({ callTool: async (name) => name === "computer_open_session"
      ? result({ ok: true, session_id: "native-session", state: "active" })
      : name === "computer_observe" ? observationResult() : result({ ok: false, code: "session_unavailable", next: "open_session" }, true) });
    await f.enable(); await f.execute("open", openArgs);
    if (viaTool) assert.equal(payload(await f.execute("close")).code, "session_unavailable");
    else await f.broker.endTurn({ id: "execution-scout-one" });
    const snapshot = await f.snapshot();
    assert.equal(snapshot.enabled, false); assert.equal(snapshot.session, null);
    await assert.rejects(f.execute("open", openArgs), /disabled/);
  }
});

test("turn completion closes a session but not opt-in; stopped calls and stale cancellation cannot reopen it", async () => {
  const f = fixture();
  await f.enable();
  const call = f.request("open", openArgs);
  await f.broker.execute("scout", call);
  await f.broker.endTurn({ id: "another-execution" });
  assert.equal(f.counts().closes, 0);
  await f.broker.endTurn({ id: "execution-scout-one" });
  assert.equal((await f.snapshot()).enabled, true); assert.equal((await f.snapshot()).session, null);
  await assert.rejects(f.broker.execute("scout", { ...call, cancel: true }), /matching admitted/);
  f.setActive(false);
  await assert.rejects(f.execute("discover"), /Native call stopped/);
  assert.equal(f.counts().connects, 1);
});

test("cancelling saved message A does not revoke message B's active computer execution", async () => {
  // This lifecycle unit check needs no built SDK or engine. Only transcript and
  // interaction helpers are substituted; cancellation and settlement run as-is.
  const collaborationUrl = new URL("./collaboration.mjs", import.meta.url).href;
  const helpers = {
    "@openwork/headless-threads": 'export const isRunning = (status) => status.type !== "idle"; export const toTranscript = (snapshot) => ({ messages: snapshot.messages.map((message) => ({ ...message, text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\\n") })) });',
    "../src/lib/threads.ts": "export const hasPendingInteractions = () => false; export const stalledRetry = () => null;",
  };
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === collaborationUrl && Object.hasOwn(helpers, specifier)) return { url: `data:text/javascript,${encodeURIComponent(helpers[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  } });
  let createCollaboration;
  try { ({ createCollaboration } = await import(collaborationUrl)); } finally { hook.deregister(); }
  const directory = await mkdtemp(path.join(tmpdir(), "coworker-computer-cancel-"));
  const f = fixture();
  const messages = [];
  let busy = false;
  const snapshot = () => ({ threadId: "one", title: "Discussion", directory: "/workspace/scout", status: { type: busy ? "busy" : "idle" }, todos: [], messages });
  const client = {
    workspaceId: "workspace-scout", getThreadSnapshot: async () => snapshot(),
    sendTurn: async (threadId, input) => {
      busy = input.prompt === "B";
      messages.push({ id: input.messageId, role: "user", parts: [{ type: "text", text: input.prompt }] },
        { id: `reply-${input.messageId}`, role: "assistant", parentId: input.messageId, completedAt: Date.now(), error: null, parts: [{ type: "text", text: "Reply" }] });
      return { threadId, messageId: input.messageId, messageCountBefore: messages.length - 2, acceptedAt: Date.now() };
    },
    waitForThread: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return { outcome: busy ? "timeout" : "settled", snapshot: snapshot(), terminalError: null }; },
    abortThread: async () => { busy = false; return { accepted: true }; },
  };
  const service = createCollaboration({ directory, clientFor: async () => client, pollMs: 2, setupTimeoutMs: 500, acceptanceTimeoutMs: 1000,
    onExecutionEnd: (entry) => f.broker.endTurn(entry), consult: async () => {}, spawn: async () => {}, cancelWorker: async () => {} });
  try {
    const owner = { slug: "scout", threadId: "one", kind: "private", conversationId: "one" };
    const a = await service.submit({ owner, messageId: "message-A", prompt: "A", track: true });
    await service.wait(a.id);
    const b = await service.submit({ owner, messageId: "message-B", prompt: "B", track: true });
    await service.acceptance(b.id);
    f.setExecution(b.id, b.messageId);
    await f.enable(); await f.execute("open", openArgs);
    await service.cancelThread("scout", "one", a.messageId);
    assert.equal(f.counts().closes, 0);
    assert.equal((await f.snapshot()).enabled, true);
    assert.equal((await service.read((state) => state.executions[b.id])).state, "running");
    await service.cancelThread("scout", "one", b.messageId);
    assert.equal(f.counts().closes, 1);
    assert.equal((await f.snapshot()).enabled, false);
  } finally { await service.stop(); await f.broker.reset(true); await rm(directory, { recursive: true, force: true }); }
});

test("native abort, restart, retirement and invalid saved ownership revoke access", async () => {
  for (const mode of ["abort", "restart", "retire", "invalid", "workspace"]) {
    const f = fixture();
    await f.enable(); await f.execute("open", openArgs);
    if (mode === "abort") {
      f.controller.abort();
      await f.broker.endTurn({ id: "execution-scout-one" });
    } else if (mode === "restart") await f.broker.reset();
    else if (mode === "retire") await f.broker.revoke({ slug: "scout" });
    else if (mode === "invalid") { f.discussions.delete("scout:one"); await assert.rejects(f.snapshot(), /saved private/); }
    else { f.changeWorkspace(); await assert.rejects(f.snapshot(), /workspace changed/); }
    assert.equal(f.counts().closes, 1, mode);
    await assert.rejects(f.execute("discover"), /disabled|stopped|saved private|workspace changed/, mode);
  }
});

test("restart denies admission throughout replacement and invalidates pre-restart reads", async () => {
  const reading = deferred();
  const read = deferred();
  let hold = false;
  const f = fixture({ discussionFor: async () => { if (hold) { reading.resolve(); await read.promise; } } });
  await f.enable();
  hold = true;
  const stale = f.snapshot();
  await reading.promise;
  await f.broker.reset(false, async () => {
    await assert.rejects(f.snapshot(), /stopping/);
    await assert.rejects(f.execute("discover"), /stopping|restarted/);
  });
  hold = false; read.resolve();
  await assert.rejects(stale, /restarted/);
  assert.equal((await f.snapshot()).enabled, false);
});

test("observations keep images in native content; UI snapshots never contain them", async () => {
  const f = fixture();
  await f.enable(); await f.execute("open", openArgs);
  const observation = await f.execute("observe", { include_image: true });
  assert.equal(observation.content[1].data, "IMAGE_DATA");
  assert.equal(JSON.stringify(await f.snapshot()).includes("IMAGE_DATA"), false);
  await f.broker.reset(true);
});
