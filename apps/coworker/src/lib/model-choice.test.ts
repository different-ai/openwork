import assert from "node:assert/strict";
import test from "node:test";
import { carryVariant, clearAutoPicked, markAutoPicked, peekStartingModel, setStartingModel, takeStartingModel, wasAutoPicked } from "./model-choice.ts";

test("the person's thinking effort stays across a model change only when the new model offers it", () => {
  const withHigh = { variants: ["low", "medium", "high"] };
  assert.equal(carryVariant("high", withHigh), "high", "kept when offered");
  assert.equal(carryVariant(" high ", withHigh), "high", "whitespace never makes it a different effort");
  assert.equal(carryVariant("xhigh", withHigh), "", "an effort the new model does not know returns to the model default");
  assert.equal(carryVariant("high", { variants: [] }), "", "a model without efforts runs at its default");
  assert.equal(carryVariant("high", null), "", "an unknown model (no catalog entry) never keeps a guess");
  assert.equal(carryVariant("", withHigh), "", "the model default stays the model default");
});

test("a model the app picked may be swapped once it fails; a model the person picked never is", () => {
  clearAutoPicked("nova");
  assert.equal(wasAutoPicked("nova", "openwork/claude"), false, "nothing picked yet");
  markAutoPicked("nova", "openwork/claude");
  assert.equal(wasAutoPicked("nova", "openwork/claude"), true);
  assert.equal(wasAutoPicked("nova", "openwork/other"), false, "only the exact model the app chose");
  assert.equal(wasAutoPicked("editor", "openwork/claude"), false, "per coworker");
  assert.equal(wasAutoPicked("nova", ""), false, "an empty model is never an automatic pick");
  clearAutoPicked("nova");
  assert.equal(wasAutoPicked("nova", "openwork/claude"), false, "the person choosing (a model or an effort) ends the app's claim on it");
});

test("the model chosen on the local mode screen goes to the first coworker once", () => {
  setStartingModel("  ollama/llama3  ");
  assert.equal(peekStartingModel(), "ollama/llama3", "peeking keeps it");
  assert.equal(takeStartingModel(), "ollama/llama3");
  assert.equal(takeStartingModel(), "", "taken once");
  assert.equal(peekStartingModel(), "");
});
