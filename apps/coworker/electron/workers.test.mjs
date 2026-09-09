import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createCoworker, getCoworker, updateCoworker } from "./coworkers.mjs";
import { createCoworkerToolsServer, handleMcpMessage } from "./coworker-tools.mjs";
import { assertControlOrigin, assertWorkerSupervisor, createWorkerControls, WORKER_MANAGEMENT } from "./worker-controls.mjs";
import { createHeadlessThreadClient } from "@openwork/headless-threads";
import { createCollaboration, withAbort } from "./collaboration.mjs";
import {
  DEFAULT_TURN_BUDGET,
  MAX_LIVE_WORKERS,
  WORKERS_REGISTRY_FILE,
  appendWorkerEvent,
  abortWorkerThread,
  createReviewScheduler,
  createWorker,
  createWorkerToolHandlers,
  describeLifespanForPrompt,
  getWorker,
  lifespanFromToolArgs,
  lifespanSpent,
  listWorkers,
  liveWorkers,
  nextWorkerState,
  normalizeLifespan,
  parseEvents,
  parseWorkerReport,
  prepareWorkerTurn,
  queueWorkerSteer,
  readWorkerEvents,
  readWorkerRegistry,
  registerWorkerThread,
  resolveWorkerModel,
  updateWorker,
  workerThreadTitle,
  workerToolCatalog,
  workerTurnOutcome,
  workerTurnTools,
  withWorkerCancellation,
} from "./workers.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-workers-"));
  roots.push(root);
  const coworkersDir = path.join(root, "coworkers");
  await createCoworker(coworkersDir, { name: "Scout" });
  return coworkersDir;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = Date.UTC(2026, 8, 2, 15, 0);

async function controlFixture(surface = "browser", overrides = {}) {
  const directory = await fixture();
  const worker = await createWorker(directory, "scout", { name: "Review", goal: "Review the supplied draft", spawnedBy: "person", spawnedFromThreadId: "origin", control: surface, lifespan: { kind: "turns", max: 3 } });
  const liveRuns = new Map();
  const drains = [];
  let active = true;
  const options = {
    discussionFor: async (slug, threadId) => { assert.equal(slug, "scout"); assert.equal(threadId, "origin"); return { workspaceId: "workspace", directory: "/workspace/scout" }; },
    taskFor: async () => ({ assertActive: () => { if (!active) throw new Error("Origin cancelled"); } }),
    readWorker: (slug, id) => getWorker(directory, slug, id), updateWorker: (slug, id, patch) => updateWorker(directory, slug, id, patch), liveRuns,
    stopNative: abortWorkerThread,
    browser: { revokeOrigin: async (scope) => { drains.push(scope); return true; } },
    computer: { delegationScope: async () => ({ assertActive() {} }), endTurn: async (entry) => { drains.push(entry); } },
    ...overrides,
  };
  const controls = createWorkerControls(options);
  const read = async () => controls.summary(await getWorker(directory, "scout", worker.id));
  const approve = async () => controls.approve(await read(), (await read()).control.revision);
  async function start() {
    const next = await prepareWorkerTurn(directory, "scout", worker.id, "Scout");
    await updateWorker(directory, "scout", worker.id, { threadId: "worker-session" });
    const name = surface === "browser" ? "coworker_browser_tabs" : "coworker_computer_discover";
    const context = { sessionID: "worker-session", messageID: "assistant", callID: "call", directory: "/workspace/scout" };
    const snapshot = { threadId: "worker-session", directory: context.directory, messages: [
      { id: next.pendingTurn.messageId, role: "user", parts: [{ type: "text", text: next.pendingTurn.prompt }] },
      { id: "assistant", role: "assistant", parentId: next.pendingTurn.messageId, completedAt: null, parts: [{ type: "tool", tool: name, callId: "call", toolStatus: "running", toolInput: {} }] },
    ] };
    const run = { active: true, controller: new AbortController(), entry: { id: "worker-execution", state: "running", sentAt: 1, workspaceId: "workspace", owner: { slug: "scout", kind: "worker", threadId: context.sessionID, conversationId: context.sessionID }, messageId: next.pendingTurn.messageId }, client: { getThreadSnapshot: async () => snapshot, abortThread: async () => ({ accepted: true }), waitUntilIdle: async () => ({ outcome: "settled" }) } };
    liveRuns.set(`scout:${worker.id}`, run);
    await controls.admit(next, run);
    return { run, snapshot, context, expected: { name, args: {} } };
  }
  return { directory, worker, controls, options, read, approve, start, liveRuns, drains, cancelOrigin: () => { active = false; } };
}

test("control requests persist paused, grants do not survive restart, and one origin has one controller", async () => {
  const f = await controlFixture();
  assert.equal((await f.read()).status, "paused");
  assert.equal((await f.read()).control.state, "needs-approval");
  assert.equal(f.controls.allowed(await f.read()), false);
  const before = await f.read();
  await assert.rejects(f.controls.approve(before, before.control.revision - 1), /Refresh/);
  const approved = await f.approve();
  assert.equal(approved.control.state, "approved");
  assert.equal(approved.status, "waiting");
  assert.equal(f.controls.allowed(approved), true);
  assert.throws(() => f.controls.assertAvailable("scout", "origin", "computer"), /Worker owns/);
  assert.doesNotThrow(() => f.controls.assertAvailable("scout", "other", "browser"));
  const sibling = await createWorker(f.directory, "scout", { name: "Other", goal: "Other goal", control: "computer", spawnedBy: "person", spawnedFromThreadId: "origin" });
  await assert.rejects(f.controls.approve(sibling, f.controls.summary(sibling).control.revision), /Worker owns/);
  const restarted = createWorkerControls(f.options);
  assert.equal(restarted.summary(await getWorker(f.directory, "scout", f.worker.id)).control.state, "needs-approval");
  assert.equal(restarted.allowed(await getWorker(f.directory, "scout", f.worker.id)), false);
  await f.controls.reset(true); await restarted.reset(true);
});

test("Worker control validates its actual native principal, exact call and origin without impersonating the discussion", async () => {
  for (const surface of ["browser", "computer"]) {
    const f = await controlFixture(surface);
    await f.approve();
    const { run, snapshot, context, expected } = await f.start();
    const trusted = await f.controls.resolve("scout", context, expected, surface);
    assert.equal(trusted.entry.owner.kind, "worker");
    assert.equal(trusted.entry.owner.threadId, "worker-session");
    assert.equal(trusted.origin.threadId, "origin");
    assert.equal(trusted.signal, run.controller.signal);
    for (const patch of [{ messageID: "other" }, { callID: "other" }, { directory: "/another" }]) await assert.rejects(f.controls.resolve("scout", { ...context, ...patch }, expected, surface), /exact running native/);
    await assert.rejects(f.controls.resolve("scout", context, { ...expected, args: { forged: true } }, surface), /exact running native/);
    await assert.rejects(f.controls.resolve("scout", context, expected, surface === "browser" ? "computer" : "browser"), /no active control/);
    assert.equal(await f.controls.resolve("other", context, expected, surface), null);
    snapshot.messages[1].completedAt = 10;
    await assert.rejects(f.controls.resolve("scout", context, expected, surface), /exact running native/);
    snapshot.messages[1].completedAt = null;
    f.cancelOrigin();
    assert.throws(trusted.assertActive, /Origin cancelled/);
    await f.controls.reset(true);
  }
});

