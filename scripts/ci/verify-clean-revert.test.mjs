import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import { eligiblePull, exemptionProducer, preflight, samePull, unguardedFiles } from "./revert-preflight.mjs";

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

const repository = "example/repo";
function pull(base = "b".repeat(40), head = "c".repeat(40)) {
  return { number: 42, state: "open", draft: false, merged: false, merged_at: null,
    title: 'Revert "change"', body: "", base: { ref: "dev", sha: base, repo: { full_name: repository } },
    head: { sha: head, repo: { full_name: repository } } };
}

test("only ready same-repo dev PRs with full immutable SHAs are candidates", () => {
  const pr = pull();
  assert.equal(eligiblePull(pr, repository), true);
  for (const change of [
    { draft: true }, { state: "closed" }, { merged: true }, { number: "42" },
    { title: "ordinary change" }, { base: { ...pr.base, ref: "main" } },
    { head: { ...pr.head, repo: { full_name: "fork/repo" } } },
    { base: { ...pr.base, sha: "dev" } }, { head: { ...pr.head, sha: "c".repeat(39) } },
  ]) assert.equal(eligiblePull({ ...pr, ...change }, repository), false, JSON.stringify(change));
  assert.equal(samePull(pr, pull(pr.base.sha, "d".repeat(40)), repository), false);
});

test("policy-changing reverts never receive an exemption", () => {
  for (const path of [".github/workflows/ci-tests.yml", "scripts/ci/revert-preflight.mjs", "warden.toml",
    ".warden/README.md", ".agents/skills/review/SKILL.md", ".claude/skills/review.md", ".opencode/config", "AGENTS.md"]) {
    assert.equal(unguardedFiles(["src/app.ts", path]), false, path);
  }
  assert.equal(unguardedFiles([]), false);
  assert.equal(unguardedFiles(["src/app.ts"]), true);
});

test("preflight uses the real Git verifier, not the candidate title/body", () => {
  const { repo, b, c } = fixture();
  const pr = pull(b, c);
  const api = (endpoint) => endpoint.endsWith("/git/ref/heads/dev") ? { object: { sha: b } } : pr;
  const run = (head) => preflight({ event: { pull_request: { ...pr, head: { ...pr.head, sha: head } } }, repository,
    api: (endpoint) => { const value = api(endpoint); return value === pr ? { ...pr, head: { ...pr.head, sha: head } } : value; },
    git: (args) => args[0] === "fetch" ? "" : spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout,
    verify: (options) => { const result = verify(repo, "--base", options.base, "--head", options.head);
      if (result.status !== 0) throw new Error("not exact"); return b; },
  });
  assert.equal(run(c).reverted, b);
  assert.equal(run(b), false); // An unchanged tree is rejected before verification.
  writeFileSync(resolve(repo, "extra.txt"), "hand edit\n");
  git(repo, "add", "extra.txt");
  git(repo, "commit", "-qm", `Revert fake\n\nThis reverts commit ${b}.`);
  assert.throws(() => run(git(repo, "rev-parse", "HEAD")), /not exact/);
});

test("stale events/base, unavailable or malformed verifier cannot exempt", () => {
  const pr = pull();
  const options = { event: { pull_request: pr }, repository,
    api: (endpoint) => endpoint.endsWith("/git/ref/heads/dev") ? { object: { sha: pr.base.sha } } : pr,
    git: () => "src/app.ts\0", verify: () => "a".repeat(40) };
  assert.ok(preflight(options));
  assert.equal(preflight({ ...options, verify: () => "verdict=pass" }), false);
  assert.throws(() => preflight({ ...options, verify: () => { throw new Error("missing helper"); } }), /missing helper/);
  assert.equal(preflight({ ...options, api: () => pull(pr.base.sha, "d".repeat(40)) }), false);
  assert.equal(preflight({ ...options, api: (endpoint) => endpoint.endsWith("/git/ref/heads/dev") ? { object: { sha: "d".repeat(40) } } : pr }), false);
  let reads = 0;
  assert.equal(preflight({ ...options, api: (endpoint) => endpoint.endsWith("/git/ref/heads/dev")
    ? { object: { sha: pr.base.sha } } : ++reads === 1 ? pr : pull(pr.base.sha, "d".repeat(40)) }), false);
});

test("base/head symbolic, abbreviated, option-like and nonexistent SHAs fail", () => {
  const { repo, b, c } = fixture();
  for (const bad of ["HEAD", b.slice(0, 8), "--help", "f".repeat(40)]) {
    assert.notEqual(verify(repo, "--base", bad, "--head", c).status, 0);
    assert.notEqual(verify(repo, "--base", b, "--head", bad).status, 0);
  }
});

test("clearance marker is bound to the successful Warden producer and skipped analysis", () => {
  const run = { id: 7, run_attempt: 1, name: "Warden", path: ".github/workflows/warden.yml", event: "pull_request",
    status: "completed", conclusion: "success", head_sha: "c".repeat(40), repository: { full_name: repository }, head_repository: { full_name: repository } };
  const job = { name: "warden", run_id: 7, head_sha: run.head_sha, conclusion: "success", steps: [
    { name: "Record verified revert exemption", conclusion: "success" }, { name: "Analyze", conclusion: "skipped" }] };
  assert.equal(exemptionProducer(run, [job], repository), true);
  for (const change of [{ event: "push" }, { conclusion: "failure" }, { path: "other.yml" }, { head_repository: { full_name: "fork/repo" } }]) {
    assert.equal(exemptionProducer({ ...run, ...change }, [job], repository), false);
  }
  assert.equal(exemptionProducer(run, [{ ...job, steps: [] }], repository), false);
  assert.equal(exemptionProducer(run, [{ ...job, head_sha: "d".repeat(40) }], repository), false);
  assert.equal(exemptionProducer(run, [{ ...job, steps: [...job.steps.slice(0, 1), { name: "Analyze", conclusion: "success" }] }], repository), false);
});

test("existing aggregate accepts only the validated exemption and preserves all normal lanes", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci-tests.yml"), "utf8");
  const shell = workflow.split("      - name: Require the selected test lane to pass\n")[1].split("        run: |\n")[1]
    .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  const run = (overrides) => spawnSync("bash", ["-c", shell], { encoding: "utf8", env: { ...process.env,
    CLASSIFY_RESULT: "success", LANE: "verified-revert", VERIFIED_REVERT: "true", CORE_RESULT: "skipped", BUILD_RESULT: "skipped",
    AUTHORING_RESULT: "skipped", SNAPSHOT_RESULT: "skipped", DOCS_RESULT: "skipped", ...overrides } }).status;
  assert.equal(run({}), 0);
  for (const change of [{ VERIFIED_REVERT: "" }, { VERIFIED_REVERT: "false" }, { CLASSIFY_RESULT: "failure" },
    { CORE_RESULT: "failure" }, { BUILD_RESULT: "cancelled" }, { AUTHORING_RESULT: "success" }, { LANE: "unknown" }, { LANE: "full" }]) {
    assert.equal(run(change), 1, JSON.stringify(change));
  }
  assert.equal(run({ LANE: "full", CORE_RESULT: "success", BUILD_RESULT: "success", AUTHORING_RESULT: "success" }), 0);
  assert.equal(run({ LANE: "docs", DOCS_RESULT: "success" }), 0);
  assert.equal(run({ LANE: "snapshot", SNAPSHOT_RESULT: "success" }), 0);
});
