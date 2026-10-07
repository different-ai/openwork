#!/usr/bin/env node
// Contributor PR gate. Sets the `contributor-pr-required` commit status on a
// PR head. Runs only from the default branch (pull_request_target and
// issue_comment) and only reads PR metadata through the API: it never checks
// out, installs, or executes PR code.
//
//   gate          every PR event: every commit must carry its author's
//                 Signed-off-by (comments on the PR when one is missing).
//                 Same-repository PRs pass here; forks wait for a maintainer.
//   approve-runs  approves the fork's waiting workflow runs (tests) for a
//                 commit, after the contributor screen passes or on /test.
//   authorize     a maintainer's `/test` or `/test <sha>` comment binds the
//                 commit they reviewed. Refused if the head has moved.
//   finalize      waits for the tests and the Warden review on that commit,
//                 then passes or fails `contributor-pr-required`.
//
// A fork's own `pull_request` workflows come from the PR's merge commit, so a
// fork could rewrite them. Changes to CI or agent configuration are therefore
// refused here; a maintainer carries them to a same-repository branch instead
// (.opencode/skills/review-a-contributor-pr).
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SCREEN_CONTEXT, WARDEN_CONTEXT, upsertComment } from "./contributor-screen.mjs";

export const STATUS_CONTEXT = "contributor-pr-required";
export const CI_CHECK = "openwork-tests-required";
const SIGNOFF_MARKER = "<!-- contributor-pr:signoff -->";
const MAINTAINER_PERMISSIONS = ["admin", "maintain", "write"];
const REVIEW_MACHINERY = /^(\.github\/|\.opencode\/|opencode\.jsonc?$|warden\.toml$|\.warden\/|\.agents\/skills\/|\.claude\/skills\/)/;
const SIGN_OFF = /^Signed-off-by: .+ <([^<>\s]+)>\s*$/gm;

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 10) : "");

export function isFork(pr) {
  return !pr?.head?.repo || pr.head.repo.full_name !== pr.base?.repo?.full_name || pr.head.repo.fork === true;
}

export function isBot(pr) {
  return pr?.user?.type === "Bot";
}

// The author's own GitHub noreply address also counts as their sign-off.
function noreplyLogin(email) {
  const match = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  return match ? match[1] : null;
}

// A commit is signed off when a Signed-off-by trailer carries its author's
// email. A trailer naming someone else is not the author's certification.
export function unsignedCommits(commits) {
  return commits
    .filter((commit) => (commit.parents?.length ?? 1) <= 1)
    .filter((commit) => {
      const author = lower(commit.commit?.author?.email);
      const login = lower(commit.author?.login);
      const emails = [...(commit.commit?.message ?? "").matchAll(SIGN_OFF)].map((match) => lower(match[1]));
      const own = (email) => email === author || (login && noreplyLogin(email) === login);
      return !author || !emails.some(own);
    })
    .map((commit) => commit.sha);
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

function blockers({ pr, commits, files }) {
  const unsigned = unsignedCommits(commits);
  if (unsigned.length) {
    return {
      state: "failure",
      description: `${unsigned.length} commit(s) missing Signed-off-by. Run: git rebase --signoff origin/dev`,
      detail: `${unsigned.length === 1 ? "This commit has" : "These commits have"} no \`Signed-off-by\` line with the author's email: ${unsigned.map((sha) => `\`${short(sha)}\``).join(", ")}. Sign off with \`git rebase --signoff origin/dev\` and force-push. See CONTRIBUTING.md.`,
      unsigned,
    };
  }
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

export function gateDecision({ pr, commits, files }) {
  if (isBot(pr)) return { state: "success", description: "Bot pull request" };
  const blocked = blockers({ pr, commits, files });
  if (blocked) return blocked;
  if (!isFork(pr)) return { state: "success", description: "Every commit is signed off" };
  return { state: "pending", description: "Contributor screen, then a maintainer's /test" };
}

export function renderSignoffComment(decision) {
  if (decision.unsigned?.length) {
    return [
      SIGNOFF_MARKER,
      "### Sign-off missing",
      "",
      decision.detail,
      "",
      "```sh",
      "git rebase --signoff origin/dev",
      "git push --force-with-lease",
      "```",
      "",
      "To sign off future commits, use `git commit -s`.",
    ].join("\n");
  }
  return [SIGNOFF_MARKER, "### Sign-off: fixed", "", "Every commit is now signed off."].join("\n");
}

// `pushedAt` is when GitHub first saw the head (its earliest workflow run).
export function authorizeDecision({ permission, pr, command, commits, files, pushedAt, commentedAt, screen }) {
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
  const blocked = blockers({ pr, commits, files });
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

async function github(path, init = {}) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env("GH_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
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
  const [pr, commits, files] = await Promise.all([
    github(`/repos/${repo}/pulls/${number}`),
    paginate(`/repos/${repo}/pulls/${number}/commits`),
    paginate(`/repos/${repo}/pulls/${number}/files`),
  ]);
  return { pr, commits, files };
}

async function statusesFor(repo, sha) {
  return latestStatuses(await github(`/repos/${repo}/commits/${sha}/status?per_page=100`));
}

async function setStatus(repo, sha, { state, description, url }) {
  await github(`/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    body: JSON.stringify({ state, context: STATUS_CONTEXT, description: description.slice(0, 140), target_url: url }),
  });
}

async function hasComment(repo, number, marker) {
  const comments = await paginate(`/repos/${repo}/issues/${number}/comments`);
  return comments.some((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker));
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

async function main(mode) {
  const repo = env("GITHUB_REPOSITORY");
  const number = Number(env("PR_NUMBER"));
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;

  if (mode === "gate") {
    const data = await loadPr(repo, number);
    const decision = gateDecision(data);
    await setStatus(repo, data.pr.head.sha, { ...decision, url: runUrl });
    // Comment when sign-off is missing; mark it fixed once it is.
    if (decision.unsigned?.length || await hasComment(repo, number, SIGNOFF_MARKER)) {
      await upsertComment(repo, number, SIGNOFF_MARKER, renderSignoffComment(decision));
    }
    await output("fork", String(isFork(data.pr) && !isBot(data.pr)));
    await output("ok", String(decision.state !== "failure"));
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
    await setStatus(repo, decision.sha, { state: "pending", description: `Reviewed by @${actor}; waiting for tests and Warden`, url: runUrl });
    const { failed } = await approveRuns(repo, decision.sha);
    const note = failed.length ? ` I couldn't start ${failed.join(", ")}; approve them on the Checks tab.` : "";
    await reply(repo, number, `Running tests and the Warden review for \`${decision.sha}\`, as reviewed by @${actor}: ${runUrl}${note}`);
    await output("sha", decision.sha);
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