test("revocation aborts before failed persistence, blocks successors through drain, and stale cleanup cannot stop a successor", async () => {
  const f = await controlFixture();
  await f.approve();
  const { run, context, expected } = await f.start();
  const release = Promise.withResolvers();
  const idle = Promise.withResolvers();
  const idleEntered = Promise.withResolvers();
  run.client.waitUntilIdle = async () => { idleEntered.resolve(); return idle.promise; };
  let waiting = true;
  f.options.browser.revokeOrigin = async (scope) => { f.drains.push(scope); if (waiting) await release.promise; return true; };
  const revision = (await f.read()).control.revision;
  const stopping = f.controls.revokeKnown("scout", f.worker.id, revision);
  assert.equal(run.controller.signal.aborted, true);
  assert.equal((await f.read()).control.state, "revoked");
  assert.equal((await f.read()).cleanupPending, true);
  await assert.rejects(f.controls.resolve("scout", context, expected, "browser"), /no active control/);
  assert.throws(() => f.controls.assertAvailable("scout", "origin"), /Worker owns/);
  waiting = false; release.resolve();
  await idleEntered.promise;
  assert.throws(() => f.controls.assertAvailable("scout", "origin"), /Worker owns/, "abort acknowledgement is not native idle");
  idle.resolve({ outcome: "settled" });
  assert.equal(await stopping, true);
  assert.throws(() => f.controls.assertAvailable("scout", "origin"), /Worker owns/, "the old native run still holds its reservation");
  f.liveRuns.clear(); f.controls.releaseRun(run);
  assert.equal((await f.read()).cleanupPending, false);
  const sibling = await createWorker(f.directory, "scout", { name: "Next", goal: "Next goal", control: "browser", spawnedBy: "person", spawnedFromThreadId: "origin" });
  await f.controls.approve(sibling, f.controls.summary(sibling).control.revision);
  const count = f.drains.length;
  await f.controls.endRun(run);
  assert.equal(f.drains.length, count, "old cleanup must not touch the newly approved browser controller");
  await f.controls.reset(true);

  const broken = await controlFixture("browser", { updateWorker: async () => { throw new Error("disk unavailable"); } });
  await assert.rejects(broken.approve(), /disk unavailable/);
  assert.equal((await broken.read()).control.state, "revoked");
  assert.match((await broken.read()).control.detail, /could not be updated/);
  assert.equal(broken.controls.allowed(await broken.read()), false);
  await broken.controls.reset(true);
});

test("approval races, permission changes, expiry and uncertain cleanup fail closed", async () => {
  const setup = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const f = await controlFixture("browser", { discussionFor: () => { entered.resolve(); return setup.promise; } });
  const approving = f.approve();
  await entered.promise;
  const stopping = f.controls.revokeKnown("scout", f.worker.id, (await f.read()).control.revision);
  setup.resolve({ workspaceId: "workspace", directory: "/workspace/scout" });
  await assert.rejects(approving, /revoked/); await stopping;
  assert.equal((await f.read()).control.state, "revoked");
  await f.controls.reset(true);

  let permission = true;
  let cleanup = true;
  let clock = NOW;
  const native = await controlFixture("computer", { now: () => clock, computer: {
    delegationScope: async () => { if (!permission) throw new Error("Discussion opt-in is off"); return { assertActive: () => { if (!permission) throw new Error("Permission changed"); } }; },
    endTurn: async () => { if (!cleanup) throw new Error("Native release unknown"); },
  } });
  await native.approve(); const { run } = await native.start();
  run.client.waitUntilIdle = async () => ({ outcome: "timeout" });
  permission = false; cleanup = false;
  assert.equal(native.controls.allowed(await native.read()), false);
  assert.equal(await native.controls.revokeId("scout", native.worker.id), false);
  assert.match((await native.read()).control.detail, /unconfirmed/);
  assert.equal((await native.read()).cleanupPending, true);
  native.liveRuns.clear(); native.controls.releaseRun(run);
  await assert.rejects(native.approve(), /stopping/);
  cleanup = true;
  assert.equal(await native.controls.revokeId("scout", native.worker.id), false, "drained input cannot stand in for native idle");
  run.client.waitUntilIdle = async () => ({ outcome: "settled" });
  assert.equal(await native.controls.revokeId("scout", native.worker.id), true);
  permission = true; await native.approve();
  clock += 15 * 60_000;
  assert.equal((await native.read()).control.state, "revoked");
  await native.controls.reset(true);
});

test("control management is native-origin scoped; queued steering survives Done and interrupted approval", async () => {
  const f = await controlFixture();
  const owner = { owner: { kind: "private", slug: "scout", threadId: "origin", conversationId: "origin" }, personRequest: true, continuation: false };
  assert.doesNotThrow(() => assertWorkerSupervisor(owner, f.worker));
  for (const patch of [{ continuation: true }, { personRequest: false }, { owner: { ...owner.owner, kind: "group" } }, { owner: { ...owner.owner, threadId: "other", conversationId: "other" } }]) assert.throws(() => assertWorkerSupervisor({ ...owner, ...patch }, f.worker), /private|originating/);
  assert.throws(() => assertControlOrigin({ ...owner, owner: { ...owner.owner, kind: "worker" } }), /private/);
  let managed = 0;
  const handlers = createWorkerToolHandlers({ coworkersDir: f.directory, steer: async () => { managed++; return f.worker; }, pause: async () => { managed++; return f.worker; }, resume: async () => { managed++; return f.worker; }, cancel: async () => { managed++; return f.worker; } });
  for (const name of WORKER_MANAGEMENT) await assert.rejects(handlers[name]("scout", { id: f.worker.id, text: "Correction" }), /context-bound/);
  assert.equal(managed, 0);
  await handlers.worker_steer("scout", { id: f.worker.id, text: "Correction" }, { entry: owner, assertActive() {} });
  assert.equal(managed, 1);
  await f.approve();
  await queueWorkerSteer(f.directory, "scout", f.worker.id, "First correction", "person");
  const admitted = await prepareWorkerTurn(f.directory, "scout", f.worker.id, "Scout");
  assert.equal(admitted.pendingTurn.steers.length, 1);
  await queueWorkerSteer(f.directory, "scout", f.worker.id, "New correction before Done", "coworker");
  const latest = await getWorker(f.directory, "scout", f.worker.id);
  const step = nextWorkerState(latest, { kind: "settled", report: { kind: "done", text: "Draft ready" } }, { hasPendingSteer: true });
  assert.equal(step.patch.status, "waiting"); assert.equal(step.schedule, "continue");
  await f.controls.revoke(latest);
  const reapproved = await f.approve();
  assert.equal(reapproved.pendingTurn, null);
  assert.deepEqual(reapproved.pendingSteers.map((steer) => steer.text), ["First correction", "New correction before Done"]);
  const next = await prepareWorkerTurn(f.directory, "scout", f.worker.id, "Scout");
  assert.notEqual(next.pendingTurn.messageId, admitted.pendingTurn.messageId);
  assert.match(next.pendingTurn.prompt, /Never replay uncertain actions/);
  const spent = nextWorkerState({ ...latest, lifespan: { kind: "turns", max: 1, used: 0 } }, { kind: "settled", report: { kind: "done", text: "Done" } }, { hasPendingSteer: true });
  assert.equal(spent.patch.status, "failed"); assert.match(spent.patch.error, /accepted correction still unresolved/);
  assert.match((await readWorkerEvents(f.directory, "scout", f.worker.id))[0].text, /Queued for the next step/);
  for (const name of ["coworker_browser_open", "coworker_computer_open", "coworker_worker_spawn", "question"]) assert.equal(workerTurnTools()[name], false);
  assert.equal(workerTurnTools("browser").coworker_browser_open, true);
  assert.equal(workerTurnTools("browser").coworker_computer_open, false);
  await f.controls.reset(true);
});

