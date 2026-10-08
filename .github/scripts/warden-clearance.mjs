#!/usr/bin/env node
// Warden clearance: approve a same-repository PR as the diff-warden App when
// the latest complete Warden review of its current head has no high or medium
// security findings and no confidentiality findings. Anything else withdraws an
// earlier clearance. Either way, one comment on the PR says what happened and
// lists the security findings. Runs from the default branch via workflow_run
// and never executes PR code.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postWardenCheck } from "./warden-check.mjs";

const SECURITY = "diff-security-review";
const CONFIDENTIALITY = "confidentiality-review";
const SEVERITIES = ["high", "medium", "low"];
const MARKER = "<!-- warden-clearance -->";
// Warden never approves changes to Warden. warden.yml runs inside the PR's own
// review and could upload a forged receipt; the rest would let one PR rewrite
// the reviewer for every later PR. Other CI, AGENTS.md, and skills are reviewed
// like any code (Warden's runtime does not load AGENTS.md or skills from the PR).
const GUARDED = /^(\.github\/workflows\/warden(-clearance|-check-backfill)?\.yml$|\.github\/scripts\/warden-(clearance|report|check)\.mjs$|warden\.toml$|\.warden\/)/;

const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function guardedFiles(files) {
  return files.filter((file) => GUARDED.test(file));
}

// Pure decision over the trusted reporter's receipt (warden-report.mjs schema 2).
export function decide(receipt, expected) {
  if (expected.conclusion !== "success") return { verdict: "flagged", reason: `analysis-${expected.conclusion || "unknown"}` };
  if (!receipt || receipt.schema_version !== 2) return { verdict: "flagged", reason: "missing-or-invalid-receipt" };
  if (receipt.repository !== expected.repository || receipt.run_id !== expected.runId ||
      receipt.run_attempt !== expected.attempt || receipt.head_sha !== expected.head || receipt.pr !== expected.pr) {
    return { verdict: "flagged", reason: "receipt-identity-mismatch" };
  }
  if (receipt.review_complete !== true || !Array.isArray(receipt.incomplete_reasons) || receipt.incomplete_reasons.length) {
    return { verdict: "flagged", reason: "review-incomplete" };
  }
  const skill = (name) => {
    const matches = Array.isArray(receipt.skills) ? receipt.skills.filter((entry) => entry?.name === name) : [];
    const only = matches.length === 1 ? matches[0] : null;
    const severity = only?.findings_by_severity;
    const valid = only?.status === "complete" && count(only.findings_count) && severity &&
      SEVERITIES.every((level) => count(severity[level])) &&
      SEVERITIES.reduce((total, level) => total + severity[level], 0) === only.findings_count;
    return valid ? only : null;
  };
  const security = skill(SECURITY);
  const confidentiality = skill(CONFIDENTIALITY);
  if (!security || !confidentiality) return { verdict: "flagged", reason: "review-incomplete" };
  const counts = { ...security.findings_by_severity, confidentiality: confidentiality.findings_count };
  if (counts.confidentiality > 0) return { verdict: "flagged", reason: "confidentiality-findings", counts };
  if (counts.high + counts.medium > 0) return { verdict: "flagged", reason: "major-security-findings", counts };
  return { verdict: "clear", reason: "no-major-findings", counts, low: counts.low };
}

// The security findings file is only trusted when it belongs to this exact run.
export function validFindings(file, expected) {
  const valid = file?.schema_version === 1 && file.repository === expected.repository && file.pr === expected.pr &&
    file.head_sha === expected.head && file.run_id === expected.runId && file.run_attempt === expected.attempt &&
    count(file.total) && Array.isArray(file.findings) && file.findings.every((finding) =>
      SEVERITIES.includes(finding?.severity) && typeof finding.title === "string" && typeof finding.description === "string");
  return valid ? file : null;
}

