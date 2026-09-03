import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_OPENER,
  WORKER_THREAD_TITLE_PREFIX,
  WORKER_TURN_OPENER,
  describeLifespan,
  describeReview,
  describeWorkerCount,
  describeWorkerEvent,
  describeWorkerStatus,
  describeWorkerToolStep,
  isLiveWorker,
  lifespanFromChoice,
  parseWorkerReview,
  parseWorkerTurn,
  workerNameFromTitle,
  workerToolName,
  workerTone,
} from "./workers.ts";

const NOW = new Date(2026, 8, 2, 15, 0).getTime();

test("lifespans read as plain words", () => {
  assert.equal(describeLifespan({ kind: "turns", max: 10, used: 7 }, NOW), "3 of 10 turns left");
  assert.equal(describeLifespan({ kind: "turns", max: 1, used: 0 }, NOW), "1 of 1 turn left");
  assert.equal(describeLifespan({ kind: "turns", max: 3, used: 5 }, NOW), "0 of 3 turns left");
  assert.equal(describeLifespan({ kind: "open" }, NOW), "Until you stop it");
  const later = new Date(2026, 8, 2, 18, 0).getTime();
  assert.equal(describeLifespan({ kind: "until", at: later }, NOW), `Until ${new Date(later).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  assert.match(describeLifespan({ kind: "until", at: NOW + 86_400_000 }, NOW), /^Until tomorrow /);
  assert.match(describeLifespan({ kind: "until", at: NOW + 3 * 86_400_000 }, NOW), /^Until (Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday) /);
  assert.match(describeLifespan({ kind: "until", at: NOW + 30 * 86_400_000 }, NOW), /^Until [A-Z][a-z]{2} \d/);
});

test("status words are the shared vocabulary, never codes", () => {
  assert.equal(describeWorkerStatus({ status: "starting", waitingFor: "" }), "Starting");
  assert.equal(describeWorkerStatus({ status: "running", waitingFor: "" }), "Working on it");
  assert.equal(describeWorkerStatus({ status: "waiting", waitingFor: "turn" }), "Waiting its turn");
  assert.equal(describeWorkerStatus({ status: "waiting", waitingFor: "decision" }), "Waiting for a decision");
  assert.equal(describeWorkerStatus({ status: "paused", waitingFor: "" }), "Paused");
  assert.equal(describeWorkerStatus({ status: "finished", waitingFor: "" }), "Done");
  assert.equal(describeWorkerStatus({ status: "cancelled", waitingFor: "" }), "Stopped");
  assert.equal(describeWorkerStatus({ status: "failed", waitingFor: "" }), "Didn't finish");
  assert.equal(isLiveWorker({ status: "paused" }), true);
  assert.equal(isLiveWorker({ status: "cancelled" }), false);
});

test("the review turn is read back as its updates, and nothing else is", () => {
  // The exact opener the main process writes (electron/workers.mjs REVIEW_OPENER).
  assert.equal(REVIEW_OPENER, "Review these updates from your Workers.");
  const prompt = [
    REVIEW_OPENER,
    "",
    "You are Nova. Your Workers right now:",
    '- "Market scan" — working on it, 8 of 10 turns left',
    "",
    "New updates:",
    'Worker "Market scan" reported: Prices rose 3% at two vendors.',
    'Worker "Inbox watch" needs a decision: Archive the newsletter?',
    "- A) Yes",
    "- B) No",
    'Worker "Old one" finished: All done.',
    'Worker "Flaky" didn\'t finish: Model unavailable',
    "",
    "Review these updates. Reply to the person in a few sentences with what changed and what you will do. If a Worker needs steering or should stop, say so plainly; if a decision needs the person, ask them.",
  ].join("\n");
  const review = parseWorkerReview(prompt);
  assert.deepEqual(review, {
    updates: [
      { worker: "Market scan", kind: "finding", text: "Prices rose 3% at two vendors." },
      { worker: "Inbox watch", kind: "decision", text: "Archive the newsletter?\n- A) Yes\n- B) No" },
      { worker: "Old one", kind: "done", text: "All done." },
      { worker: "Flaky", kind: "failed", text: "Model unavailable" },
    ],
  });
  assert.equal(describeReview(review), "Reviewed 4 updates from Workers");
  assert.equal(describeReview({ updates: [{ worker: "Market scan", kind: "finding", text: "x" }] }), "Reviewed an update from Market scan");
  assert.equal(
    describeReview({ updates: [{ worker: "Market scan", kind: "finding", text: "x" }, { worker: "Market scan", kind: "done", text: "y" }] }),
    "Reviewed 2 updates from Market scan",
  );
  assert.equal(parseWorkerReview("Please review these updates from your Workers."), null);
  assert.equal(parseWorkerReview(`${REVIEW_OPENER}\n\nno updates section`), null);
});

test("worker threads are named from the title the app gave them, and rows take the app's tones", () => {
  // The exact prefix the main process writes (electron/workers.mjs WORKER_THREAD_TITLE_PREFIX).
  assert.equal(WORKER_THREAD_TITLE_PREFIX, "Worker: ");
  assert.equal(workerNameFromTitle("Worker: Market scan"), "Market scan");
  assert.equal(workerNameFromTitle("  Worker:   "), "Worker:");
  assert.equal(workerNameFromTitle("Launch brief"), "Launch brief");
  assert.equal(workerTone({ status: "running", waitingFor: "" }), "spark");
  assert.equal(workerTone({ status: "waiting", waitingFor: "turn" }), "spark");
  assert.equal(workerTone({ status: "waiting", waitingFor: "decision" }), "amber");
  assert.equal(workerTone({ status: "paused", waitingFor: "" }), "mist");
  assert.equal(workerTone({ status: "finished", waitingFor: "" }), "mint");
  assert.equal(workerTone({ status: "failed", waitingFor: "" }), "rose");
  assert.equal(workerTone({ status: "cancelled", waitingFor: "" }), "mist");
});

test("timeline events read as plain lines attributed to the right party", () => {
  const base = { id: "evt_1", at: 1 };
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "finding", report: "finding", text: "Prices rose." }, "Nova"), { label: "Finding", text: "Prices rose.", quiet: false });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "finding", report: "decision", text: "A or B?" }, "Nova"), { label: "Needs a decision", text: "A or B?", quiet: false });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "finding", report: "done", text: "All set." }, "Nova"), { label: "Done", text: "All set.", quiet: false });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "steer", by: "coworker", text: "Skip C." }, "Nova"), { label: "Steered by Nova", text: "Skip C.", quiet: true });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "steer", by: "person", text: "Add D." }, "Nova"), { label: "Steered by you", text: "Add D.", quiet: true });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "review", text: "x" }, "Nova"), { label: "", text: "Nova reviewed this", quiet: true });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "review", text: "x", error: "failed" }, "Nova"), { label: "", text: "Nova could not review this yet", quiet: true });
  assert.deepEqual(describeWorkerEvent({ ...base, kind: "status", text: "Stopped" }, "Nova"), { label: "", text: "Stopped", quiet: true });
});

test("the New Worker form's lifespan choice becomes a bounded lifespan or a plain message", () => {
  assert.deepEqual(lifespanFromChoice({ kind: "open" }), { lifespan: { kind: "open" } });
  assert.deepEqual(lifespanFromChoice({ kind: "turns", turns: "12" }), { lifespan: { kind: "turns", max: 12, used: 0 } });
  assert.deepEqual(lifespanFromChoice({ kind: "turns", turns: "0" }), { error: "Choose between 1 and 100 turns." });
  assert.deepEqual(lifespanFromChoice({ kind: "turns", turns: "abc" }), { error: "Choose between 1 and 100 turns." });
  assert.deepEqual(lifespanFromChoice({ kind: "until", at: "" }, NOW), { error: "Choose when the Worker should stop." });
  assert.deepEqual(lifespanFromChoice({ kind: "until", at: "2026-09-02T14:00" }, NOW), { error: "Choose a time that is still ahead." });
  const later = lifespanFromChoice({ kind: "until", at: "2026-09-02T18:00" }, NOW);
  assert.deepEqual(later, { lifespan: { kind: "until", at: new Date(2026, 8, 2, 18, 0).getTime() } });
});

test("the live Worker count reads as one line", () => {
  assert.equal(describeWorkerCount([]), "");
  assert.equal(describeWorkerCount([{ status: "finished", waitingFor: "" }]), "");
  assert.equal(describeWorkerCount([{ status: "running", waitingFor: "" }]), "1 Worker · 1 running");
  assert.equal(
    describeWorkerCount([{ status: "running", waitingFor: "" }, { status: "waiting", waitingFor: "turn" }, { status: "waiting", waitingFor: "decision" }]),
    "3 Workers · 2 running · 1 waiting for a decision",
  );
  assert.equal(describeWorkerCount([{ status: "paused", waitingFor: "" }, { status: "cancelled", waitingFor: "" }]), "1 Worker · 1 paused");
});

test("the app's own turns in a Worker's thread read back as what they asked for", () => {
  assert.equal(WORKER_TURN_OPENER, 'You are a Worker named "');
  const frame = [
    'You are a Worker named "Market scan" started by Nova. You work in Nova\'s workspace with the same files, memory, and tools.',
    "",
    "Your goal:",
    "Watch vendor prices.",
    "",
    "Keep an eye on vendor C too.",
    "",
    "Lifespan: 6 of 10 turns left.",
    'Work in bounded steps. After each meaningful step, end your turn with a section titled "Finding": 2–6 sentences a person can read.',
    "",
    "Steering from Nova: Skip vendor C.",
    "",
    "Steering from the person Nova works for: Add vendor D.",
  ].join("\n");
  assert.deepEqual(parseWorkerTurn(frame), { body: "Steering from Nova: Skip vendor C.\n\nSteering from the person Nova works for: Add vendor D." });
  assert.equal(parseWorkerTurn("Reply with exactly COWORKER CHAT READY."), null);
  assert.equal(parseWorkerTurn('You are a Worker named "x" but the frame is missing'), null);
});

test("the Workers view speaks plain words: no sub-agents, sessions, threads, slots, or engines in its copy", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../ui/workers.tsx", import.meta.url), "utf8");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const banned = /\b(sub-agents?|sessions?|threads?|slots?|engines?|orchestrators?)\b/gi;
  const hits = [...withoutComments.matchAll(banned)].map((match) => match[0]);
  assert.deepEqual(hits, []);
});

test("the coworker's Worker tool calls read as receipts that name the Worker", () => {
  assert.equal(workerToolName("coworker_worker_spawn"), "worker_spawn");
  assert.equal(workerToolName("WORKERS_LIST"), "workers_list");
  assert.equal(workerToolName("coworker_document_create"), "");
  const kept = { output: { content: [], structuredContent: { worker: { id: "wrk_a", name: "Market scan", action: "started" } } }, metadata: {} };
  assert.deepEqual(describeWorkerToolStep("worker_spawn", { input: { name: "typed name" }, ...kept }), { label: "Started a Worker · Market scan", doing: "starting a Worker" });
  assert.deepEqual(describeWorkerToolStep("worker_spawn", { input: { name: "Inbox watch" }, output: undefined, metadata: {} }), { label: "Started a Worker · Inbox watch", doing: "starting a Worker" });
  assert.deepEqual(describeWorkerToolStep("worker_steer", { input: { id: "wrk_a" }, ...kept }), { label: "Steered Market scan", doing: "steering Market scan" });
  assert.deepEqual(describeWorkerToolStep("worker_cancel", { input: { id: "wrk_a" }, output: undefined, metadata: {} }), { label: "Stopped a Worker", doing: "stopping a Worker" });
  assert.deepEqual(describeWorkerToolStep("worker_findings", { input: { id: "wrk_a" }, ...kept }), { label: "Read Market scan's findings", doing: "reading a Worker's findings" });
  assert.deepEqual(describeWorkerToolStep("workers_list", { input: {}, output: undefined, metadata: {} }), { label: "Looked over its Workers", doing: "looking over its Workers" });
});
