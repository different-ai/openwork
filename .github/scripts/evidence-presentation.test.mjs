import assert from "node:assert/strict";
import test from "node:test";
import { presentEvidence } from "./evidence-presentation.mjs";

const sha = "a".repeat(40), repo = "sample-org/sample-project";
const url = `https://review.example.test/r/${"b".repeat(32)}`;
function fixture() {
  const source = { id: 30, run_attempt: 1, workflow_id: 20, path: ".github/workflows/pr-proof.yml", name: "PR change proof", event: "pull_request", status: "completed", conclusion: "success", head_sha: sha,
    repository: { id: 10, full_name: repo }, head_repository: { id: 10, full_name: repo },
    pull_requests: [{ number: 7, head: { sha, repo: { id: 10 } }, base: { repo: { id: 10 } } }] };
  const pr = { state: "open", head: { sha, repo: { id: 10 } }, base: { repo: { id: 10 } } };
  const writes = [], checks = [], runs = [source], deployments = [], deploymentStatuses = {};
  let afterWrite = () => {};
  const api = async (path, method = "GET", body) => {
    if (method !== "GET") { writes.push({ path, method, body }); afterWrite(path); return { id: path.endsWith("deployments") ? 50 : 40 }; }
    if (path.endsWith("/actions/runs/30")) return source;
    if (path.endsWith("/workflows/pr-proof.yml")) return { id: 20, path: source.path };
    if (path.endsWith("/pulls/7")) return pr;
    if (path.includes("/workflows/20/runs?")) return { total_count: runs.length, workflow_runs: runs };
    if (path.includes("/comments?")) return [];
    if (path.includes("/deployments?")) return deployments;
    if (/\/deployments\/\d+\/statuses\?/.test(path)) return deploymentStatuses[path.match(/deployments\/(\d+)\//)[1]] ?? [];
    if (path.includes("/check-runs?")) return { total_count: checks.length, check_runs: checks };
    throw new Error(path);
  };
  const input = { repo, runId: 30, runAttempt: 1, phase: "complete", reviewUrl: "https://review.example.test",
    receipt: { state: "published", reportUrl: url, evidence: { gitSha: sha, verdict: "Passed", tests: 2, passedTests: 2, assertions: 4, passedAssertions: 4 } } };
  return { source, pr, writes, checks, runs, deployments, deploymentStatuses, api, input, afterWrite: fn => { afterWrite = fn; } };
}

test("published evidence creates a SHA-bound check and native deployment with immutable report link", async () => {
  const f = fixture(); await presentEvidence(f.input, f.api);
  assert.equal(f.writes[0].body.head_sha, sha);
  assert.equal(f.writes[0].body.conclusion, "success");
  assert.equal(f.writes[0].body.details_url, url);
  const deployment = f.writes.find(w => w.path.endsWith("/deployments")).body;
  assert.equal(deployment.ref, sha); assert.equal(deployment.auto_merge, false);
  assert.deepEqual(deployment.required_contexts, []);
  assert.equal(deployment.environment, "Evidence / PR 7");
  const status = f.writes.find(w => w.path.endsWith("/statuses")).body;
  assert.equal(status.environment_url, url); assert.equal(status.auto_inactive, false);
  assert.ok(f.writes.some(w => w.path.endsWith("/issues/7/comments")));
  assert.equal(deployment.transient_environment, false);
  const commitStatus = f.writes.find(w => w.path.includes("/statuses/"));
  assert.equal(commitStatus.body.context, "OpenWork Evidence");
  assert.equal(commitStatus.body.target_url, url);
});

test("failed evidence stays red even though its report deployment is available", async () => {
  const f = fixture(); f.input.receipt.evidence.verdict = "Failed"; f.source.conclusion = "failure";
  await presentEvidence(f.input, f.api);
  assert.equal(f.writes[0].body.conclusion, "failure");
  assert.equal(f.writes.at(-1).body.state, "success");
});

test("missing reports fail, no-spec selection is neutral, and cancellation never passes", async () => {
  for (const [receipt, producer, conclusion] of [[undefined, "success", "failure"], [{ state: "skipped", noEvidence: true }, "success", "neutral"], [undefined, "cancelled", "cancelled"], [{ state: "skipped", noEvidence: false }, "success", "failure"]]) {
    const f = fixture(); f.input.receipt = receipt; f.source.conclusion = producer;
    await presentEvidence(f.input, f.api);
    assert.equal(f.writes[0].body.conclusion, conclusion);
    assert.equal(f.writes.length, 3);
  }
});

test("stale heads, attempts, runs, forks and unrelated producers make no writes", async () => {
  for (const mutate of [f => { f.pr.head.sha = "c".repeat(40); }, f => { f.source.run_attempt = 2; },
    f => { f.runs.push({ ...f.source, id: 31 }); }, f => { f.source.head_repository.id = 11; },
    f => { f.source.path = ".github/workflows/unknown.yml"; }, f => { f.source.pull_requests = []; }]) {
    const f = fixture(); mutate(f); await presentEvidence(f.input, f.api); assert.equal(f.writes.length, 0);
  }
});

test("delayed progress cannot downgrade a finished result; queued and publishing are explicit", async () => {
  const f = fixture(); f.input.phase = "progress";
  f.checks.push({ id: 40, external_id: "evidence:30:1", app: { slug: "github-actions" }, status: "completed" });
  await presentEvidence(f.input, f.api); assert.equal(f.writes.length, 0);
  f.checks.length = 0; f.source.status = "queued";
  await presentEvidence(f.input, f.api); assert.equal(f.writes[0].body.status, "queued");
  f.source.status = "completed"; await presentEvidence(f.input, f.api);
  assert.equal(f.writes.filter(w => w.path.endsWith("/check-runs")).at(-1).body.output.title, "Publishing evidence");
});

test("a push while publishing can only retire this run's deployment", async () => {
  const f = fixture();
  f.afterWrite(path => { if (path.endsWith("/deployments")) f.pr.head.sha = "c".repeat(40); });
  await presentEvidence(f.input, f.api);
  assert.equal(f.writes.at(-1).body.state, "inactive");
  assert.ok(f.writes.filter(w => w.path.endsWith("statuses")).every(w => w.path.includes("/50/") && w.body.auto_inactive === false));
});

test("untrusted report URLs and commit receipts are rejected before writing", async () => {
  for (const mutate of [f => { f.input.receipt.reportUrl = "https://other.test/r/" + "b".repeat(32); }, f => { f.input.receipt.evidence.gitSha = "c".repeat(40); }]) {
    const f = fixture(); mutate(f); await assert.rejects(presentEvidence(f.input, f.api), /Invalid evidence publication receipt/); assert.equal(f.writes.length, 0);
  }
});

test("new runs retire only authenticated older evidence deployments, never a newer one", async () => {
  const f = fixture(); f.input.phase = "progress";
  for (const runId of [29, 31]) f.deployments.push({ id: runId, creator: { login: "github-actions[bot]" }, payload: { kind: "openwork-evidence-v1", pr: 7, runId, runAttempt: 1 } });
  f.deployments.push({ ...f.deployments[0], id: 28, creator: { login: "someone-else" } });
  await presentEvidence(f.input, f.api);
  const statuses = f.writes.filter(w => w.path.endsWith("statuses"));
  assert.equal(statuses.length, 1); assert.match(statuses[0].path, /deployments\/29\/statuses$/);
  assert.equal(statuses[0].body.state, "inactive");
});

test("an older evidence deployment that is already inactive gets no new status", async () => {
  const f = fixture(); f.input.phase = "progress";
  for (const runId of [27, 29]) f.deployments.push({ id: runId, creator: { login: "github-actions[bot]" }, payload: { kind: "openwork-evidence-v1", pr: 7, runId, runAttempt: 1 } });
  f.deploymentStatuses[27] = [{ state: "inactive" }];
  f.deploymentStatuses[29] = [{ state: "success" }];
  await presentEvidence(f.input, f.api);
  const statuses = f.writes.filter(w => /deployments\/\d+\/statuses$/.test(w.path));
  assert.deepEqual(statuses.map(w => w.path.match(/deployments\/(\d+)\//)[1]), ["29"]);
});

const designNote = {
  rule: "layout.split-row", severity: "medium", source: "layout",
  title: "Columns drift away from their rows",
  detail: "9 rows leave a 405–845px hole between “What it does” … “Kind”.",
  step: "after: at 1920 wide every row has its own columns",
  spec: "evals/specs/library-list-on-wide-screens.e2e.test.ts",
  anchors: ['[data-library-row="docs-helper"]'], classes: ["w-[150px] md:w-[190px]"],
};

test("advisory design notes ride in the same evidence check: what is wrong, where in the code, how to reproduce, and the verdict is unchanged", async () => {
  const f = fixture();
  f.input.receipt.design = { reviewed: 1, notes: [designNote] };
  await presentEvidence(f.input, f.api);
  const check = f.writes[0].body;
  assert.equal(check.name, "Evidence preview");
  assert.equal(check.conclusion, "success");
  assert.match(check.output.summary, /Design review \(advisory\): 1 note, 1 worth fixing\./);
  assert.match(check.output.text, /### 1\. Columns drift away from their rows/);
  assert.match(check.output.text, /Where in the code: `\[data-library-row="docs-helper"\]` · class `w-\[150px\] md:w-\[190px\]`/);
  assert.match(check.output.text, /Reproduce: `pnpm evals:e2e library-list-on-wide-screens --local && pnpm --dir evals design:review -- --test-run latest --json`/);
  assert.match(check.output.text, /```json\n\[/);
  assert.equal(f.writes.filter(write => write.path.endsWith("/check-runs")).length, 1, "no second check for design");
});

test("design note text from the page or the model is inert, and a malformed digest adds nothing", async () => {
  const f = fixture();
  f.input.receipt.design = { reviewed: 1, notes: [{ ...designNote, title: "[Approve](https://evil.example/x) @octocat <img src=x>",
    detail: "``` break out", spec: "evals/specs/../../.github/x.test.ts" }, { ...designNote, rule: "not a rule" }] };
  await presentEvidence(f.input, f.api);
  const text = f.writes[0].body.output.text;
  assert.doesNotMatch(text.split("<details>")[0], /\]\(https:\/\//);
  assert.match(text, /\\\[Approve\\\]\\\(https:\u200b\/\/evil\.example\/x\\\)/);
  assert.match(text, /@\u200boctocat/);
  assert.match(text, /\\<img src=x\\>/);
  assert.doesNotMatch(text, /``` break out/);
  assert.doesNotMatch(text, /\.github\/x\.test\.ts/);
  assert.equal((text.match(/^### /gm) ?? []).length, 1, "the note without a valid rule is dropped");
  for (const design of ["1 note", { reviewed: "1", notes: [] }]) {
    const g = fixture(); g.input.receipt.design = design;
    await presentEvidence(g.input, g.api);
    assert.equal(g.writes[0].body.conclusion, "success");
    assert.equal(g.writes[0].body.output.text, undefined);
  }
});
