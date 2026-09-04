import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NO_REPLY,
  WAIT_BUDGET_MS,
  choiceNavigates,
  cutOffLine,
  deriveTurnOutcome,
  failureChoices,
  retryLine,
  retrySummary,
  type TurnChoiceId,
  type TurnFacts,
} from "./turn-outcome.ts";

const NOW = 1_000_000;

function facts(overrides: Partial<TurnFacts> = {}): TurnFacts {
  return {
    coworkerName: "Nova",
    now: NOW,
    turn: { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - 5_000, stoppedAt: null, recovered: false },
    engine: { type: "busy" },
    reply: NO_REPLY,
    needsYou: false,
    failure: "",
    appRetry: null,
    attemptActive: false,
    waitBudgetMs: WAIT_BUDGET_MS,
    signedIn: false,
    recommendedModel: "",
    ...overrides,
  };
}

test("nothing in flight and nobody waiting: nothing to say", () => {
  assert.equal(deriveTurnOutcome(facts({ turn: null })), null);
});

test("a fresh turn is working, with Stop one click away and no words of its own", () => {
  const outcome = deriveTurnOutcome(facts());
  assert.equal(outcome?.kind, "working");
  assert.equal(outcome?.label, "Working");
  assert.equal(outcome?.tone, "spark");
  assert.equal(outcome?.line, "");
  assert.deepEqual(outcome?.choices.map((choice) => choice.id), ["stop"]);
  // The engine has not picked the turn up yet: still working, never cut off, for a live send.
  assert.equal(deriveTurnOutcome(facts({ engine: { type: "idle" } }))?.kind, "working");
});

test("the wait budget passing while the engine is still busy is slow, not failed", () => {
  const outcome = deriveTurnOutcome(facts({ turn: { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - WAIT_BUDGET_MS, stoppedAt: null, recovered: false } }));
  assert.equal(outcome?.kind, "slow");
  assert.equal(outcome?.label, "Still working");
  assert.equal(outcome?.tone, "spark");
  assert.equal(outcome?.line, "Nova is still working on it…");
  assert.deepEqual(outcome?.choices.map((choice) => choice.id), ["stop"]);
  // A reply the engine is still writing past the budget is the same: still working.
  assert.equal(deriveTurnOutcome(facts({
    turn: { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - WAIT_BUDGET_MS - 1, stoppedAt: null, recovered: false },
    reply: { state: "writing", error: "", retryable: null, aborted: false },
  }))?.kind, "slow");
});

test("a reply that landed is replied", () => {
  const outcome = deriveTurnOutcome(facts({ engine: { type: "idle" }, reply: { state: "complete", error: "", retryable: null, aborted: false } }));
  assert.equal(outcome?.kind, "replied");
  assert.deepEqual(outcome?.choices, []);
});

test("the engine's own retry is trying again, live, with the count in the line", () => {
  const outcome = deriveTurnOutcome(facts({ engine: { type: "retry", attempt: 2, message: "429 rate limited", next: NOW + 5_400, reason: null } }));
  assert.equal(outcome?.kind, "retrying");
  assert.equal(outcome?.label, "Retrying");
  assert.equal(outcome?.tone, "amber");
  assert.equal(outcome?.line, "Couldn't reach the AI model. Trying again in 6 s…");
  assert.deepEqual(outcome?.retry, { attempt: 2, nextAt: NOW + 5_400, by: "engine", reason: null });
  assert.deepEqual(outcome?.choices.map((choice) => choice.id), ["stop"]);
  assert.equal(retryLine(NOW + 200, NOW), "Couldn't reach the AI model. Trying again…");
});

