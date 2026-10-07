#!/usr/bin/env node
// Contributor PR gate. Sets the `contributor-pr-required` commit status on a
// PR head. Runs only from the default branch (pull_request_target and
// issue_comment) and only reads PR metadata through the API: it never checks
// out, installs, or executes PR code.
//
//   gate       every PR event: DCO sign-off on every commit. Same-repository
//              PRs pass here. Fork PRs wait for a maintainer's `/test <sha>`.
//   authorize  a `/test <sha>` comment: a maintainer with write access binds
//              the commit they reviewed. Refused if the head has moved.
//   finalize   after authorize: wait for `openwork-tests-required` on that
//              exact commit, then pass or fail the status.
//
// A fork's own `pull_request` workflows come from the PR's merge commit, so a
// fork could rewrite them. Changes to CI or agent configuration are therefore
// refused here; a maintainer carries them to a same-repository branch instead
// (.opencode/skills/review-a-contributor-pr).
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const STATUS_CONTEXT = "contributor-pr-required";
export const CI_CHECK = "openwork-tests-required";
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

// `/test` alone asks for the head SHA; `/test <sha>` binds a reviewed commit.
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
      detail: `These commits have no \`Signed-off-by\` trailer with their author's email: ${unsigned.map((sha) => `\`${short(sha)}\``).join(", ")}. Sign off with \`git rebase --signoff origin/dev\` and force-push. See CONTRIBUTING.md.`,
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
  return {
    state: "pending",
    description: `Waiting for a maintainer to review and comment /test ${short(pr.head.sha)}`,
  };
}

export function authorizeDecision({ permission, pr, command, commits, files }) {
  if (!MAINTAINER_PERMISSIONS.includes(permission)) {
    return { ok: false, reply: "Only maintainers with write access can run `/test`." };
  }
  if (pr.state !== "open") return { ok: false, reply: "This pull request is not open." };
  if (!isFork(pr)) {
    return { ok: false, reply: "`/test` is for fork pull requests. This branch is in the repository, so its checks run automatically." };
  }
  const head = lower(pr.head.sha);
  if (!command.sha) {
    return { ok: false, reply: `Review the diff at \`${head}\`, then comment \`/test ${short(head)}\` to bind that commit.` };
  }
  if (!head.startsWith(command.sha)) {
    return { ok: false, reply: `The head is now \`${head}\`, not \`${command.sha}\`. Review the new commits, then comment \`/test ${short(head)}\`.` };
  }
  const blocked = blockers({ pr, commits, files });
  if (blocked) return { ok: false, reply: blocked.detail };
  return { ok: true, sha: head };
}

// Picks the newest completed run of the required CI check on that commit.
export function ciDecision(checkRuns) {
  const runs = checkRuns
    .filter((run) => run.name === CI_CHECK && run.app?.slug === "github-actions")
    .sort((a, b) => Date.parse(b.started_at ?? 0) - Date.parse(a.started_at ?? 0));
  const latest = runs[0];
  if (!latest) return { done: false };
  if (latest.status !== "completed") return { done: false };
  if (latest.conclusion === "success") return { done: true, state: "success", description: "Reviewed by a maintainer; CI passed" };
  return { done: true, state: "failure", description: `${CI_CHECK} concluded ${latest.conclusion}`, url: latest.html_url };
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
  return response.status === 204 ? null : response.json();
}

async function paginate(path) {
  const items = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const list = Array.isArray(batch) ? batch : batch.check_runs;
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

async function setStatus(repo, sha, { state, description, url }) {
  await github(`/repos/${repo}/statuses/${sha}`, {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(mode) {
  const repo = env("GITHUB_REPOSITORY");
  const number = Number(env("PR_NUMBER"));
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;

  if (mode === "gate") {
    const data = await loadPr(repo, number);
    const decision = gateDecision(data);
    await setStatus(repo, data.pr.head.sha, { ...decision, url: runUrl });
    console.log(`${STATUS_CONTEXT} on ${data.pr.head.sha}: ${decision.state} (${decision.description})`);
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
    const decision = authorizeDecision({ permission, command, ...data });
    if (!decision.ok) {
      await reply(repo, number, `@${actor} ${decision.reply}`);
      console.log(`Refused: ${decision.reply}`);
      return;
    }
    await setStatus(repo, decision.sha, { state: "pending", description: `Reviewed by @${actor}; waiting for CI`, url: runUrl });
    await reply(repo, number, `Checks for \`${decision.sha}\` were started by @${actor}: ${runUrl}`);
    await output("sha", decision.sha);
    return;
  }

  if (mode === "finalize") {
    const sha = env("HEAD_SHA");
    const deadline = Date.now() + Number(process.env.WAIT_MINUTES ?? 120) * 60_000;
    for (;;) {
      const decision = ciDecision(await paginate(`/repos/${repo}/commits/${sha}/check-runs?check_name=${CI_CHECK}`));
      if (decision.done) {
        await setStatus(repo, sha, { state: decision.state, description: decision.description, url: decision.url ?? runUrl });
        console.log(`${STATUS_CONTEXT} on ${sha}: ${decision.state}`);
        if (decision.state !== "success") process.exitCode = 1;
        return;
      }
      if (Date.now() > deadline) {
        await setStatus(repo, sha, {
          state: "failure",
          description: `${CI_CHECK} did not finish. Approve the fork's workflow runs, then comment /test again`,
          url: runUrl,
        });
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