test("a lifespan is always bounded by default and validated when chosen", () => {
  assert.deepEqual(normalizeLifespan(undefined, { now: NOW }), { kind: "turns", max: DEFAULT_TURN_BUDGET, used: 0 });
  assert.deepEqual(normalizeLifespan({ kind: "turns", max: 3.4 }, { now: NOW }), { kind: "turns", max: 3, used: 0 });
  assert.deepEqual(normalizeLifespan({ kind: "until", at: NOW + 60_000 }, { now: NOW }), { kind: "until", at: NOW + 60_000 });
  assert.deepEqual(normalizeLifespan({ kind: "open" }, { now: NOW }), { kind: "open" });
  assert.throws(() => normalizeLifespan({ kind: "until", at: NOW - 1 }, { now: NOW }), /in the future/);
  assert.throws(() => normalizeLifespan({ kind: "turns", max: 0 }, { now: NOW }), /between 1 and/);
  assert.throws(() => normalizeLifespan({ kind: "forever" }, { now: NOW }), /lifespan/);
  assert.equal(lifespanSpent({ kind: "turns", max: 2, used: 2 }, NOW), true);
  assert.equal(lifespanSpent({ kind: "until", at: NOW }, NOW), true);
  assert.equal(lifespanSpent({ kind: "open" }, NOW), false);
  assert.equal(describeLifespanForPrompt({ kind: "turns", max: 10, used: 7 }, NOW), "3 of 10 turns left");
  assert.equal(describeLifespanForPrompt({ kind: "open" }, NOW), "until you are stopped");
  assert.match(describeLifespanForPrompt({ kind: "until", at: NOW + 3_600_000 }, NOW), /^until /);
});

test("workers are created under the coworker home, listed newest first, capped, and never deleted", async () => {
  const coworkersDir = await fixture();
  const first = await createWorker(coworkersDir, "scout", { name: "  Market   scan ", goal: "Watch vendor prices.", spawnedBy: "person" }, { now: 1_000 });
  assert.match(first.id, /^wrk_[a-z0-9]{20}$/);
  assert.equal(first.name, "Market scan");
  assert.equal(first.status, "starting");
  assert.deepEqual(first.lifespan, { kind: "turns", max: DEFAULT_TURN_BUDGET, used: 0 });
  assert.equal(workerThreadTitle(first.name), "Worker: Market scan");

  const second = await createWorker(coworkersDir, "scout", { name: "Inbox watch", goal: "Watch the inbox.", spawnedBy: "person", spawnedFromThreadId: "ses_chat", lifespan: { kind: "open" } }, { now: 2_000 });
  assert.equal(second.spawnedFromThreadId, "ses_chat");
  assert.deepEqual((await listWorkers(coworkersDir, "scout")).map((worker) => worker.id), [second.id, first.id]);

  await createWorker(coworkersDir, "scout", { name: "Third", goal: "Do a third thing.", spawnedBy: "person" }, { now: 3_000 });
  await assert.rejects(
    createWorker(coworkersDir, "scout", { name: "Fourth", goal: "One too many.", spawnedBy: "person" }),
    new RegExp(`${MAX_LIVE_WORKERS} Workers are already running`),
  );
  // Stopping one makes room; the stopped Worker stays on disk.
  const stopped = await updateWorker(coworkersDir, "scout", first.id, { status: "cancelled" }, { now: 4_000 });
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.endedAt, 4_000);
  assert.equal(liveWorkers(await listWorkers(coworkersDir, "scout")).length, 2);
  const fourth = await createWorker(coworkersDir, "scout", { name: "Fourth", goal: "Now there is room.", spawnedBy: "person" }, { now: 5_000 });
  assert.equal((await listWorkers(coworkersDir, "scout")).length, 4);
  assert.equal((await getWorker(coworkersDir, "scout", fourth.id)).goal, "Now there is room.");

  await assert.rejects(createWorker(coworkersDir, "scout", { name: "", goal: "x", spawnedBy: "person" }), /needs a name/);
  await assert.rejects(createWorker(coworkersDir, "scout", { name: "x", goal: "", spawnedBy: "person" }), /needs a goal/);
  await assert.rejects(createWorker(coworkersDir, "scout", { name: "x", goal: "x", spawnedBy: "coworker", lifespan: { kind: "open" } }), /finite turn limit/);
  await assert.rejects(createWorker(coworkersDir, "scout", { name: "x", goal: "x", spawnedBy: "person", purpose: "recursive" }), /purpose/);
  await assert.rejects(getWorker(coworkersDir, "scout", "wrk_../escape"), /Invalid Worker id/);
  await assert.rejects(getWorker(coworkersDir, "../scout", first.id), /Invalid coworker slug/);
});

