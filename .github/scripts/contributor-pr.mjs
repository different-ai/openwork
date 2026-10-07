#!/usr/bin/env node
// Contributor PR gate. Sets the `contributor-pr-required` commit status on a
// PR head. Runs only from the default branch (pull_request_target and
// issue_comment) and only reads PR metadata through the API: it never checks
// out, installs, or executes PR code.
//
//   gate          every PR event. Same-repository PRs pass here; forks wait
//                 for a maintainer. No sign-off is required: as at GitLab,
//                 contributing means accepting the DCO or the ee/ CLA
//                 (CONTRIBUTING.md).
//   authorize     a maintainer's `/test` or `/test <sha>` comment binds the
//                 commit they reviewed. Refused if the head has moved or the
//                 free screen blocked it. Nothing that costs money (model
//                 calls, test runs) starts before this.
//   approve-runs  approves the fork's waiting workflow runs (tests) for that
//                 commit, once the AI screen is clean or a maintainer has
//                 commented /test again to proceed anyway.
//   finalize      waits for the tests and the Warden review on that commit,
//                 then passes or fails `contributor-pr-required`.
//   backfill      manual run: sets `contributor-pr-required` on every open PR
//                 to dev (or one, with PR_NUMBER), and lists the fork PRs
//                 that still need the free screen. For PRs opened before
//                 this gate existed.
//
// `contributor-pr-required` is posted with STATUS_TOKEN, a diff-warden App
// token minted only in the `warden-clearance` environment (dev and v* tags).
// The dev ruleset requires the status from that App, so no workflow on another
// branch can post it, whatever token it asks for.
//
// A fork's own `pull_request` workflows come from the PR's merge commit, so a
// fork could rewrite them. Changes to CI or agent configuration are therefore
// refused here; a maintainer carries them to a same-repository branch instead
// (.opencode/skills/review-a-contributor-pr).
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AI_SCREEN_CONTEXT, SCREEN_CONTEXT, WARDEN_CONTEXT } from "./contributor-screen.mjs";

export const STATUS_CONTEXT = "contributor-pr-required";
export const CI_CHECK = "openwork-tests-required";
const MAINTAINER_PERMISSIONS = ["admin", "maintain", "write"];
const REVIEW_MACHINERY = /^(\.github\/|\.opencode\/|opencode\.jsonc?$|warden\.toml$|\.warden\/|\.agents\/skills\/|\.claude\/skills\/)/;

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 10) : "");

export function isFork(pr) {
  return !pr?.head?.repo || pr.head.repo.full_name !== pr.base?.repo?.full_name || pr.head.repo.fork === true;
}

export function isBot(pr) {
  return pr?.user?.type === "Bot";
}

export function machineryFiles(files) {
  return files
    .flatMap((file) => [file.filename, file.previous_filename])
    .filter((name) => typeof name === "string" && REVIEW_MACHINERY.test(name));
}

// `/test` binds the head as it was when the comment was written;
// `/test <sha>` binds exactly the commit named.
export function parseTestCommand(body) {
  const line = (body ?? "").trim().split("\n")[0].trim();
  const match = /^\/test(?:\s+([0-9a-fA-F]{7,40}))?$/.exec(line);
  if (!match) return null;
  return { sha: match[1] ? match[1].toLowerCase() : null };
}

function blockers({ pr, files }) {
  const machinery = isFork(pr) ? machineryFiles(files) : [];
  if (machinery.length) {
    return {
      state: "failure",
      description: "Changes CI or agent configuration; a maintainer must carry it to a same-repo branch",
      detail: `Fork PRs can't change CI or agent configuration through this path: ${[...new Set(machinery)].slice(0, 10).map((name) => `\`${name}\``).join(", ")}. A maintainer must carry these commits to a same-repository branch.`,
    };
  }
  return null;
}

export function gateDecision({ pr, files }) {
  if (isBot(pr)) return { state: "success", description: "Bot pull request" };
  const blocked = blockers({ pr, files });
  if (blocked) return blocked;
  if (!isFork(pr)) return { state: "success", description: "Pull request from this repository" };
  return { state: "pending", description: "Waiting for a maintainer to review and comment /test" };
}

// `pushedAt` is when GitHub first saw the head (its earliest workflow run).
export function authorizeDecision({ permission, pr, command, files, pushedAt, commentedAt, screen }) {
  if (!MAINTAINER_PERMISSIONS.includes(permission)) {
    return { ok: false, reply: "Only maintainers with write access can run `/test`." };
  }
  if (pr.state !== "open") return { ok: false, reply: "This pull request is not open." };
  if (!isFork(pr)) {
    return { ok: false, reply: "`/test` is for fork pull requests. This branch is in the repository, so its checks run automatically." };
  }
  const head = lower(pr.head.sha);
  if (command.sha) {
    if (!head.startsWith(command.sha)) {
      return { ok: false, reply: `The head is now \`${head}\`, not \`${command.sha}\`. Review the new commits, then comment \`/test\` again.` };
    }
  } else if (!pushedAt || !commentedAt || Date.parse(pushedAt) > Date.parse(commentedAt)) {
    return { ok: false, reply: `New commits arrived after your comment, or I can't tell when \`${short(head)}\` was pushed. Review the head, then comment \`/test\` again, or \`/test ${short(head)}\` to name it.` };
  }
  const blocked = blockers({ pr, files });
  if (blocked) return { ok: false, reply: blocked.detail };
  if (!screen) return { ok: false, reply: `The contributor screen hasn't finished for \`${short(head)}\` yet. Comment \`/test\` again when it has.` };
  if (screen.state === "failure") return { ok: false, reply: `The contributor screen blocked \`${short(head)}\`: ${screen.description}. The contributor must fix this first.` };
  return { ok: true, sha: head };
}

