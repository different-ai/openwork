#!/usr/bin/env node
// Fork-only /test authorization. Runs trusted default-branch scripts; only
// reads PR metadata and approves immutable workflow run IDs, never PR code.
// There is no custom required status or App token. Merge clearance belongs to
// the required CI check and trusted maintainer reviews (see CONTRIBUTING.md).
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AI_SCREEN_CONTEXT, SCREEN_CONTEXT, WARDEN_CONTEXT } from "./contributor-screen.mjs";
import { isFork, machineryFiles } from "./contributor-policy.mjs";
export { isFork, machineryFiles } from "./contributor-policy.mjs";

const MAINTAINER_PERMISSIONS = ["admin", "maintain", "write"];
const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 10) : "");

export function parseTestCommand(body) {
  const line = (body ?? "").trim().split("\n")[0].trim();
  const match = /^\/test(?:\s+([0-9a-fA-F]{7,40}))?$/.exec(line);
  if (!match) return null;
  return { sha: match[1] ? match[1].toLowerCase() : null };
}

// `pushedAt` is when GitHub first saw this head in this PR's workflow runs.
export function authorizeDecision({ permission, pr, command, files, pushedAt, commentedAt, screen }) {
  if (!MAINTAINER_PERMISSIONS.includes(permission)) {
    return { ok: false, reply: "Only maintainers with write access can run `/test`." };
  }
  if (pr.state !== "open") return { ok: false, reply: "This pull request is not open." };
  if (!isFork(pr)) {
    return { ok: false, reply: "`/test` is for fork pull requests. This branch is in the repository, so its checks run automatically." };
  }
  if (pr.base?.ref !== "dev") return { ok: false, reply: "`/test` only supports pull requests targeting `dev`." };
  const head = lower(pr.head.sha);
  if (command.sha) {
    if (command.sha.length !== 40) {
      return { ok: false, reply: "Use `/test <full-40-character-sha>` to bind the exact commit you reviewed; abbreviated SHAs are not accepted." };
    }
    if (head !== command.sha) {
      return { ok: false, reply: `The head is now \`${head}\`, not \`${command.sha}\`. Review the new commits, then comment \`/test\` again.` };
    }
  } else if (!Number.isFinite(Date.parse(pushedAt)) || !Number.isFinite(Date.parse(commentedAt)) || Date.parse(pushedAt) > Date.parse(commentedAt)) {
    return { ok: false, reply: `New commits arrived after your comment, or I can't tell when \`${short(head)}\` was pushed. Review the head, then comment \`/test\` again, or \`/test ${head}\` to name it.` };
  }
  const machinery = machineryFiles(files);
  if (machinery.length) {
    return { ok: false, reply: `Fork PRs can't change CI or agent configuration through this path: ${[...new Set(machinery)].slice(0, 10).map((name) => `\`${name}\``).join(", ")}. A maintainer must carry these commits to a same-repository branch.` };
  }
  if (!screen) return { ok: false, reply: `The contributor screen hasn't finished for \`${short(head)}\` yet. Comment \`/test\` again when it has.` };
  // pending is a completed free screen with findings held for human review.
  if (!["success", "pending"].includes(screen.state)) return { ok: false, reply: `The contributor screen blocked \`${short(head)}\`: ${screen.description}. The contributor must fix this first.` };
  return { ok: true, sha: head };
}

export function latestStatuses(combined) {
  const byContext = {};
  for (const status of combined?.statuses ?? []) {
    if (!byContext[status.context] || Date.parse(status.updated_at) > Date.parse(byContext[status.context].updated_at)) {
      byContext[status.context] = status;
    }
  }
  return byContext;
}

