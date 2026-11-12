import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { association, authorEvidenceNotice } from "../../.github/scripts/evidence-association.mjs";

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

test("Evidence review admits dispatches and keeps publisher checkout on the default branch", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/evidence-review.yml", import.meta.url), "utf8");
  assert.equal(workflow.match(/contains\(fromJSON\('\["pull_request", "workflow_dispatch"\]'\), github.event.workflow_run.event\)/g)?.length, 2);
  assert.equal(workflow.match(/ref: \$\{\{ github.event.repository.default_branch \}\}/g)?.length, 2);
  assert.match(workflow, /github.event_name == 'workflow_dispatch' && github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
});