// Picks the newest completed run of the required CI check on that commit.
export function ciDecision(checkRuns) {
  const runs = checkRuns
    .filter((run) => run.name === CI_CHECK && run.app?.slug === "github-actions")
    .sort((a, b) => Date.parse(b.started_at ?? 0) - Date.parse(a.started_at ?? 0));
  const latest = runs[0];
  if (!latest || latest.status !== "completed") return { done: false };
  return { done: true, success: latest.conclusion === "success", conclusion: latest.conclusion, url: latest.html_url };
}

export function finalDecision({ ci, warden, screen }) {
  if (screen?.state === "failure") return { state: "failure", description: `Contributor screen: ${screen.description}` };
  if (warden?.state === "failure" || warden?.state === "error") return { state: "failure", description: `Warden: ${warden.description}` };
  if (!ci.success) return { state: "failure", description: `${CI_CHECK} concluded ${ci.conclusion}`, url: ci.url };
  return { state: "success", description: "Screened, reviewed by a maintainer, Warden clear, tests passed" };
}

// Latest status per context for a commit.
export function latestStatuses(combined) {
  const byContext = {};
  for (const status of combined?.statuses ?? []) {
    if (!byContext[status.context] || Date.parse(status.updated_at) > Date.parse(byContext[status.context].updated_at)) {
      byContext[status.context] = status;
    }
  }
  return byContext;
}