test("updates are validated and a stopped worker never changes status again", async () => {
  const coworkersDir = await fixture();
  const worker = await createWorker(coworkersDir, "scout", { name: "Scan", goal: "Scan.", spawnedBy: "person" }, { now: 1_000 });
  const running = await updateWorker(coworkersDir, "scout", worker.id, { status: "running", threadId: "ses_w1" }, { now: 2_000 });
  assert.equal(running.status, "running");
  assert.equal(running.threadId, "ses_w1");
  const waiting = await updateWorker(coworkersDir, "scout", worker.id, { status: "waiting", waitingFor: "decision", lastFindingAt: 2_500, steerCount: 1 }, { now: 2_500 });
  assert.equal(waiting.waitingFor, "decision");
  assert.equal(waiting.lastFindingAt, 2_500);
  assert.equal(waiting.steerCount, 1);
  await assert.rejects(updateWorker(coworkersDir, "scout", worker.id, { status: "sleeping" }), /Unknown Worker status/);
  await assert.rejects(updateWorker(coworkersDir, "scout", worker.id, { waitingFor: "coffee" }), /wait reason/);
  const finished = await updateWorker(coworkersDir, "scout", worker.id, { status: "finished" }, { now: 3_000 });
  assert.equal(finished.waitingFor, "");
  assert.equal(finished.endedAt, 3_000);
  await assert.rejects(updateWorker(coworkersDir, "scout", worker.id, { status: "running" }), /already stopped/);
  // Non-status fields still update after the end (an error message, for example).
  assert.equal((await updateWorker(coworkersDir, "scout", worker.id, { error: "late note" })).error, "late note");
});

test("findings append in order, tolerate one truncated final line, and keep their shape", async () => {
  const coworkersDir = await fixture();
  const worker = await createWorker(coworkersDir, "scout", { name: "Scan", goal: "Scan.", spawnedBy: "person" });
  assert.deepEqual(await readWorkerEvents(coworkersDir, "scout", worker.id), []);
  const [finding, steer] = await Promise.all([
    appendWorkerEvent(coworkersDir, "scout", worker.id, { kind: "finding", report: "decision", text: "Include vendor C?" }, { now: 10 }),
    appendWorkerEvent(coworkersDir, "scout", worker.id, { kind: "steer", text: "Yes, include it.", by: "coworker" }, { now: 20 }),
  ]);
  assert.equal(finding.report, "decision");
  assert.equal(steer.by, "coworker");
  const review = await appendWorkerEvent(coworkersDir, "scout", worker.id, { kind: "review", text: "Reviewed", reviewThreadId: "ses_chat", findingIds: [finding.id] }, { now: 30 });
  assert.deepEqual(review.findingIds, [finding.id]);
  assert.deepEqual((await readWorkerEvents(coworkersDir, "scout", worker.id)).map((event) => event.kind), ["finding", "steer", "review"]);
  assert.deepEqual((await readWorkerEvents(coworkersDir, "scout", worker.id, { limit: 1 })).map((event) => event.id), [review.id]);

  const file = path.join(coworkersDir, "scout", "workers", worker.id, "findings.jsonl");
  await writeFile(file, `${await readFile(file, "utf8")}{"id":"evt_cut","kind":"finding","te`, "utf8");
  assert.equal((await readWorkerEvents(coworkersDir, "scout", worker.id)).length, 3);
  assert.throws(() => parseEvents('{"id":"evt_a","kind":"status","text":"a"}\nnot json\n{"id":"evt_b","kind":"status","text":"b"}\n'), SyntaxError);
  await assert.rejects(appendWorkerEvent(coworkersDir, "scout", worker.id, { kind: "gossip", text: "no" }), /Unknown Worker event kind/);
});

test("the registry lists worker threads once, in the same shape as discussions.json", async () => {
  const coworkersDir = await fixture();
  assert.deepEqual(await readWorkerRegistry(coworkersDir, "scout"), []);
  assert.deepEqual(await registerWorkerThread(coworkersDir, "scout", "ses_w1"), ["ses_w1"]);
  assert.deepEqual(await registerWorkerThread(coworkersDir, "scout", "ses_w2"), ["ses_w1", "ses_w2"]);
  assert.deepEqual(await registerWorkerThread(coworkersDir, "scout", "ses_w1"), ["ses_w1", "ses_w2"]);
  const stored = JSON.parse(await readFile(path.join(coworkersDir, "scout", WORKERS_REGISTRY_FILE), "utf8"));
  assert.deepEqual(stored, { schemaVersion: 1, threadIds: ["ses_w1", "ses_w2"] });
  await assert.rejects(registerWorkerThread(coworkersDir, "scout", ""), /thread id is required/);
});

test("a worker's reply is read back as a finding, a decision, or done — and never lost", () => {
  assert.deepEqual(parseWorkerReport(""), { kind: "none", text: "" });
  assert.deepEqual(
    parseWorkerReport("I checked three vendors.\n\n## Finding\nPrices rose 3% at two vendors. The third has not updated.\n"),
    { kind: "finding", text: "Prices rose 3% at two vendors. The third has not updated." },
  );
  assert.deepEqual(
    parseWorkerReport("**Finding:** Nothing changed since the last check."),
    { kind: "finding", text: "Nothing changed since the last check." },
  );
  assert.deepEqual(
    parseWorkerReport("Some work.\n\n**Needs a decision**\nShould I include vendor C?\n- A) Yes\n- B) No"),
    { kind: "decision", text: "Should I include vendor C?\n- A) Yes\n- B) No" },
  );
  // "Done" may stand alone; the finding before it carries the words.
  assert.deepEqual(
    parseWorkerReport("## Finding\nAll vendors covered; the report is saved.\n\nDone."),
    { kind: "done", text: "All vendors covered; the report is saved." },
  );
  assert.deepEqual(parseWorkerReport("### Done\nThe goal is met; see report.md."), { kind: "done", text: "The goal is met; see report.md." });
  // A reply that skipped the contract still counts as a finding.
  assert.deepEqual(parseWorkerReport("Just some prose without a heading."), { kind: "finding", text: "Just some prose without a heading." });
  assert.deepEqual(parseWorkerReport("Needs a decision"), { kind: "decision", text: "Needs a decision." });
});

test("an interrupted step cannot reuse an older finding or continue from an incomplete reply", () => {
  const result = { outcome: "settled", terminalError: null };
  const old = { role: "assistant", parentId: "msg_old", completedAt: 1, text: "## Done\nEarlier goal met." };
  const partial = { role: "assistant", parentId: "msg_current", completedAt: null, text: "Still looking" };
  assert.equal(workerTurnOutcome(result, { messages: [old, partial] }, "msg_current").kind, "failed");
  assert.equal(workerTurnOutcome(result, { messages: [old] }, "msg_current").kind, "failed");
  const complete = { ...partial, completedAt: 2, text: "## Finding\nCompared two sources." };
  assert.deepEqual(workerTurnOutcome(result, { messages: [old, partial, complete] }, "msg_current"), { kind: "settled", report: { kind: "finding", text: "Compared two sources." } });
});