test("a retry the engine pushed hours away is a failure with the provider's words, not endless Retrying", () => {
  const outcome = deriveTurnOutcome(facts({ engine: { type: "retry", attempt: 1, message: "Provider is over capacity, retrying tomorrow.", next: NOW + 9 * 3_600_000, reason: null } }));
  assert.equal(outcome?.kind, "failed");
  assert.equal(outcome?.label, "Reply failed");
  assert.equal(outcome?.line, "Nova's AI model could not answer.");
  assert.equal(outcome?.technical, "Provider is over capacity, retrying tomorrow");
  assert.equal(outcome?.modelRelated, true);
});

test("the free model's shared limit, while the engine retries, is named in the app's words with the way out inline", () => {
  const outcome = deriveTurnOutcome(facts({
    engine: { type: "retry", attempt: 2, message: "Free usage exceeded, subscribe to Go", next: NOW + 5_400, reason: "free_tier_limit" },
  }));
  assert.equal(outcome?.kind, "retrying");
  assert.equal(outcome?.label, "Retrying");
  assert.equal(outcome?.line, "The free model is busy. Trying again in 6 s…");
  assert.equal(outcome?.modelRelated, true);
  assert.deepEqual(outcome?.choices.map((choice) => choice.id), ["stop", "connect-provider"]);
  assert.doesNotMatch(JSON.stringify(outcome), /subscribe|Go\b/);
  assert.deepEqual(outcome?.retry, { attempt: 2, nextAt: NOW + 5_400, by: "engine", reason: "free_tier_limit" });
  assert.equal(retryLine(NOW + 200, NOW, "free_tier_limit"), "The free model is busy. Trying again…");
  assert.equal(retryLine(NOW + 200, NOW, "account_rate_limit"), "Couldn't reach the AI model. Trying again…");
  assert.equal(retrySummary("free_tier_limit"), "The free model is busy. Trying again…");
  assert.equal(retrySummary(null), "Couldn't reach the AI model. Trying again…");
});

test("the free model's shared limit pushed hours away is that limit, named, with connecting a provider as the way out", () => {
  const outcome = deriveTurnOutcome(facts({
    engine: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", next: NOW + 9 * 3_600_000, reason: "free_tier_limit" },
    signedIn: true,
  }));
  assert.equal(outcome?.kind, "failed");
  assert.equal(outcome?.line, "The free model is busy right now.");
  assert.match(outcome?.detail ?? "", /OpenWork Models membership and your own AI providers so Nova can keep working/);
  assert.match(outcome?.technical ?? "", /free_tier_limit/);
  assert.deepEqual(outcome?.choices.map((choice) => `${choice.letter} ${choice.label}`), ["A Retry", "B Choose AI model", "C Connect an AI provider"]);
});

test("the free model's limit as the engine's terminal error reads the same, and a connected model takes the first letter", () => {
  const raw = "APIError · FreeUsageLimitError: Error from provider (Console): Rate limit exceeded. Please try again later.";
  const outcome = deriveTurnOutcome(facts({
    engine: { type: "idle" },
    reply: { state: "error", error: raw, retryable: true, aborted: false },
    recommendedModel: "GPT-5 mini",
    signedIn: false,
  }));
  assert.equal(outcome?.kind, "failed");
  assert.equal(outcome?.line, "The free model is busy right now.");
  assert.equal(outcome?.technical, raw);
  assert.deepEqual(outcome?.choices.map((choice) => `${choice.letter} ${choice.label}`), ["A Use GPT-5 mini", "B Choose AI model", "C Connect an AI provider"]);
});

test("a retry whose moment is long past is over: the engine reads idle", () => {
  // Recovered after a quit: idle with no reply is cut off.
  const outcome = deriveTurnOutcome(facts({
    turn: { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - 400_000, stoppedAt: null, recovered: true },
    engine: { type: "retry", attempt: 3, message: "rate limited", next: NOW - 90_000, reason: null },
  }));
  assert.equal(outcome?.kind, "cut-off");
});

