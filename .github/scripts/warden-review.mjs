#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const KNOWN_SKILLS = [
  "diff-security-review",
  "confidentiality-review",
  "spec-provenance-review",
  "desktop-den-sync-review",
];
const MANDATORY_SKILLS = KNOWN_SKILLS.slice(0, 2);
const SECURITY_SKILLS = new Set(MANDATORY_SKILLS);
const SEVERITIES = new Set(["high", "medium", "low"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const SUMMARY_MARKER = "<!-- openwork:warden-review-summary:v1 -->";
const STATE_START = "<!-- openwork:warden-review-state:v1\n";
const STATE_END = "\n-->";
const MAX_ITEMS = 20;
const MAX_OBSERVATIONS = 20;
const MAX_THREAD_SNAPSHOT = 500;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function validSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function validateLocation(location, label) {
  assert(isObject(location), `${label} must be an object`);
  assert(typeof location.path === "string", `${label}.path must be a string`);
  assert(isInteger(location.startLine, 1), `${label}.startLine must be positive`);
  assert(location.endLine === undefined || isInteger(location.endLine, 1), `${label}.endLine is invalid`);
}

function validateFinding(finding, label) {
  assert(isObject(finding), `${label} must be an object`);
  assert(typeof finding.id === "string" && finding.id.length > 0, `${label}.id must be a string`);
  assert(typeof finding.severity === "string", `${label}.severity must be a string`);
  assert(
    finding.confidence === undefined || typeof finding.confidence === "string",
    `${label}.confidence must be a string`,
  );
  assert(typeof finding.title === "string", `${label}.title must be a string`);
  assert(typeof finding.description === "string", `${label}.description must be a string`);
  if (finding.location !== undefined) validateLocation(finding.location, `${label}.location`);
  if (finding.additionalLocations !== undefined) {
    assert(Array.isArray(finding.additionalLocations), `${label}.additionalLocations must be an array`);
    finding.additionalLocations.forEach((location, index) =>
      validateLocation(location, `${label}.additionalLocations[${index}]`),
    );
  }
  if (finding.sourceSnippet !== undefined) {
    const snippet = finding.sourceSnippet;
    assert(isObject(snippet) && typeof snippet.path === "string" && Array.isArray(snippet.lines),
      `${label}.sourceSnippet is invalid`);
    for (const key of ["startLine", "endLine", "targetStartLine", "targetEndLine"]) {
      assert(isInteger(snippet[key], 1), `${label}.sourceSnippet.${key} is invalid`);
    }
    snippet.lines.forEach((line, index) => assert(isObject(line) && isInteger(line.line, 1) &&
      typeof line.content === "string" && (line.highlighted === undefined || typeof line.highlighted === "boolean"),
    `${label}.sourceSnippet.lines[${index}] is invalid`));
  }
}

function validateRaw(raw) {
  assert(isObject(raw), "findings document must be an object");
  assert(raw.version === "1", "unsupported findings version");
  assert(validDate(raw.timestamp), "findings timestamp is invalid");
  assert(isObject(raw.repository), "repository is missing");
  for (const key of ["owner", "name", "fullName"]) {
    assert(typeof raw.repository[key] === "string", `repository.${key} must be a string`);
  }
  assert(raw.event === "pull_request", "findings event must be pull_request");
  assert(isObject(raw.pullRequest), "pullRequest is missing");
  assert(isInteger(raw.pullRequest.number, 1), "pullRequest.number is invalid");
  for (const key of ["author", "title", "baseBranch", "headBranch", "headSha"]) {
    assert(typeof raw.pullRequest[key] === "string", `pullRequest.${key} must be a string`);
  }
  assert(typeof raw.runId === "string" && /^\d+$/.test(raw.runId), "runId is invalid");
  assert(isObject(raw.summary), "summary is missing");
  assert(isInteger(raw.summary.totalFindings), "summary.totalFindings is invalid");
  assert(isInteger(raw.summary.totalSkills), "summary.totalSkills is invalid");
  assert(isObject(raw.summary.findingsBySeverity), "summary.findingsBySeverity is missing");
  for (const severity of SEVERITIES) {
    assert(isInteger(raw.summary.findingsBySeverity[severity]), `summary ${severity} count is invalid`);
  }
  assert(Array.isArray(raw.skills), "skills must be an array");
  raw.skills.forEach((skill, skillIndex) => {
    assert(isObject(skill), `skills[${skillIndex}] must be an object`);
    assert(typeof skill.name === "string", `skills[${skillIndex}].name must be a string`);
    assert(typeof skill.summary === "string", `skills[${skillIndex}].summary must be a string`);
    assert(Array.isArray(skill.findings), `skills[${skillIndex}].findings must be an array`);
    assert(skill.durationMs === undefined || Number.isFinite(skill.durationMs) && skill.durationMs >= 0,
      `skills[${skillIndex}].durationMs is invalid`);
    for (const field of ["failedHunks", "failedExtractions"]) {
      assert(skill[field] === undefined || isInteger(skill[field]), `skills[${skillIndex}].${field} is invalid`);
    }
    if (skill.error !== undefined) {
      assert(isObject(skill.error) && typeof skill.error.code === "string" &&
        typeof skill.error.message === "string" &&
        (skill.error.timestamp === undefined || validDate(skill.error.timestamp)),
      `skills[${skillIndex}].error is invalid`);
    }
    skill.findings.forEach((finding, findingIndex) =>
      validateFinding(finding, `skills[${skillIndex}].findings[${findingIndex}]`),
    );
  });
  assert(raw.triggerResults === undefined || Array.isArray(raw.triggerResults), "triggerResults must be an array");
  for (const [index, result] of (raw.triggerResults ?? []).entries()) {
    assert(isObject(result), `triggerResults[${index}] must be an object`);
    assert(result.triggerId === undefined || typeof result.triggerId === "string",
      `triggerResults[${index}].triggerId is invalid`);
    assert(typeof result.triggerName === "string", `triggerResults[${index}].triggerName is invalid`);
    assert(typeof result.skillName === "string", `triggerResults[${index}].skillName is invalid`);
    assert(result.status === "success" || result.status === "error", `triggerResults[${index}].status is invalid`);
    if (result.status === "success") {
      assert(isObject(result.report), `triggerResults[${index}].report is missing`);
      assert(typeof result.report.skill === "string", `triggerResults[${index}].report.skill is invalid`);
      assert(typeof result.report.summary === "string", `triggerResults[${index}].report.summary is invalid`);
      assert(Array.isArray(result.report.findings), `triggerResults[${index}].report.findings is invalid`);
      assert(result.report.durationMs === undefined ||
        Number.isFinite(result.report.durationMs) && result.report.durationMs >= 0,
      `triggerResults[${index}].report.durationMs is invalid`);
      result.report.findings.forEach((finding, findingIndex) =>
        validateFinding(finding, `triggerResults[${index}].report.findings[${findingIndex}]`),
      );
    } else {
      assert(isObject(result.error) && typeof result.error.message === "string",
        `triggerResults[${index}].error is invalid`);
    }
  }
  assert(Array.isArray(raw.findingObservations), "findingObservations must be an array");
  raw.findingObservations.forEach((observation, index) => {
    const label = `findingObservations[${index}]`;
    assert(isObject(observation) && ["posted", "deduped", "skipped", "resolved", "failed"]
      .includes(observation.outcome), `${label}.outcome is invalid`);
    validateFinding(observation.finding, `${label}.finding`);
    assert(observation.skill === undefined || typeof observation.skill === "string", `${label}.skill is invalid`);
    if (observation.outcome === "deduped") {
      assert(isObject(observation.dedupe) && ["warden", "external"].includes(observation.dedupe.source) &&
        ["hash", "semantic"].includes(observation.dedupe.matchType), `${label}.dedupe is invalid`);
    }
    if (observation.outcome === "skipped") {
      assert(["max_findings", "duplicate_in_batch", "no_inline_location"].includes(observation.skippedReason),
        `${label}.skippedReason is invalid`);
    }
    if (observation.outcome === "resolved") {
      assert(["fix_evaluation", "stale_check"].includes(observation.resolvedReason),
        `${label}.resolvedReason is invalid`);
    }
  });
}

function safeFindingId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

function safeLocation(finding, skill) {
  if (skill === "confidentiality-review" || !finding.location) return undefined;
  const { path, startLine } = finding.location;
  if (
    path.length > 240 || path.startsWith("/") || path.split("/").includes("..") ||
    !/^[A-Za-z0-9._/@+ -]+$/.test(path)
  ) return undefined;
  return { file: path, line: startLine };
}

function disposition(skill, severity) {
  if (SECURITY_SKILLS.has(skill)) return "blocker";
  if (skill === "desktop-den-sync-review") {
    return severity === "medium" || severity === "low" ? "advisory" : "blocker";
  }
  return skill === "spec-provenance-review" ? "advisory" : "needs-recheck";
}

function signature(finding) {
  return JSON.stringify({
    severity: finding.severity,
    confidence: finding.confidence ?? null,
    title: finding.title,
    description: finding.description,
    location: finding.location ?? null,
    additionalLocations: finding.additionalLocations ?? [],
    sourceSnippet: finding.sourceSnippet ?? null,
  });
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function consolidateFindings(skills, reasons) {
  const consolidated = [];
  const byId = new Map();
  const rank = { advisory: 0, "needs-recheck": 1, blocker: 2 };
  for (const skillReport of skills) {
    const knownSkill = KNOWN_SKILLS.includes(skillReport.name) ? skillReport.name : "unknown";
    for (const finding of skillReport.findings) {
      if (!SEVERITIES.has(finding.severity)) addReason(reasons, "unknown-severity");
      if (finding.confidence !== undefined && !CONFIDENCES.has(finding.confidence)) {
        addReason(reasons, "unknown-confidence");
      }
      if (!safeFindingId(finding.id)) {
        addReason(reasons, "unsafe-finding-id");
        continue;
      }
      const item = {
        id: finding.id,
        severity: SEVERITIES.has(finding.severity) ? finding.severity : "unknown",
        skills: [knownSkill],
        disposition: disposition(knownSkill, finding.severity),
        ...(safeLocation(finding, knownSkill) && { location: safeLocation(finding, knownSkill) }),
      };
      const previous = byId.get(finding.id);
      const findingSignature = signature(finding);
      if (previous && previous.signature === findingSignature) {
        if (!previous.item.skills.includes(knownSkill)) previous.item.skills.push(knownSkill);
        if (rank[item.disposition] > rank[previous.item.disposition]) previous.item.disposition = item.disposition;
        if (knownSkill === "confidentiality-review") delete previous.item.location;
        continue;
      }
      if (previous) addReason(reasons, "stable-id-conflict");
      consolidated.push(item);
      if (!previous) byId.set(finding.id, { signature: findingSignature, item });
    }
  }
  for (const item of consolidated) item.skills.sort();
  return consolidated;
}

function exportedFinding(finding) {
  return {
    id: finding.id,
    severity: finding.severity,
    ...(finding.confidence !== undefined && { confidence: finding.confidence }),
    title: finding.title,
    description: finding.description,
    ...(finding.location !== undefined && { location: finding.location }),
    ...(finding.additionalLocations !== undefined && { additionalLocations: finding.additionalLocations }),
    ...(finding.sourceSnippet !== undefined && { sourceSnippet: finding.sourceSnippet }),
  };
}

function replayReportSignature(skillName, report) {
  return JSON.stringify({
    skill: skillName,
    summary: report.summary,
    findings: report.findings.map(exportedFinding),
    ...(report.durationMs !== undefined && { durationMs: report.durationMs }),
  });
}

export function prepareReceipt(raw, metadata) {
  validateRaw(raw);
  const [owner, name, extra] = metadata.repository.split("/");
  assert(owner && name && !extra && /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(name),
    "repository must be owner/name");
  assert(isInteger(metadata.pr, 1), "pr must be a positive integer");
  assert(validSha(metadata.head), "head must be a 40-character SHA");
  assert(validSha(metadata.base), "base must be a 40-character SHA");
  assert(/^\d+$/.test(metadata.runId), "run-id must contain digits only");
  assert(isInteger(metadata.attempt, 1), "attempt must be a positive integer");
  assert(raw.repository.owner === owner && raw.repository.name === name && raw.repository.fullName === metadata.repository,
    "findings repository does not match trusted metadata");
  assert(raw.pullRequest.number === metadata.pr, "findings PR does not match trusted metadata");
  assert(raw.pullRequest.headSha === metadata.head, "findings head does not match trusted metadata");
  assert(raw.runId === metadata.runId, "findings runId does not match trusted metadata");

  const reasons = [];
  const skillNames = raw.skills.map((skill) => skill.name);
  for (const mandatory of MANDATORY_SKILLS) {
    if (!skillNames.includes(mandatory)) addReason(reasons, `missing-mandatory-skill:${mandatory}`);
  }
  if (skillNames.some((skill) => !KNOWN_SKILLS.includes(skill))) addReason(reasons, "unknown-skill");
  for (const skill of raw.skills) {
    const safeName = KNOWN_SKILLS.includes(skill.name) ? skill.name : "unknown";
    if ((skill.failedHunks ?? 0) > 0) addReason(reasons, `partial-failed-hunks:${safeName}`);
    if ((skill.failedExtractions ?? 0) > 0) addReason(reasons, `partial-failed-extractions:${safeName}`);
    if (skill.error !== undefined) addReason(reasons, `skill-error:${safeName}`);
  }
  const unmatchedReports = new Set(raw.skills.map((_, index) => index));
  const triggerSuccesses = new Set();
  const replayKeys = new Set();
  if (!raw.triggerResults || raw.triggerResults.length === 0) addReason(reasons, "missing-trigger-results");
  for (const result of raw.triggerResults ?? []) {
    const safeName = KNOWN_SKILLS.includes(result.skillName) ? result.skillName : "unknown";
    const replayKey = result.triggerId ?? `${result.triggerName}\0${result.skillName}`;
    if (replayKeys.has(replayKey)) addReason(reasons, "duplicate-trigger-result");
    replayKeys.add(replayKey);
    if (safeName === "unknown") addReason(reasons, "unknown-trigger-skill");
    if (result.status === "error") addReason(reasons, `trigger-error:${safeName}`);
    else {
      const reportNameMatches = result.report.skill === result.skillName;
      if (!reportNameMatches) addReason(reasons, `trigger-report-skill-mismatch:${safeName}`);
      const expectedSignature = replayReportSignature(result.report.skill, result.report);
      const reportIndex = [...unmatchedReports].find((index) => {
        const report = raw.skills[index];
        return replayReportSignature(report.name, report) === expectedSignature;
      });
      if (reportIndex === undefined) {
        addReason(reasons, `trigger-report-mismatch:${safeName}`);
      } else {
        unmatchedReports.delete(reportIndex);
        if (reportNameMatches && safeName !== "unknown") triggerSuccesses.add(result.skillName);
      }
      if (result.report.findings.some((finding) => !SEVERITIES.has(finding.severity))) {
        addReason(reasons, "unknown-severity");
      }
      if (result.report.findings.some((finding) =>
        finding.confidence !== undefined && !CONFIDENCES.has(finding.confidence))) {
        addReason(reasons, "unknown-confidence");
      }
    }
  }
  for (const reportIndex of unmatchedReports) {
    const reportName = raw.skills[reportIndex].name;
    addReason(reasons, `trigger-report-mismatch:${KNOWN_SKILLS.includes(reportName) ? reportName : "unknown"}`);
  }
  for (const mandatory of MANDATORY_SKILLS) {
    if (!triggerSuccesses.has(mandatory)) addReason(reasons, `missing-mandatory-trigger:${mandatory}`);
  }

  const allFindings = raw.skills.flatMap((skill) => skill.findings);
  const severityCounts = Object.fromEntries([...SEVERITIES].map((severity) => [
    severity,
    allFindings.filter((finding) => finding.severity === severity).length,
  ]));
  if (
    raw.summary.totalFindings !== allFindings.length || raw.summary.totalSkills !== raw.skills.length ||
    [...SEVERITIES].some((severity) => raw.summary.findingsBySeverity[severity] !== severityCounts[severity])
  ) addReason(reasons, "summary-count-mismatch");

  const findings = consolidateFindings(raw.skills, reasons);
  const securityCount = raw.skills
    .filter((skill) => SECURITY_SKILLS.has(skill.name))
    .reduce((count, skill) => count + skill.findings.length, 0);
  const syncFindings = raw.skills
    .filter((skill) => skill.name === "desktop-den-sync-review")
    .flatMap((skill) => skill.findings);
  const syncAdvisoryCount = syncFindings.filter((finding) =>
    finding.severity === "medium" || finding.severity === "low").length;
  const syncBlockingCount = syncFindings.length - syncAdvisoryCount;
  const blockingCount = securityCount + syncBlockingCount;
  const reviewComplete = reasons.length === 0;
  const verdict = reviewComplete ? (blockingCount === 0 ? "clear" : "blocked") : "incomplete";
  const coverage = [...new Set(skillNames.map((skillName) =>
    KNOWN_SKILLS.includes(skillName) ? skillName : "unknown"))].map((skillName) => {
    const reports = raw.skills.filter((skill) =>
      (KNOWN_SKILLS.includes(skill.name) ? skill.name : "unknown") === skillName);
    const durationMs = reports.length === 1 && Number.isFinite(reports[0].durationMs)
      ? reports[0].durationMs
      : undefined;
    return {
      name: skillName,
      status: "reported",
      ...(Number.isFinite(durationMs) && { durationMs }),
    };
  });

  return {
    schema_version: "1",
    producer: {
      repository: metadata.repository,
      pr: metadata.pr,
      headSha: metadata.head,
      baseSha: metadata.base,
      runId: metadata.runId,
      attempt: metadata.attempt,
    },
    analysisAt: raw.timestamp,
    head_sha: metadata.head,
    findings_count: allFindings.length,
    high_count: severityCounts.high,
    blocking_count: blockingCount,
    security_count: securityCount,
    sync_blocking_count: syncBlockingCount,
    sync_advisory_count: syncAdvisoryCount,
    review_complete: reviewComplete,
    verdict,
    coverage: { label: "reported-trigger-coverage", skills: coverage },
    findings,
    needs_recheck: reasons,
  };
}

export function validateReceipt(receipt) {
  assert(isObject(receipt) && receipt.schema_version === "1", "receipt version is invalid");
  assert(isObject(receipt.producer), "receipt producer is missing");
  const producer = receipt.producer;
  assert(typeof producer.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(producer.repository),
    "receipt repository is invalid");
  assert(isInteger(producer.pr, 1) && validSha(producer.headSha) && validSha(producer.baseSha),
    "receipt pull request identity is invalid");
  assert(typeof producer.runId === "string" && /^\d+$/.test(producer.runId) && isInteger(producer.attempt, 1),
    "receipt run identity is invalid");
  assert(validDate(receipt.analysisAt) && receipt.head_sha === producer.headSha, "receipt analysis identity is invalid");
  for (const key of ["findings_count", "high_count", "blocking_count", "security_count", "sync_blocking_count", "sync_advisory_count"]) {
    assert(isInteger(receipt[key]), `receipt ${key} is invalid`);
  }
  assert(receipt.blocking_count === receipt.security_count + receipt.sync_blocking_count,
    "receipt blocking counts are inconsistent");
  assert(typeof receipt.review_complete === "boolean", "receipt review_complete is invalid");
  assert(["clear", "blocked", "incomplete"].includes(receipt.verdict), "receipt verdict is invalid");
  const expectedVerdict = receipt.review_complete ? (receipt.blocking_count === 0 ? "clear" : "blocked") : "incomplete";
  assert(receipt.verdict === expectedVerdict, "receipt verdict is inconsistent");
  assert(isObject(receipt.coverage) && receipt.coverage.label === "reported-trigger-coverage" &&
    Array.isArray(receipt.coverage.skills), "receipt coverage is invalid");
  assert(Array.isArray(receipt.findings) && Array.isArray(receipt.needs_recheck), "receipt findings are invalid");
  for (const skill of receipt.coverage.skills) {
    assert(isObject(skill) && [...KNOWN_SKILLS, "unknown"].includes(skill.name) && skill.status === "reported",
      "receipt coverage skill is invalid");
    assert(skill.durationMs === undefined || Number.isFinite(skill.durationMs) && skill.durationMs >= 0,
      "receipt coverage duration is invalid");
  }
  for (const finding of receipt.findings) {
    assert(isObject(finding) && safeFindingId(finding.id), "receipt finding id is invalid");
    assert([...SEVERITIES, "unknown"].includes(finding.severity), "receipt finding severity is invalid");
    assert(Array.isArray(finding.skills) && finding.skills.length > 0 &&
      new Set(finding.skills).size === finding.skills.length &&
      finding.skills.every((skill) => [...KNOWN_SKILLS, "unknown"].includes(skill)),
      "receipt finding skills are invalid");
    assert(["blocker", "advisory", "needs-recheck"].includes(finding.disposition),
      "receipt finding disposition is invalid");
    if (finding.location !== undefined) {
      assert(isObject(finding.location) && typeof finding.location.file === "string" &&
        isInteger(finding.location.line, 1) && safeLocation({ location: {
        path: finding.location.file,
        startLine: finding.location.line,
      } }, finding.skills.includes("confidentiality-review") ? "confidentiality-review" : "") !== undefined,
      "receipt finding location is invalid");
    }
    const rank = { advisory: 0, "needs-recheck": 1, blocker: 2 };
    const expectedDisposition = finding.skills.reduce((current, skill) => {
      const projected = disposition(skill, finding.severity);
      return rank[projected] > rank[current] ? projected : current;
    }, "advisory");
    assert(finding.disposition === expectedDisposition, "receipt finding disposition is inconsistent");
  }
  assert(receipt.needs_recheck.every((reason) => typeof reason === "string" &&
    /^(missing-trigger-results|missing-mandatory-(skill|trigger):(diff-security-review|confidentiality-review)|duplicate-trigger-result|unknown-(skill|trigger-skill|severity|confidence)|trigger-report-(skill-mismatch|mismatch):(diff-security-review|confidentiality-review|spec-provenance-review|desktop-den-sync-review|unknown)|partial-failed-(hunks|extractions):(diff-security-review|confidentiality-review|spec-provenance-review|desktop-den-sync-review|unknown)|skill-error:(diff-security-review|confidentiality-review|spec-provenance-review|desktop-den-sync-review|unknown)|trigger-error:(diff-security-review|confidentiality-review|spec-provenance-review|desktop-den-sync-review|unknown)|summary-count-mismatch|stable-id-conflict|unsafe-finding-id)$/.test(reason)),
    "receipt recheck reason is invalid");
  assert(new Set(receipt.needs_recheck).size === receipt.needs_recheck.length,
    "receipt recheck reasons must be unique");
  assert(receipt.review_complete === (receipt.needs_recheck.length === 0),
    "receipt completeness and recheck reasons are inconsistent");
  const coverageNames = receipt.coverage.skills.map((skill) => skill.name);
  assert(new Set(coverageNames).size === coverageNames.length, "receipt coverage skills must be unique");
  if (receipt.review_complete) {
    assert(MANDATORY_SKILLS.every((skill) => coverageNames.includes(skill)),
      "complete receipt is missing mandatory coverage");
    assert(!coverageNames.includes("unknown"), "complete receipt has unknown coverage");
    assert(receipt.findings.every((finding) => finding.severity !== "unknown" &&
      !finding.skills.includes("unknown") && finding.disposition !== "needs-recheck"),
    "complete receipt has an unknown policy projection");
    assert(receipt.findings_count === 0 || receipt.findings.length > 0,
      "complete receipt omitted reported findings");
  }
  const blockerFindings = receipt.findings.filter((finding) => finding.disposition === "blocker").length;
  const securityFindings = receipt.findings.filter((finding) =>
    finding.skills.some((skill) => SECURITY_SKILLS.has(skill))).length;
  const syncBlockingFindings = receipt.findings.filter((finding) =>
    finding.skills.includes("desktop-den-sync-review") &&
    disposition("desktop-den-sync-review", finding.severity) === "blocker").length;
  const syncAdvisoryFindings = receipt.findings.filter((finding) =>
    finding.skills.includes("desktop-den-sync-review") &&
    disposition("desktop-den-sync-review", finding.severity) === "advisory").length;
  const highFindings = receipt.findings.filter((finding) => finding.severity === "high").length;
  assert(receipt.findings_count >= receipt.findings.length && receipt.high_count >= highFindings,
    "receipt finding counts are inconsistent");
  assert(receipt.security_count >= securityFindings && receipt.sync_blocking_count >= syncBlockingFindings &&
    receipt.sync_advisory_count >= syncAdvisoryFindings && receipt.blocking_count >= blockerFindings,
  "receipt policy counts are inconsistent");
  assert(receipt.security_count <= receipt.findings_count &&
    receipt.sync_blocking_count + receipt.sync_advisory_count <= receipt.findings_count,
  "receipt policy counts exceed findings count");
  assert(blockerFindings === 0 || receipt.verdict !== "clear", "receipt with blockers cannot be clear");
  return receipt;
}

function apiUrl(base, path) {
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function githubRequest(fetchImpl, url, token, options = {}) {
  const { timeoutMs = 15_000, ...requestOptions } = options;
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "GitHub request timeout is invalid");
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(new Error("GitHub request timed out")), timeoutMs);
  const signal = requestOptions.signal
    ? AbortSignal.any([requestOptions.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await fetchImpl(url, {
      ...requestOptions,
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...requestOptions.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${requestOptions.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}`);
    }
    if (response.status === 204) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function allIssueComments(fetchImpl, apiBase, token, owner, name, pr) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(fetchImpl,
      apiUrl(apiBase, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pr}/comments?per_page=100&page=${page}`),
      token);
    assert(Array.isArray(batch), "GitHub issue comments response is invalid");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function wardenThreads(fetchImpl, graphqlUrl, token, owner, name, pr) {
  const threads = new Map();
  const cursors = new Set();
  let after = null;
  do {
    const payload = await githubRequest(fetchImpl, graphqlUrl, token, {
      method: "POST",
      body: JSON.stringify({
        query: `query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{body author{login __typename}}}}}}}}`,
        variables: { owner, name, pr, after },
      }),
    });
    assert(isObject(payload), "GitHub GraphQL response is invalid");
    assert(!payload.errors, "GitHub GraphQL returned errors");
    const connection = payload.data?.repository?.pullRequest?.reviewThreads;
    assert(connection && Array.isArray(connection.nodes), "GitHub review thread response is invalid");
    assert(isObject(connection.pageInfo) && typeof connection.pageInfo.hasNextPage === "boolean" &&
      (connection.pageInfo.endCursor === null || typeof connection.pageInfo.endCursor === "string"),
    "GitHub review thread pageInfo is invalid");
    for (const thread of connection.nodes) {
      const initial = thread.comments?.nodes?.[0];
      if (
        typeof thread.id === "string" && typeof thread.isResolved === "boolean" &&
        initial?.author?.login === "github-actions" && initial.author.__typename === "Bot" &&
        typeof initial.body === "string" && initial.body.includes("<!-- warden:finding:v1:")
      ) {
        assert(!/[<>\r\n]/.test(thread.id) && !thread.id.includes("--"), "GitHub review thread id is unsafe");
        threads.set(thread.id, thread.isResolved);
      }
    }
    if (connection.pageInfo.hasNextPage) {
      const next = connection.pageInfo.endCursor;
      assert(typeof next === "string" && next.length > 0 && next !== after && !cursors.has(next),
        "GitHub review thread cursor did not advance");
      cursors.add(next);
      after = next;
    } else {
      after = null;
    }
  } while (after !== null);
  return [...threads];
}

function parseState(body) {
  const start = body.indexOf(STATE_START);
  if (start === -1) return null;
  const contentStart = start + STATE_START.length;
  const end = body.indexOf(STATE_END, contentStart);
  if (end === -1) throw new Error("trusted Warden summary state is malformed");
  const state = JSON.parse(body.slice(contentStart, end));
  assert(isObject(state) && state.version === 1 && isObject(state.latest), "trusted Warden summary state is invalid");
  assert(Array.isArray(state.history) && Array.isArray(state.threads), "trusted Warden summary history is invalid");
  assert(/^\d+$/.test(state.latest.runId) && isInteger(state.latest.attempt, 1) &&
    isInteger(state.latest.runNumber, 1), "trusted Warden summary run identity is invalid");
  assert(state.history.length <= MAX_OBSERVATIONS && state.history.every((item) =>
    isObject(item) && /^\d+$/.test(item.runId) && isInteger(item.attempt, 1) &&
    isInteger(item.runNumber, 1) && validSha(item.headSha) && validDate(item.observedAt) &&
    ["firstObservedResolved", "firstObservedUnresolved", "resolvedTransitions", "unresolvedTransitions"]
      .every((key) => isInteger(item[key]))), "trusted Warden summary observation history is invalid");
  assert(state.threads.length <= MAX_THREAD_SNAPSHOT && state.threads.every((thread) =>
    Array.isArray(thread) && thread.length === 2 &&
    typeof thread[0] === "string" && !/[<>\r\n]/.test(thread[0]) && !thread[0].includes("--") &&
    typeof thread[1] === "boolean"),
  "trusted Warden summary thread snapshot is invalid");
  assert(isObject(state.metrics), "trusted Warden summary metrics are invalid");
  return state;
}

function compareRun(latest, run) {
  if (String(latest.runId) === String(run.id)) {
    if (latest.attempt === run.run_attempt) return "same";
    return run.run_attempt < latest.attempt ? "older" : "newer";
  }
  if (run.run_number !== latest.runNumber) return run.run_number < latest.runNumber ? "older" : "newer";
  return BigInt(run.id) < BigInt(latest.runId) ? "older" : "newer";
}

function metricsSnapshot(previous, threads, run, receipt) {
  const retainedThreads = [...threads]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_THREAD_SNAPSHOT);
  const previousThreads = new Map(previous?.threads ?? []);
  let firstObservedResolved = 0;
  let firstObservedUnresolved = 0;
  let resolvedTransitions = 0;
  let unresolvedTransitions = 0;
  for (const [id, resolved] of retainedThreads) {
    if (!previousThreads.has(id)) {
      if (resolved) firstObservedResolved += 1;
      else firstObservedUnresolved += 1;
    } else if (previousThreads.get(id) !== resolved) {
      if (resolved) resolvedTransitions += 1;
      else unresolvedTransitions += 1;
    }
  }
  const observation = {
    runId: String(run.id),
    attempt: run.run_attempt,
    runNumber: run.run_number,
    headSha: receipt.producer.headSha,
    observedAt: new Date().toISOString(),
    firstObservedResolved,
    firstObservedUnresolved,
    resolvedTransitions,
    unresolvedTransitions,
  };
  const unbounded = [...(previous?.history ?? []), observation];
  const history = unbounded.slice(-MAX_OBSERVATIONS);
  const truncated = Boolean(previous?.truncated) || unbounded.length > MAX_OBSERVATIONS;
  const metrics = {
    uniqueObservedRunAttempts: new Set(history.map((item) => `${item.runId}:${item.attempt}`)).size,
    distinctHeads: new Set(history.map((item) => item.headSha).filter(Boolean)).size,
    currentUnresolvedThreads: threads.filter(([, resolved]) => !resolved).length,
    currentObservedThreads: threads.length,
    observedTransitions: {
      resolved: history.reduce((sum, item) => sum + item.resolvedTransitions, 0),
      unresolved: history.reduce((sum, item) => sum + item.unresolvedTransitions, 0),
    },
    firstObserved: {
      resolved: history.reduce((sum, item) => sum + item.firstObservedResolved, 0),
      unresolved: history.reduce((sum, item) => sum + item.firstObservedUnresolved, 0),
    },
    precision: null,
    collectionWindow: { retainedRunAttempts: history.length, limit: MAX_OBSERVATIONS, truncated },
    threadSnapshot: {
      retained: retainedThreads.length,
      observed: threads.length,
      limit: MAX_THREAD_SNAPSHOT,
      truncated: threads.length > retainedThreads.length,
    },
  };
  return {
    state: {
      version: 1,
      latest: { runId: String(run.id), attempt: run.run_attempt, runNumber: run.run_number },
      history,
      threads: retainedThreads,
      truncated,
      metrics,
    },
    metrics,
  };
}

function html(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function findingLines(receipt, disposition) {
  const findings = receipt.findings.filter((finding) => finding.disposition === disposition);
  const shown = findings.slice(0, MAX_ITEMS).map((finding) => {
    const location = finding.location ? ` · <code>${html(finding.location.file)}:${finding.location.line}</code>` : "";
    return `- <code>${html(finding.id)}</code> · ${html(finding.severity)} · ${finding.skills.map(html).join(", ")}${location}`;
  });
  if (findings.length > shown.length) shown.push(`- ${findings.length - shown.length} more consolidated finding(s) not displayed.`);
  return shown.length > 0 ? shown.join("\n") : "- None.";
}

export function renderComment(receipt, metrics, state, runUrl) {
  const verdict = receipt.verdict[0].toUpperCase() + receipt.verdict.slice(1);
  const findingCount = receipt.review_complete
    ? `Native findings: **${receipt.findings_count}**.`
    : `Native finding records present: **${receipt.findings_count}**; total findings are unknown because review was incomplete.`;
  const reasons = receipt.needs_recheck.slice(0, MAX_ITEMS).map((reason) => `- <code>${html(reason)}</code>`);
  if (receipt.needs_recheck.length > reasons.length) {
    reasons.push(`- ${receipt.needs_recheck.length - reasons.length} more recheck reason(s) not displayed.`);
  }
  const coverage = receipt.coverage.skills.map((skill) =>
    `${html(skill.name)}${skill.durationMs === undefined ? "" : ` (${skill.durationMs} ms)`}`).join(", ") || "none reported";
  return `${SUMMARY_MARKER}
## Warden review summary — ${verdict}

${findingCount} Blocking policy matches before consolidation: **${receipt.blocking_count}**. Full finding text remains in Warden's native checks and review threads. This comment retains only native IDs, severity, skill attribution, and safe locations. [Analysis run](${runUrl})

Reported trigger coverage (not proof of complete repository or context coverage): ${coverage}.

### Blockers
${findingLines(receipt, "blocker")}

### Advisories
${findingLines(receipt, "advisory")}

### Needs recheck
${reasons.length > 0 ? reasons.join("\n") : findingLines(receipt, "needs-recheck")}

### Observed review-thread metrics
- Unique observed run attempts in retained window: **${metrics.uniqueObservedRunAttempts}**
- Distinct heads in retained window: **${metrics.distinctHeads}**
- Current unresolved Warden threads: **${metrics.currentUnresolvedThreads}** of **${metrics.currentObservedThreads}** observed
- Observed resolved/unresolved transitions in retained snapshots: **${metrics.observedTransitions.resolved} / ${metrics.observedTransitions.unresolved}**
- First observed resolved/unresolved (state at first collection, not event time): **${metrics.firstObserved.resolved} / ${metrics.firstObserved.unresolved}**
- Precision: **unavailable** (no adjudications; no TP/FP values are inferred)
- Observation window: **${metrics.collectionWindow.retainedRunAttempts}/${metrics.collectionWindow.limit}** run attempts retained; truncated: **${metrics.collectionWindow.truncated}**
- Transition snapshot: **${metrics.threadSnapshot.retained}/${metrics.threadSnapshot.observed}** current attributed threads retained (limit ${metrics.threadSnapshot.limit}); truncated: **${metrics.threadSnapshot.truncated}**

Thread states are read-only collection snapshots. These metrics are neither lifetime totals nor exact resolution times, and this summary is not clearance authority.

${STATE_START}${JSON.stringify(state)}${STATE_END}`;
}

export async function publishReceipt(receiptInput, options = {}) {
  const receipt = validateReceipt(receiptInput);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = env.GITHUB_TOKEN;
  assert(token, "GITHUB_TOKEN is required");
  const apiBase = env.GITHUB_API_URL || "https://api.github.com";
  const graphqlUrl = env.GITHUB_GRAPHQL_URL || "https://api.github.com/graphql";
  const serverUrl = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
  const [owner, name] = receipt.producer.repository.split("/");
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const expected = options.expectedProducer ?? {
    repository: env.WARDEN_EXPECTED_REPOSITORY,
    runId: env.WARDEN_EXPECTED_RUN_ID,
    attempt: env.WARDEN_EXPECTED_RUN_ATTEMPT === undefined
      ? undefined
      : Number(env.WARDEN_EXPECTED_RUN_ATTEMPT),
    headSha: env.WARDEN_EXPECTED_HEAD_SHA,
  };
  const expectedValues = [expected.repository, expected.runId, expected.attempt, expected.headSha];
  if (expectedValues.some((value) => value !== undefined)) {
    assert(expectedValues.every((value) => value !== undefined), "trusted producer metadata is incomplete");
    assert(expected.repository === receipt.producer.repository && expected.runId === receipt.producer.runId &&
      expected.attempt === receipt.producer.attempt && expected.headSha === receipt.producer.headSha,
    "receipt producer does not match trusted workflow metadata");
  }

  const currentPullRequest = (pr) => {
    assert(isObject(pr) && isInteger(pr.number, 1) && typeof pr.state === "string" &&
      typeof pr.merged === "boolean" && (pr.merged_at === null || typeof pr.merged_at === "string") &&
      isObject(pr.head) && validSha(pr.head.sha) && typeof pr.head.ref === "string" &&
      isObject(pr.head.repo) && typeof pr.head.repo.full_name === "string" &&
      isObject(pr.base) && validSha(pr.base.sha) && typeof pr.base.ref === "string" &&
      isObject(pr.base.repo) && typeof pr.base.repo.full_name === "string",
    "GitHub pull request response is invalid");
    return pr.number === receipt.producer.pr && pr.state === "open" && !pr.merged && pr.merged_at === null &&
      pr.head.sha === receipt.producer.headSha && pr.base.sha === receipt.producer.baseSha &&
      pr.head.repo.full_name === receipt.producer.repository &&
      pr.base.repo.full_name === receipt.producer.repository;
  };
  const responsePath = (value) => {
    if (typeof value !== "string") return null;
    try {
      return new URL(value).pathname;
    } catch {
      return null;
    }
  };
  const repositoryMatches = (repository) => isObject(repository) &&
    (repository.full_name === receipt.producer.repository || responsePath(repository.url) === root);

  const pr = await githubRequest(fetchImpl, apiUrl(apiBase, `${root}/pulls/${receipt.producer.pr}`), token);
  if (!currentPullRequest(pr)) return { status: "stale", verdict: receipt.verdict, metrics: null };
  const run = await githubRequest(fetchImpl,
    apiUrl(apiBase, `${root}/actions/runs/${receipt.producer.runId}`), token);
  assert(isObject(run) && String(run.id) === receipt.producer.runId &&
    isInteger(run.run_attempt, 1) && run.run_attempt === receipt.producer.attempt,
    "producer run identity does not match receipt");
  assert(run.event === "pull_request" && run.head_sha === receipt.producer.headSha,
    "producer run is not for the receipt pull request head");
  assert(repositoryMatches(run.repository) && repositoryMatches(run.head_repository),
    "producer run repository does not match receipt");
  assert(run.status === "completed" && run.conclusion === "success", "producer run is not successfully completed");
  assert(typeof run.path === "string" && run.path.split("@")[0] === ".github/workflows/warden.yml",
    "producer run did not use the Warden workflow");
  assert(Array.isArray(run.pull_requests), "producer run pull request associations are invalid");
  if (run.pull_requests.length > 0) {
    assert(run.pull_requests.some((item) => isObject(item) && item.number === receipt.producer.pr &&
      responsePath(item.url) === `${root}/pulls/${receipt.producer.pr}` &&
      isObject(item.head) && item.head.sha === receipt.producer.headSha && repositoryMatches(item.head.repo) &&
      isObject(item.base) && item.base.sha === receipt.producer.baseSha && repositoryMatches(item.base.repo)),
    "producer run is not repository-qualified to the receipt pull request");
  } else {
    assert(typeof run.head_branch === "string" && run.head_branch === pr.head.ref,
      "producer run cannot be attributed to the receipt pull request");
  }
  assert(isInteger(run.run_number, 1), "producer run number is invalid");

  const comments = await allIssueComments(fetchImpl, apiBase, token, owner, name, receipt.producer.pr);
  const trusted = comments
    .filter((comment) => isInteger(comment.id, 1) &&
      comment.user?.login === "github-actions[bot]" && comment.user?.type === "Bot" &&
      typeof comment.body === "string" && comment.body.includes(SUMMARY_MARKER))
    .sort((left, right) => right.id - left.id)[0];
  const previous = trusted ? parseState(trusted.body) : null;
  if (trusted) assert(previous, "trusted Warden summary comment has no state snapshot");
  if (previous) {
    const order = compareRun(previous.latest, run);
    if (order === "older") {
      return { status: "stale", commentId: trusted.id, verdict: receipt.verdict, metrics: previous.metrics };
    }
    if (order === "same") {
      return { status: "published", commentId: trusted.id, verdict: receipt.verdict, metrics: previous.metrics };
    }
  }

  const threads = await wardenThreads(fetchImpl, graphqlUrl, token, owner, name, receipt.producer.pr);
  const { state, metrics } = metricsSnapshot(previous, threads, run, receipt);
  const runUrl = `${serverUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${receipt.producer.runId}`;
  const body = renderComment(receipt, metrics, state, runUrl);
  const latestPr = await githubRequest(fetchImpl,
    apiUrl(apiBase, `${root}/pulls/${receipt.producer.pr}`), token);
  if (!currentPullRequest(latestPr)) {
    return { status: "stale", ...(trusted && { commentId: trusted.id }), verdict: receipt.verdict, metrics: null };
  }
  let comment;
  if (trusted) {
    comment = await githubRequest(fetchImpl, apiUrl(apiBase, `${root}/issues/comments/${trusted.id}`), token, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  } else {
    comment = await githubRequest(fetchImpl, apiUrl(apiBase, `${root}/issues/${receipt.producer.pr}/comments`), token, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }
  assert(isInteger(comment?.id, 1), "GitHub comment write response is invalid");
  return { status: "published", commentId: comment.id, verdict: receipt.verdict, metrics };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert(key?.startsWith("--") && args[index + 1] !== undefined, `invalid argument ${key ?? ""}`);
    parsed[key.slice(2)] = args[index + 1];
  }
  return parsed;
}

function help() {
  return `Usage:
  node .github/scripts/warden-review.mjs prepare --findings <path> --repository <owner/repo> --pr <N> --head <SHA> --base <SHA> --run-id <digits> --attempt <N> --output <receipt.json>
  node .github/scripts/warden-review.mjs publish --receipt <receipt.json>`;
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    console.log(help());
    return;
  }
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "prepare") {
    for (const key of ["findings", "repository", "pr", "head", "base", "run-id", "attempt", "output"]) {
      assert(args[key] !== undefined, `--${key} is required`);
    }
    const raw = JSON.parse(await readFile(args.findings, "utf8"));
    const receipt = prepareReceipt(raw, {
      repository: args.repository,
      pr: Number(args.pr),
      head: args.head,
      base: args.base,
      runId: args["run-id"],
      attempt: Number(args.attempt),
    });
    await writeFile(args.output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(receipt));
    return;
  }
  if (command === "publish") {
    assert(args.receipt !== undefined, "--receipt is required");
    const receipt = JSON.parse(await readFile(args.receipt, "utf8"));
    console.log(JSON.stringify(await publishReceipt(receipt)));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`warden-review: ${error.message}`);
    process.exitCode = 1;
  });
}
