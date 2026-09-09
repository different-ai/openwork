import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EFFORT_STOPS,
  effortForTurn,
  laneWithPreference,
  replyKindForLane,
  variantForLevel,
  workerTurnsFor,
} from "./effort.ts";
import { classifyRequest } from "./model-choice.ts";

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];

test("a level snaps to the nearest effort the model offers, ties go lower, and a model without efforts runs at its default", () => {
  assert.equal(variantForLevel(2, ["low", "high"]), "low", "medium is one step from both; the lower wins");
  assert.equal(variantForLevel(4, ["low", "medium"]), "medium", "a model that stops at medium never gets asked for more");
  assert.equal(variantForLevel(3, []), "", "no efforts: the model default");
  // Efforts the engine does not name are read as evenly spaced from least to most.
  assert.equal(variantForLevel(2, ["fast", "thinking"]), "fast");
});

test("the effort a turn is sent with: an exact effort the person fixed wins when offered, otherwise the dial through the kind", () => {
  const lane = classifyRequest("Quick audit; keep the answer short.");
  const kind = replyKindForLane(laneWithPreference(lane, "balanced"));
  assert.equal(effortForTurn({ kind, stop: "balanced", fixedVariant: "", variants: SIX }), "high", "a short audit still gets deep effort");
  assert.equal(laneWithPreference(lane, "light"), "standard", "the explicit dial still nudges the lane");
  assert.equal(effortForTurn({ kind, stop: "all-in", fixedVariant: "low", variants: SIX }), "low", "a fixed effort still overrides deep work");
  assert.equal(effortForTurn({ kind: "worker-turn", stop: "balanced", fixedVariant: "", variants: SIX }), "high");
  assert.equal(effortForTurn({ kind: "worker-turn", stop: "all-in", fixedVariant: "", variants: SIX }), "max");
  assert.equal(effortForTurn({ kind: "reply", stop: "all-in", fixedVariant: "low", variants: SIX }), "low", "the person's exact effort wins over the dial");
  assert.equal(effortForTurn({ kind: "reply", stop: "all-in", fixedVariant: "ultra", variants: SIX }), "xhigh", "an exact effort the model does not offer is ignored, not guessed");
  assert.equal(effortForTurn({ kind: "reply", stop: "all-in", fixedVariant: "", variants: [] }), "", "no efforts offered: the model default, whatever the dial says");
  assert.equal(effortForTurn({ kind: "facilitator", stop: "all-in", fixedVariant: "", variants: SIX }), "minimal");
});

test("a Worker's default turns follow the dial", () => {
  assert.deepEqual(EFFORT_STOPS.map(workerTurnsFor), [6, 8, 10, 14, 20]);
});
