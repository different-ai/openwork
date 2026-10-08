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

// Security findings from this run's analysis, even when the review stopped
// early (for example, files skipped over the size limits). Null when the
// analysis isn't this run's, or its findings are malformed.
function securityFindingsOf(report, raw) {
  if (report.incomplete_reasons.includes("missing-or-invalid-analysis")) return null;
  const findings = raw?.skills?.find?.((skill) => skill?.name === "diff-security-review")?.findings;
  const valid = Array.isArray(findings) && findings.every((finding) =>
    finding && SEVERITIES.includes(finding.severity) && typeof finding.title === "string" && typeof finding.description === "string");
  return valid ? findings : null;
}

// Files Warden left out because of a size limit, across both skills. Ignored
// paths (lockfiles, generated files) are skipped on purpose and not counted.
export function limitSkips(raw) {
  const byFile = new Map();
  for (const skill of Array.isArray(raw?.skills) ? raw.skills : []) {
    for (const file of Array.isArray(skill?.skippedFiles) ? skill.skippedFiles : []) {
      if (typeof file?.filename === "string" && typeof file.reason === "string" && file.reason.startsWith("limit:")) {
        byFile.set(file.filename, file.reason);
      }
    }
  }
  const reasons = {};
  for (const reason of byFile.values()) reasons[reason] = (reasons[reason] ?? 0) + 1;
  return { count: byFile.size, reasons };
}

// Display data only. No GitHub writes; warden-clearance.mjs decides approval
// from this receipt and comments on the PR with the security findings file.
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
  // Warden lists files it left out over the size limits but doesn't fail the
  // review for them. A PR with unreviewed files is never complete.
  if (identityMatches && limitSkips(raw).count) reasons.push("files-over-size-limits");

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
    "", "Warden Clearance approves when this review is complete with no high or medium security findings and no confidentiality findings.", "",
    "<details><summary>Review details and timing</summary>", "",
    "| Review | Result | Findings | Duration |", "| --- | --- | --- | --- |",
    ...report.skills.map((skill) => `| ${skill.name} | ${skill.status} | ${skill.findings_count ?? "unknown"} | ${duration(skill.duration_ms)} |`),
    "", "Durations per skill may overlap. Time through summary excludes queueing and artifact upload.",
  ];
  if (report.incomplete_reasons.length) lines.push("", `Needs recheck: ${report.incomplete_reasons.join(", ")}.`);
  // Never repeat confidentiality text or paths in a public summary or artifact.
  const privacy = report.skills.find((skill) => skill.name === "confidentiality-review");
  if (privacy.findings_count) lines.push("", "Confidentiality finding(s): review the added diff for outside identities; details are omitted here.");
  const skipped = limitSkips(raw);
  if (skipped.count) {
    lines.push("", `Skipped ${skipped.count} file(s) over Warden's size limits (${Object.entries(skipped.reasons).map(([reason, n]) => `${reason} ${n}`).join(", ")}). Split the PR to review them.`);
  }
  const security = report.skills.find((skill) => skill.name === "diff-security-review");
  const findings = securityFindingsOf(report, raw);
  if (findings) {
    if ((security.status !== "complete" || skipped.count) && findings.length) lines.push("", "Findings from the part of the PR that was reviewed (the review is incomplete):");
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

// Security findings for the Warden Clearance PR comment, bound to this run.
// Confidentiality findings are never included: their text may name the very
// outside identity the rule protects. Written even when the review stopped
// early, marked `complete: false`, so authors see what was found; clearance
// still never approves an incomplete review. Null when the analysis isn't
// this run's.
export function securityFindings(report, raw) {
  const security = report.skills.find((skill) => skill.name === "diff-security-review");
  const findings = securityFindingsOf(report, raw);
  if (!findings) return null;
  return {
    // Complete only if the security skill finished and no file was skipped.
    complete: security.status === "complete" && !report.incomplete_reasons.includes("files-over-size-limits"),
    skipped: limitSkips(raw),
    schema_version: 1,
    repository: report.repository,
    pr: report.pr,
    head_sha: report.head_sha,
    run_id: report.run_id,
    run_attempt: report.run_attempt,
    total: findings.length,
    findings: findings.slice(0, 20).map((finding) => ({
      severity: finding.severity,
      title: finding.title.slice(0, 300),
      description: finding.description.slice(0, 2000),
      path: typeof finding.location?.path === "string" ? finding.location.path.slice(0, 240) : null,
      line: Number.isSafeInteger(finding.location?.startLine) && finding.location.startLine > 0
        ? finding.location.startLine : null,
    })),
  };
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
  const findings = env.FINDINGS_REPORT_PATH ? securityFindings(report, raw) : null;
  if (findings) await writeFile(env.FINDINGS_REPORT_PATH, `${JSON.stringify(findings, null, 2)}\n`);
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
