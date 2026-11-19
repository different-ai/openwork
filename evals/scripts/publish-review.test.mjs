import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { association, authorEvidenceNotice } from "../../.github/scripts/evidence-association.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_SPECS, proofArtifact } from "../../.github/scripts/pr-proof.mjs";
import { publishCompletedEvidence } from "./publish-review.mjs";
import { assembleReview } from "../packages/test-artifacts/src/review.ts";
import { summarizeReview } from "../../packages/review/src/schema.ts";

test("author evidence uses only the API run's validated starter, with actor fallback", () => {
  const label = "Author evidence: these tests run the PR's own code. Not a CI verification or merge gate.";
  assert.equal(authorEvidenceNotice({ triggering_actor: { login: "api-user" }, actor: { login: "original" }, artifacts: [{ login: "artifact" }] }), `Started by @api-user. ${label}`);
  assert.equal(authorEvidenceNotice({ actor: { login: "original" } }), `Started by @original. ${label}`);
  for (const login of [undefined, "", "-bad", "bad-", "bad--login", "a".repeat(40), "@team", "<img>", "x\ntext", "x\n", "x\r", 42])
    assert.equal(authorEvidenceNotice({ triggering_actor: { login }, artifacts: [{ login: "artifact" }] }), label);
});

const repo = "example/repo";
const repository = { id: 1, full_name: repo, owner: { login: "example" }, name: "repo" };
const sha = "a".repeat(40);
const workflows = [{ id: 2, file: "pr-proof.yml", name: "PR change proof", events: ["pull_request", "workflow_dispatch"] }];
const run = { workflow_id: 2, path: ".github/workflows/pr-proof.yml", name: "PR change proof",
  repository, head_repository: repository, status: "completed", conclusion: "success",
  event: "workflow_dispatch", head_branch: "proof/branch", head_sha: sha, pull_requests: [] };
const pr = { number: 3, state: "open", base: { repo: repository }, head: { repo: repository, ref: run.head_branch, sha } };

for (const [name, pulls, expected] of [
  ["one matching open PR", [pr], { pr: 3, sha }],
  ["no match", [], { reason: "missing or ambiguous PR association" }],
  ["two matches", [pr, { ...pr, number: 4 }], { reason: "missing or ambiguous PR association" }],
  ...[
    ["fork head", { head: { ...pr.head, repo: { ...repository, id: 9, full_name: "fork/repo" } } }],
    ["different SHA", { head: { ...pr.head, sha: "b".repeat(40) } }],
    ["closed PR", { state: "closed" }],
    ["different branch", { head: { ...pr.head, ref: "other" } }],
    ["different repository ID", { base: { repo: { ...repository, id: 9 } } }],
  ].map(([name, change]) => [name, [{ ...pr, ...change }], { reason: "missing or ambiguous PR association" }]),
]) test(`dispatch association: ${name}`, async () => {
  assert.deepEqual(await association(run, repo, workflows, async path => {
    assert.equal(path, "repos/example/repo/pulls?state=open&head=example%3Aproof%2Fbranch&per_page=100&page=1");
    return pulls;
  }), expected);
});

test("dispatch association reads every page before accepting a unique PR", async () => {
  const pages = [Array.from({ length: 100 }, () => ({ ...pr, state: "closed" })), [pr]];
  assert.deepEqual(await association(run, repo, workflows, async () => pages.shift()), { pr: 3, sha });
});

test("pull_request association is unchanged and does not list pulls", async () => {
  assert.deepEqual(await association({ ...run, event: "pull_request", pull_requests: [pr] }, repo, workflows,
    async () => assert.fail("unexpected API lookup")), { pr: 3, sha });
  assert.deepEqual(await association({ ...run, event: "pull_request" }, repo, workflows), { reason: "missing or ambiguous PR association" });
});

