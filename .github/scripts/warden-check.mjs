#!/usr/bin/env node
// The advisory-only `warden-clear` check: Warden's verdict on a PR head,
// posted by the diff-warden App. Clear reviews succeed; findings and incomplete
// reviews are neutral. Neither this check nor Warden workflow jobs are merge
// requirements; incomplete jobs still fail for observability. The App key is
// only in the warden-clearance environment, which only dev and v* tags can use.
//
// Posted by:
//   warden-clearance.mjs        same-repository PRs, after every Warden run
//   contributor-pr-test.yml     fork PRs, after the sandboxed review on /test
//   mode `backfill` (below)     PRs diff-warden already approved at their head
import { pathToFileURL } from "node:url";

export const CHECK_NAME = "warden-clear";

const REASONS = {
  "changes-warden": "This PR changes Warden itself; a person should inspect the reviewer changes. Warden cannot independently assess its own changes.",
  "confidentiality-findings": "The confidentiality review flagged something. See the Warden comment on the PR.",
  "major-security-findings": "The security review found high or medium findings. See the Warden comment on the PR.",
  "review-incomplete": "The review didn't finish. Re-run Warden or push again.",
  flagged: "The Warden review flagged something. See the Warden comment on the PR.",
  "files-over-size-limits": "This PR is too big for Warden to review in full (over 400 files or 60,000 changed lines). Split it into smaller PRs.",
  "missing-or-invalid-receipt": "The review didn't finish. Re-run Warden or push again.",
  "receipt-identity-mismatch": "The review result didn't match this run. Re-run Warden.",
};

// verdict: "clear" or anything else; reason: why it isn't clear.
export function checkRunBody({ sha, verdict, reason, detailsUrl, source = "Warden" }) {
  const clear = verdict === "clear";
  const why = REASONS[reason] ?? (reason ? `Not clear (${reason}).` : "Not clear.");
  return {
    name: CHECK_NAME,
    head_sha: sha,
    status: "completed",
    // Advisory even when a review is incomplete or reports findings. Do not
    // turn uncertainty into success, or into a merge-blocking failure.
    conclusion: clear ? "success" : "neutral",
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    output: {
      title: clear ? `${source}: clear (advisory)` : `${source}: needs attention (advisory)`,
      summary: `${clear ? "No high or medium security findings and no confidentiality findings." : why}\n\nWarden is advisory only and does not block merging. Tests and human review are separate requirements.`,
    },
  };
}

async function api(token, repo, method, path, body, attempt = 0) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // GitHub occasionally answers 5xx; one retry keeps the check from going missing.
  if (response.status >= 500 && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
    return api(token, repo, method, path, body, attempt + 1);
  }
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function postWardenCheck({ token, repo, ...input }) {
  const body = checkRunBody(input);
  await api(token, repo, "POST", "/check-runs", body);
  console.log(`${CHECK_NAME} on ${input.sha}: ${body.conclusion} (${body.output.title})`);
  return body;
}

async function paginate(token, repo, path) {
  const items = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await api(token, repo, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`${path}: too many pages`);
}

// An approval only counts while it is still in force on the current head.
export function approvedAtHead(reviews, appLogin, sha) {
  return reviews.some((review) => review.user?.login === appLogin && review.state === "APPROVED" && review.commit_id === sha);
}

// For PRs opened before the check existed: post success only where diff-warden
// already approved the exact current head. Everything else gets the check on
// its next Warden run.
async function backfill({ token, repo, appSlug, runUrl }) {
  const appLogin = `${appSlug}[bot]`;
  const prs = (await paginate(token, repo, "/pulls?state=open&base=dev")).filter((pr) => pr.head?.repo?.full_name === repo);
  let posted = 0;
  for (const pr of prs) {
    const [reviews, checks] = await Promise.all([
      paginate(token, repo, `/pulls/${pr.number}/reviews`),
      api(token, repo, "GET", `/commits/${pr.head.sha}/check-runs?check_name=${CHECK_NAME}`),
    ]);
    if (checks.total_count > 0 || !approvedAtHead(reviews, appLogin, pr.head.sha)) continue;
    await postWardenCheck({ token, repo, sha: pr.head.sha, verdict: "clear", detailsUrl: runUrl, source: "Warden (earlier approval)" });
    posted += 1;
  }
  console.log(`Checked ${prs.length} open same-repository PR(s); posted ${CHECK_NAME} on ${posted}.`);
}

async function main(mode) {
  const need = (name) => {
    if (!process.env[name]) throw new Error(`${name} is required`);
    return process.env[name];
  };
  const token = need("GH_TOKEN");
  const repo = need("REPO");
  if (mode === "post") {
    return postWardenCheck({ token, repo, sha: need("HEAD_SHA"), verdict: process.env.VERDICT, reason: process.env.REASON, detailsUrl: process.env.DETAILS_URL });
  }
  if (mode === "backfill") return backfill({ token, repo, appSlug: need("APP_SLUG"), runUrl: process.env.DETAILS_URL });
  throw new Error(`Unknown mode: ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
