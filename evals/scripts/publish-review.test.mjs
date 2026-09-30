import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { proofArtifact } from "../../.github/scripts/pr-proof.mjs";
import { association, publicationJob, publishCompletedEvidence } from "./publish-review.mjs";

const repo = "sample-org/sample-project";
const repository = { id: 10, full_name: repo, name: "sample-project", owner: { login: "sample-org" } };
const sha = "1".repeat(40);
const spec = "evals/specs/change-proof.e2e.test.ts";
const workflows = [
  { id: 20, file: "pr-proof.yml", name: "PR change proof", events: ["pull_request"], proof: true },
  { id: 21, file: "daytona-e2e.yml", name: "Product journeys", events: ["workflow_run"] },
];
function run(id = 30, producer = workflows[0]) {
  return {
    id, run_attempt: 1, workflow_id: producer.id, path: `.github/workflows/${producer.file}`, name: producer.name,
    event: producer.events[0], status: "completed", conclusion: "success",
    repository, head_repository: repository, head_sha: sha,
    pull_requests: [{ number: 7, base: { repo: { id: 10 } }, head: { repo: { id: 10 }, sha } }],
  };
}
function harness(options = {}) {
  const source = options.source ?? run();
  const logs = [], downloads = [], publications = [];
  const files = options.files ?? [
    { filename: "apps/app/src/change.ts", status: "modified" },
    { filename: spec, status: "added" },
  ];
  const current = { number: 7, state: "open", changed_files: files.length, created_at: "2026-07-01T00:00:00Z",
    base: { repo: repository }, head: { repo: repository, sha } };
  const artifactName = proofArtifact(spec, 1);
  const api = async path => {
    const workflow = workflows.find(item => path.endsWith(`/workflows/${item.file}`));
    if (workflow) return { ...workflow, path: `.github/workflows/${workflow.file}` };
    if (path.endsWith("/pulls/7")) return current;
    if (path.includes("/pulls/7/files?")) return files;
    if (path.endsWith("/actions/runs/30")) return source;
    if (path.includes("/actions/runs/30/artifacts?")) return options.artifacts ?? {
      total_count: 1, artifacts: [{ name: artifactName, expired: false }],
    };
    throw new Error(`Unexpected API path: ${path}`);
  };
  return {
    logs, downloads, publications, current,
    dependencies: {
      api, log: message => logs.push(message),
      download: async (id, directory, name, recordSpec = options.recordSpec ?? spec) => {
        downloads.push({ id, name });
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "test-run.json"), JSON.stringify({
          name: "Change-specific behavior", specFile: recordSpec, dir: directory,
          createdAt: "2026-07-02T00:00:00Z", closedAt: "2026-07-02T00:01:00Z", gitSha: options.recordSha ?? sha,
          engine: "v1", branch: "test", artifacts: [{ caption: "Observed outcome", fileName: "", hash: "", route: "",
            at: "2026-07-02T00:00:30Z", description: "The requested behavior was observed.", model: "", ok: true,
            results: [{ expectation: "Observed outcome", evidence: "The requested behavior was observed.", passed: true }],
            judgments: [{ expectation: "Observed outcome", state: "passed", reasoning: "The requested behavior was observed." }] }],
          trace: [], steps: [{ seq: 1, name: "Observe requested behavior", depth: 0, ok: true }], outcome: "passed",
          summary: { ok: true, totalArtifacts: 1, passedArtifacts: 1, failedArtifacts: 0, unvalidatedArtifacts: 0,
            pendingArtifacts: 0, passedExpectations: 1, failedExpectations: 0, pendingJudgments: 0 },
        }));
      },
      publish: async publishOptions => { publications.push(publishOptions); return { posted: true, urls: { report: `https://review.example.test/r/${"a".repeat(32)}` } }; },
    },
  };
}

test("association accepts only the recognized same-repository PR proof run", () => {
  assert.deepEqual(association(run(), repo, workflows), { pr: 7, sha });
  for (const mutate of [
    value => { value.path = ".github/workflows/unknown.yml"; },
    value => { value.pull_requests = []; },
    value => { value.head_sha = "2".repeat(40); },
    value => { value.head_repository = { ...repository, owner: { login: "other" } }; },
  ]) {
    const value = run(); mutate(value);
    assert.ok(association(value, repo, workflows).reason);
  }
});