for (const [event, fault] of [
  ["workflow_dispatch", "none"], ["pull_request", "none"], ["pull_request", "missing-core"],
  ...["missing", "duplicate", "unexpected", "future-attempt", "stale-sha", "wrong-spec"].map(fault => ["workflow_dispatch", fault]),
]) test(`${event} publication with selected artifacts: ${fault}`, async () => {
  const changed = ["evals/proofs/web.proof.test.ts", "evals/core/packaged-startup.e2e.test.ts"];
  const specs = event === "pull_request" ? [...CORE_SPECS, ...changed] : changed;
  let artifacts = specs.map(spec => ({ name: proofArtifact(spec, 2), expired: false }));
  if (fault === "missing" || fault === "missing-core") artifacts = artifacts.slice(1);
  if (fault === "duplicate") artifacts.push(artifacts[0]);
  if (fault === "unexpected") artifacts.push({ name: proofArtifact("evals/proofs/other.proof.test.ts", 2), expired: false });
  if (fault === "future-attempt") artifacts.push({ name: proofArtifact(changed[0], 3), expired: false });
  let published = false;
  const result = await publishCompletedEvidence({ repo, runId: 10, runAttempt: 2 }, {
    api: async path => {
      if (path.endsWith("/workflows/pr-proof.yml")) return { ...workflows[0], path: run.path };
      if (path.endsWith("/actions/runs/10")) return { ...run, id: 10, run_attempt: 2, event, pull_requests: event === "pull_request" ? [pr] : [] };
      if (path.includes("/pulls?")) return [pr];
      if (path.endsWith("/pulls/3")) return { ...pr, changed_files: changed.length };
      if (path.includes("/pulls/3/files?")) return changed.map(filename => ({ filename, status: "modified" }));
      if (path.includes("/artifacts?")) return { total_count: artifacts.length, artifacts };
      assert.fail(`unexpected GitHub lookup: ${path}`);
    },
    download: async (id, directory, name) => {
      assert.equal(id, 10);
      const spec = specs.find(spec => proofArtifact(spec, 2) === name);
      assert.ok(spec); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "test-run.json"), JSON.stringify({
        name: spec, specFile: fault === "wrong-spec" ? "evals/proofs/other.proof.test.ts" : spec,
        gitSha: fault === "stale-sha" ? "b".repeat(40) : sha, dir: directory,
        createdAt: "2026-11-12T00:00:00.000Z", closedAt: "2026-11-12T00:00:01.000Z",
        outcome: spec.includes("packaged-") ? "skipped" : "passed",
        artifacts: spec.includes("packaged-") ? [] : [{ caption: "Synthetic check", fileName: "", hash: "", route: "",
          at: "2026-11-12T00:00:00.000Z", description: "", model: "", ok: true,
          results: [{ expectation: "Synthetic check", passed: true, evidence: "unit fixture" }] }],
        summary: { ok: false, totalArtifacts: 0, passedArtifacts: 0, failedArtifacts: 0, unvalidatedArtifacts: 0, passedExpectations: 0, failedExpectations: 0 },
      }));
    },
    publish: async options => {
      published = true; assert.equal(options.testRunDirs.length, specs.length);
      const { report } = await assembleReview(options);
      assert.ok(report.sources.some(source => source.kind === "test-run" && source.outcome === "skipped"));
      assert.equal(summarizeReview(report).verdict, "Incomplete");
      return { posted: true, urls: { report: "https://review.example.test/r/test" } };
    },
    log: () => {},
  });
  assert.equal(published, fault === "none");
  if (fault === "none") assert.equal(result.posted, true);
  else assert.match(result.skipped, /missing or duplicated|unexpected proof artifact|source or commit/);
});

test("Evidence review admits dispatches and keeps publisher checkout on the default branch", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/evidence-review.yml", import.meta.url), "utf8");
  assert.equal(workflow.match(/contains\(fromJSON\('\["pull_request", "workflow_dispatch"\]'\), github.event.workflow_run.event\)/g)?.length, 2);
  assert.equal(workflow.match(/ref: \$\{\{ github.event.repository.default_branch \}\}/g)?.length, 2);
  assert.match(workflow, /github.event_name == 'workflow_dispatch' && github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
});
