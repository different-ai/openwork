import assert from "node:assert/strict";
import test from "node:test";
import { bannedWordIn } from "./local-providers.ts";
import { carryVariant, clearAutoPicked, describeModelChoice, markAutoPicked, peekStartingModel, setStartingModel, takeStartingModel, wasAutoPicked } from "./model-choice.ts";

test("the person's thinking effort stays across a model change only when the new model offers it", () => {
  const withHigh = { variants: ["low", "medium", "high"] };
  assert.equal(carryVariant("high", withHigh), "high", "kept when offered");
  assert.equal(carryVariant(" high ", withHigh), "high", "whitespace never makes it a different effort");
  assert.equal(carryVariant("xhigh", withHigh), "", "an effort the new model does not know returns to the model default");
  assert.equal(carryVariant("high", { variants: [] }), "", "a model without efforts runs at its default");
  assert.equal(carryVariant("high", null), "", "an unknown model (no catalog entry) never keeps a guess");
  assert.equal(carryVariant("", withHigh), "", "the model default stays the model default");
});

test("a model the app picked may be swapped once it fails; a model the person picked never is — before and after a relaunch", () => {
  clearAutoPicked("nova");
  const record = (model: string, modelChosenBy: "app" | "person" | "") => ({ slug: "nova", model, modelChosenBy });
  // Before the record catches up: the session remembers the app's pick.
  assert.equal(wasAutoPicked(record("", ""), "openwork/claude"), false, "nothing picked yet");
  markAutoPicked("nova", "openwork/claude");
  assert.equal(wasAutoPicked(record("", ""), "openwork/claude"), true);
  assert.equal(wasAutoPicked(record("", ""), "openwork/other"), false, "only the exact model the app chose");
  assert.equal(wasAutoPicked({ ...record("", ""), slug: "editor" }, "openwork/claude"), false, "per coworker");
  assert.equal(wasAutoPicked(record("", ""), ""), false, "an empty model is never an automatic pick");
  clearAutoPicked("nova");
  assert.equal(wasAutoPicked(record("", ""), "openwork/claude"), false, "the person choosing (a model or an effort) ends the app's claim on it");
  // After a relaunch the session is empty; the record on disk answers the same way.
  assert.equal(wasAutoPicked(record("openwork/claude", "app"), "openwork/claude"), true, "the app's pick stays the app's pick across a relaunch");
  assert.equal(wasAutoPicked(record("openwork/claude", "app"), "openwork/other"), false, "a turn on another model is not the app's pick");
  assert.equal(wasAutoPicked(record("openwork/claude", "person"), "openwork/claude"), false, "the person's model is never swapped");
  assert.equal(wasAutoPicked(record("openwork/claude", ""), "openwork/claude"), false, "a record that never said who chose is the person's");
});

test("the app's own pick is explained in one plain line that says where the model came from and what follows", () => {
  assert.equal(describeModelChoice({ tier: "cloud" }), "Chosen for you, from your OpenWork account. It stays until you pick one; if it can't answer, the next best takes over once.");
  assert.equal(describeModelChoice({ tier: "key" }), "Chosen for you, from a subscription or key on this Mac. It stays until you pick one; if it can't answer, the next best takes over once.");
  assert.equal(describeModelChoice({ tier: "local-server" }), "Chosen for you, from a model server on this Mac. It stays until you pick one; if it can't answer, the next best takes over once.");
  assert.equal(describeModelChoice({ tier: "free" }), "Chosen for you, the free model, nothing to set up. It stays until you pick one; if it can't answer, the next best takes over once.");
  for (const tier of ["cloud", "key", "local-server", "free"] as const) {
    assert.equal(bannedWordIn(describeModelChoice({ tier })), null, "plain words only");
  }
});

test("the model chosen on the local mode screen goes to the first coworker once", () => {
  setStartingModel("  ollama/llama3  ");
  assert.equal(peekStartingModel(), "ollama/llama3", "peeking keeps it");
  assert.equal(takeStartingModel(), "ollama/llama3");
  assert.equal(takeStartingModel(), "", "taken once");
  assert.equal(peekStartingModel(), "");
});
