import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ciStatus, counts, jobSummary, MAX_PRS, needsAttention, planFix, planWindow, prNumber, slackMessage, sweepEnvironment, sweepFindings, validState,
} from "./warden-sweep.mjs";

const sha = (n) => String(n).padStart(40, "a");
const parsed = (findings) => ({ complete: true, findings });
const pr = (overrides = {}) => ({
  sha: sha(1), number: 101, title: "feat(app): thing", complete: true, reason: "", findings: [], ci: { failed: [], pending: 0 }, ...overrides,
});

test("reads the PR number from a squash-merge subject", () => {
  assert.equal(prNumber("feat(app): stop background commands (#6820)"), 6820);
  assert.equal(prNumber("Merge branch 'x' into dev"), null);
  assert.equal(prNumber("fix: see (#12) for context"), null);
});

test("accepts only well-formed state", () => {
  assert.equal(validState(null), null);
  assert.equal(validState({ version: 1, reviewedThrough: "main" }), null);
  const state = validState({ version: 1, reviewedThrough: sha(2), ciPending: [{ sha: sha(3), since: "2026-11-01T00:00:00Z" }, { sha: "x" }] });
  assert.deepEqual(state.ciPending.map((entry) => entry.sha), [sha(3)]);
});

test("reviews the oldest merges first and defers the rest", () => {
  const commits = Array.from({ length: MAX_PRS + 3 }, (_, i) => ({ sha: sha(i) }));
  const plan = planWindow(commits);
  assert.equal(plan.batch.length, MAX_PRS);
  assert.equal(plan.deferred, 3);
  assert.equal(plan.reviewedThrough, sha(MAX_PRS - 1));
  assert.equal(planWindow([]).reviewedThrough, null);
});

test("maps skills to kinds, sorts by severity and drops the PR-only screenshot note", () => {
  const findings = sweepFindings(parsed([
    { skill: "design-spec-review", severity: "low", title: "UI change without screenshot evidence" },
    { skill: "design-spec-review", severity: "medium", title: "P2: title and description", location: { path: "a.tsx", startLine: 4 } },
    { skill: "diff-bug-review", severity: "high", title: "Crash on empty list", description: "token sk-abcdefghijklmnopqrstuvwx leaked" },
    { skill: "confidentiality-review", severity: "high", title: "never shown" },
  ]));
  assert.deepEqual(findings.map((finding) => [finding.kind, finding.severity]), [["bug", "high"], ["design", "medium"]]);
  assert.match(findings[0].description, /\[redacted\]/);
  assert.equal(findings[1].path, "a.tsx");
  assert.equal(findings[1].line, 4);
});

test("CI status keeps the newest attempt and tells new failures from old ones", async () => {
  const runs = [
    { workflow_id: 1, name: "Build", status: "completed", conclusion: "failure", created_at: "2026-11-01T00:00:00Z", html_url: "u1" },
    { workflow_id: 1, name: "Build", status: "completed", conclusion: "success", created_at: "2026-11-01T01:00:00Z", html_url: "u2" },
    { workflow_id: 2, name: "E2E", status: "completed", conclusion: "failure", created_at: "2026-11-01T00:00:00Z", html_url: "u3" },
    { workflow_id: 3, name: "Lint", status: "completed", conclusion: "timed_out", created_at: "2026-11-01T00:00:00Z", html_url: "u4" },
    { workflow_id: 4, name: "Slow", status: "in_progress", conclusion: null, created_at: "2026-11-01T00:00:00Z", html_url: "u5" },
  ];
  const status = await ciStatus(runs, async (run) => (run.workflow_id === 2 ? "success" : "failure"));
  assert.equal(status.pending, 1);
  assert.deepEqual(status.failed.map((run) => [run.name, run.newlyFailing]), [["E2E", true], ["Lint", false]]);
});

test("Slack stays quiet when nothing needs fixing", () => {
  assert.equal(slackMessage({ repo: "o/r", prs: [pr()], runUrl: "u", deferred: 0, lateCi: [] }), null);
  assert.equal(needsAttention(pr({ complete: false })), true);
});