// Never approve another PR's runs even if its branch has the same commit.
export function runsForPr(runs, pr) {
  return runs.filter((run) => run.event === "pull_request" && run.head_sha === pr.head.sha &&
    run.head_repository?.full_name === pr.head.repo?.full_name &&
    run.pull_requests?.some((item) => item.number === pr.number));
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github(path, init = {}, attempt = 0) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env("GH_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if ((response.status === 403 || response.status === 429) && attempt < 3 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after"))) {
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const wait = Math.min(Math.max(reset - Date.now(), Number(response.headers.get("retry-after") ?? 0) * 1000, 30_000), 3_600_000);
    console.log(`Rate limited on ${path}; waiting ${Math.round(wait / 1000)}s.`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return github(path, init, attempt + 1);
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function paginate(path, key) {
  const items = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const list = key ? batch[key] : batch;
    items.push(...list);
    if (list.length < 100) return items;
  }
  throw new Error(`${path}: too many pages`);
}

// PR files follow a mutable head (even two metadata reads cannot exclude an
// A -> B -> A race). Compare immutable SHAs instead. GitHub caps compare files
// at 300; fail closed at that limit and use a maintainer carry for large diffs.
async function loadPr(repo, number) {
  const before = await github(`/repos/${repo}/pulls/${number}`);
  const comparison = await github(`/repos/${repo}/compare/${before.base.sha}...${before.head.sha}`);
  const files = comparison.files;
  const pr = await github(`/repos/${repo}/pulls/${number}`);
  if (before.head.sha !== pr.head.sha || before.base.sha !== pr.base.sha || before.base.ref !== pr.base.ref) {
    throw new Error("PR changed while reading files. Review the current head and comment /test again.");
  }
  if (!Array.isArray(files) || files.length >= 300 || files.length !== pr.changed_files) {
    throw new Error("Incomplete or oversized PR file list; a maintainer must carry this PR to a same-repository branch.");
  }
  return { pr, files };
}

async function statusesFor(repo, sha) {
  return latestStatuses({ statuses: await paginate(`/repos/${repo}/commits/${sha}/statuses`) });
}

async function reply(repo, number, body) {
  await github(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function pullRequestRuns(repo, pr) {
  return runsForPr(await paginate(`/repos/${repo}/actions/runs?head_sha=${pr.head.sha}&event=pull_request`, "workflow_runs"), pr);
}

async function backfill(repo) {
  const only = (process.env.PR_NUMBER ?? "").trim();
  if (only && !/^\d+$/.test(only)) throw new Error(`PR_NUMBER must be a number, got: ${only}`);
  const prs = only ? [await github(`/repos/${repo}/pulls/${only}`)] : await paginate(`/repos/${repo}/pulls?state=open&base=dev`);
  const forks = prs.filter((pr) => pr.state === "open" && pr.base.ref === "dev" && isFork(pr)).map((pr) => ({ number: pr.number, sha: pr.head.sha }));
  if (forks.length > 256) throw new Error("More than 256 forks; screen individual PR numbers instead.");
  await output("forks", JSON.stringify(forks));
  console.log(`Queued ${forks.length} fork PR(s) for the free screen. Same-repository PRs are untouched.`);
}

async function main(mode) {
  const repo = env("GITHUB_REPOSITORY");
  if (mode === "backfill") return backfill(repo);
  const number = Number(env("PR_NUMBER"));

  if (mode === "approve-runs") {
    const { pr, files } = await loadPr(repo, number);
    if (pr.state !== "open" || !isFork(pr) || pr.base.ref !== "dev" || pr.head.sha !== env("HEAD_SHA") || machineryFiles(files).length) {
      throw new Error("PR is no longer the authorized fork head. Review it and comment /test again.");
    }
    const waiting = (await pullRequestRuns(repo, pr)).filter((run) => run.status === "action_required" || run.conclusion === "action_required");
    for (const run of waiting) {
      // An approval targets a run ID, not a mutable branch or PR. A push
      // after this snapshot cannot inherit authorization for its new SHA.
      await github(`/repos/${repo}/actions/runs/${run.id}/approve`, { method: "POST" });
    }
    console.log(`Approved ${waiting.length} waiting run(s) for ${pr.head.sha}.`);
    return;
  }

  if (mode === "authorize") {
    const command = parseTestCommand(process.env.COMMENT_BODY);
    if (!command) return console.log("Not a /test command.");
    // Same-repository PRs do not enter contributor authorization at all.
    if (!isFork(await github(`/repos/${repo}/pulls/${number}`))) return;
    const actor = env("COMMENT_AUTHOR");
    const [{ permission }, data] = await Promise.all([
      github(`/repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`), loadPr(repo, number),
    ]);
    const head = data.pr.head.sha;
    const [runs, statuses] = await Promise.all([pullRequestRuns(repo, data.pr), statusesFor(repo, head)]);
    const pushedAt = runs.map((run) => run.created_at).sort()[0];
    const decision = authorizeDecision({ permission, command, ...data, pushedAt, commentedAt: env("COMMENT_CREATED_AT"), screen: statuses[SCREEN_CONTEXT] });
    if (!decision.ok) {
      await reply(repo, number, `@${actor} ${decision.reply}`);
      console.log(`Refused: ${decision.reply}`);
      return;
    }
    const needsScreen = !statuses[AI_SCREEN_CONTEXT];
    const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
    await reply(repo, number, needsScreen
      ? `Running the AI screen for \`${decision.sha}\`, as reviewed by @${actor}. Tests and the Warden security review start if it's clear: ${runUrl}`
      : `Running tests and the Warden security review for \`${decision.sha}\`, as reviewed by @${actor}: ${runUrl}`);
    await output("sha", decision.sha);
    await output("needs_screen", String(needsScreen));
    await output("needs_review", String(statuses[WARDEN_CONTEXT]?.state !== "success"));
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
