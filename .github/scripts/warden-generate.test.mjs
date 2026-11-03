import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixes, editsToPatch, safeFile, validatePatch, responsesRequest, generationModel, fixOutcomeLine } from "./warden-generate.mjs";
import { readPlan, main as openFixPrs } from "./warden-sweep-open.mjs";
import { planFix, validState, slackMessage, jobSummary, sweepFindings, relatedOpenFixes, queueFixRetry } from "./warden-sweep.mjs";
import { parseWardenJsonl } from "./contributor-screen.mjs";
import { guardedFiles } from "./warden-clearance.mjs";
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "warden-generation-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.tsx"), 'const label = "";\n');
  writeFileSync(join(cwd, "DESIGN.md"), "Reuse existing primitives and tokens.\n");
  git(cwd, ["add", "."]); git(cwd, ["commit", "-m", "base"]);
  writeFileSync(join(cwd, "src/a.tsx"), 'const label = "bad";\n');
  git(cwd, ["commit", "-am", "regression (#12)"]);
  return cwd;
}
const finding = { kind: "bug", title: "Empty label", description: "Concrete label regression", path: "src/a.tsx", line: 1, confidence: "high", severity: "medium", suggested_fix: null };
const proposed = { disposition: "fix", reason: "restore label", edits: [{ path: finding.path, before: '"bad"', after: '"Good"' }] };
const verified = { applicable: true, rootCause: true, minimal: true, checksPreserved: true, reason: "small and applicable" };
const options = (cwd, request, findings = [finding]) => ({ cwd, request, findings, files: [finding.path], budget: { remaining: 5 }, model: "model", apiKey: "test" });

test("high-confidence missing diff becomes a verified, applicable draft PR plan including design", async (t) => {
  for (const kind of ["bug", "security", "design"]) {
    const cwd = fixture(t);
    const stages = [];
    const result = await generateFixes(options(cwd, async ({ stage, data }) => {
      stages.push(stage);
      assert.match(data.design, /primitives and tokens/);
      return stage === "generate" ? proposed : verified;
    }, sweepFindings(parseWardenJsonl([
      // Warden 0.43.0 FindingSchema has no suggestedFix; Zod strips extra fields.
      // getsentry/warden@8759014a14130cd2b82e59d3fb450a7385721221 packages/warden/src/types/index.ts
      JSON.stringify({ schemaVersion: 1, skill: { bug: "diff-bug-review", security: "diff-security-review", design: "design-spec-review" }[kind], status: "ok", findings: [{ id: "schema-regression", severity: "medium", confidence: "high", title: finding.title, description: finding.description, verification: "Observed current code", location: { path: finding.path, startLine: 1 } }] }),
      JSON.stringify({ type: "summary", totalFindings: 1, bySeverity: {} }),
    ].join("\n"), [{ bug: "diff-bug-review", security: "diff-security-review", design: "design-spec-review" }[kind]]))));
    assert.deepEqual(stages, ["generate", "verify"]);
    assert.equal(result.findings.length, 1);
    const sha = git(cwd, ["rev-parse", "HEAD"]);
    const plan = planFix({ sha, number: 12, complete: true, findings: result.findings }, [finding.path]);
    assert.equal(plan.patches.length, 1);
    validatePatch(cwd, plan.patches[0], [finding.path]);
    assert.equal(readFileSync(join(cwd, finding.path), "utf8"), 'const label = "bad";\n');
    const dir = join(cwd, "artifact"); mkdirSync(dir);
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
    writeFileSync(join(dir, "01.patch"), plan.patches[0]);
    writeFileSync(join(dir, "body.md"), plan.body);
    assert.equal(readPlan(cwd, dir).patches.length, 1);
    writeFileSync(join(dir, "01.patch"), plan.patches[0].replaceAll("src/a.tsx", ".github/x"));
    assert.throws(() => readPlan(cwd, dir));
  }
});
test("untrusted, missing, symlink, nontracked, duplicate and machinery edits refused", (t) => {
  const cwd = fixture(t);
  const context = new Map([[finding.path, safeFile(cwd, finding.path)]]);
  for (const path of ["../escape", "/etc/passwd", ".github/test.mjs", "src/new.tsx"]) {
    assert.throws(() => editsToPatch(cwd, [{ ...proposed.edits[0], path }], context));
  }
  writeFileSync(join(cwd, "src/new.tsx"), "not tracked");
  assert.throws(() => safeFile(cwd, "src/new.tsx"));
  symlinkSync("a.tsx", join(cwd, "src/link.tsx"));
  git(cwd, ["add", "src/link.tsx"]);
  assert.throws(() => safeFile(cwd, "src/link.tsx"), /symlink/);
  symlinkSync("src", join(cwd, "linked"));
  assert.throws(() => safeFile(cwd, "linked/a.tsx"), /symlink/);
  assert.throws(() => editsToPatch(cwd, [{ ...proposed.edits[0], before: "missing" }], context), /uniquely/);
  writeFileSync(join(cwd, finding.path), '"bad" "bad"');
  assert.throws(() => editsToPatch(cwd, proposed.edits, context), /current content/);
  assert.throws(() => editsToPatch(cwd, proposed.edits, new Map([[finding.path, '"bad" "bad"']])), /uniquely/);
});
test("model failures, refusal, rejection and budgets are explicit with no success claims", async (t) => {
  const cwd = fixture(t);
  for (const [request, reason] of [
    [async () => { throw new Error("secret error text"); }, /model generation request failed/],
    [async () => ({ disposition: "no_fix", edits: [] }), /model declined/],
    [async ({ stage }) => stage === "generate" ? proposed : { ...verified, rootCause: false }, /verification rejected/],
    [async ({ stage }) => stage === "generate" ? proposed : { ...verified, checksPreserved: false }, /verification rejected/],
    [async () => ({ ...proposed, edits: [{ ...proposed.edits[0], path: "../oops" }] }), /generated edit validation/],
  ]) {
    const result = await generateFixes(options(cwd, request));
    assert.equal(result.findings.length, 0);
    assert.match(fixOutcomeLine(result.outcomes), reason);
    assert.doesNotMatch(fixOutcomeLine(result.outcomes), /secret error text/);
  }
  const opts = options(cwd, async () => assert.fail("budget should stop request")); opts.budget.remaining = 0;
  assert.match(fixOutcomeLine((await generateFixes(opts)).outcomes), /budget exhausted/);
});
test("existing diffs still require independent verification and stale content is refused", async (t) => {
  const cwd = fixture(t);
  const patch = editsToPatch(cwd, proposed.edits, new Map([[finding.path, safeFile(cwd, finding.path)]]));
  const opts = options(cwd, async ({ stage }) => { assert.equal(stage, "verify"); return verified; }, [{ ...finding, suggested_fix: { diff: patch } }]);
  assert.equal((await generateFixes(opts)).findings.length, 1);
  const stale = await generateFixes(options(cwd, async ({ stage }) => {
    if (stage === "generate") return proposed;
    writeFileSync(join(cwd, finding.path), "changed during verification\n");
    return verified;
  }));
  assert.equal(stale.findings.length, 0);
  assert.match(fixOutcomeLine(stale.outcomes), /current patch revalidation failed/);
});