test("Slack lists every kind with escaped model text; the public summary hides security text", () => {
  const prs = [pr({
    title: "feat: <b>&</b>",
    findings: [
      { kind: "security", severity: "high", title: "SSRF in <proxy> @here", description: "", path: "x.ts", line: 3 },
      { kind: "bug", severity: "medium", title: "Missing await", description: "Drops errors", path: "y.ts", line: null },
    ],
    ci: { failed: [{ name: "Build", url: "https://ci", newlyFailing: true }], pending: 0 },
  })];
  const message = slackMessage({ repo: "o/r", prs, runUrl: "https://run", deferred: 2, lateCi: [] });
  assert.match(message.text, /1 security · 1 bug · 1 failing workflow/);
  assert.match(message.text, /feat: &lt;b&gt;&amp;&lt;\/b&gt;/);
  assert.match(message.text, /SSRF in &lt;proxy&gt; @\u200bhere/);
  assert.match(message.text, /previous run passed; cause not established/);
  assert.match(message.text, /2 more merged PR/);

  const summary = jobSummary({ repo: "o/r", prs, deferred: 0, lateCi: [], base: sha(1), head: sha(2), slack: "Posted to Slack." });
  assert.doesNotMatch(summary, /SSRF/);
  assert.match(summary, /Missing await/);
  assert.match(summary, /\| \[#101\]\(https:\/\/github.com\/o\/r\/pull\/101\) \| 1 \| 1 \| 0 \| 1 \| complete \|/);
  assert.deepEqual(counts(prs), { security: 1, bug: 1, design: 0, tests: 1, incomplete: 0 });
});

test("Warden's agent never sees GitHub or Slack credentials", () => {
  const env = sweepEnvironment({ PATH: "/bin", GH_TOKEN: "t", GITHUB_TOKEN: "t", SLACK_BOT_TOKEN: "s", SLACK_WARDEN_SWEEP_CHANNEL_ID: "c", WARDEN_OPENAI_API_KEY: "k" });
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "WARDEN_OPENAI_API_KEY"]);
});

const diff = (path, from = "a", to = "b") => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const fixable = (overrides = {}) => ({
  kind: "bug", severity: "high", title: "Crash on empty list", description: "", path: "src/a.ts", line: 1,
  confidence: "high", suggested_fix: { description: "", diff: diff("src/a.ts") }, ...overrides,
});

test("plans one fix PR per merged PR from high-confidence suggested fixes only", () => {
  const plan = planFix(pr({ findings: [
    fixable(),
    fixable({ title: "Unsure", confidence: "medium" }),
    fixable({ kind: "design", title: "baseline-ui: icon-only button needs aria-label", suggested_fix: { diff: diff("src/b.tsx") } }),
    fixable({ title: "Elsewhere", suggested_fix: { diff: diff("src/other.ts") } }),
    fixable({ title: "Workflow", suggested_fix: { diff: diff(".github/workflows/x.yml") } }),
  ] }), ["src/a.ts", "src/b.tsx", ".github/workflows/x.yml"]);
  assert.equal(plan.branch, `warden-fix/merged-101-${sha(1).slice(0, 12)}`);
  assert.equal(plan.patches.length, 2);
  assert.match(plan.title, /#101/);
  assert.match(plan.body, /Crash on empty list/);
  assert.match(plan.body, /design · high\*\*: baseline-ui: icon-only button needs aria-label/);
  assert.match(plan.body, /3 other finding\(s\)/);
});

test("no fix PR for incomplete reviews or nothing fixable", () => {
  assert.equal(planFix(pr({ complete: false, findings: [fixable()] }), ["src/a.ts"]), null);
  assert.equal(planFix(pr({ findings: [fixable({ suggested_fix: null })] }), ["src/a.ts"]), null);
});

test("security fix PRs name the file, never the issue", () => {
  const plan = planFix(pr({ findings: [fixable({ kind: "security", title: "SSRF via proxy URL" })] }), ["src/a.ts"]);
  assert.doesNotMatch(plan.body, /SSRF/);
  assert.match(plan.body, /security · high\*\* in `src\/a.ts`/);
  assert.doesNotMatch(plan.title, /security/i);
});

test("UI Skills findings count as design", () => {
  const [finding] = sweepFindings(parsed([{ skill: "ui-skills-review", severity: "medium", title: "fixing-accessibility: div used as a button" }]));
  assert.equal(finding.kind, "design");
});

test("sweep findings keep Warden's confidence and suggested diff for planning", () => {
  const [finding] = sweepFindings(parsed([{ skill: "diff-bug-review", severity: "high", title: "t", confidence: "high", suggestedFix: { diff: "d", description: "x" } }]));
  assert.equal(finding.confidence, "high");
  assert.equal(finding.suggested_fix.diff, "d");
});
