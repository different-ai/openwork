import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_OPENER,
  lifespanFromChoice,
  parseWorkerDecision,
  parseWorkerReview,
  parseWorkerTurn,
} from "./workers.ts";

const NOW = new Date(2026, 8, 2, 15, 0).getTime();

test("the review turn is read back as its updates, and nothing else is", () => {
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
  assert.equal(parseWorkerReview("Please review these updates from your Workers."), null);
  assert.equal(parseWorkerReview(`${REVIEW_OPENER}\n\nno updates section`), null);
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

test("the app's own turns in a Worker's thread read back as what they asked for", () => {
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

test("a decision finding splits into the question and its lettered choices", () => {
  assert.deepEqual(parseWorkerDecision("Should I include vendor C in the scan?\n- A) Yes, include it\n- B) No, skip it"), {
    question: "Should I include vendor C in the scan?",
    options: ["Yes, include it", "No, skip it"],
  });
  // One bullet is not a choice; open questions keep their text whole.
  assert.deepEqual(parseWorkerDecision("The file is missing.\n- Should I create it?"), { question: "The file is missing.\n- Should I create it?", options: [] });
  assert.deepEqual(parseWorkerDecision("What budget should I assume?"), { question: "What budget should I assume?", options: [] });
});