test("an automatic attempt the app scheduled reads the same as the engine's, and says whose it is", () => {
  const outcome = deriveTurnOutcome(facts({ engine: { type: "idle" }, reply: { state: "error", error: "ECONNRESET", retryable: null, aborted: false }, appRetry: { attempt: 1, nextAt: NOW + 2_000 } }));
  assert.equal(outcome?.kind, "retrying");
  assert.equal(outcome?.line, "Couldn't reach the AI model. Trying again in 2 s…");
  assert.deepEqual(outcome?.retry, { attempt: 1, nextAt: NOW + 2_000, by: "app", reason: null });
});

test("an attempt being classified never flashes its raw engine error as a failure", () => {
  const outcome = deriveTurnOutcome(facts({
    engine: { type: "idle" },
    reply: { state: "error", error: "APIError: rate limited", retryable: true, aborted: false },
    attemptActive: true,
  }));
  assert.equal(outcome?.kind, "working");
});

test("a stop by the person is one word with Retry, whatever the engine or the wait still reports", () => {
  const outcome = deriveTurnOutcome(facts({ turn: { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - 5_000, stoppedAt: NOW - 1_000, recovered: false }, failure: "The operation was aborted" }));
  assert.equal(outcome?.kind, "stopped-by-you");
  assert.equal(outcome?.line, "Stopped.");
  assert.equal(outcome?.label, "Stopped");
  assert.equal(outcome?.tone, "mist");
  assert.equal(outcome?.since, NOW - 1_000);
  assert.deepEqual(outcome?.choices.map((choice) => choice.id), ["retry"]);
});

test("a turn read back after a quit with the engine idle and no finished reply was cut off", () => {
  const recovered = { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - 600_000, stoppedAt: null, recovered: true };
  for (const reply of [NO_REPLY, { state: "writing" as const, error: "", retryable: null, aborted: false }, { state: "error" as const, error: "The operation was aborted", retryable: null, aborted: true }]) {
    const outcome = deriveTurnOutcome(facts({ turn: recovered, engine: { type: "idle" }, reply }));
    assert.equal(outcome?.kind, "cut-off", reply.state);
    assert.equal(outcome?.line, cutOffLine("Nova"));
    assert.equal(outcome?.label, "Stopped");
    assert.deepEqual(outcome?.choices.map((choice) => choice.id), ["continue", "discard"]);
  }
  // The engine still on it after a reload is simply working, and a finished reply is replied.
  assert.equal(deriveTurnOutcome(facts({ turn: recovered, engine: { type: "busy" } }))?.kind, "slow");
  assert.equal(deriveTurnOutcome(facts({ turn: recovered, engine: { type: "idle" }, reply: { state: "complete", error: "", retryable: null, aborted: false } }))?.kind, "replied");
});

test("an aborted reply in a live session that nobody stopped is a failure in the coworker's voice", () => {
  const outcome = deriveTurnOutcome(facts({ engine: { type: "idle" }, reply: { state: "error", error: "The operation was aborted", retryable: null, aborted: true } }));
  assert.equal(outcome?.kind, "failed");
  assert.equal(outcome?.line, "Nova stopped before replying.");
});

test("a failed reply leads with the headline, keeps the raw text behind Technical details, and letters at most three ways out", () => {
  const raw = 'APIError: No endpoints found that support tool use. Try disabling "bash".';
  const outcome = deriveTurnOutcome(facts({ engine: { type: "idle" }, reply: { state: "error", error: raw, retryable: false, aborted: false }, recommendedModel: "Claude Sonnet", signedIn: false }));
  assert.equal(outcome?.kind, "failed");
  assert.equal(outcome?.label, "Reply failed");
  assert.equal(outcome?.tone, "amber");
  assert.equal(outcome?.line, "Nova's AI model cannot use the tools enabled for this coworker.");
  assert.equal(outcome?.technical, raw);
  assert.equal(outcome?.modelRelated, true);
  assert.deepEqual(outcome?.choices, [
    { id: "use-model", label: "Use Claude Sonnet", letter: "A" },
    { id: "choose-model", label: "Choose AI model", letter: "B" },
    { id: "continue-with-openwork", label: "Continue with OpenWork", letter: "C" },
  ]);
});