test("a settled turn decides whether the worker continues, holds, or stops", () => {
  const base = { id: "wrk_a", name: "Scan", status: "running", waitingFor: "", lifespan: { kind: "turns", max: 3, used: 0 } };
  const finding = nextWorkerState(base, { kind: "settled", report: { kind: "finding", text: "Step one done." } }, { now: NOW });
  assert.equal(finding.schedule, "continue");
  assert.deepEqual(finding.patch, { status: "waiting", waitingFor: "turn", lifespan: { kind: "turns", max: 3, used: 1 }, lastFindingAt: NOW });
  assert.deepEqual(finding.events, [{ kind: "finding", report: "finding", text: "Step one done." }]);

  const decision = nextWorkerState(base, { kind: "settled", report: { kind: "decision", text: "A or B?" } }, { now: NOW });
  assert.equal(decision.schedule, "hold");
  assert.equal(decision.patch.waitingFor, "decision");
  // A steer that already arrived answers the decision.
  assert.equal(nextWorkerState(base, { kind: "settled", report: { kind: "decision", text: "A or B?" } }, { now: NOW, hasPendingSteer: true }).schedule, "continue");

  const done = nextWorkerState(base, { kind: "settled", report: { kind: "done", text: "Finished." } }, { now: NOW });
  assert.equal(done.schedule, "stop");
  assert.equal(done.patch.status, "finished");

  const spent = nextWorkerState({ ...base, lifespan: { kind: "turns", max: 3, used: 2 } }, { kind: "settled", report: { kind: "finding", text: "Last step." } }, { now: NOW });
  assert.equal(spent.schedule, "stop");
  assert.equal(spent.patch.status, "failed");
  assert.match(spent.patch.error, /^Incomplete:/);
  assert.deepEqual(spent.events.map((event) => event.kind), ["finding", "status"]);
  assert.match(spent.events[1].text, /lifespan/);

  const deadline = nextWorkerState({ ...base, lifespan: { kind: "until", at: NOW - 1 } }, { kind: "settled", report: { kind: "finding", text: "x" } }, { now: NOW });
  assert.equal(deadline.patch.status, "failed");
  const thinker = { ...base, purpose: "thinking", lifespan: { kind: "turns", max: 2, used: 1 } };
  for (const reply of ["", "## Finding\nStill comparing workspace/brief.md", "## Done", "## Done\n**Decision:**\n**Constraints:**\n**Acceptance criteria:**\n**Open risks:**"]) {
    const incomplete = nextWorkerState(thinker, { kind: "settled", report: parseWorkerReport(reply) }, { now: NOW });
    assert.equal(incomplete.patch.status, "failed");
    assert.match(incomplete.patch.error, /^Incomplete:/);
    assert.equal(incomplete.schedule, "stop");
  }
  const brief = "## Done\nDecision: use A\nConstraints: local files only\nAcceptance criteria: two sources agree\nOpen risks: source freshness";
  assert.equal(nextWorkerState(thinker, { kind: "settled", report: parseWorkerReport(brief) }, { now: NOW }).patch.status, "finished");

  const paused = nextWorkerState({ ...base, status: "paused" }, { kind: "settled", report: { kind: "finding", text: "x" } }, { now: NOW });
  assert.equal(paused.schedule, "hold");
  assert.equal(paused.patch.status, undefined);

  const silent = nextWorkerState(base, { kind: "settled", report: { kind: "none", text: "" } }, { now: NOW });
  assert.deepEqual(silent.events, []);
  assert.equal(silent.schedule, "continue");

  const failed = nextWorkerState(base, { kind: "failed", error: "Model unavailable" }, { now: NOW });
  assert.equal(failed.schedule, "stop");
  assert.equal(failed.patch.status, "failed");
  assert.equal(failed.patch.error, "Model unavailable");
  assert.deepEqual(failed.events, [{ kind: "status", text: "Didn't finish: Model unavailable" }]);

  // A stop that arrived while the turn ran wins over the turn's outcome.
  assert.deepEqual(nextWorkerState({ ...base, status: "cancelled" }, { kind: "settled", report: { kind: "done", text: "x" } }, { now: NOW }), { patch: {}, events: [], schedule: "stop" });
});

