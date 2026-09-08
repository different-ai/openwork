import test from "node:test";
import assert from "node:assert/strict";
import { readableTyping, typeWithCadence, typingPlan } from "../src/typing.ts";

test("typing preserves graphemes and adds deterministic word and punctuation pauses", () => {
  const plan = typingPlan("A 👩🏽‍💻é.", readableTyping);
  assert.deepEqual(
    plan.map((entry) => entry.text),
    ["A", " ", "👩🏽‍💻", "é", "."],
  );
  assert.ok(plan[1].pauseMs > plan[0].pauseMs);
  assert.ok(plan[4].pauseMs > plan[3].pauseMs);
  assert.deepEqual(typingPlan("A 👩🏽‍💻é.", readableTyping), plan);
  assert.throws(
    () => typingPlan("hello", { ...readableTyping, cadenceMs: [] }),
    /cadence/,
  );
  assert.throws(
    () => typingPlan("hello", { ...readableTyping, characterMs: NaN }),
    /finite/,
  );
});

test("input is sequential and stops immediately on a failed insertion", async () => {
  const inserted: string[] = [];
  await assert.rejects(
    typeWithCadence(
      "abc",
      readableTyping,
      async (character) => {
        inserted.push(character);
        if (character === "b") throw new Error("input lost focus");
      },
      async () => {},
    ),
    /input lost focus/,
  );
  assert.deepEqual(inserted, ["a", "b"]);
});
