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
  const writes = [], checks = [], runs = [source], deployments = [];
  let afterWrite = () => {};
  const api = async (path, method = "GET", body) => {
    if (method !== "GET") { writes.push({ path, method, body }); afterWrite(path); return { id: path.endsWith("deployments") ? 50 : 40 }; }
    if (path.endsWith("/actions/runs/30")) return source;
    if (path.endsWith("/workflows/pr-proof.yml")) return { id: 20, path: source.path };
    if (path.endsWith("/pulls/7")) return pr;
    if (path.includes("/workflows/20/runs?")) return { total_count: runs.length, workflow_runs: runs };
    if (path.includes("/deployments?")) return deployments;
    if (path.includes("/check-runs?")) return { total_count: checks.length, check_runs: checks };
    throw new Error(path);
  };
  const input = { repo, runId: 30, runAttempt: 1, phase: "complete", reviewUrl: "https://review.example.test",
    receipt: { state: "published", reportUrl: url, evidence: { gitSha: sha, verdict: "Passed", tests: 2, passedTests: 2, assertions: 4, passedAssertions: 4 } } };
  return { source, pr, writes, checks, runs, deployments, api, input, afterWrite: fn => { afterWrite = fn; } };
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
  assert.ok(f.writes.every(w => !w.path.includes("comments")));
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
    assert.equal(f.writes.length, 1);
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
  assert.equal(f.writes.at(-1).body.output.title, "Publishing evidence");
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