test("steering and an admitted turn survive rereads, while pause and stop win settlement", async () => {
  const coworkersDir = await fixture();
  const providers = [
    { id: "conversation", models: { standard: { capabilities: { toolcall: true }, variants: { low: {}, high: {} } } } },
    { id: "reasoning", models: { deep: { capabilities: { toolcall: true }, variants: { low: {}, high: {} } } } },
    { id: "delivery", models: { fast: { capabilities: { toolcall: true }, variants: {} } } },
  ];
  const owner = await updateCoworker(coworkersDir, "scout", { model: "conversation/standard", modelVariant: "low", modelMode: "auto", modelChosenBy: "person", effortPreference: "light", thinkingModel: "reasoning/deep", thinkingModelVariant: "high", deliveryModel: "delivery/fast" });
  const modelSnapshot = resolveWorkerModel(owner, "thinking", providers);
  assert.deepEqual(modelSnapshot, { providerId: "reasoning", modelId: "deep", variant: "high" });
  assert.deepEqual(resolveWorkerModel(owner, "delivery", providers), { providerId: "delivery", modelId: "fast", variant: "" });
  assert.deepEqual(resolveWorkerModel({ ...owner, thinkingModel: "" }, "thinking", providers), { providerId: "conversation", modelId: "standard", variant: "low" });
  assert.deepEqual(await getCoworker(coworkersDir, "scout"), owner, "resolving a Worker never changes the owner");
  const worker = await createWorker(coworkersDir, "scout", { name: "Scan", goal: "Compare sources.", purpose: "thinking", modelSnapshot, spawnedBy: "person" });
  assert.equal(worker.lifespan.max, 2);
  const edited = await updateCoworker(coworkersDir, "scout", { model: "delivery/fast", modelVariant: "", thinkingModel: "delivery/fast", thinkingModelVariant: "", effortPreference: "all-in" });
  assert.deepEqual(resolveWorkerModel(edited, "thinking", providers, (await getWorker(coworkersDir, "scout", worker.id)).modelSnapshot), modelSnapshot);
  assert.throws(() => resolveWorkerModel(edited, "thinking", providers.slice(2), modelSnapshot), /unavailable.*will not switch/);
  assert.throws(() => resolveWorkerModel(owner, "thinking", [{ id: "reasoning", models: { deep: { capabilities: { toolcall: false } } } }]), /tool support/);
  assert.throws(() => resolveWorkerModel(owner, "thinking", [{ id: "reasoning", models: { deep: {} } }]), /tool support/);
  assert.throws(() => resolveWorkerModel(edited, "thinking", [{ id: "reasoning", models: { deep: { capabilities: { toolcall: true }, variants: { low: {} } } } }], modelSnapshot), /saved effort/);
  const nativeDefaults = { default: { conversation: "standard" } };
  const nativeDefault = resolveWorkerModel({}, "delivery", providers, null, nativeDefaults);
  assert.deepEqual(nativeDefault, { providerId: "conversation", modelId: "standard", variant: "high" });
  assert.deepEqual(resolveWorkerModel({}, "thinking", providers, null, nativeDefaults), nativeDefault, "one model for every role is valid");
  const configuredDefaults = { model: "reasoning/deep", default: { conversation: "standard", delivery: "fast" } };
  assert.deepEqual(resolveWorkerModel({}, "delivery", providers, null, configuredDefaults), { providerId: "reasoning", modelId: "deep", variant: "high" }, "the configured native model takes precedence over per-provider defaults");
  assert.deepEqual(resolveWorkerModel({}, "delivery", providers, nativeDefault, configuredDefaults), nativeDefault, "a pinned default never follows later default edits");
  assert.throws(() => resolveWorkerModel({ thinkingModel: "reasoning/missing" }, "thinking", providers, null, nativeDefaults), /unavailable.*will not switch/);
  assert.throws(() => resolveWorkerModel({ model: "reasoning/missing" }, "delivery", providers, null, nativeDefaults), /unavailable.*will not switch/);
  assert.throws(() => resolveWorkerModel({}, "delivery", providers, null, { ...nativeDefaults, model: "reasoning/missing" }), /unavailable.*will not switch/);
  assert.throws(() => resolveWorkerModel({}, "delivery", providers, null, { default: configuredDefaults.default }), /native default model.*unambiguously/);
  assert.throws(() => resolveWorkerModel({}, "delivery", providers), /native default model.*unambiguously/);
  assert.throws(() => resolveWorkerModel(edited, "thinking", providers, { providerId: "reasoning" }), /unreadable/);
  const blocked = nextWorkerState(worker, { kind: "settled", report: { kind: "decision", text: "Missing acceptance criteria." } });
  assert.equal(blocked.patch.status, "failed", "a new Worker's blocker returns to the supervisor through durable completion");
  assert.equal(blocked.schedule, "stop");
  for (const tool of ["task", "question", "coworker_team_consult", "coworker_worker_spawn"]) assert.equal(workerTurnTools()[tool], false);
  await updateWorker(coworkersDir, "scout", worker.id, { status: "paused" });
  await Promise.all([
    queueWorkerSteer(coworkersDir, "scout", worker.id, "Use source A.", "person"),
    queueWorkerSteer(coworkersDir, "scout", worker.id, "Skip source B.", "coworker"),
  ]);
  const paused = await getWorker(coworkersDir, "scout", worker.id);
  assert.equal(paused.steerCount, 2);
  assert.equal(paused.pendingSteers.length, 2);
  assert.equal((await prepareWorkerTurn(coworkersDir, "scout", worker.id, "Scout")).pendingTurn, null);
  await updateWorker(coworkersDir, "scout", worker.id, { status: "waiting", waitingFor: "turn" });
  const admitted = await prepareWorkerTurn(coworkersDir, "scout", worker.id, "Scout");
  assert.deepEqual(admitted.pendingTurn.model, modelSnapshot);
  assert.equal(admitted.purpose, "thinking");
  assert.match(admitted.pendingTurn.prompt, /Use source A/);
  assert.match(admitted.pendingTurn.prompt, /Skip source B/);
  assert.equal(admitted.pendingSteers.length, 0);
  await queueWorkerSteer(coworkersDir, "scout", worker.id, "Include source C next.", "person");
  const recovered = await prepareWorkerTurn(coworkersDir, "scout", worker.id, "Scout");
  assert.deepEqual(recovered.pendingTurn, admitted.pendingTurn, "recovery observes the same admitted message");
  assert.equal(recovered.pendingSteers.length, 1, "later steering belongs to the next step");
  let step;
  const [, settled] = await Promise.all([
    updateWorker(coworkersDir, "scout", worker.id, { status: "paused" }),
    updateWorker(coworkersDir, "scout", worker.id, (current) => {
      step = nextWorkerState(current, { kind: "settled", report: { kind: "done", text: "Sources compared; see brief.md." } });
      return { ...step.patch, pendingTurn: null };
    }),
  ]);
  assert.equal(settled.status, "paused");
  assert.equal(step.schedule, "hold");
  assert.equal(settled.lifespan.used, 1);
  assert.equal(settled.pendingSteers.length, 1);
  await updateWorker(coworkersDir, "scout", worker.id, { status: "waiting", waitingFor: "turn" });
  const continued = await prepareWorkerTurn(coworkersDir, "scout", worker.id, "Scout");
  assert.match(continued.pendingTurn.prompt, /Include source C next/);
  assert.equal(continued.pendingSteers.length, 0);
  assert.deepEqual(continued.pendingTurn.model, modelSnapshot, "the next turn uses the same model and effort after settings edits");
  await updateWorker(coworkersDir, "scout", worker.id, { status: "cancelled", pendingSteers: [] });
  assert.equal((await prepareWorkerTurn(coworkersDir, "scout", worker.id, "Scout")).status, "cancelled");
  await assert.rejects(queueWorkerSteer(coworkersDir, "scout", worker.id, "One more.", "person"), /already stopped/);
  const legacy = await createWorker(coworkersDir, "scout", { name: "Old", goal: "Keep going.", spawnedBy: "person" });
  const legacyPath = path.join(coworkersDir, "scout", "workers", legacy.id, "worker.json");
  const { purpose, modelSnapshot: omitted, ...oldRecord } = legacy;
  await writeFile(legacyPath, JSON.stringify(oldRecord));
  const oldTurn = await prepareWorkerTurn(coworkersDir, "scout", legacy.id, "Scout");
  assert.equal(oldTurn.purpose, "delivery");
  assert.equal(oldTurn.modelSnapshot, null);
  assert.equal(Object.hasOwn(oldTurn.pendingTurn, "model"), false, "legacy Workers retain the existing owner-model path");
});