test("manual Warden follow-ups defer located-file generation rather than duplicate their concern", async (t) => {
  const cwd = fixture(t);
  const followup = { number: 22, title: "Fix", body: "Addresses Warden's post-merge review of #12", head: { ref: "warden-fix/manual-follow-up" } };
  assert.deepEqual(relatedOpenFixes({ number: 12 }, [followup]), [followup]);
  assert.deepEqual(relatedOpenFixes({ number: 1 }, [followup]), []);
  assert.deepEqual(relatedOpenFixes({ number: 12 }, [{ ...followup, head: { ref: "unrelated" } }]), []);
  const opts = options(cwd, async () => assert.fail("existing follow-up must not generate a duplicate"));
  opts.coveredPaths = new Set([finding.path]);
  const result = await generateFixes(opts);
  assert.equal(result.findings.length, 0);
  assert.equal(opts.budget.remaining, 5);
  assert.match(fixOutcomeLine(result.outcomes), /open Warden follow-up/);
});

test("retry state stores only bounded commit IDs and attempt counts", () => {
  const sha = "a".repeat(40);
  const state = validState({ version: 1, reviewedThrough: sha, fixPending: [{ sha, attempts: 1, securityText: "secret" }, { sha, attempts: 3 }, { sha: "../bad", attempts: 1 }] });
  assert.deepEqual(state.fixPending, [{ sha, attempts: 1 }]);
  const pending = [];
  assert.match(queueFixRetry(pending, state.fixPending, sha), /queued/);
  assert.deepEqual(pending, [{ sha, attempts: 2 }]);
  assert.match(queueFixRetry([], pending, sha), /attempt cap reached; human/);
  const full = Array.from({ length: 60 }, () => ({ sha, attempts: 1 }));
  assert.match(queueFixRetry(full, [], "b".repeat(40)), /queue full; human/);
  assert.equal(full.length, 60);
});
test("model config is explicit and Responses API receives no tools, GitHub or Slack tokens", async (t) => {
  assert.equal(generationModel('model = "openai/current-model"'), "current-model");
  assert.equal(generationModel('model = "openai/default"', "openai/override"), "override");
  assert.throws(() => generationModel('model = "other/model"'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.text.format.strict, true);
    assert.match(body.instructions, /untrusted data/);
    assert.equal(init.headers.Authorization, "Bearer test-key");
    return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(proposed) }] }] }) };
  };
  assert.deepEqual(await responsesRequest({ apiKey: "test-key", model: "override", stage: "generate", data: { finding } }), proposed);
});
test("generation diagnostics are visible privately and publicly without raw security model reasons", () => {
  const sha = "a".repeat(40);
  const pr = { number: 12, sha, title: "test", complete: true, findings: [{ ...finding, kind: "security", title: "private issue" }], ci: { failed: [], pending: 0 }, fixOutcomes: [{ status: "failed", reason: "generation, patch validation or model request failed" }], fixQueueReason: "queued for re-review" };
  const args = { repo: "o/r", prs: [pr], runUrl: "url", lateCi: [], deferred: 0, base: sha, head: sha, slack: "sent", fixPlans: 1 };
  assert.match(slackMessage(args).text, /0 of 1 findings got a verified fix\. Not fixed: 1 generation, patch validation or model request failed/);
  assert.match(slackMessage(args).text, /1 PR will get another fix attempt/);
  assert.doesNotMatch(slackMessage(args).text, /Opening/);
  assert.match(jobSummary(args), /queued for re-review/);
  assert.doesNotMatch(jobSummary(args), /private issue/);
});
test("workflow preserves token isolation, draft-only normal CI and quick-check coverage", () => {
  const workflow = readFileSync(new URL("../workflows/warden-sweep.yml", import.meta.url), "utf8");
  const writer = readFileSync(new URL("warden-sweep-open.mjs", import.meta.url), "utf8");
  const fix = workflow.split("\n  fix:")[1];
  assert.doesNotMatch(fix, /WARDEN_OPENAI_API_KEY|WARDEN_MODEL/);
  assert.match(writer, /"--draft"/);
  assert.match(writer, /automation App required/);
  assert.match(writer, /readPlan/);
  assert.match(writer, /chat.postMessage/);
  assert.deepEqual(guardedFiles([".github/scripts/warden-generate.mjs", ".github/scripts/warden-sweep-open.mjs"]), [".github/scripts/warden-generate.mjs", ".github/scripts/warden-sweep-open.mjs"]);
  assert.match(readFileSync(new URL("../workflows/quick-check.yml", import.meta.url), "utf8"), /warden-generate.test.mjs/);
});