// Model-written text comes from a PR diff: escape markup, and break @mentions
// and #references so a finding can never ping people or link elsewhere.
// Break references first: the entities added afterwards contain "#".
const safe = (value, max) => String(value).slice(0, max)
  .replace(/([@#])/g, "$1\u200b")
  .replace(/[&<>"'`[\]()*_~|\\!]/g, (char) => `&#${char.charCodeAt(0)};`);
const code = (value) => `\`${String(value).replace(/[`\r\n]/g, "").slice(0, 240)}\``;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function headline(decision, guarded) {
  const c = decision.counts;
  if (guarded.length) {
    return ["### Warden: needs a human approval",
      `This PR changes Warden itself, so Warden can't approve it. Changed: ${guarded.slice(0, 10).map(code).join(", ")}${guarded.length > 10 ? `, and ${guarded.length - 10} more` : ""}.`];
  }
  switch (decision.reason) {
    case "no-major-findings":
      return ["### Warden: approved", "No high or medium security findings and no confidentiality findings."];
    case "major-security-findings":
      return ["### Warden: not approved",
        `Security review found ${[c.high && `${c.high} high`, c.medium && `${c.medium} medium`].filter(Boolean).join(" and ")} severity ${c.high + c.medium === 1 ? "finding" : "findings"}. Fix ${c.high + c.medium === 1 ? "it" : "them"} and push; Warden reviews again automatically. If ${c.high + c.medium === 1 ? "it is a false positive" : "they are false positives"}, a maintainer can approve by hand.`];
    case "confidentiality-findings":
      return ["### Warden: not approved",
        `Confidentiality review flagged ${plural(c.confidentiality, "item")} that may identify a customer, prospect, partner, or outside person (see \`AGENTS.md\`). Details stay out of this public comment; check the lines this PR adds.`];
    default:
      return ["### Warden: not approved",
        `The review didn't finish (\`${decision.reason}\`), so Warden can't approve. Re-run the Warden job or push again.`];
  }
}

export function renderComment(decision, findings, guarded, env) {
  const lines = [MARKER, ...headline(decision, guarded)];
  if (findings?.findings.length) {
    lines.push("", `**Security findings** (${plural(findings.total, "finding")})`, "");
    let size = lines.join("\n").length;
    for (const finding of findings.findings) {
      const where = finding.path ? ` in ${code(finding.line ? `${finding.path}:${finding.line}` : finding.path)}` : "";
      const entry = `<details><summary><b>${finding.severity}</b>: ${safe(finding.title, 300)}${where}</summary>\n\n<pre>${safe(finding.description, 2000)}</pre>\n</details>`;
      if (size + entry.length > 55000) break;
      lines.push(entry);
      size += entry.length;
    }
    if (findings.total > findings.findings.length) lines.push("", `More findings are in the [Warden run summary](${env.RUN_URL}).`);
  } else if (decision.counts && decision.counts.high + decision.counts.medium + decision.counts.low > 0) {
    lines.push("", `Security finding details are in the [Warden run summary](${env.RUN_URL}).`);
  }
  lines.push("", `<sub>Reviewed ${code(env.HEAD_SHA.slice(0, 12))} · [Warden run](${env.RUN_URL}) · Updates after every Warden run.</sub>`);
  return lines.join("\n");
}

async function github(env, method, path, body) {
  const response = await fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GH_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function paginate(env, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await github(env, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

const atHead = (pr, env) => pr.state === "open" && !pr.merged && pr.head?.sha === env.HEAD_SHA &&
  pr.head?.repo?.full_name === env.REPO && pr.base?.repo?.full_name === env.REPO;

// Returns false when the head moved, so the caller does not claim an approval.
async function clear(env, number, decision) {
  const bot = `${env.APP_SLUG}[bot]`;
  const reviews = await paginate(env, `/pulls/${number}/reviews`);
  if (reviews.some((review) => review.user?.login === bot && review.state === "APPROVED" && review.commit_id === env.HEAD_SHA)) {
    console.log(`PR #${number}: already cleared at ${env.HEAD_SHA}.`);
    return true;
  }
  // Re-check immediately before the write; commit_id pins the approval to the reviewed head.
  if (!atHead(await github(env, "GET", `/pulls/${number}`), env)) {
    console.log(`PR #${number}: head moved before approval; skipping.`);
    return false;
  }
  const low = decision.low ? ` ${plural(decision.low, "low-severity note")} listed in the Warden comment.` : "";
  await github(env, "POST", `/pulls/${number}/reviews`, {
    event: "APPROVE",
    commit_id: env.HEAD_SHA,
    body: `**Warden clearance.** Complete security and confidentiality review of \`${env.HEAD_SHA}\` found no high or medium security findings and no confidentiality findings.${low} Any new push dismisses this approval. [Analysis run](${env.RUN_URL})`,
  });
  console.log(`PR #${number}: cleared at ${env.HEAD_SHA}.`);
  return true;
}

async function revoke(env, number, reason) {
  const bot = `${env.APP_SLUG}[bot]`;
  const reviews = await paginate(env, `/pulls/${number}/reviews`);
  const active = reviews.filter((review) => review.user?.login === bot && review.user?.type === "Bot" && review.state === "APPROVED");
  for (const review of active) {
    await github(env, "PUT", `/pulls/${number}/reviews/${review.id}/dismissals`, {
      message: `Latest Warden review is not clear (${reason}); see the Warden comment.`,
      event: "DISMISS",
    });
  }
  console.log(`PR #${number}: not cleared (${reason}); withdrew ${active.length} approval(s).`);
}

// One comment per PR, edited in place, so authors always see the latest result.
async function upsertComment(env, number, body) {
  const bot = `${env.APP_SLUG}[bot]`;
  const comments = await paginate(env, `/issues/${number}/comments`);
  const existing = comments.find((comment) => comment.user?.login === bot && comment.body?.startsWith(MARKER));
  if (existing?.body === body) return;
  if (existing) await github(env, "PATCH", `/issues/comments/${existing.id}`, { body });
  else await github(env, "POST", `/issues/${number}/comments`, { body });
  console.log(`PR #${number}: ${existing ? "updated" : "posted"} Warden comment.`);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; /* Missing or malformed files are never clear. */ }
}

export async function main(env = process.env) {
  for (const name of ["GH_TOKEN", "APP_SLUG", "REPO", "RUN_ID", "RUN_ATTEMPT", "HEAD_SHA", "RUN_URL", "PULL_REQUESTS"]) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  const receipt = await readJson(env.RECEIPT_PATH);
  const findingsFile = env.FINDINGS_PATH ? await readJson(env.FINDINGS_PATH) : null;

  const numbers = JSON.parse(env.PULL_REQUESTS)
    .filter((pr) => pr?.head?.sha === env.HEAD_SHA && Number.isSafeInteger(pr?.number))
    .map((pr) => pr.number);
  if (!numbers.length) console.log("No open pull request matches the analyzed head.");

  for (const number of numbers) {
    const pr = await github(env, "GET", `/pulls/${number}`);
    if (!atHead(pr, env)) {
      // A newer push dismisses stale approvals and gets its own Warden run.
      console.log(`PR #${number}: closed, foreign, or no longer at ${env.HEAD_SHA}; skipping.`);
      continue;
    }
    const expected = {
      conclusion: env.CONCLUSION, repository: env.REPO, runId: env.RUN_ID,
      attempt: Number(env.RUN_ATTEMPT), head: env.HEAD_SHA, pr: number,
    };
    const guarded = guardedFiles((await paginate(env, `/pulls/${number}/files`)).map((file) => file.filename));
    const reviewed = decide(receipt, expected);
    const decision = guarded.length ? { ...reviewed, verdict: "flagged", reason: "changes-warden" } : reviewed;
    if (guarded.length) console.log(`PR #${number} changes Warden itself; human review required:\n${guarded.join("\n")}`);

    // The required `warden-clear` check goes first, so a failed approval or
    // comment below can't leave the PR without it.
    try {
      await postWardenCheck({ token: env.GH_TOKEN, repo: env.REPO, sha: env.HEAD_SHA, verdict: decision.verdict, reason: decision.reason, detailsUrl: env.RUN_URL });
    } catch (error) {
      console.error(`PR #${number}: could not post the warden-clear check: ${error.message}`);
      process.exitCode = 1;
    }
    if (decision.verdict === "clear") {
      if (!(await clear(env, number, decision))) continue;
    } else {
      await revoke(env, number, decision.reason);
    }
    await upsertComment(env, number, renderComment(decision, validFindings(findingsFile, expected), guarded, env));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Warden clearance failed: ${error.message}`);
    process.exitCode = 1;
  });
}
