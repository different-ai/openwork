// Contribution guard for fork pull requests (CONTRIBUTING.md §1 and §2).
//
// Pure decision logic is exported for `node --test`; `main` only reads PR
// metadata through the GitHub REST API. It never fetches or executes PR code.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CLA_LABEL = "cla-signed";
export const EE_PREFIX = "ee/";

const CLA_DOCUMENTS = [
  "legal/individual-contributor-license-agreement.md",
  "legal/corporate-contributor-license-agreement.md",
];

export function signoffEmails(message) {
  const emails = [];
  for (const line of message.split(/\r?\n/)) {
    const match = /^Signed-off-by:\s*.*<([^>]+)>\s*$/i.exec(line.trim());
    if (match) emails.push(match[1].trim().toLowerCase());
  }
  return emails;
}

// GitHub noreply addresses: `login@users.noreply.github.com` or `ID+login@users.noreply.github.com`.
export function isNoreplyFor(email, login) {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(\\d+\\+)?${escaped}@users\\.noreply\\.github\\.com$`, "i").test(email);
}

export function checkSignoffs(commits, prAuthorLogin) {
  const problems = [];
  for (const commit of commits) {
    // Merge commits carry no authorship of their own; the DCO app skips them too.
    if ((commit.parents?.length ?? 0) > 1) continue;
    const author = (commit.commit.author?.email ?? "").toLowerCase();
    const emails = signoffEmails(commit.commit.message);
    if (emails.some((email) => email === author || isNoreplyFor(email, prAuthorLogin))) continue;
    // Never echo emails or logins: this report lands in public logs and the step summary.
    const subject = commit.commit.message.split(/\r?\n/, 1)[0];
    const reason = emails.length
      ? "Signed-off-by email does not match the commit author email or the PR author's GitHub noreply address"
      : "missing Signed-off-by trailer";
    problems.push(`${commit.sha.slice(0, 7)} "${subject}": ${reason}`);
  }
  return problems;
}

export function eePaths(files) {
  return files
    .flatMap((file) => [file.filename, file.previous_filename])
    .filter((path) => typeof path === "string" && path.startsWith(EE_PREFIX));
}

export function evaluate({ repository, headRepository, prAuthorLogin, labels, commits, files }) {
  if (headRepository === repository) {
    return { verdict: "skipped", dco: [], ee: [], reason: "same-repository pull request; employees are covered by their employment terms" };
  }
  const dco = checkSignoffs(commits, prAuthorLogin);
  const ee = labels.includes(CLA_LABEL) ? [] : eePaths(files);
  return { verdict: dco.length || ee.length ? "fail" : "pass", dco, ee };
}

export function report(result) {
  const lines = ["# Contribution guard", ""];
  if (result.verdict === "skipped") {
    lines.push(`Skipped: ${result.reason}.`);
  } else if (result.verdict === "pass") {
    lines.push("PASS: every commit carries a matching `Signed-off-by:` trailer and no `ee/` path is touched without the CLA label.");
  }
  if (result.dco.length) {
    lines.push(
      "## DCO sign-off missing",
      "",
      "CONTRIBUTING.md §1: \"Every commit must be signed off, certifying the Developer Certificate of Origin v1.1. Pull requests with unsigned commits cannot be merged.\"",
      "",
      ...result.dco.map((problem) => `- ${problem}`),
      "",
      "Remedy: sign new commits with `git commit -s`, or add the trailer to existing commits with `git rebase --signoff origin/dev` and force-push. The trailer email must match the commit author email (or your GitHub noreply address).",
      "",
    );
  }
  if (result.ee.length) {
    lines.push(
      "## Contributor License Agreement required for `ee/`",
      "",
      "CONTRIBUTING.md §2: \"Contributions to code under ee/ additionally require a Contributor License Agreement.\" This pull request changes:",
      "",
      ...result.ee.map((path) => `- \`${path}\``),
      "",
      `Remedy: sign the applicable CLA (${CLA_DOCUMENTS.map((path) => `\`${path}\``).join(" or ")}) and send it to your OpenWork contact. A maintainer adds the \`${CLA_LABEL}\` label once it is on file; the check re-runs on labeling.`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function api(path, token, paginate = false) {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  if (!paginate) {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return response.json();
  }
  const items = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${base}${path}?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    const batch = await response.json();
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, PR_NUMBER: number } = process.env;
  if (!token || !repository || !/^\d+$/.test(number ?? "")) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and a numeric PR_NUMBER are required.");
  }
  const prefix = `/repos/${repository}/pulls/${number}`;
  const pull = await api(prefix, token);
  const headRepository = pull.head.repo?.full_name ?? "";
  let commits = [];
  let files = [];
  if (headRepository !== repository) {
    [commits, files] = await Promise.all([api(`${prefix}/commits`, token, true), api(`${prefix}/files`, token, true)]);
    if (commits.length !== pull.commits) {
      throw new Error(`Listed ${commits.length} of ${pull.commits} commits; refusing to verify a partial commit list.`);
    }
  }
  const result = evaluate({
    repository,
    headRepository,
    prAuthorLogin: pull.user.login,
    labels: pull.labels.map((label) => label.name),
    commits,
    files,
  });
  const text = report(result);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exitCode = result.verdict === "fail" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