test("writer applies a verified generated patch, pushes its branch and reports a draft PR receipt", async (t) => {
  const cwd = fixture(t);
  const temp = mkdtempSync(join(tmpdir(), "warden-writer-boundary-"));
  const originalCwd = process.cwd(), originalPath = process.env.PATH, originalFetch = globalThis.fetch;
  t.after(() => { process.chdir(originalCwd); process.env.PATH = originalPath; globalThis.fetch = originalFetch; rmSync(temp, { recursive: true, force: true }); });
  const remote = join(temp, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  git(cwd, ["remote", "add", "origin", remote]);
  const result = await generateFixes(options(cwd, async ({ stage }) => stage === "generate" ? proposed : verified));
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  const plan = planFix({ sha, number: 12, complete: true, findings: result.findings }, [finding.path]);
  const fixes = join(temp, "fixes"), dir = join(fixes, "01"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "body.md"), plan.body);
  writeFileSync(join(dir, "01.patch"), plan.patches[0]);
  const bin = join(temp, "bin"); mkdirSync(bin);
  const receipt = join(temp, "gh-operations.jsonl");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify(args)+'\\n'); if(args[0]==='pr'&&args[1]==='list') console.log('[]');else if(args[0]==='pr'&&args[1]==='create') console.log('https://github.com/example/repo/pull/123');else process.exit(1);\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const messages = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://slack.com/api/chat.postMessage");
    messages.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  process.chdir(cwd);
  await openFixPrs({ BASE: sha, FIXES_DIR: fixes, PR_TOKEN: "test-app", GH_TOKEN: "test-read", HAS_AUTOMATION_APP: "true", GITHUB_REPOSITORY: "example/repo", SLACK_BOT_TOKEN: "test-slack", SLACK_WARDEN_SWEEP_CHANNEL_ID: "test-channel" });
  const pushed = git(cwd, ["ls-remote", "origin", `refs/heads/${plan.branch}`]);
  assert.match(pushed, new RegExp(plan.branch));
  assert.equal(git(cwd, ["show", "HEAD:src/a.tsx"]), 'const label = "Good";');
  const operations = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(operations.length, 2);
  assert.ok(operations[1].includes("--draft"));
  assert.ok(operations[1].includes("--base"));
  assert.match(messages[0], /Warden opened 1 draft fix PR/);
  assert.match(messages[0], /#123> empty label/);
  assert.match(messages[0], /https:\/\/github.com\/example\/repo\/pull\/123/);
});

test("CI source candidates carry log evidence through independent patch verification", async (t) => {
  const cwd = fixture(t);
  const ciEvidence = { runId: 123, evidence: "Expected nonempty accessible name", observedFailure: "Accessible name assertion failed", causeHypothesis: "The source sets an empty label" };
  const opts = options(cwd, async ({ stage, data }) => {
    assert.equal(data.finding.kind, "ci");
    assert.deepEqual(data.finding.ciEvidence, ciEvidence);
    return stage === "generate" ? proposed : verified;
  }, [{ ...finding, kind: "ci", ciEvidence }]);
  const result = await generateFixes(opts);
  assert.equal(result.findings.length, 1);
  assert.equal(opts.budget.remaining, 4);
  assert.equal(result.findings[0].kind, "ci");
});