test("Stop attempts native abort across rejected writes and repairs terminal metadata without hiding unconfirmed cleanup", async () => {
  // The renderer typecheck excludes this JS entry point; resolve its bindings without booting Electron.
  const entry = fileURLToPath(new URL("./main.mjs", import.meta.url));
  const program = ts.createProgram([entry], { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext });
  const unbound = program.getSemanticDiagnostics(program.getSourceFile(entry)).filter((diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2552);
  assert.deepEqual(unbound.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")), [], "native Stop must not call an unbound runtime identifier");
  const coworkersDir = await fixture();
  const worker = await createWorker(coworkersDir, "scout", { name: "Stop check", goal: "Check once.", spawnedBy: "person" });
  const require = createRequire(import.meta.url);
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL("../src/ui/worker-detail.tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "shared-react-runtime", setup(plugin) {
      plugin.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, ({ path: name }) => ({ path: pathToFileURL(require.resolve(name)).href, external: true }));
    } }],
  });
  const { WorkerDetail } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
  const coworker = await getCoworker(coworkersDir, "scout");
  const liveRuns = new Map();
  const controls = createWorkerControls({ liveRuns });
  const reread = async () => controls.summary(await getWorker(coworkersDir, "scout", worker.id));
  // Each render starts with fresh component state, like reopening a collapsed row.
  const freshDetail = async () => renderToStaticMarkup(createElement(WorkerDetail, { coworker, initialWorker: await reread(), onChanged() {} }));
  await updateWorker(coworkersDir, "scout", worker.id, { status: "running", threadId: "ses_stop" });
  const service = createCollaboration({ directory: coworkersDir, pollMs: 60_000 });
  await service.attachWorker(worker, { slug: "scout", threadId: "ses_origin", conversationId: "ses_origin", kind: "private" });
  const requests = [];
  let mode = "idle";
  let clock = 0;
  const client = createHeadlessThreadClient({ baseUrl: "http://worker.invalid", workspaceId: "workspace_scout", now: () => clock, sleep: async (ms) => { clock += ms; }, fetch: async (request) => {
    const route = new URL(request).pathname;
    requests.push(route);
    if (route.endsWith("/abort")) return mode === "reject" ? Response.json({ message: "Abort unavailable" }, { status: 503 }) : Response.json(false);
    if (route.endsWith("/status")) return Response.json({ ses_stop: { type: mode === "busy" ? "busy" : "idle" } });
    if (route.endsWith("/message") || route.endsWith("/todo")) return Response.json([]);
    assert.ok(route.endsWith("/session/ses_stop"));
    return Response.json({ id: "ses_stop" });
  } });
  const findings = path.join(coworkersDir, "scout", "workers", worker.id, "findings.jsonl");
  const blockedWrite = path.join(coworkersDir, ".collaboration", "state.json.tmp");
  const handlers = createWorkerToolHandlers({ coworkersDir, cancel: async (slug, id) => {
    controls.startStop(slug, id);
    const stopped = await withWorkerCancellation(async () => {
      const stopped = await updateWorker(coworkersDir, slug, id, { status: "cancelled" });
      await service.completeWorker(stopped, []);
      await appendWorkerEvent(coworkersDir, slug, id, { id: "evt_stop", kind: "status", text: "Stopped" });
      return stopped;
    }, () => {
      const signal = AbortSignal.timeout(1000);
      return withAbort(abortWorkerThread(client, "ses_stop", signal), signal);
    });
    controls.finishStop(slug, id);
    return controls.summary(stopped);
  } });
  try {
    await mkdir(blockedWrite);
    await assert.rejects(handlers.worker_cancel("scout", { id: worker.id }), /EISDIR/);
    assert.equal(requests.filter((route) => route.endsWith("/abort")).length, 1);
    assert.equal((await getWorker(coworkersDir, "scout", worker.id)).status, "cancelled");
    assert.equal((await reread()).cleanupPending, true);
    for (let reopen = 0; reopen < 2; reopen++) {
      const html = await freshDetail();
      assert.match(html, /data-testid="worker-stop"[^>]*>Retry Stop<\/button>/);
      assert.match(html, /Stop not confirmed/);
    }
    await rm(blockedWrite, { recursive: true });
    await rm(findings);
    await mkdir(findings);
    mode = "reject";
    await assert.rejects(handlers.worker_cancel("scout", { id: worker.id }), (error) => {
      assert.match(error.message, /could not be confirmed/);
      assert.match(error.errors[0].message, /Abort unavailable/);
      assert.match(error.errors[1].message, /EISDIR/);
      return true;
    });
    await rm(findings, { recursive: true });
    mode = "busy";
    await assert.rejects(handlers.worker_cancel("scout", { id: worker.id }), /could not be confirmed/);
    assert.equal((await reread()).cleanupPending, true);
    assert.match(await freshDetail(), />Retry Stop<\/button>/);
    mode = "idle";
    const repaired = await handlers.worker_cancel("scout", { id: worker.id });
    assert.equal(repaired.structured.worker.action, "stopped");
    assert.equal(requests.filter((route) => route.endsWith("/abort")).length, 4, "every Stop retries native cleanup even after the metadata is terminal");
    assert.equal((await readWorkerEvents(coworkersDir, "scout", worker.id)).length, 1);
    assert.equal((await reread()).cleanupPending, false);
    assert.doesNotMatch(await freshDetail(), /data-testid="worker-stop"/);
    // Native cleanup can fail without a person having clicked Stop yet.
    liveRuns.set(`scout:${worker.id}`, { controller: new AbortController(), cleanupError: new Error("Native cleanup unconfirmed") });
    assert.equal((await reread()).cleanupPending, true);
    assert.match(await freshDetail(), />Retry Stop<\/button>/);
    liveRuns.clear();
  } finally { await service.stop(); }
});

