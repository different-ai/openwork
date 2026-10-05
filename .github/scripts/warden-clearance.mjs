#!/usr/bin/env node
// Warden clearance: approve a same-repository PR as the diff-warden App when
// the latest complete Warden review of its current head has no high or medium
// security findings and no confidentiality findings. Anything else withdraws an
// earlier clearance. Runs from the default branch via workflow_run and never
// executes PR code.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECURITY = "diff-security-review";
const CONFIDENTIALITY = "confidentiality-review";
const SEVERITIES = ["high", "medium", "low"];
// A PR that changes how it is reviewed, or what reviews it, never clears itself.
const GUARDED = /^(\.github\/|warden\.toml$|\.warden\/|\.agents\/skills\/|\.claude\/skills\/|\.opencode\/|AGENTS\.md$)/;

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
  if (confidentiality.findings_count > 0) return { verdict: "flagged", reason: "confidentiality-findings" };
  const major = security.findings_by_severity.high + security.findings_by_severity.medium;
  if (major > 0) return { verdict: "flagged", reason: "major-security-findings" };
  return { verdict: "clear", reason: "no-major-findings", low: security.findings_by_severity.low };
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

async function clear(env, number, decision) {
  const bot = `${env.APP_SLUG}[bot]`;
  const reviews = await paginate(env, `/pulls/${number}/reviews`);
  if (reviews.some((review) => review.user?.login === bot && review.state === "APPROVED" && review.commit_id === env.HEAD_SHA)) {
    console.log(`PR #${number}: already cleared at ${env.HEAD_SHA}.`);
    return;
  }
  // Re-check immediately before the write; commit_id pins the approval to the reviewed head.
  if (!atHead(await github(env, "GET", `/pulls/${number}`), env)) {
    console.log(`PR #${number}: head moved before approval; skipping.`);
    return;
  }
  const low = decision.low ? ` ${decision.low} low-severity security note(s) are in the [Warden run summary](${env.RUN_URL}).` : "";
  await github(env, "POST", `/pulls/${number}/reviews`, {
    event: "APPROVE",
    commit_id: env.HEAD_SHA,
    body: `**Warden clearance.** Complete security and confidentiality review of \`${env.HEAD_SHA}\` found no high or medium security findings and no confidentiality findings.${low} This is an automated review; any new push dismisses it. [Analysis run](${env.RUN_URL})`,
  });
  console.log(`PR #${number}: cleared at ${env.HEAD_SHA}.`);
}

async function revoke(env, number, reason) {
  const bot = `${env.APP_SLUG}[bot]`;
  const reviews = await paginate(env, `/pulls/${number}/reviews`);
  const active = reviews.filter((review) => review.user?.login === bot && review.user?.type === "Bot" && review.state === "APPROVED");
  for (const review of active) {
    await github(env, "PUT", `/pulls/${number}/reviews/${review.id}/dismissals`, {
      message: `Latest Warden review is not clear (${reason}); clearance withdrawn.`,
      event: "DISMISS",
    });
  }
  console.log(`PR #${number}: not cleared (${reason}); withdrew ${active.length} approval(s).`);
}

export async function main(env = process.env) {
  for (const name of ["GH_TOKEN", "APP_SLUG", "REPO", "RUN_ID", "RUN_ATTEMPT", "HEAD_SHA", "RUN_URL", "PULL_REQUESTS"]) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  let receipt = null;
  try { receipt = JSON.parse(await readFile(env.RECEIPT_PATH, "utf8")); }
  catch { /* Missing or malformed receipts are never clear. */ }

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
    const guarded = guardedFiles((await paginate(env, `/pulls/${number}/files`)).map((file) => file.filename));
    const decision = guarded.length
      ? { verdict: "flagged", reason: "touches-review-machinery" }
      : decide(receipt, {
        conclusion: env.CONCLUSION, repository: env.REPO, runId: env.RUN_ID,
        attempt: Number(env.RUN_ATTEMPT), head: env.HEAD_SHA, pr: number,
      });
    if (guarded.length) console.log(`PR #${number} changes review machinery; human review required:\n${guarded.join("\n")}`);
    if (decision.verdict === "clear") await clear(env, number, decision);
    else await revoke(env, number, decision.reason);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Warden clearance failed: ${error.message}`);
    process.exitCode = 1;
  });
}
