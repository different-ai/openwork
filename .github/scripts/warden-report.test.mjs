import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildReport, renderSummary } from "./warden-report.mjs";

const now = Date.parse("2026-09-22T12:00:00Z");
const metadata = {
  repository: "different-ai/openwork", pr: 42, head: "a".repeat(40), base: "b".repeat(40),
  runId: "123456", attempt: 2, outcome: "success", started: now / 1000 - 14, analysisStarted: now / 1000 - 10,
};
const finding = {
  id: "SEC-1", severity: "high", title: "Unsafe input", description: "Untrusted input reaches a command.",
  location: { path: ".github/workflows/example.yml", startLine: 12 },
};
function analysis(security = [], privacy = []) {
  const skills = [
    { name: "diff-security-review", findings: security, durationMs: 8000 },
    { name: "confidentiality-review", findings: privacy, durationMs: 6000 },
  ];
  const findings = skills.flatMap((skill) => skill.findings);
  return {
    version: "1", event: "pull_request", repository: { fullName: metadata.repository },
    pullRequest: { number: metadata.pr, headSha: metadata.head, author: "private-author", title: "private-title" },
    runId: metadata.runId,
    skills,
    triggerResults: skills.map((skill) => ({ skillName: skill.name, status: "success", report: {
      skill: skill.name, findings: skill.findings,
    } })),
    summary: { totalSkills: 2, totalFindings: findings.length, findingsBySeverity:
      Object.fromEntries(["high", "medium", "low"].map((severity) => [severity, findings.filter((f) => f.severity === severity).length])),
    },
  };
}

test("records wall time separately from overlapping skill durations and preserves run identity", () => {
  const report = buildReport(analysis(), metadata, now);
  assert.equal(report.verdict, "clear");
  assert.equal(report.review_complete, true);
  assert.deepEqual(report.timing, { review_to_summary_ms: 14000, analysis_ms: 10000 });
  assert.deepEqual(report.skills.map((skill) => skill.duration_ms), [8000, 6000]);
  assert.equal(report.run_id, metadata.runId);
  assert.equal(report.run_attempt, 2);
  assert.equal(report.head_sha, metadata.head);
  assert.equal(report.blocking_count, 0);
});

test("security findings on CI files are reported without path or author-based approval gates", () => {
  const raw = analysis([finding]);
  const report = buildReport(raw, metadata, now);
  assert.equal(report.verdict, "findings");
  assert.equal(report.findings_count, 1);
  assert.equal(report.blocking_count, 1);
  const summary = renderSummary(report, raw);
  assert.match(summary, /Unsafe input/);
  assert.match(summary, /\.github\/workflows\/example.yml:12/);
  assert.match(summary, /Merge approval stays with the OpenWork admin team/);
});

test("retains every security severity and omits identity text and locations from measurements", () => {
  const raw = analysis([finding, { ...finding, id: "SEC-2", severity: "low" }], [{
    ...finding, id: "CONF-1", title: "private-confidentiality-title", description: "private-confidentiality-description",
    location: { path: "private-confidentiality-path", startLine: 1 },
  }]);
  const report = buildReport(raw, metadata, now);
  assert.equal(report.findings_count, 3);
  assert.deepEqual(report.skills[0].findings_by_severity, { high: 1, medium: 0, low: 1 });
  const measurement = JSON.stringify(report);
  for (const privateText of ["private-", finding.title, finding.description, finding.location.path, finding.id]) {
    assert.equal(measurement.includes(privateText), false);
  }
  assert.doesNotMatch(renderSummary(report, raw), /private-/);
});

test("escapes model-authored HTML and bounds summary size", () => {
  const raw = analysis(Array.from({ length: 30 }, (_, index) => ({
    ...finding, id: `SEC-${index}`,
    title: index % 2 === 0 ? "<script>unsafe</script>" : "<ScRiPt>unsafe</ScRiPt>",
    description: (index % 2 === 0 ? "<img onerror=unsafe>" : "<IMG onerror=unsafe>") + "x".repeat(5000),
  })));
  const summary = renderSummary(buildReport(raw, metadata, now), raw);
  assert.doesNotMatch(summary, /<script\b|<img\b/i);
  assert.match(summary, /&lt;script&gt;/);
  assert.match(summary, /&lt;ScRiPt&gt;/);
  assert.match(summary, /&lt;IMG onerror=unsafe&gt;/);
  assert.match(summary, /10 additional finding/);
  assert.ok(summary.length < 90000);
});