test("reviews run at once for the first finding, batch inside the window, and retry once after a failure", async () => {
  const timers = [];
  let clock = 0;
  const reviews = [];
  let outcome = "reviewed";
  const dropped = [];
  const scheduler = createReviewScheduler({
    review: async (slug, findings) => {
      reviews.push({ slug, ids: findings.map((finding) => finding.id) });
      if (outcome === "throw") throw new Error("model failed");
      return outcome;
    },
    debounceMs: 60_000,
    now: () => clock,
    setTimer: (callback, wait) => {
      const timer = { callback, at: clock + wait };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => timers.splice(timers.indexOf(timer), 1),
    onDropped: (slug, batch) => dropped.push(batch.map((finding) => finding.id)),
  });
  const fire = async () => {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (!next) return false;
    clock = Math.max(clock, next.at);
    next.callback();
    await new Promise((resolve) => setImmediate(resolve));
    return true;
  };

  scheduler.add("scout", { id: "f1" });
  assert.equal(timers[0].at, 0);
  await fire();
  assert.deepEqual(reviews, [{ slug: "scout", ids: ["f1"] }]);

  // Two findings inside the window join one review, scheduled at the window's end.
  clock = 10_000;
  scheduler.add("scout", { id: "f2" });
  clock = 20_000;
  scheduler.add("scout", { id: "f3" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 60_000);
  await fire();
  assert.deepEqual(reviews[1], { slug: "scout", ids: ["f2", "f3"] });

  // A held review keeps its findings and tries again after the window.
  outcome = "hold";
  clock = 130_000;
  scheduler.add("scout", { id: "f4" });
  await fire();
  assert.deepEqual(reviews[2].ids, ["f4"]);
  assert.deepEqual(scheduler.pending("scout").map((finding) => finding.id), ["f4"]);
  outcome = "reviewed";
  await fire();
  assert.deepEqual(reviews[3].ids, ["f4"]);
  assert.deepEqual(scheduler.pending("scout"), []);

  // A failing review is retried once, then its findings are dropped.
  outcome = "throw";
  clock = 400_000;
  scheduler.add("scout", { id: "f5" });
  await fire();
  await fire();
  assert.deepEqual(reviews.slice(4).map((review) => review.ids), [["f5"], ["f5"]]);
  assert.deepEqual(dropped, [["f5"]]);
  assert.deepEqual(scheduler.pending("scout"), []);
  scheduler.clear("scout");
  assert.equal(timers.length, 0);
});

test("worker tool lifespans preserve the default budget and reject invalid limits", () => {
  assert.deepEqual(lifespanFromToolArgs(undefined, { now: NOW }), { kind: "turns", max: DEFAULT_TURN_BUDGET, used: 0 });
  assert.deepEqual(lifespanFromToolArgs({ kind: "turns", turns: 4 }, { now: NOW }), { kind: "turns", max: 4, used: 0 });
  assert.deepEqual(lifespanFromToolArgs({ kind: "until", until: new Date(NOW + 3_600_000).toISOString() }, { now: NOW }), { kind: "until", at: NOW + 3_600_000 });
  assert.deepEqual(lifespanFromToolArgs({ kind: "open" }, { now: NOW }), { kind: "open" });
  assert.throws(() => lifespanFromToolArgs({ kind: "until", until: "soon" }, { now: NOW }), /ISO 8601/);
  assert.throws(() => lifespanFromToolArgs({ kind: "forever" }, { now: NOW }), /turns, until, or open/);
});

test("the coworker starts, lists, steers, reads, and stops Workers through its own MCP server", async () => {
  const coworkersDir = await fixture();
  const calls = [];
  const handlers = createWorkerToolHandlers({
    coworkersDir,
    spawn: async (slug, input) => {
      calls.push(["spawn", slug, input.name, input.lifespan === undefined ? "lifespan left to the app" : "lifespan chosen"]);
      const worker = await createWorker(coworkersDir, slug, { ...input, spawnedBy: "coworker" }, { now: NOW });
      return updateWorker(coworkersDir, slug, worker.id, { status: "running", threadId: "ses_w" }, { now: NOW });
    },
    steer: async (slug, id, text) => {
      calls.push(["steer", slug, id, text]);
      await appendWorkerEvent(coworkersDir, slug, id, { kind: "steer", text, by: "coworker" }, { now: NOW + 1 });
      return getWorker(coworkersDir, slug, id);
    },
    cancel: async (slug, id, reason) => {
      calls.push(["cancel", slug, id, reason]);
      await appendWorkerEvent(coworkersDir, slug, id, { kind: "status", text: `Stopped: ${reason}`, by: "coworker" }, { now: NOW + 2 });
      return updateWorker(coworkersDir, slug, id, { status: "cancelled" }, { now: NOW + 2 });
    },
    pause: (slug, id) => updateWorker(coworkersDir, slug, id, { status: "paused" }),
    resume: (slug, id) => updateWorker(coworkersDir, slug, id, { status: "waiting", waitingFor: "turn" }),
    now: () => NOW,
  });
  const server = await createCoworkerToolsServer({
    resolveSlug: (token) => (token === "scout-token" ? "scout" : null),
    handlers,
    tools: workerToolCatalog(),
    instructions: "Workers too.",
  });
  try {
    const call = async (name, args) => {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer scout-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const init = await handleMcpMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, { slug: "scout", handlers, tools: workerToolCatalog(), serverInfo: { name: "t", version: "0" }, instructions: "Workers too." });
    assert.equal(init.result.instructions, "Workers too.");

    const empty = await call("workers_list", {});
    assert.match(empty.content[0].text, /^No live Workers/);
    assert.deepEqual(empty.structuredContent.workers, []);

    const started = await call("worker_spawn", { name: "Market scan", goal: "Watch vendor prices.", purpose: "thinking", lifespan: { kind: "turns", turns: 3 } });
    assert.equal(started.isError, false);
    assert.match(started.content[0].text, /^Started Worker "Market scan" \(id wrk_[a-z0-9]+\), 3 of 3 turns left\./);
    assert.match(started.content[0].text, /tell the person in a sentence/);
    const id = started.structuredContent.worker.id;
    assert.deepEqual(calls[0], ["spawn", "scout", "Market scan", "lifespan chosen"]);
    assert.equal(started.structuredContent.worker.action, "started");
    assert.equal(started.structuredContent.worker.purpose, "thinking");

    const listed = await call("workers_list", {});
    assert.match(listed.content[0].text, /Live Workers \(1 of 3\):/);
    assert.match(listed.content[0].text, new RegExp(`${id} — "Market scan" — working on it, 3 of 3 turns left`));

    const steered = await call("worker_steer", { id, text: "Skip vendor C." });
    assert.match(steered.content[0].text, /^Steered "Market scan"; it takes that as its next step once its current step settles\./);
    assert.deepEqual(calls[1], ["steer", "scout", id, "Skip vendor C."]);

    const paused = await call("worker_pause", { id });
    assert.equal(paused.structuredContent.worker.status, "paused");
    assert.match(paused.content[0].text, /current step can finish/);
    const resumed = await call("worker_resume", { id });
    assert.equal(resumed.structuredContent.worker.status, "waiting");
    await updateWorker(coworkersDir, "scout", id, { status: "running", waitingFor: "" });

    await appendWorkerEvent(coworkersDir, "scout", id, { kind: "finding", report: "finding", text: "Prices rose 3%." }, { now: NOW + 3 });
    const findings = await call("worker_findings", { id, limit: 5 });
    assert.match(findings.content[0].text, /^"Market scan" — working on it, 3 of 3 turns left\. Events, oldest first:/);
    assert.match(findings.content[0].text, /steered by you: Skip vendor C\./);
    assert.match(findings.content[0].text, /finding: Prices rose 3%\./);
    assert.equal(findings.structuredContent.events.length, 2);

    const stopped = await call("worker_cancel", { id, reason: "Enough" });
    assert.match(stopped.content[0].text, /^Stopped "Market scan"\./);
    assert.deepEqual(calls[2], ["cancel", "scout", id, "Enough"]);

    // A lifespan the coworker leaves out is not the tool's to fill in: the app's effort dial sets the default turns.
    const unchosen = await call("worker_spawn", { name: "Inbox pass", goal: "Read the inbox." });
    assert.equal(unchosen.isError, false);
    assert.deepEqual(calls[3], ["spawn", "scout", "Inbox pass", "lifespan left to the app"]);
    assert.match(unchosen.content[0].text, /10 of 10 turns left/, "the store's default holds when nothing else decides");
    assert.equal((await getWorker(coworkersDir, "scout", id)).status, "cancelled");

    const again = await call("worker_cancel", { id, reason: "Twice" });
    assert.match(again.content[0].text, /^Stopped "Market scan"/);
    assert.equal(calls.filter((entry) => entry[0] === "cancel").length, 2);

    const bad = await call("worker_steer", { id: "nope", text: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Name the Worker by its id/);
  } finally {
    await server.stop();
  }
});
