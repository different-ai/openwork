import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { changedLines, diffPaths, eligiblePr, fixBranch, fixPrBody, qualifyingFixes, LIMITS } from "./warden-fixer.mjs";
import { securityFindings, buildReport } from "./warden-report.mjs";

const diff = (path, added = 1) => [`--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", "-const a = unsafe(input)", ...Array.from({ length: added }, () => "+const a = safe(input)"), " keep", ""].join("\n");
const finding = (overrides = {}) => ({
  severity: "high", title: "Unescaped input", description: "x", path: "apps/server/src/a.ts", line: 1,
  confidence: "high", suggested_fix: { description: "escape it", diff: diff("apps/server/src/a.ts") }, ...overrides,
});
const files = ["apps/server/src/a.ts", "apps/server/src/b.ts"];

test("only high-confidence, small fixes to files the PR changes qualify", () => {
  const { fixes, skipped } = qualifyingFixes({ findings: [
    finding(),
    finding({ confidence: "medium" }),
    finding({ suggested_fix: null }),
    finding({ suggested_fix: { diff: diff("apps/server/src/other.ts") } }),
    finding({ suggested_fix: { diff: diff(".github/workflows/ci-tests.yml") } }),
    finding({ suggested_fix: { diff: diff("apps/server/src/b.ts", LIMITS.changedLinesPerFix + 1) } }),
  ] }, [...files, ".github/workflows/ci-tests.yml"]);
  assert.equal(fixes.length, 1);
  assert.deepEqual(skipped.map((item) => item.reason), [
    "not high confidence", "no applicable text diff", "touches a file the PR does not change",
    "touches review or CI machinery", "too large",
  ]);
});

test("renames, new or deleted files, binaries and path escapes are never applied", () => {
  for (const bad of [
    "rename from a\nrename to b\n", `new file mode 100644\n${diff("a.ts")}`, `--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n`,
    "GIT binary patch\nliteral 1\n", `--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n`, "", null, "x".repeat(LIMITS.diffBytes + 1),
  ]) assert.equal(diffPaths(bad), null, String(bad).slice(0, 30));
  assert.deepEqual(diffPaths(diff("apps/server/src/a.ts")), ["apps/server/src/a.ts"]);
  assert.equal(changedLines(diff("a.ts", 2)), 3);
});

test("at most a handful of fixes per review", () => {
  const many = Array.from({ length: LIMITS.fixes + 2 }, () => finding());
  const { fixes, skipped } = qualifyingFixes({ findings: many }, files);
  assert.equal(fixes.length, LIMITS.fixes);
  assert.deepEqual(skipped.map((item) => item.reason), ["fix limit reached", "fix limit reached"]);
});

test("forks, fix PRs, other bases and moved heads never get fixes", () => {
  const head = "a".repeat(40);
  const repo = { full_name: "example/repo", fork: false };
  const pr = { state: "open", base: { ref: "dev", repo }, head: { ref: "feat/x", sha: head, repo } };
  const options = { repository: "example/repo", reviewedHead: head };
  assert.equal(eligiblePr(pr, options), null);
  assert.match(eligiblePr({ ...pr, head: { ...pr.head, repo: { full_name: "someone/repo", fork: true } } }, options), /fork/);
  assert.match(eligiblePr({ ...pr, head: { ...pr.head, ref: fixBranch(1, head) } }, options), /never fixed again/);
  assert.match(eligiblePr({ ...pr, base: { ...pr.base, ref: "main" } }, options), /target dev/);
  assert.match(eligiblePr(pr, { ...options, reviewedHead: "b".repeat(40) }), /moved/);
  assert.match(eligiblePr({ ...pr, state: "closed" }, options), /not open/);
  assert.equal(fixBranch(12, head), `warden-fix/12-${head.slice(0, 12)}`);
  assert.throws(() => fixBranch(0, head));
  assert.throws(() => fixBranch(1, "nope"));
});

test("the fix PR says how to accept or reject and that Warden never merges", () => {
  const body = fixPrBody({ pr: 7, headSha: "a".repeat(40), fixes: [{ severity: "high", title: "t", path: "p.ts" }], skipped: [{ title: "u", reason: "too large" }] });
  assert.match(body, /Merge this PR into your branch to accept/);
  assert.match(body, /close it to reject/);
  assert.match(body, /Warden never merges/);
  assert.match(body, /Release note: none/);
});

test("Warden's findings report carries confidence and the suggested fix", () => {
  const raw = {
    version: "1", event: "pull_request", repository: { fullName: "o/r" }, pullRequest: { number: 1, headSha: "h" }, runId: "9",
    skills: ["diff-security-review", "confidentiality-review"].map((name) => ({ name, findings: name === "diff-security-review" ? [{ severity: "high", title: "t", description: "d", confidence: "high", location: { path: "a.ts", startLine: 2 }, suggestedFix: { description: "fix", diff: diff("a.ts") } }] : [] })),
    triggerResults: ["diff-security-review", "confidentiality-review"].map((skillName) => ({ skillName, status: "success" })),
  };
  const report = buildReport(raw, { repository: "o/r", pr: 1, head: "h", runId: "9", attempt: 1, outcome: "success", started: 1, analysisStarted: 1 });
  const [entry] = securityFindings(report, raw).findings;
  assert.equal(entry.confidence, "high");
  assert.equal(entry.suggested_fix.diff, diff("a.ts"));
});

test("the fixer workflow is off by default, manual, same-repository and never merges", () => {
  const workflow = readFileSync(new URL("../workflows/warden-fixer.yml", import.meta.url), "utf8");
  const triggers = workflow.split("\njobs:\n")[0];
  assert.match(triggers, /workflow_dispatch:/);
  assert.doesNotMatch(triggers, /pull_request_target|pull_request:|workflow_run:|push:|schedule:/);
  assert.match(workflow, /vars\.WARDEN_FIXER_ENABLED == 'true'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/dev'/);
  assert.doesNotMatch(workflow, /gh pr merge|--auto|pulls\/[^ ]*\/merge|enablePullRequestAutoMerge|reviews/);
  assert.match(workflow, /gh pr create --base "\$PR_BRANCH"/);
});
