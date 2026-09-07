import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EFFORT_STOP,
  EFFORT_STOPS,
  describeEffortStop,
  describeEffortUsed,
  effortForTurn,
  effortLevelFor,
  effortShift,
  effortStopLabel,
  effortStopOf,
  laneWithPreference,
  replyKindForLane,
  variantForLevel,
  workerTurnsFor,
} from "./effort.ts";
import { bannedWordIn } from "./local-providers.ts";

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];

test("the dial has five stops, Balanced in the middle, and an unknown stored value never turns it", () => {
  assert.deepEqual([...EFFORT_STOPS], ["light", "steady", "balanced", "thorough", "all-in"]);
  assert.equal(effortStopOf("thorough"), "thorough");
  assert.equal(effortStopOf(""), DEFAULT_EFFORT_STOP);
  assert.equal(effortStopOf("max"), DEFAULT_EFFORT_STOP, "an exact effort is not a stop");
  assert.equal(effortStopOf(undefined), DEFAULT_EFFORT_STOP);
  assert.deepEqual(EFFORT_STOPS.map(effortShift), [-2, -1, 0, 1, 2]);
});

test("each kind of work has a baseline the dial shifts, clamped to the scale; the facilitator never moves", () => {
  // Balanced: the baselines themselves.
  assert.equal(effortLevelFor("quick-reply", "balanced"), 1);
  assert.equal(effortLevelFor("reply", "balanced"), 2);
  assert.equal(effortLevelFor("deep-reply", "balanced"), 3);
  assert.equal(effortLevelFor("worker-turn", "balanced"), 3);
  assert.equal(effortLevelFor("assignment-run", "balanced"), 3);
  assert.equal(effortLevelFor("review", "balanced"), 2);
  assert.equal(effortLevelFor("facilitator", "balanced"), 0);
  // The dial moves everything but the facilitator.
  assert.equal(effortLevelFor("reply", "all-in"), 4);
  assert.equal(effortLevelFor("worker-turn", "all-in"), 5);
  assert.equal(effortLevelFor("worker-turn", "light"), 1);
  assert.equal(effortLevelFor("quick-reply", "light"), 0, "clamped at minimal");
  assert.equal(effortLevelFor("assignment-run", "all-in"), 5, "clamped at max");
  for (const stop of EFFORT_STOPS) assert.equal(effortLevelFor("facilitator", stop), 0);
});

test("a level snaps to the nearest effort the model offers, ties go lower, and a model without efforts runs at its default", () => {
  assert.equal(variantForLevel(3, SIX), "high");
  assert.equal(variantForLevel(0, SIX), "minimal");
  assert.equal(variantForLevel(5, SIX), "max");
  assert.equal(variantForLevel(3, ["low", "high"]), "high");
  assert.equal(variantForLevel(2, ["low", "high"]), "low", "medium is one step from both; the lower wins");
  assert.equal(variantForLevel(4, ["low", "medium"]), "medium", "a model that stops at medium never gets asked for more");
  assert.equal(variantForLevel(1, ["high"]), "high", "one offered effort is the only answer");
  assert.equal(variantForLevel(3, []), "", "no efforts: the model default");
  // Efforts the engine does not name are read as evenly spaced from least to most.
  assert.equal(variantForLevel(0, ["fast", "thinking"]), "fast");
  assert.equal(variantForLevel(5, ["fast", "thinking"]), "thinking");
  assert.equal(variantForLevel(2, ["fast", "thinking"]), "fast");
  assert.equal(variantForLevel(3, ["fast", "thinking"]), "thinking");
});

test("the effort a turn is sent with: an exact effort the person fixed wins when offered, otherwise the dial through the kind", () => {
  assert.equal(effortForTurn({ kind: "worker-turn", stop: "balanced", fixedVariant: "", variants: SIX }), "high");
  assert.equal(effortForTurn({ kind: "worker-turn", stop: "all-in", fixedVariant: "", variants: SIX }), "max");
  assert.equal(effortForTurn({ kind: "quick-reply", stop: "balanced", fixedVariant: "", variants: SIX }), "low");
  assert.equal(effortForTurn({ kind: "quick-reply", stop: "thorough", fixedVariant: "", variants: SIX }), "medium");
  assert.equal(effortForTurn({ kind: "reply", stop: "light", fixedVariant: "", variants: SIX }), "minimal");
  assert.equal(effortForTurn({ kind: "reply", stop: "all-in", fixedVariant: "low", variants: SIX }), "low", "the person's exact effort wins over the dial");
  assert.equal(effortForTurn({ kind: "reply", stop: "all-in", fixedVariant: "ultra", variants: SIX }), "xhigh", "an exact effort the model does not offer is ignored, not guessed");
  assert.equal(effortForTurn({ kind: "reply", stop: "all-in", fixedVariant: "", variants: [] }), "", "no efforts offered: the model default, whatever the dial says");
  assert.equal(effortForTurn({ kind: "facilitator", stop: "all-in", fixedVariant: "", variants: SIX }), "minimal");
});

test("the dial nudges the lane a message takes, one step at most, and Balanced leaves it alone", () => {
  for (const lane of ["quick", "standard", "deep"] as const) assert.equal(laneWithPreference(lane, "balanced"), lane);
  assert.equal(laneWithPreference("quick", "thorough"), "standard", "Thorough gives a quick ask a proper look");
  assert.equal(laneWithPreference("standard", "thorough"), "standard", "one step up only reaches the quick lane");
  assert.equal(laneWithPreference("standard", "all-in"), "deep");
  assert.equal(laneWithPreference("quick", "all-in"), "standard");
  assert.equal(laneWithPreference("deep", "all-in"), "deep", "nothing above deep");
  assert.equal(laneWithPreference("deep", "steady"), "standard");
  assert.equal(laneWithPreference("standard", "steady"), "standard");
  assert.equal(laneWithPreference("standard", "light"), "quick");
  assert.equal(laneWithPreference("quick", "light"), "quick");
  assert.deepEqual([replyKindForLane("quick"), replyKindForLane("standard"), replyKindForLane("deep")], ["quick-reply", "reply", "deep-reply"]);
});

test("a Worker's default turns follow the dial", () => {
  assert.deepEqual(EFFORT_STOPS.map(workerTurnsFor), [6, 8, 10, 14, 20]);
});

test("the dial's words are plain and say what a stop means for the turns", () => {
  assert.deepEqual(EFFORT_STOPS.map(effortStopLabel), ["Light", "Steady", "Balanced", "Thorough", "All in"]);
  for (const stop of EFFORT_STOPS) {
    assert.equal(bannedWordIn(describeEffortStop(stop)), null);
    assert.ok(describeEffortStop(stop).length < 140, `${stop}: one line`);
  }
  assert.equal(describeEffortUsed({ variant: "high", stop: "thorough", kind: "worker-turn", fixed: false }), "Thinking effort: high — Thorough, a Worker turn");
  assert.equal(describeEffortUsed({ variant: "low", stop: "balanced", kind: "reply", fixed: true }), "Thinking effort: low — fixed in Coworker settings");
  assert.equal(describeEffortUsed({ variant: "", stop: "all-in", kind: "quick-reply", fixed: false }), "Thinking effort: the model's default — a quick reply");
});
