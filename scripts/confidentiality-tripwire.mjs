#!/usr/bin/env node
/**
 * Confidentiality tripwire.
 *
 * Scans every surface of a change that becomes public on GitHub — branch
 * name, PR title/body, commit messages, and added diff lines — for
 * confidential terms (customer/prospect/partner names) and for structural
 * leaks that need no term list (email addresses, Slack channels and links).
 *
 * The term list is NEVER stored in this repository: it is read from the
 * CONFIDENTIAL_TERMS environment variable (newline- or comma-separated), which
 * CI receives from a repository secret and the local pre-push hook receives
 * from Infisical. Findings are reported by term index and hash prefix only, so
 * a hit never repeats the confidential value in a log.
 *
 * Usage:
 *   node scripts/confidentiality-tripwire.mjs ci        # inside GitHub Actions
 *   node scripts/confidentiality-tripwire.mjs pre-push  # git pre-push hook (stdin)
 *   node scripts/confidentiality-tripwire.mjs range <base> <head> [--branch <name>]
 *
 * Exit codes: 0 clean, 1 findings, 2 misconfiguration.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MIN_TERM_LENGTH = 4;

const DEFAULT_ALLOWED_EMAIL_DOMAINS = [
  "openworklabs.com",
  "different.ai",
  "users.noreply.github.com",
  "noreply.github.com",
  "example.com",
  "example.org",
  "example.net",
  "example.invalid",
];

/** Lowercase, strip diacritics, drop every non-alphanumeric character. */
export function compact(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function decodeLoosely(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function parseTerms(raw) {
  if (!raw) return [];
  const seen = new Set();
  const terms = [];
  for (const entry of raw.split(/[\n,]/)) {
    const term = entry.trim();
    if (!term || term.startsWith("#")) continue;
    const key = compact(term);
    if (key.length < MIN_TERM_LENGTH || seen.has(key)) continue;
    seen.add(key);
    terms.push({ key, id: createHash("sha256").update(key).digest("hex").slice(0, 8) });
  }
  return terms;
}

function parseDomainList(raw) {
  return (raw ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const SLACK_CHANNEL_PATTERN = /(?:^|[\s(`"'])#(?:ext|shared|ext-[a-z0-9]+)-[a-z0-9][a-z0-9_-]*/gi;
const SLACK_LINK_PATTERN = /[a-z0-9-]+\.slack\.com\/(?:archives|client)\//gi;

function isAllowedEmailDomain(domain, allowedDomains) {
  const value = domain.toLowerCase();
  if (value.endsWith(".test") || value.endsWith(".invalid") || value.endsWith(".localhost")) return true;
  return allowedDomains.some((allowed) => value === allowed || value.endsWith(`.${allowed}`));
}

/**
 * Scan one surface. `lines` are scanned individually so a finding can point
 * at a line without echoing it.
 */
export function scanSurface(surface, lines, options) {
  const findings = [];
  const allowedDomains = options.allowedEmailDomains ?? DEFAULT_ALLOWED_EMAIL_DOMAINS;
  lines.forEach((line, index) => {
    const decoded = decodeLoosely(line);
    const haystack = compact(decoded);
    for (const term of options.terms) {
      if (haystack.includes(term.key)) {
        findings.push({ surface, line: index + 1, kind: "term", detail: `confidential term #${term.id}` });
      }
    }
    for (const match of decoded.matchAll(EMAIL_PATTERN)) {
      if (!isAllowedEmailDomain(match[1], allowedDomains)) {
        findings.push({ surface, line: index + 1, kind: "email", detail: "email address outside the allowed domains" });
      }
    }
    if (SLACK_CHANNEL_PATTERN.test(decoded)) {
      findings.push({ surface, line: index + 1, kind: "slack", detail: "shared/external Slack channel name" });
    }
    SLACK_CHANNEL_PATTERN.lastIndex = 0;
    if (SLACK_LINK_PATTERN.test(decoded)) {
      findings.push({ surface, line: index + 1, kind: "slack", detail: "Slack message link" });
    }
    SLACK_LINK_PATTERN.lastIndex = 0;
  });
  return findings;
}

/** Only added lines of a unified diff become public text worth scanning. */
export function addedDiffLines(diff) {
  const lines = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lines.push({ file, text: raw.slice(1) });
    }
  }
  return lines;
}

export function scanChange(input, options) {
  const findings = [];
  if (input.branch) findings.push(...scanSurface("branch name", [input.branch], options));
  if (input.title) findings.push(...scanSurface("PR title", [input.title], options));
  if (input.body) findings.push(...scanSurface("PR body", input.body.split("\n"), options));
  (input.commits ?? []).forEach((message, index) => {
    findings.push(...scanSurface(`commit message ${index + 1}`, message.split("\n"), options));
  });
  if (input.diff) {
    const byFile = new Map();
    for (const line of addedDiffLines(input.diff)) {
      if (!byFile.has(line.file)) byFile.set(line.file, []);
      byFile.get(line.file).push(line.text);
    }
    for (const [file, lines] of byFile) {
      if (isIgnoredPath(file)) continue;
      findings.push(...scanSurface(`added lines in ${file}`, lines, options));
    }
  }
  return findings;
}