// --- GitHub I/O -------------------------------------------------------------

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github(path, init = {}, attempt = 0) {
  const { token, ...request } = init;
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...request,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token ?? env("GH_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  // Out of API quota: wait for the reset (at most an hour) and try again.
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

async function loadPr(repo, number) {
  const [pr, files] = await Promise.all([
    github(`/repos/${repo}/pulls/${number}`),
    paginate(`/repos/${repo}/pulls/${number}/files`),
  ]);
  return { pr, files };
}

async function statusesFor(repo, sha) {
  return latestStatuses(await github(`/repos/${repo}/commits/${sha}/status?per_page=100`));
}

// Fails closed: without the App token there is no status, and the PR waits.
async function setStatus(repo, sha, { state, description, url }) {
  await github(`/repos/${repo}/statuses/${sha}`, {
    token: env("STATUS_TOKEN"),
    method: "POST",
    body: JSON.stringify({ state, context: STATUS_CONTEXT, description: description.slice(0, 140), target_url: url }),
  });
}

async function reply(repo, number, body) {
  await github(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// Workflow runs GitHub created for this exact commit from `pull_request`
// events. Fork runs wait as `action_required` until approved.
async function pullRequestRuns(repo, sha) {
  return paginate(`/repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request`, "workflow_runs");
}

async function approveRuns(repo, sha) {
  const waiting = (await pullRequestRuns(repo, sha)).filter((run) => run.status === "action_required" || run.conclusion === "action_required");
  const failed = [];
  for (const run of waiting) {
    try {
      await github(`/repos/${repo}/actions/runs/${run.id}/approve`, { method: "POST" });
    } catch (error) {
      failed.push(run.name);
      console.log(`::warning::Could not approve ${run.name} (${run.id}): ${error.message}`);
    }
  }
  return { approved: waiting.length - failed.length, failed };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function backfill(repo, runUrl) {
  const only = (process.env.PR_NUMBER ?? "").trim();
  if (only && !/^\d+$/.test(only)) throw new Error(`PR_NUMBER must be a number, got: ${only}`);
  const prs = only
    ? [await github(`/repos/${repo}/pulls/${only}`)]
    : await paginate(`/repos/${repo}/pulls?state=open&base=dev`);
  const forks = [];
  for (const pr of prs.filter((item) => item.state === "open")) {
    // Files only matter for forks (CI and agent configuration check).
    const files = isFork(pr) ? await paginate(`/repos/${repo}/pulls/${pr.number}/files`) : [];
    const decision = gateDecision({ pr, files });
    await setStatus(repo, pr.head.sha, { ...decision, url: runUrl });
    console.log(`#${pr.number} ${pr.head.sha.slice(0, 10)}: ${decision.state} (${decision.description})`);
    // Forks that change CI or agent configuration are carried by a maintainer.
    if (isFork(pr) && !isBot(pr) && decision.state !== "failure") forks.push({ number: pr.number, sha: pr.head.sha });
  }
  // A job matrix holds at most 256 entries.
  await output("forks", JSON.stringify(forks.slice(0, 256)));
  console.log(`Checked ${prs.length} PR(s); ${forks.length} fork PR(s) queued for the free screen.`);
}

async function main(mode) {
  const repo = env("GITHUB_REPOSITORY");
  if (mode === "backfill") {
    const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
    return backfill(repo, runUrl);
  }
  const number = Number(env("PR_NUMBER"));
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;

  if (mode === "gate") {
    const data = await loadPr(repo, number);
    const decision = gateDecision(data);
    await setStatus(repo, data.pr.head.sha, { ...decision, url: runUrl });
    await output("fork", String(isFork(data.pr) && !isBot(data.pr)));
    console.log(`${STATUS_CONTEXT} on ${data.pr.head.sha}: ${decision.state} (${decision.description})`);
    return;
  }

  if (mode === "approve-runs") {
    const sha = env("HEAD_SHA");
    const { approved, failed } = await approveRuns(repo, sha);
    console.log(`Approved ${approved} waiting run(s) for ${sha}.`);
    if (failed.length) {
      await reply(repo, number, `I couldn't start these checks for \`${short(sha)}\`: ${failed.join(", ")}. A maintainer can approve them on the Checks tab.`);
    }
    return;
  }

  if (mode === "authorize") {
    const command = parseTestCommand(process.env.COMMENT_BODY);
    if (!command) return console.log("Not a /test command.");
    const actor = env("COMMENT_AUTHOR");
    const [{ permission }, data] = await Promise.all([
      github(`/repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`),
      loadPr(repo, number),
    ]);
    const head = data.pr.head.sha;
    const [runs, statuses] = await Promise.all([pullRequestRuns(repo, head), statusesFor(repo, head)]);
    const pushedAt = runs.map((run) => run.created_at).sort()[0];
    const decision = authorizeDecision({
      permission, command, ...data, pushedAt, commentedAt: env("COMMENT_CREATED_AT"), screen: statuses[SCREEN_CONTEXT],
    });
    if (!decision.ok) {
      await reply(repo, number, `@${actor} ${decision.reply}`);
      console.log(`Refused: ${decision.reply}`);
      return;
    }
    // The AI screen runs once per commit. A second /test after it flagged
    // something is the maintainer deciding to proceed anyway.
    const needsScreen = !statuses[AI_SCREEN_CONTEXT];
    await setStatus(repo, decision.sha, {
      state: "pending",
      description: needsScreen
        ? `Reviewed by @${actor}; AI screen first. If it flags something, /test again to run tests`
        : `Reviewed by @${actor}; tests and Warden running`,
      url: runUrl,
    });
    await reply(repo, number, needsScreen
      ? `Running the AI screen for \`${decision.sha}\`, as reviewed by @${actor}. Tests and the Warden security review start if it's clear: ${runUrl}`
      : `Running tests and the Warden security review for \`${decision.sha}\`, as reviewed by @${actor}: ${runUrl}`);
    await output("sha", decision.sha);
    await output("needs_screen", String(needsScreen));
    await output("needs_review", String(statuses[WARDEN_CONTEXT]?.state !== "success"));
    return;
  }

  if (mode === "finalize") {
    const sha = env("HEAD_SHA");
    const deadline = Date.now() + Number(process.env.WAIT_MINUTES ?? 120) * 60_000;
    for (;;) {
      const [checkRuns, statuses] = await Promise.all([
        paginate(`/repos/${repo}/commits/${sha}/check-runs?check_name=${CI_CHECK}`, "check_runs"),
        statusesFor(repo, sha),
      ]);
      const ci = ciDecision(checkRuns);
      // A Warden job that crashed before reporting counts as not clear.
      const warden = statuses[WARDEN_CONTEXT] ?? (process.env.REVIEW_JOB_RESULT === "failure"
        ? { state: "failure", description: "the review job failed before reporting" } : undefined);
      if (ci.done && warden && warden.state !== "pending") {
        const decision = finalDecision({ ci, warden, screen: statuses[SCREEN_CONTEXT] });
        await setStatus(repo, sha, { ...decision, url: decision.url ?? runUrl });
        console.log(`${STATUS_CONTEXT} on ${sha}: ${decision.state} (${decision.description})`);
        if (decision.state !== "success") process.exitCode = 1;
        return;
      }
      if (Date.now() > deadline) {
        const missing = [!ci.done && CI_CHECK, !warden && "Warden review"].filter(Boolean).join(" and ");
        await setStatus(repo, sha, { state: "failure", description: `${missing} did not finish. Comment /test to try again`, url: runUrl });
        process.exitCode = 1;
        return;
      }
      await sleep(60_000);
    }
  }

  throw new Error(`Unknown mode: ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