test("publishes only records bound to the live added or changed proof specs", async () => {
  const fixture = harness();
  const result = await publishCompletedEvidence({ repo, runId: 30, runAttempt: "1" }, fixture.dependencies);
  assert.equal(result.posted, true);
  assert.deepEqual(fixture.downloads, [{ id: 30, name: proofArtifact(spec, 1) }]);
  assert.equal(fixture.publications.length, 1);
  assert.equal(fixture.publications[0].testRunDirs.length, 1);
  assert.deepEqual(fixture.publications[0].gaps, []);
  assert.match(fixture.publications[0].title, /PR #7 change proof/);
});

test("a changed existing spec is a proof too, and multiple specs aggregate into one report", async () => {
  const other = "evals/specs/other-change.e2e.test.ts";
  const fixture = harness({
    files: [{ filename: spec, status: "modified" }, { filename: other, status: "added" }],
    artifacts: { total_count: 2, artifacts: [{ name: proofArtifact(spec, 1), expired: false }, { name: proofArtifact(other, 1), expired: false }] },
  });
  fixture.dependencies.download = (() => {
    const original = fixture.dependencies.download;
    return (id, directory, name) => original(id, directory, name, name === proofArtifact(other, 1) ? other : spec);
  })();
  const result = await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
  assert.equal(result.posted, true);
  assert.equal(fixture.downloads.length, 2);
  assert.equal(fixture.publications[0].testRunDirs.length, 2);
});

test("never substitutes smoke, unrelated records, or missing proof artifacts", async () => {
  for (const fixture of [
    harness({ files: [{ filename: "apps/app/src/change.ts", status: "modified" }] }),
    harness({ recordSpec: "evals/specs/other.e2e.test.ts" }),
    harness({ recordSha: "2".repeat(40) }),
    harness({ artifacts: { total_count: 1, artifacts: [{ name: "packaged-desktop-smoke-1", expired: false }] } }),
    harness({ artifacts: { total_count: 2, artifacts: [{ name: proofArtifact(spec, 1), expired: false }, { name: "pr-proof-1-" + "f".repeat(64), expired: false }] } }),
  ]) {
    await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
    assert.equal(fixture.publications.length, 0);
    assert.match(fixture.logs[0], /skipped:/);
  }
});

test("stale heads and run attempts do not publish", async () => {
  const staleAttempt = harness();
  await publishCompletedEvidence({ repo, runId: 30, runAttempt: "2" }, staleAttempt.dependencies);
  assert.match(staleAttempt.logs[0], /attempt is stale/);
  const staleHead = harness(); staleHead.current.head.sha = "2".repeat(40);
  await publishCompletedEvidence({ repo, runId: 30 }, staleHead.dependencies);
  assert.match(staleHead.logs[0], /stale/);
});

const jobEnv = { GITHUB_REPOSITORY: repo, REVIEW_RUN_ID: "30", OPENWORK_REVIEW_URL: "https://review.example.test", BLOB_READ_WRITE_TOKEN: "synthetic" };
test("publication job distinguishes published, skipped, unavailable and failed without leaking errors", async () => {
  for (const [value, state, code] of [
    [{ posted: true, urls: { report: `https://review.example.test/r/${"a".repeat(32)}` } }, "published", 0],
    [{ skipped: "PR adds or changes no E2E spec; no proof evidence to publish" }, "skipped", 0],
  ]) {
    const summaries = [];
    const result = await publicationJob(jobEnv, { publish: async () => value, summary: async text => summaries.push(text) });
    assert.deepEqual(result, { state, exitCode: code });
    assert.match(summaries[0], new RegExp(state));
  }
  const missing = await publicationJob({ ...jobEnv, BLOB_READ_WRITE_TOKEN: "" }, { summary: async () => {} });
  assert.deepEqual(missing, { state: "unavailable", exitCode: 1 });
  const summaries = [];
  const failed = await publicationJob(jobEnv, { publish: async () => { throw new Error("secret detail"); }, summary: async text => summaries.push(text) });
  assert.deepEqual(failed, { state: "failed", exitCode: 1 });
  assert.doesNotMatch(summaries[0], /secret detail/);
});

test("candidate checks are PR-only and credentialed publication checks out trusted default-branch code", async () => {
  const candidate = await readFile(new URL("../../.github/workflows/evidence-review-checks.yml", import.meta.url), "utf8");
  assert.match(candidate, /on:\n  pull_request:/);
  assert.doesNotMatch(candidate, /workflow_dispatch|workflow_run|secrets\.|pull-requests: write/);
  const publisher = await readFile(new URL("../../.github/workflows/evidence-review.yml", import.meta.url), "utf8");
  assert.doesNotMatch(publisher, /pull_request:\n/);
  assert.match(publisher, /workflows: \[PR change proof, Product journeys\]/);
  assert.match(publisher, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.doesNotMatch(publisher, /ref:.*head.sha/);
});

test("publication emits a trusted native receipt rather than relying on comment text", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "evidence-receipt-"));
  const path = join(directory, "receipt.json");
  try {
    const evidence = { gitSha: sha, verdict: "Passed", tests: 1, passedTests: 1, assertions: 1, passedAssertions: 1 };
    await publicationJob({ ...jobEnv, EVIDENCE_RECEIPT_PATH: path }, {
      publish: async () => ({ posted: true, evidence, urls: { report: `https://review.example.test/r/${"a".repeat(32)}` } }), summary: async () => {},
    });
    const receipt = JSON.parse(await readFile(path, "utf8"));
    assert.equal(receipt.state, "published"); assert.deepEqual(receipt.evidence, evidence);
    assert.match(receipt.reportUrl, /\/r\/a{32}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native workflow writes use only trusted code and require completion before publishing", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/evidence-review.yml", import.meta.url), "utf8");
  assert.match(workflow, /types: \[requested, in_progress, completed\]/);
  assert.match(workflow, /github.event.action == 'completed'/);
  assert.match(workflow, /checks: write/); assert.match(workflow, /deployments: write/);
  assert.match(workflow, /if: always\(\)\n        env:[\s\S]*?run: node .github\/scripts\/evidence-presentation.mjs complete/);
  assert.doesNotMatch(workflow, /ref:.*head.sha|pull_request_target/);
});
