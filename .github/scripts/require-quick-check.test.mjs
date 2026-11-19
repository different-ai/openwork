import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { quickCheckState, requireQuickCheck } from "./require-quick-check.mjs";

const sha = "a".repeat(40);
const run = (fields) => ({ id: 1, head_sha: sha, status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", html_url: "https://example.test/run", ...fields });
const quiet = { sleep: async () => {}, log: () => {} };

test("only a successful quick check on the same commit passes", () => {
  assert.equal(quickCheckState([run()], sha).state, "passed");
  assert.equal(quickCheckState([run({ head_sha: "b".repeat(40) })], sha).state, "missing");
  assert.equal(quickCheckState([], sha).state, "missing");
  assert.equal(quickCheckState(undefined, sha).state, "missing");
  assert.equal(quickCheckState([run({ status: "in_progress", conclusion: null })], sha).state, "pending");
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "neutral", null]) {
    assert.equal(quickCheckState([run({ conclusion })], sha).state, "failed");
  }
});

test("the newest run for the commit decides", () => {
  const failedThenPassed = [run({ id: 1, conclusion: "failure" }), run({ id: 2, created_at: "2026-01-01T00:05:00Z" })];
  assert.equal(quickCheckState(failedThenPassed, sha).state, "passed");
  const passedThenFailed = [run({ id: 1 }), run({ id: 2, conclusion: "failure", created_at: "2026-01-01T00:05:00Z" })];
  assert.equal(quickCheckState(passedThenFailed, sha).state, "failed");
});

test("a running check is waited for, then decides", async () => {
  const answers = [[], [run({ status: "queued", conclusion: null })], [run()]];
  const result = await requireQuickCheck({ sha, listRuns: async () => answers.shift(), ...quiet });
  assert.equal(result.state, "passed");
  assert.equal(answers.length, 0);
});

test("a failed, missing or unfinished check blocks", async () => {
  await assert.rejects(requireQuickCheck({ sha, listRuns: async () => [run({ conclusion: "failure" })], ...quiet }), /Quick check failure/);
  let clock = 0;
  const expiring = { ...quiet, now: () => (clock += 60_000), waitMs: 120_000 };
  await assert.rejects(requireQuickCheck({ sha, listRuns: async () => [], ...expiring }), /No quick check ran/);
  clock = 0;
  await assert.rejects(requireQuickCheck({ sha, listRuns: async () => [run({ status: "in_progress", conclusion: null })], ...expiring }), /did not finish in time/);
  await assert.rejects(requireQuickCheck({ sha: "dev", listRuns: async () => [run()], ...quiet }), /Not a full commit SHA/);
  await assert.rejects(requireQuickCheck({ sha, listRuns: async () => { throw new Error("HTTP 500") }, ...quiet }), /HTTP 500/);
});

const workflow = (name) => readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8");
const jobBlock = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job is missing`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

test("the quick check runs on every dev push, so each dev commit has a result", () => {
  const quick = workflow("quick-check.yml");
  assert.match(quick, /on:\n  pull_request:\n    branches:\n      - dev\n  push:\n    branches:\n      - dev\n/);
  assert.match(jobBlock(quick, "openwork-tests-required"), /needs: \[quick-select, quick-static, quick-typecheck, desktop-build, den-quick\]/);
});

test("no alpha is published from a commit the quick check did not pass", () => {
  const alpha = workflow("alpha-macos-aarch64.yml");
  const gate = jobBlock(alpha, "critical-checks");
  assert.match(gate, /node \.github\/scripts\/require-quick-check\.mjs --sha "\$GITHUB_SHA"/);
  assert.match(gate, /actions: read/);
  for (const job of ["publish-alpha-macos-aarch64", "publish-alpha-windows-x64"]) {
    assert.match(jobBlock(alpha, job), /needs: \[[^\]]*\bcritical-checks\b[^\]]*\]/, `${job} must wait for the quick check`);
  }
});

test("a fresh release is not tagged on a dev commit the quick check did not pass", () => {
  const release = workflow("release-macos-aarch64.yml");
  const gate = release.indexOf('node .github/scripts/require-quick-check.mjs --sha "$SHA"');
  const tag = release.indexOf('gh api -X POST "repos/${GITHUB_REPOSITORY}/git/refs"');
  assert.ok(gate !== -1 && tag !== -1 && gate < tag, "the gate must run before the tag is created");
  assert.ok(release.indexOf('SHA="$(git rev-parse origin/dev)"') < gate);
});