const incompleteCases = {
  missing: () => null,
  "wrong repository": (raw) => { raw.repository.fullName = "elsewhere/repo"; },
  "wrong head": (raw) => { raw.pullRequest.headSha = "c".repeat(40); },
  "wrong run": (raw) => { raw.runId = "999"; },
  "wrong PR": (raw) => { raw.pullRequest.number++; },
  "wrong version": (raw) => { raw.version = "2"; },
  "no triggers": (raw) => { raw.triggerResults = []; },
  "failed trigger": (raw) => { raw.triggerResults[0].status = "error"; },
  "missing mandatory skill": (raw) => { raw.skills.pop(); },
  "duplicate skill": (raw) => { raw.skills[1] = raw.skills[0]; },
  "unknown skill": (raw) => { raw.skills[1].name = "design-spec-review"; },
  "partial hunks": (raw) => { raw.skills[0].failedHunks = 1; },
  "partial extraction": (raw) => { raw.skills[1].failedExtractions = 1; },
  "model error": (raw) => { raw.skills[0].error = { message: "private-model-error" }; },
  "malformed findings": (raw) => { raw.skills[0].findings = null; },
  "inconsistent totals": (raw) => { raw.summary.totalFindings = 12; },
  "inconsistent severity": (raw) => { raw.summary.findingsBySeverity.high = 1; },
  "replay mismatch": (raw) => { raw.triggerResults[0].report.findings = [finding]; },
};
for (const [name, mutate] of Object.entries(incompleteCases)) {
  test(`${name} stays incomplete, never a passing zero`, () => {
    const raw = analysis();
    const result = mutate(raw);
    const report = buildReport(result === null ? null : raw, metadata, now);
    assert.equal(report.verdict, "incomplete");
    assert.equal(report.review_complete, false);
    assert.equal(report.blocking_count, null);
    assert.ok(report.incomplete_reasons.length > 0);
    assert.doesNotMatch(JSON.stringify(report), /private-/);
  });
}

test("failed, cancelled, and skipped analysis never become clear even with an old complete file", () => {
  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    const report = buildReport(analysis(), { ...metadata, outcome }, now);
    assert.equal(report.verdict, "incomplete");
    assert.equal(report.analysis_outcome, outcome);
  }
});

test("missing and invalid durations are unknown, not zero or summed skill times", () => {
  const raw = analysis();
  delete raw.skills[0].durationMs;
  raw.skills[1].durationMs = -1;
  const report = buildReport(raw, { ...metadata, started: 0, analysisStarted: now / 1000 + 1 }, now);
  assert.deepEqual(report.timing, { review_to_summary_ms: null, analysis_ms: null });
  assert.deepEqual(report.skills.map((skill) => skill.duration_ms), [null, null]);
});

test("production reporter writes measurements for clean, flagged, and malformed runs without GitHub credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warden-report-test-"));
  try {
    for (const [content, exitCode, verdict] of [
      [JSON.stringify(analysis()), 0, "clear"],
      [JSON.stringify(analysis([finding])), 0, "findings"],
      ["invalid JSON", 1, "incomplete"],
    ]) {
      await writeFile(join(directory, "findings.json"), content);
      const result = spawnSync(process.execPath, [new URL("./warden-report.mjs", import.meta.url).pathname], {
        encoding: "utf8", env: {
          GITHUB_REPOSITORY: metadata.repository, PR_NUMBER: String(metadata.pr), HEAD_SHA: metadata.head,
          BASE_SHA: metadata.base, GITHUB_RUN_ID: metadata.runId, GITHUB_RUN_ATTEMPT: "2",
          ANALYSIS_OUTCOME: "success", FINDINGS_FILE: join(directory, "findings.json"),
          REPORT_PATH: join(directory, "report.json"), GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
        },
      });
      assert.equal(result.status, exitCode, result.stderr);
      const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
      assert.equal(report.verdict, verdict);
      assert.doesNotMatch(JSON.stringify(report), /private-/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
