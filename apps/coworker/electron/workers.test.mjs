import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker } from "./coworkers.mjs";
import { createCoworkerToolsServer, handleMcpMessage, toolCatalog } from "./coworker-tools.mjs";
import {
  DEFAULT_TURN_BUDGET,
  MAX_LIVE_WORKERS,
  REVIEW_OPENER,
  WORKERS_REGISTRY_FILE,
  appendWorkerEvent,
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
  readWorkerEvents,
  readWorkerRegistry,
  registerWorkerThread,
  reviewPrompt,
  steerBody,
  updateWorker,
  WORKER_NOTE_TEXT,
  workerProgressNote,
  workerThreadTitle,
  workerToolCatalog,
  workerTurnPrompt,
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

  const second = await createWorker(coworkersDir, "scout", { name: "Inbox watch", goal: "Watch the inbox.", spawnedBy: "coworker", spawnedFromThreadId: "ses_chat", lifespan: { kind: "open" } }, { now: 2_000 });
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

test("the worker prompt frame names the goal, the lifespan, and the reporting contract", () => {
  const worker = { name: "Market scan", goal: "Watch vendor prices.", lifespan: { kind: "turns", max: 10, used: 4 } };
  const prompt = workerTurnPrompt({ worker, coworkerName: "Nova", body: "Begin working toward the goal now.", now: NOW });
  assert.match(prompt, /^You are a Worker named "Market scan" started by Nova\./);
  assert.match(prompt, /Watch vendor prices\./);
  assert.match(prompt, /Lifespan: 6 of 10 turns left\./);
  assert.match(prompt, /section titled "Finding"/);
  assert.match(prompt, /section titled "Needs a decision"/);
  assert.match(prompt, /section titled "Done"/);
  assert.match(prompt, /never start, steer, or stop Workers, never set up or change assignments, and never change Nova's memory or soul \(those tools are Nova's\)/);
  assert.ok(prompt.endsWith("Begin working toward the goal now."));
  assert.equal(
    steerBody([{ by: "coworker", text: "Skip vendor C." }, { by: "person", text: "Add vendor D." }], "Nova"),
    "Steering from Nova: Skip vendor C.\n\nSteering from the person Nova works for: Add vendor D.",
  );
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
  assert.equal(spent.patch.status, "finished");
  assert.deepEqual(spent.events.map((event) => event.kind), ["finding", "status"]);
  assert.match(spent.events[1].text, /lifespan/);

  const deadline = nextWorkerState({ ...base, lifespan: { kind: "until", at: NOW - 1 } }, { kind: "settled", report: { kind: "finding", text: "x" } }, { now: NOW });
  assert.equal(deadline.patch.status, "finished");

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

test("the working-memory line for a Worker follows it from start to finding to decision and clears when it ends", () => {
  const base = { id: "wrk_a", name: "Market scan", goal: "Watch the three competitors' pricing pages and report any change.", status: "starting", waitingFor: "", lifespan: { kind: "turns", max: 10, used: 0 } };
  // Keyed by the Worker's name so it never collides with the coworker's own notes.
  const started = workerProgressNote(base);
  assert.deepEqual(started, { work: "Worker · Market scan", text: "started — Watch the three competitors' pricing pages and report any change" });
  assert.equal(workerProgressNote({ ...base, status: "running" }).text, "working — Watch the three competitors' pricing pages and report any change");
  assert.equal(workerProgressNote({ ...base, status: "waiting", waitingFor: "turn" }).text, "working — Watch the three competitors' pricing pages and report any change");
  // A finding replaces the goal with the latest state; a decision says it is waiting for one.
  assert.equal(workerProgressNote({ ...base, status: "waiting", waitingFor: "turn" }, { kind: "finding", report: "finding", text: "Acme dropped its Pro tier by 10%." }).text, "latest: Acme dropped its Pro tier by 10%.");
  assert.equal(workerProgressNote({ ...base, status: "waiting", waitingFor: "decision" }, { kind: "finding", report: "decision", text: "Should I include the annual plans too?" }).text, "needs a decision: Should I include the annual plans too?");
  assert.equal(workerProgressNote({ ...base, status: "waiting", waitingFor: "decision" }).text, "waiting for a decision — Watch the three competitors' pricing pages and report any change");
  // A steer or a status event is not a finding and leaves the goal in place.
  assert.equal(workerProgressNote({ ...base, status: "running" }, { kind: "steer", text: "Skip Beta." }).text, "working — Watch the three competitors' pricing pages and report any change");
  assert.equal(workerProgressNote({ ...base, status: "paused" }).text, "paused — Watch the three competitors' pricing pages and report any change");
  // Every ending clears the line, whatever the last finding said.
  for (const status of ["finished", "cancelled", "failed"]) {
    assert.deepEqual(workerProgressNote({ ...base, status }, { kind: "finding", report: "done", text: "All three pages checked." }), { work: "Worker · Market scan", text: "" });
  }
  // Long goals and findings are cut so the line fits the memory limit; an empty goal leaves no dangling dash.
  const long = "x".repeat(WORKER_NOTE_TEXT + 50);
  assert.equal(workerProgressNote({ ...base, goal: long }).text, `started — ${"x".repeat(WORKER_NOTE_TEXT)}`);
  assert.equal(workerProgressNote({ ...base, status: "running" }, { kind: "finding", report: "finding", text: long }).text, `latest: ${"x".repeat(WORKER_NOTE_TEXT)}`);
  assert.equal(workerProgressNote({ ...base, goal: "" }).text, "started");
});

test("the review prompt opens with the marker the renderer recognises and lists each update", () => {
  const workers = [
    { id: "wrk_a", name: "Market scan", status: "running", waitingFor: "", spawnedBy: "coworker", lifespan: { kind: "turns", max: 10, used: 2 } },
    { id: "wrk_b", name: "Inbox watch", status: "waiting", waitingFor: "decision", spawnedBy: "person", lifespan: { kind: "open" } },
  ];
  const prompt = reviewPrompt({
    coworkerName: "Nova",
    workers,
    findings: [
      { workerId: "wrk_a", workerName: "Market scan", report: "finding", text: "Prices rose 3%." },
      { workerId: "wrk_b", workerName: "Inbox watch", report: "decision", text: "Archive the newsletter?" },
      { workerId: "wrk_gone", workerName: "Old one", report: "done", text: "All done." },
      { workerId: "wrk_flaky", workerName: "Flaky", report: "failed", text: "Model unavailable" },
    ],
    now: NOW,
  });
  assert.match(prompt, /Worker "Flaky" didn't finish: Model unavailable/);
  assert.ok(prompt.startsWith(`${REVIEW_OPENER}\n`));
  assert.match(prompt, /- "Market scan" \(wrk_a\) — working on it, 8 of 10 turns left — started by you/);
  assert.match(prompt, /- "Inbox watch" \(wrk_b\) — waiting for a decision — started by the person/);
  assert.match(prompt, /Worker "Market scan" reported: Prices rose 3%\./);
  assert.match(prompt, /Worker "Inbox watch" needs a decision: Archive the newsletter\?/);
  assert.match(prompt, /Worker "Old one" finished: All done\./);
  assert.match(prompt, /say so plainly/);
  const withTools = reviewPrompt({ coworkerName: "Nova", workers: [], findings: [], toolsAvailable: true });
  assert.match(withTools, /steer it with your Worker tools now/);
  assert.match(withTools, /never stop a Worker the person started unless they ask/);
  assert.match(withTools, /do not ask them the same question yourself/);
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

test("the worker tool catalog sits beside the document tools with strict schemas and plain descriptions", () => {
  const names = workerToolCatalog().map((tool) => tool.name);
  assert.deepEqual(names, ["workers_list", "worker_spawn", "worker_steer", "worker_cancel", "worker_findings"]);
  const all = [...toolCatalog(), ...workerToolCatalog()];
  assert.equal(new Set(all.map((tool) => tool.name)).size, all.length);
  for (const tool of workerToolCatalog()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 40);
  }
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

    const started = await call("worker_spawn", { name: "Market scan", goal: "Watch vendor prices.", lifespan: { kind: "turns", turns: 3 } });
    assert.equal(started.isError, false);
    assert.match(started.content[0].text, /^Started Worker "Market scan" \(id wrk_[a-z0-9]+\), 3 of 3 turns left\./);
    assert.match(started.content[0].text, /tell the person in a sentence/);
    const id = started.structuredContent.worker.id;
    assert.deepEqual(calls[0], ["spawn", "scout", "Market scan", "lifespan chosen"]);
    assert.equal(started.structuredContent.worker.action, "started");

    const listed = await call("workers_list", {});
    assert.match(listed.content[0].text, /Live Workers \(1 of 3\):/);
    assert.match(listed.content[0].text, new RegExp(`${id} — "Market scan" — working on it, 3 of 3 turns left`));

    const steered = await call("worker_steer", { id, text: "Skip vendor C." });
    assert.match(steered.content[0].text, /^Steered "Market scan"; it takes that as its next step once its current step settles\./);
    assert.deepEqual(calls[1], ["steer", "scout", id, "Skip vendor C."]);

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
    assert.match(again.content[0].text, /had already stopped; nothing to stop\./);
    assert.equal(calls.filter((entry) => entry[0] === "cancel").length, 1);

    const bad = await call("worker_steer", { id: "nope", text: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Name the Worker by its id/);
  } finally {
    await server.stop();
  }
});