test("a failure the app met before sending (a model that is not connected) is failed with the same shape", () => {
  const raw = 'The saved model "missing/one" is not available: provider "missing" is not connected on this Mac. Choose another AI model or connect that provider in OpenWork.';
  const outcome = deriveTurnOutcome(facts({ engine: { type: "idle" }, failure: raw, signedIn: true }));
  assert.equal(outcome?.kind, "failed");
  assert.equal(outcome?.line, "Nova's AI model is not available.");
  assert.equal(outcome?.detail, raw);
  assert.deepEqual(outcome?.choices.map((choice) => `${choice.letter} ${choice.label}`), ["A Retry", "B Choose AI model", "C Refresh providers"]);
});

test("a failure that is not about the model offers Retry and another model, nothing else", () => {
  assert.deepEqual(failureChoices({ modelRelated: false, recommendedModel: "Claude Sonnet", signedIn: true }).map((choice) => `${choice.letter} ${choice.label}`), ["A Retry", "B Choose AI model"]);
  assert.deepEqual(failureChoices({ modelRelated: true, recommendedModel: "", signedIn: true }).map((choice) => `${choice.letter} ${choice.label}`), ["A Retry", "B Choose AI model", "C Refresh providers"]);
  for (const input of [{ modelRelated: true, recommendedModel: "X", signedIn: false }, { modelRelated: false, recommendedModel: "", signedIn: false }, { modelRelated: true, recommendedModel: "X", signedIn: true, freeModelLimit: true }]) {
    assert.ok(failureChoices(input).length <= 3);
  }
  // The free model's limit: connecting a provider is the third way, signed in or not.
  for (const signedIn of [true, false]) {
    assert.deepEqual(failureChoices({ modelRelated: true, recommendedModel: "", signedIn, freeModelLimit: true }).map((choice) => `${choice.letter} ${choice.label}`), ["A Retry", "B Choose AI model", "C Connect an AI provider"]);
  }
});

test("a permission or question waiting on the person comes first, whatever else is going on", () => {
  const outcome = deriveTurnOutcome(facts({ needsYou: true, engine: { type: "busy" } }));
  assert.equal(outcome?.kind, "waiting-on-you");
  assert.equal(outcome?.label, "Needs you");
  assert.equal(outcome?.tone, "amber");
  assert.deepEqual(outcome?.choices, []);
  assert.equal(deriveTurnOutcome(facts({ needsYou: true, turn: null }))?.kind, "waiting-on-you");
});

test("a finished step while the engine is still busy is still working, not replied", () => {
  const outcome = deriveTurnOutcome(facts({ engine: { type: "busy" }, reply: { state: "complete", error: "", retryable: null, aborted: false } }));
  assert.equal(outcome?.kind, "working");
});

test("a failure keeps one steady moment, so its card does not re-open on every tick", () => {
  const turn = { messageId: "msg_1", prompt: "Draft the note.", startedAt: NOW - 5_000, stoppedAt: null, recovered: false };
  const first = deriveTurnOutcome(facts({ turn, engine: { type: "idle" }, reply: { state: "error", error: "ECONNRESET", retryable: null, aborted: false } }));
  const later = deriveTurnOutcome(facts({ turn, now: NOW + 3_000, engine: { type: "idle" }, reply: { state: "error", error: "ECONNRESET", retryable: null, aborted: false } }));
  assert.equal(first?.since, later?.since);
});

test("only the choices that open another screen leave the failure's card ready for the person's return", () => {
  const navigates: TurnChoiceId[] = ["choose-model", "connect-provider", "continue-with-openwork"];
  const acts: TurnChoiceId[] = ["retry", "use-model", "refresh-providers", "stop", "continue", "discard"];
  for (const id of navigates) assert.equal(choiceNavigates(id), true, id);
  for (const id of acts) assert.equal(choiceNavigates(id), false, id);
});
