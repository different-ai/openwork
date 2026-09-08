import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";

const script = resolve(import.meta.dirname, "verify-clean-revert.mjs");
const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(repo, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const repo = mkdtempSync(resolve(tmpdir(), "clean-revert-test-"));
  tempDirs.push(repo);
  git(repo, "init", "-q");
  writeFileSync(resolve(repo, "file.txt"), "A\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-q", "-m", "A");
  const a = git(repo, "rev-parse", "HEAD");
  writeFileSync(resolve(repo, "file.txt"), "B\n");
  git(repo, "commit", "-q", "-am", "B");
  const b = git(repo, "rev-parse", "HEAD");
  git(repo, "revert", "--no-edit", b);
  const c = git(repo, "rev-parse", "HEAD");
  return { repo, a, b, c };
}

function verify(repo, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
}

test("passes an exact revert parsed from the head message", () => {
  const { repo, b, c } = fixture();
  const result = verify(repo, "--base", b, "--head", c);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`PASS clean-revert of ${b}`));
  assert.match(result.stdout, /verdict=pass/);
});

test("fails when the revert tree contains an extra edit", () => {
  const { repo, b, c } = fixture();
  writeFileSync(resolve(repo, "extra.txt"), "tampered\n");
  git(repo, "add", "extra.txt");
  git(repo, "commit", "-q", "-m", "extra edit");
  const tampered = git(repo, "rev-parse", "HEAD");
  const result = verify(repo, "--base", b, "--head", tampered, "--reverted", b);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL PR tree is not the exact inverse/);
  assert.notEqual(c, tampered);
});

test("fails when source drift makes the revert conflict", () => {
  const { repo, b } = fixture();
  git(repo, "switch", "-q", "--detach", b);
  writeFileSync(resolve(repo, "file.txt"), "unrelated edit to the same line\n");
  git(repo, "commit", "-q", "-am", "source drift");
  const driftedBase = git(repo, "rev-parse", "HEAD");
  const result = verify(repo, "--base", driftedBase, "--head", driftedBase, "--reverted", b);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL revert does not apply cleanly to PR base/);
});

test("fails when the reverted commit is not an ancestor of base", () => {
  const { repo, a, b, c } = fixture();
  git(repo, "switch", "-q", "--detach", a);
  writeFileSync(resolve(repo, "other.txt"), "other\n");
  git(repo, "add", "other.txt");
  git(repo, "commit", "-q", "-m", "divergent");
  const divergent = git(repo, "rev-parse", "HEAD");
  const result = verify(repo, "--base", b, "--head", c, "--reverted", divergent);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL reverted commit is not an ancestor of the PR base/);
});

test("fails when the head message does not identify a reverted commit", () => {
  const { repo, a, b } = fixture();
  const result = verify(repo, "--base", a, "--head", b);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL head commit message has no 'This reverts commit <40-hex>' line/);
  assert.match(result.stdout, /verdict=fail/);
});

// Exercise the actual workflow shell against a fake GitHub CLI boundary. No
// credentials or live merges are used; jq still evaluates the real API filter.
function runAutoMerge(overrides = {}, mergeStatus = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), "revert-auto-merge-test-"));
  tempDirs.push(directory);
  const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/revert-fastlane.yml"), "utf8");
  const step = workflow.split("      - name: Enable automatic merge of verified revert\n")[1]
    .split("      - name: Record ineligible revert\n")[0];
  const shell = step.split("        run: |\n")[1].split("\n")
    .map((line) => line.replace(/^          /, "")).join("\n");
  const calls = resolve(directory, "calls");
  const summary = resolve(directory, "summary");
  writeFileSync(calls, "");
  writeFileSync(summary, "");
  writeFileSync(resolve(directory, "gh"), `#!/bin/bash
set -euo pipefail
if [[ "$1" == "api" ]]; then
  printf '%s' "$TEST_PR" | jq -r "$4"
else
  printf '%s\\n' "$@" > "$TEST_CALLS"
  exit "$TEST_MERGE_STATUS"
fi
`, { mode: 0o755 });
  const result = spawnSync("bash", ["-c", shell], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "example/repo",
      PR_NUMBER: "123",
      HEAD_SHA: "a".repeat(40),
      GITHUB_STEP_SUMMARY: summary,
      TEST_CALLS: calls,
      TEST_MERGE_STATUS: String(mergeStatus),
      TEST_PR: JSON.stringify({ state: "open", draft: false, base: { ref: "dev" }, title: 'Revert "change"', ...overrides }),
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8"), summary: readFileSync(summary, "utf8") };
}

test("automatic merge requests the verified head without an admin bypass", () => {
  const result = runAutoMerge();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.trim().split("\n"), [
    "pr", "merge", "123", "--repo", "example/repo", "--auto", "--squash", "--match-head-commit", "a".repeat(40),
  ]);
  assert.match(result.summary, /Automatic merge requested/);
});

test("automatic merge is withheld after a draft, close, retarget, or title change", () => {
  for (const change of [{ draft: true }, { state: "closed" }, { base: { ref: "main" } }, { title: "ordinary change" }]) {
    const result = runAutoMerge(change);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, "");
    assert.match(result.summary, /Automatic merge withheld/);
  }
});

test("merge API rejection fails the job without claiming success", () => {
  const result = runAutoMerge({}, 1);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.summary, /Automatic merge requested/);
});
