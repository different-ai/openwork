#!/usr/bin/env node
// Collect the pull requests that shipped between two release tags and sort
// them by who they affect, so the changelog agent writes from PR descriptions
// instead of guessing from one-line commit subjects.
//
// Usage:
//   node scripts/release/collect-release-prs.mjs <prev> <tag> --json <path> --markdown <path>
//
// Requires `gh` with a token that can read pull requests (GITHUB_TOKEN in CI).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Paths no end user, admin, or self-hoster ever sees.
const INTERNAL_PATH_PATTERNS = [
  /^\.github\//,
  /^\.opencode\//,
  /^\.warden\//,
  /^\.agents\//,
  /^evals\//,
  /(^|\/)scripts\//,
  /^changelog\//,
  /^docs\//,
  /^worlds\//,
  /^packages\/world\//,
  /^warden\.toml$/,
  /^apps\/review\//,
  /^packages\/review\//,
  /^packages\/freestyle\//,
  /^packages\/agent-lab\//,
  /^apps\/labs\//,
  /^apps\/story-book\//,
  /^apps\/ui-demo\//,
  /^ee\/apps\/enterprise-mock-lab\//,
  /^packages\/enterprise-mcp-mock-server\//,
  /(^|\/)(tests?|__tests__|fixtures)\//,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/,
  /\.e2e\.test\.[cm]?[jt]sx?$/,
  /^(AGENTS|DESIGN|CONTRIBUTING|CLAUDE)\.md$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)\.env\.example$/,
];

