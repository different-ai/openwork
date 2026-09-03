import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_OPENER,
  describeLifespan,
  describeReview,
  describeWorkerStatus,
  isLiveWorker,
  parseWorkerReview,
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
