import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { describeSourceCommit, sourceCommitLines } from "../src/drift.ts";
import { fixtureRepo } from "./git-fixture.ts";

test("a source commit is described, and recipe drift in this checkout is counted", async () => {
  const { root, sha } = await fixtureRepo();
  try {
    const clean = await describeSourceCommit(root, sha, ["worlds"]);
    assert.deepEqual(clean, { sha, known: true, subject: "feat: fixture world recipe", head: sha, branch: "main", recipeDrift: [] });
    assert.deepEqual(sourceCommitLines(clean, { label: "origin/dev", component: "desktop" }), [`source  desktop ${sha.slice(0, 9)} (origin/dev) feat: fixture world recipe`]);

    // Only recipe paths count: an unrelated change is not drift.
    await writeFile(join(root, "README.md"), "changed\n");
    assert.deepEqual((await describeSourceCommit(root, sha, ["worlds"])).recipeDrift, []);
    await writeFile(join(root, "worlds", "remote.ts"), 'export const supportedTargets = ["local/host"];\n');
    const drifted = await describeSourceCommit(root, sha, ["worlds"]);
    assert.deepEqual(drifted.recipeDrift, ["worlds/remote.ts"]);
    const lines = sourceCommitLines(drifted, { label: "origin/dev" });
    assert.equal(lines[1], `note  this checkout's world recipes differ from ${sha.slice(0, 9)} in 1 file; the driver runs from this checkout (${sha.slice(0, 9)} on main), not from ${sha.slice(0, 9)}. For that commit's recipes, run from a worktree: git worktree add ../openwork-${sha.slice(0, 9)} origin/dev`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a commit this checkout does not have is named, with how to compare it", async () => {
  const { root, sha } = await fixtureRepo();
  try {
    const missing = "f".repeat(40);
    const unknown = await describeSourceCommit(root, missing, ["worlds"]);
    assert.deepEqual(unknown, { sha: missing, known: false, head: sha, branch: "main" });
    assert.deepEqual(sourceCommitLines(unknown), [
      `source  fffffffff`,
      `note  fffffffff is not in this checkout, so its world recipes cannot be compared; the driver runs from ${sha.slice(0, 9)} on main. Run git fetch origin to compare.`,
    ]);
    await assert.rejects(() => describeSourceCommit(root, "--upload-pack=evil", []), /full 40-character commit SHA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