function isIgnoredPath(file) {
  return /(^|\/)pnpm-lock\.yaml$/.test(file) || /(^|\/)node_modules\//.test(file) || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$/i.test(file);
}

export function formatReport(findings, context) {
  if (findings.length === 0) return "confidentiality tripwire: clean";
  const lines = ["confidentiality tripwire: BLOCKED — confidential content is about to become public", ""];
  for (const finding of findings) {
    lines.push(`- ${finding.surface}, line ${finding.line}: ${finding.detail}`);
  }
  lines.push("");
  if (findings.some((finding) => finding.surface === "branch name")) {
    lines.push(
      "The branch name itself is affected. A branch name cannot be scrubbed once pushed",
      "(it stays in PR metadata and preview URLs): create a neutral branch, cherry-pick",
      "the commits with reworded messages, and open a new PR from it.",
    );
  } else {
    lines.push(
      "Reword the flagged commit messages/PR text and remove the flagged lines. Refer",
      "to customer reports by an internal ticket ID only (see AGENTS.md, Confidentiality).",
    );
  }
  if (context?.termCount === 0) {
    lines.push("", "Note: CONFIDENTIAL_TERMS was empty; only structural checks (emails, Slack) ran.");
  }
  return lines.join("\n");
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function commitMessages(base, head) {
  const output = git(["log", "--format=%B%x00", `${base}..${head}`]);
  return output.split("\0").map((message) => message.trim()).filter(Boolean);
}

function rangeDiff(base, head) {
  return git(["diff", "--no-color", "--unified=0", `${base}..${head}`]);
}

function loadOptions(env) {
  const terms = parseTerms(env.CONFIDENTIAL_TERMS);
  const allowedEmailDomains = [
    ...DEFAULT_ALLOWED_EMAIL_DOMAINS,
    ...parseDomainList(env.CONFIDENTIAL_ALLOWED_EMAIL_DOMAINS),
  ];
  return { terms, allowedEmailDomains };
}

function runCi(env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("GITHUB_EVENT_PATH is not set; run this mode inside GitHub Actions.");
    return 2;
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    console.error("No pull_request payload in the event; nothing to scan.");
    return 0;
  }
  const options = loadOptions(env);
  const base = pr.base.sha;
  const head = pr.head.sha;
  const findings = scanChange({
    branch: pr.head.ref,
    title: pr.title ?? "",
    body: pr.body ?? "",
    commits: commitMessages(base, head),
    diff: rangeDiff(base, head),
  }, options);
  const report = formatReport(findings, { termCount: options.terms.length });
  console.log(report);
  if (env.GITHUB_STEP_SUMMARY) {
    execFileSync("sh", ["-c", `cat >> "$GITHUB_STEP_SUMMARY"`], { input: `${report}\n`, env });
  }
  return findings.length ? 1 : 0;
}

function runRange(base, head, branch, env) {
  const options = loadOptions(env);
  const findings = scanChange({
    branch,
    commits: commitMessages(base, head),
    diff: rangeDiff(base, head),
  }, options);
  console.log(formatReport(findings, { termCount: options.terms.length }));
  return findings.length ? 1 : 0;
}

const ZERO_SHA = /^0+$/;

function runPrePush(env, stdin) {
  const options = loadOptions(env);
  const findings = [];
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO_SHA.test(localSha)) continue; // deletion
    const branch = localRef.replace(/^refs\/heads\//, "");
    let base = remoteSha && !ZERO_SHA.test(remoteSha) ? remoteSha : null;
    if (!base) {
      try {
        base = git(["merge-base", localSha, "origin/dev"]).trim();
      } catch {
        base = null;
      }
    }
    findings.push(...scanChange({
      branch,
      commits: base ? commitMessages(base, localSha) : [],
      diff: base ? rangeDiff(base, localSha) : "",
    }, options));
  }
  console.error(formatReport(findings, { termCount: options.terms.length }));
  return findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, ...rest] = process.argv.slice(2);
  let code;
  if (mode === "ci") {
    code = runCi(process.env);
  } else if (mode === "pre-push") {
    code = runPrePush(process.env, readFileSync(0, "utf8"));
  } else if (mode === "range") {
    const [base, head] = rest;
    const branchIndex = rest.indexOf("--branch");
    const branch = branchIndex === -1 ? "" : rest[branchIndex + 1] ?? "";
    if (!base || !head) {
      console.error("usage: confidentiality-tripwire.mjs range <base> <head> [--branch <name>]");
      code = 2;
    } else {
      code = runRange(base, head, branch, process.env);
    }
  } else {
    console.error("usage: confidentiality-tripwire.mjs <ci|pre-push|range>");
    code = 2;
  }
  process.exit(code);
}
