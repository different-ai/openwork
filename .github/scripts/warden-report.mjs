#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKILLS = ["diff-security-review", "confidentiality-review"];
const SEVERITIES = ["high", "medium", "low"];
const milliseconds = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const elapsed = (seconds, now) => Number.isFinite(seconds) && seconds > 0
  ? milliseconds(now - seconds * 1000) : null;
const html = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const duration = (value) => value === null ? "unavailable" : `${(value / 1000).toFixed(1)}s`;

// Display data only. No GitHub writes, merge decisions, or comment history.
export function buildReport(raw, metadata, now = Date.now()) {
  const identityMatches = raw?.version === "1" && raw.event === "pull_request" &&
    raw.repository?.fullName === metadata.repository && raw.pullRequest?.number === metadata.pr &&
    raw.pullRequest?.headSha === metadata.head && raw.runId === metadata.runId;
  const reports = identityMatches && Array.isArray(raw.skills) ? raw.skills : [];
  const triggers = identityMatches && Array.isArray(raw.triggerResults) ? raw.triggerResults : [];
  const reasons = [];
  if (!identityMatches) reasons.push("missing-or-invalid-analysis");
  if (metadata.outcome !== "success") reasons.push("analysis-did-not-succeed");
  if (reports.length !== SKILLS.length || reports.some((report) => !SKILLS.includes(report?.name)) ||
      triggers.length !== SKILLS.length) reasons.push("unexpected-skill-coverage");

  const skills = SKILLS.map((name) => {
    const matches = reports.filter((report) => report?.name === name);
    const results = triggers.filter((trigger) => trigger?.skillName === name);
    const report = matches[0];
    const trigger = results[0];
    const findings = report?.findings;
    const validFindings = Array.isArray(findings) && findings.every((finding) =>
      finding && typeof finding.id === "string" && SEVERITIES.includes(finding.severity) &&
      typeof finding.title === "string" && typeof finding.description === "string");
    const projectedFindings = (items) => items?.map?.((finding) => [finding?.id, finding?.severity]);
    const complete = matches.length === 1 && results.length === 1 && validFindings &&
      !report.error && (report.failedHunks ?? 0) === 0 && (report.failedExtractions ?? 0) === 0 &&
      trigger.status === "success" && trigger.report?.skill === name &&
      JSON.stringify(projectedFindings(trigger.report.findings)) === JSON.stringify(projectedFindings(findings));
    if (!complete) reasons.push(`incomplete:${name}`);
    return {
      name,
      status: complete ? "complete" : "incomplete",
      duration_ms: milliseconds(report?.durationMs),
      findings_count: validFindings ? findings.length : null,
      findings_by_severity: validFindings
        ? Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((f) => f.severity === severity).length]))
        : null,
    };
  });
  const findingsCount = skills.every((skill) => skill.findings_count !== null)
    ? skills.reduce((count, skill) => count + skill.findings_count, 0) : null;
  if (identityMatches && (raw.summary?.totalSkills !== reports.length || raw.summary?.totalFindings !== findingsCount ||
      SEVERITIES.some((severity) => raw.summary?.findingsBySeverity?.[severity] !==
        skills.reduce((count, skill) => count + (skill.findings_by_severity?.[severity] ?? 0), 0)))) {
    reasons.push("inconsistent-analysis-counts");
  }
  const complete = reasons.length === 0;
  return {
    schema_version: 2,
    repository: metadata.repository,
    pr: metadata.pr,
    head_sha: metadata.head,
    base_sha: metadata.base,
    run_id: metadata.runId,
    run_attempt: metadata.attempt,
    recorded_at: new Date(now).toISOString(),
    analysis_outcome: metadata.outcome,
    review_complete: complete,
    verdict: complete ? findingsCount === 0 ? "clear" : "findings" : "incomplete",
    findings_count: findingsCount,
    // Legacy readers cannot mistake a partial result for zero blockers.
    blocking_count: complete ? findingsCount : null,
    timing: {
      review_to_summary_ms: elapsed(metadata.started, now),
      analysis_ms: elapsed(metadata.analysisStarted, now),
    },
    skills,
    incomplete_reasons: reasons,
  };
}

export function renderSummary(report, raw) {
  const label = report.verdict === "clear" ? "no findings" : report.verdict === "findings"
    ? `${report.findings_count} finding(s)` : "incomplete";
  const lines = [
    `Warden security: **${label}** · ${duration(report.timing.analysis_ms)} analysis · ${duration(report.timing.review_to_summary_ms)} through summary.`,
    "", "Merge approval stays with the OpenWork admin team.", "",
    "<details><summary>Review details and timing</summary>", "",
    "| Review | Result | Findings | Duration |", "| --- | --- | --- | --- |",
    ...report.skills.map((skill) => `| ${skill.name} | ${skill.status} | ${skill.findings_count ?? "unknown"} | ${duration(skill.duration_ms)} |`),
    "", "Durations per skill may overlap. Time through summary excludes queueing and artifact upload.",
  ];
  if (report.incomplete_reasons.length) lines.push("", `Needs recheck: ${report.incomplete_reasons.join(", ")}.`);
  // Never repeat confidentiality text or paths in a public summary or artifact.
  const privacy = report.skills.find((skill) => skill.name === "confidentiality-review");
  if (privacy.findings_count) lines.push("", "Confidentiality finding(s): review the added diff for outside identities; details are omitted here.");
  const security = report.skills.find((skill) => skill.name === "diff-security-review");
  if (security.status === "complete") {
    const findings = raw.skills.find((skill) => skill.name === security.name).findings;
    for (const finding of findings.slice(0, 20)) {
      lines.push("", `<strong>${html(finding.severity)}: ${html(finding.title.slice(0, 300))}</strong>`,
        `<pre>${html(finding.description.slice(0, 4000))}</pre>`);
      if (typeof finding.location?.path === "string" && Number.isSafeInteger(finding.location.startLine) && finding.location.startLine > 0) {
        lines.push(`<code>${html(finding.location.path.slice(0, 240))}:${finding.location.startLine}</code>`);
      }
    }
    if (findings.length > 20) lines.push("", `${findings.length - 20} additional finding(s); run the security review locally for the full report.`);
  }
  lines.push("", "</details>", "");
  return lines.join("\n");
}

export async function main(env = process.env) {
  let raw = null;
  try { raw = JSON.parse(await readFile(env.FINDINGS_FILE, "utf8")); }
  catch { /* Missing, cancelled, and malformed analysis is incomplete, never clear. */ }
  const report = buildReport(raw, {
    repository: env.GITHUB_REPOSITORY,
    pr: Number(env.PR_NUMBER),
    head: env.HEAD_SHA,
    base: env.BASE_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    outcome: env.ANALYSIS_OUTCOME,
    started: Number(env.REVIEW_STARTED),
    analysisStarted: Number(env.ANALYSIS_STARTED),
  });
  await writeFile(env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  await appendFile(env.GITHUB_STEP_SUMMARY, renderSummary(report, raw));
  // Findings remain visible in the summary. Operational failure is explicit.
  if (!report.review_complete) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error("Warden report could not be written; review is incomplete.");
    process.exitCode = 1;
  });
}
