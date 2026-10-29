import assert from "node:assert/strict";
import test from "node:test";
import { everyCoreJourney, NIGHTLY_ONLY, selectProof } from "./pr-proof.mjs";

const restart = "evals/core/thread-continues-after-restart.e2e.test.ts";

test("nightly-only journeys stay out of every PR's core journeys", () => {
  assert.ok(NIGHTLY_ONLY.has("thread-continues-after-restart.e2e.test.ts"));
  const core = everyCoreJourney();
  assert.ok(core.length > 0);
  assert.equal(core.includes(restart), false);
  const { specs } = selectProof([{ filename: "apps/app/src/index.ts", status: "modified" }]);
  assert.equal(specs.includes(restart), false);
  assert.ok(specs.includes("evals/core/core-chat.e2e.test.ts"));
});

test("a PR that changes a nightly-only journey still runs it", () => {
  const { specs } = selectProof([{ filename: restart, status: "modified" }]);
  assert.ok(specs.includes(restart));
});

test("a docs-only PR runs no journeys", () => {
  assert.deepEqual(selectProof([{ filename: "docs/notes.md", status: "modified" }]).specs, []);
});
