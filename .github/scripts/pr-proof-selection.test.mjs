import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CORE_SPECS, NIGHTLY_ONLY, PROOF_MACHINERY, everyCoreJourney, selectProof } from "./pr-proof.mjs";

const coreChat = "evals/core/core-chat.e2e.test.ts";
const restart = "evals/core/thread-continues-after-restart.e2e.test.ts";
const product = { filename: "apps/app/src/index.ts", status: "modified" };

test("a product PR runs core-chat and no other core journey", () => {
  assert.deepEqual(CORE_SPECS, [coreChat]);
  const { specs } = selectProof([product]);
  assert.deepEqual(specs, [coreChat]);
  for (const journey of everyCoreJourney()) assert.equal(specs.includes(journey), false, journey);
});

test("a PR that adds or changes a core journey or spec runs it", () => {
  for (const spec of [restart, "evals/core/agent-permissions.e2e.test.ts", "evals/specs/drive-files.e2e.test.ts", "evals/proofs/access-roles.proof.test.ts"]) {
    for (const status of ["added", "modified", "renamed"]) {
      const file = status === "renamed" ? { filename: spec, status, previous_filename: "evals/specs/old.e2e.test.ts" } : { filename: spec, status };
      assert.deepEqual(selectProof([file]).specs, [coreChat, spec].sort(), `${status} ${spec}`);
    }
  }
  assert.deepEqual(selectProof([{ filename: restart, status: "removed" }, product]).specs, [coreChat], "a removed spec cannot run");
});

test("a docs-only PR runs no journeys, a changed spec still runs", () => {
  assert.deepEqual(selectProof([{ filename: "docs/notes.md", status: "modified" }]).specs, []);
  assert.deepEqual(selectProof([{ filename: "packages/docs/guide.mdx", status: "modified" }]).specs, []);
});

test("a PR that changes the proof machinery runs every core journey but the nightly-only one", () => {
  for (const filename of PROOF_MACHINERY) {
    const { specs } = selectProof([{ filename, status: "modified" }]);
    assert.deepEqual(specs, [coreChat, ...everyCoreJourney()].sort(), filename);
    assert.equal(specs.includes(restart), false);
  }
  assert.ok(NIGHTLY_ONLY.has("thread-continues-after-restart.e2e.test.ts"));
});

test("every core journey a PR no longer runs still runs on dev pushes and nightly", () => {
  const journeys = [...everyCoreJourney(), ...[...NIGHTLY_ONLY].map((name) => `evals/core/${name}`)];
  assert.ok(journeys.length >= 5);
  assert.ok(journeys.includes(restart));
  assert.ok(journeys.every((spec) => !/\/(core-chat|app-smoke|packaged-[^/]+)\.e2e\.test\.ts$/.test(spec)));
  const workflow = readFileSync(new URL("../workflows/core-journeys.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n  push:\n    branches: \[dev\]\n/);
  assert.match(workflow, /\n  schedule:\n/);
  assert.match(workflow, /cancel-in-progress: false/);
  // The workflow lists evals/core itself; it must exclude exactly the journeys
  // that run elsewhere (packaged smoke and the PR core-chat lane).
  assert.match(workflow, /find evals\/core -maxdepth 1 -name '\*\.e2e\.test\.ts' ! -name 'packaged-\*' ! -name 'app-smoke\.e2e\.test\.ts' ! -name 'core-chat\.e2e\.test\.ts'/);
});