// Public website and documentation: visible, but not a product change.
const WEBSITE_PATH_PATTERNS = [/^ee\/apps\/landing\//, /^packages\/landing\//, /^packages\/docs\//, /^README\.md$/];

const INTERNAL_TITLE_PATTERN = /^(chore|ci|test|build)(\(.+?\))?!?:/i;
const SELF_TITLE_PATTERN = /^docs\(changelog\)/i;
const NO_NOTE_PATTERN = /^(none|n\/a|na|-|no|internal|no user[- ]facing change\.?)$/i;

const BODY_LIMIT = 1400;

export function parseCommits(log) {
  return log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [hash, ...rest] = line.split("\t");
      const subject = rest.join("\t");
      const match = subject.match(/\(#([0-9]+)\)\s*$/);
      return { hash, subject, pr: match ? Number(match[1]) : null };
    });
}

// Remove every HTML comment. Repeats until nothing changes, so overlapping
// markers such as "<!<!--x-->--" cannot leave a "<!--" behind; an unterminated
// comment drops the rest of the text.
export function stripHtmlComments(text) {
  let current = text;
  for (;;) {
    let next = "";
    let index = 0;
    for (;;) {
      const start = current.indexOf("<!--", index);
      if (start === -1) {
        next += current.slice(index);
        break;
      }
      next += current.slice(index, start);
      const end = current.indexOf("-->", start + 4);
      if (end === -1) break;
      index = end + 3;
    }
    if (next === current) return next;
    current = next;
  }
}

export function extractReleaseNote(body) {
  if (!body) return null;
  const lines = stripHtmlComments(body).split("\n");
  const start = lines.findIndex((line) => /^#{2,3}\s*release notes?\s*$/i.test(line.trim()));
  if (start === -1) return null;
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break;
    collected.push(line);
  }
  const note = collected.join("\n").trim();
  return note === "" ? null : note;
}

export function cleanBody(body, limit = BODY_LIMIT) {
  if (!body) return "";
  const cleaned = stripHtmlComments(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<\/?details>|<\/?summary>/gi, "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}…` : cleaned;
}

export function summarizeAreas(paths) {
  const areas = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    const depth = parts[0] === "ee" ? 3 : 2;
    areas.add(parts.slice(0, Math.min(depth, parts.length - 1) || 1).join("/"));
  }
  return [...areas].slice(0, 6);
}

// Returns { audience, reason } where audience is "product", "website", "internal", or "skip".
export function classifyPr({ title, paths, releaseNote }) {
  if (SELF_TITLE_PATTERN.test(title)) return { audience: "skip", reason: "previous changelog entry" };
  if (releaseNote && NO_NOTE_PATTERN.test(releaseNote.trim())) {
    return { audience: "internal", reason: "author marked the release note as none" };
  }
  const visible = paths.filter((path) => !INTERNAL_PATH_PATTERNS.some((pattern) => pattern.test(path)));
  const product = visible.filter((path) => !WEBSITE_PATH_PATTERNS.some((pattern) => pattern.test(path)));
  if (product.length > 0) {
    if (INTERNAL_TITLE_PATTERN.test(title) && !releaseNote) {
      return { audience: "product", reason: "maintenance change touching product code; include only if users notice" };
    }
    return { audience: "product", reason: "touches product code" };
  }
  if (visible.length > 0) return { audience: "website", reason: "touches only the public website or docs" };
  if (paths.length === 0) return { audience: "product", reason: "no file list available; review by hand" };
  return { audience: "internal", reason: "touches only CI, tests, review tooling, or scripts" };
}

function fetchPullRequests(repo, numbers) {
  const [owner, name] = repo.split("/");
  const results = new Map();
  for (let index = 0; index < numbers.length; index += 25) {
    const batch = numbers.slice(index, index + 25);
    const fields = batch
      .map(
        (number) =>
          `pr${number}: pullRequest(number: ${number}) { number title url body author { login } labels(first: 20) { nodes { name } } files(first: 100) { nodes { path } } }`,
      )
      .join("\n");
    const query = `query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`;
    const raw = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const repository = JSON.parse(raw).data?.repository ?? {};
    for (const number of batch) {
      const pr = repository[`pr${number}`];
      if (pr) results.set(number, pr);
    }
  }
  return results;
}

export function renderMarkdown({ prev, tag, prs, commitsWithoutPr }) {
  const byAudience = (audience) => prs.filter((pr) => pr.audience === audience);
  const lines = [
    `# Release facts: ${tag} (since ${prev})`,
    "",
    "Collected by scripts/release/collect-release-prs.mjs. Every PR under Product and Website must get a row in the tracker's Pull requests table.",
    "",
  ];
  const renderFull = (pr) => {
    lines.push(`### #${pr.number} ${pr.title}`, "");
    lines.push(`- Areas: ${pr.areas.join(", ") || "unknown"}`);
    lines.push(`- Classifier: ${pr.audience} (${pr.reason})`);
    if (pr.author) lines.push(`- Author: ${pr.author}`);
    lines.push(`- Author's release note: ${pr.releaseNote ? pr.releaseNote.replace(/\n+/g, " ") : "(not provided)"}`, "");
    if (pr.body) {
      lines.push("PR description:", "", ...pr.body.split("\n").map((line) => `> ${line}`), "");
    }
  };
  const product = byAudience("product");
  lines.push(`## Product (${product.length})`, "");
  if (product.length === 0) lines.push("None.", "");
  product.forEach(renderFull);
  const website = byAudience("website");
  lines.push(`## Website and docs (${website.length})`, "");
  if (website.length === 0) lines.push("None.", "");
  website.forEach(renderFull);
  const internal = byAudience("internal");
  lines.push(`## Internal (${internal.length})`, "", "Do not describe these individually. At most one closing bullet may mention them in plain language.", "");
  if (internal.length === 0) lines.push("None.");
  for (const pr of internal) lines.push(`- #${pr.number} ${pr.title} (${pr.areas.join(", ")})`);
  lines.push("");
  if (commitsWithoutPr.length > 0) {
    lines.push(`## Commits without a pull request (${commitsWithoutPr.length})`, "");
    for (const commit of commitsWithoutPr) lines.push(`- ${commit.hash.slice(0, 9)} ${commit.subject}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const [prev, tag] = positional;
  const jsonPath = option("--json");
  const markdownPath = option("--markdown");
  const repo = option("--repo") ?? process.env.GITHUB_REPOSITORY ?? "different-ai/openwork";
  if (!prev || !tag || (!jsonPath && !markdownPath)) {
    console.error("usage: collect-release-prs.mjs <prev> <tag> --json <path> --markdown <path> [--repo owner/name]");
    process.exit(1);
  }

  const log = execFileSync("git", ["log", "--no-merges", "--format=%H%x09%s", `${prev}..${tag}`], { encoding: "utf8" });
  const commits = parseCommits(log);
  const numbers = [...new Set(commits.map((commit) => commit.pr).filter((number) => number !== null))];
  const fetched = fetchPullRequests(repo, numbers);

  const prs = [];
  for (const number of numbers) {
    const pr = fetched.get(number);
    const commit = commits.find((entry) => entry.pr === number);
    const title = pr?.title ?? commit.subject.replace(/\s*\(#[0-9]+\)\s*$/, "");
    const paths = pr?.files?.nodes?.map((file) => file.path) ?? [];
    const releaseNote = extractReleaseNote(pr?.body ?? "");
    const { audience, reason } = classifyPr({ title, paths, releaseNote });
    if (audience === "skip") continue;
    prs.push({
      number,
      title,
      url: pr?.url ?? `https://github.com/${repo}/pull/${number}`,
      author: pr?.author?.login ?? null,
      labels: pr?.labels?.nodes?.map((label) => label.name) ?? [],
      areas: summarizeAreas(paths),
      audience,
      reason,
      releaseNote,
      body: audience === "internal" ? "" : cleanBody(pr?.body ?? ""),
    });
  }
  const commitsWithoutPr = commits.filter((commit) => commit.pr === null);
  const facts = { prev, tag, prs, commitsWithoutPr };

  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(facts, null, 2)}\n`);
  if (markdownPath) writeFileSync(markdownPath, renderMarkdown(facts));
  const count = (audience) => prs.filter((pr) => pr.audience === audience).length;
  console.log(
    `Collected ${prs.length} PRs for ${tag}: ${count("product")} product, ${count("website")} website, ${count("internal")} internal, ${commitsWithoutPr.length} commits without a PR.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
