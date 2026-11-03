import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciFixBranch, ciRepairState, planCiRepairs } from "./warden-ci-plan.mjs";
import { planFix } from "./warden-sweep.mjs";
import { readPlan } from "./warden-sweep-open.mjs";
import { editsToPatch, safeFile } from "./warden-generate.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "warden-ci-planning-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init"]); git(cwd, ["config", "user.name", "Test"]); git(cwd, ["config", "user.email", "test@example.invalid"]);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/older.ts"), "export const answer = 0;\n");
  writeFileSync(join(cwd, "DESIGN.md"), "Use existing primitives.\n");
  git(cwd, ["add", "."]); git(cwd, ["commit", "-m", "base"]);
  writeFileSync(join(cwd, "src/new.ts"), "export const added = 1;\n");
  git(cwd, ["add", "."]); git(cwd, ["commit", "-m", "change (#10)"]);
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  const run = { id: 123, run_attempt: 1, head_sha: sha, head_branch: "dev", event: "push", status: "completed", conclusion: "failure" };
  const finding = { kind: "ci", title: "Incorrect answer", description: "assertion expected 42, received 0", severity: "medium", confidence: "high", path: "src/older.ts", line: 1, ciEvidence: "Expected 42, received 0" };
  return { cwd, sha, run, finding };
}
function options(f) {
  return { cwd: f.cwd, repo: "example/repo", head: f.sha, sources: [{ sha: f.sha, number: 10, ci: { failed: [{ id: 123, runAttempt: 1 }] } }], previous: [], budget: { remaining: 5 }, model: "test", apiKey: "test", makePlan: planFix,
    api: (path) => path.includes("/pulls?") ? [] : f.run,
    loadLog: async () => "Expected 42, received 0",
    diagnose: async ({ budget }) => { budget.remaining--; return { findings: [f.finding], files: [f.finding.path], outcomes: [], suggestions: [{ summary: "Use 42" }] }; },
    generate: async () => {
      const patch = editsToPatch(f.cwd, [{ path: f.finding.path, before: "answer = 0", after: "answer = 42" }], new Map([[f.finding.path, safeFile(f.cwd, f.finding.path)]]));
      return { findings: [{ ...f.finding, suggested_fix: { diff: patch } }], outcomes: [{ status: "verified", reason: "model verified; tests not run" }] };
    },
  };
}

test("CI state keeps only bounded validated run identities, not logs or model text", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(ciRepairState([{ id: 1, runAttempt: 1, sha, attempts: 2, done: false, logs: "secret" }]), [{ id: 1, runAttempt: 1, sha, attempts: 2, done: false }]);
  assert.deepEqual(ciRepairState([{ id: 1, runAttempt: 1, sha, attempts: 99, done: false }]), []);
  assert.throws(() => ciFixBranch(-1, sha));
});

test("a failing CI run can repair a log-located source file outside its merge diff", async (t) => {
  const f = fixture(t);
  const result = await planCiRepairs(options(f));
  assert.equal(result.plans.length, 1);
  const plan = result.plans[0];
  assert.equal(plan.branch, ciFixBranch(123, f.sha));
  assert.deepEqual(plan.ci.files, ["src/older.ts"]);
  assert.match(plan.body, /not reproduced locally/);
  assert.equal(result.state[0].attempts, 1);
  const dir = join(f.cwd, "artifacts"); mkdirSync(dir);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "body.md"), plan.body);
  writeFileSync(join(dir, "01.patch"), plan.patches[0]);
  assert.deepEqual(readPlan(f.cwd, dir, { loadCiRun: () => f.run }).files, ["src/older.ts"]);
  assert.throws(() => readPlan(f.cwd, dir), /CI plan identity/);
  assert.throws(() => readPlan(f.cwd, dir, { loadCiRun: () => ({ ...f.run, conclusion: "success" }) }), /evidence changed/);
  assert.throws(() => readPlan(f.cwd, dir, { loadCiRun: () => ({ ...f.run, head_sha: "b".repeat(40) }) }), /evidence changed/);
});

test("CI recovery, existing PRs, wrong-head and fork runs do not generate fixes", async (t) => {
  for (const variant of ["recovered", "existing", "wrong-head", "fork"]) {
    const f = fixture(t), opts = options(f);
    opts.api = (path) => path.includes("/pulls?") ? variant === "existing" ? [{ html_url: "https://github.com/example/repo/pull/1" }] : [] : { ...f.run,
      ...(variant === "recovered" ? { conclusion: "success" } : {}),
      ...(variant === "wrong-head" ? { head_sha: "b".repeat(40) } : {}),
      ...(variant === "fork" ? { event: "pull_request" } : {}),
    };
    opts.diagnose = () => assert.fail("must not send unbound evidence to model");
    const result = await planCiRepairs(opts);
    assert.equal(result.plans.length, 0, variant);
    assert.equal(result.reports.length, 1);
  }
});

test("late failures retry with no new merges; exhausted investigations stop explicitly", async (t) => {
  const f = fixture(t), opts = options(f);
  opts.sources = [];
  opts.previous = [{ id: 123, runAttempt: 1, sha: f.sha, attempts: 2, done: false }];
  opts.diagnose = async ({ budget }) => { budget.remaining--; return { findings: [], files: [], outcomes: [], suggestions: [{ summary: "Restore missing runner credential" }] }; };
  const result = await planCiRepairs(opts);
  assert.equal(result.reports.length, 1);
  assert.equal(result.state[0].attempts, 3);
  assert.match(result.reports[0].retry, /attempt cap/);
  assert.equal(result.reports[0].suggestions.length, 1);
  assert.equal(result.plans.length, 0);
});

test("CI diagnosis details stay in private reports, with only fixed summaries publicly", async () => {
  const { ciRepairSlack, ciRepairSummary } = await import("./warden-sweep.mjs");
  const reports = [{ id: 123, url: "https://github.com/example/repo/actions/runs/123", disposition: "suggestions only; no validated source fix", suggestions: [{ classification: "infrastructure", status: "manual", title: "Runner database auth", observedFailure: "private database failure", causeHypothesis: "private credential hypothesis", evidence: "password=do-not-publish", suggestedFix: "Restore runner credential; never disable auth" }], generation: [], planned: false }];
  const slack = ciRepairSlack(reports), summary = ciRepairSummary(reports, 1);
  assert.match(slack, /Suggested fix \/ next step: Restore runner credential/);
  assert.doesNotMatch(slack, /do-not-publish/);
  assert.doesNotMatch(summary, /private database|private credential|password|Restore runner/);
  assert.match(summary, /1 suggestion\(s\), 0 draft plan\(s\)/);
  assert.match(summary, /1 CI investigation\(s\) exceeded/);
});

test("unavailable logs consume a bounded CI investigation attempt without a patch", async (t) => {
  const f = fixture(t), opts = options(f);
  opts.diagnose = async () => ({ findings: [], files: [], outcomes: [{ status: "unresolved", reason: "log loading failed" }], suggestions: [] });
  const result = await planCiRepairs(opts);
  assert.equal(result.state[0].attempts, 1);
  assert.equal(result.plans.length, 0);
});
