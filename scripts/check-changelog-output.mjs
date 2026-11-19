import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const factsIndex = args.indexOf("--facts");
const factsPath = factsIndex === -1 ? null : args[factsIndex + 1];
const [tag, previousTag] = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--facts");

function fail(message) {
  console.error(`Changelog output check failed: ${message}`);
  process.exit(1);
}

if (!tag || !previousTag) {
  fail("usage: node scripts/check-changelog-output.mjs <tag> <prev> [--facts <release-facts.json>]");
}

const cwd = process.cwd();
const docsPath = "packages/docs/changelog.mdx";
const trackerPattern = /^changelog\/release-tracker-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/;
const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trimEnd();

if (!status) {
  fail("no changes found; the changelog agent did not modify any files");
}

const changedPaths = status.split("\n").map((line) => line.slice(3));
const unexpectedPaths = changedPaths.filter((path) => path !== docsPath && !trackerPattern.test(path));
if (unexpectedPaths.length > 0) {
  fail(`unexpected changed path(s): ${unexpectedPaths.join(", ")}`);
}
if (!changedPaths.includes(docsPath)) {
  fail(`${docsPath} was not changed`);
}
if (!changedPaths.some((path) => trackerPattern.test(path))) {
  fail("no release tracker file was changed");
}
console.log("Changed paths are limited to the changelog docs and release tracker files.");

const docs = readFileSync(resolve(cwd, docsPath), "utf8");
const openingUpdates = docs.match(/<Update /g)?.length ?? 0;
const closingUpdates = docs.match(/<\/Update>/g)?.length ?? 0;
if (openingUpdates !== closingUpdates) {
  fail(`unbalanced Update tags: found ${openingUpdates} opening and ${closingUpdates} closing tags`);
}

const compareLink = `[${tag}](https://github.com/different-ai/openwork/compare/${previousTag}...${tag})`;
const compareLinkCount = docs.split(compareLink).length - 1;
if (compareLinkCount !== 1) {
  fail(`expected the exact compare link ${compareLink} once, found ${compareLinkCount}`);
}

const versions = [...docs.matchAll(/^\s*## \[(v[0-9]+\.[0-9]+\.[0-9]+)\]\(/gm)].map((match) => match[1]);
function compareVersions(left, right) {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}
for (let index = 1; index < versions.length; index += 1) {
  if (compareVersions(versions[index - 1], versions[index]) <= 0) {
    fail(`docs versions are not strictly descending at ${versions[index - 1]} then ${versions[index]}`);
  }
}
console.log("Changelog Update tags, compare link, and version ordering are valid.");

const trackerDirectory = resolve(cwd, "changelog");
const trackerFiles = readdirSync(trackerDirectory)
  .filter((name) => /^release-tracker-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/.test(name))
  .sort();
const tagHeading = `## ${tag}`;
const containingTrackers = [];

for (const trackerFile of trackerFiles) {
  const path = resolve(trackerDirectory, trackerFile);
  const contents = readFileSync(path, "utf8");
  const headingCount = contents.split("\n").filter((line) => line === tagHeading).length;
  for (let count = 0; count < headingCount; count += 1) {
    containingTrackers.push({ path, contents });
  }
}

if (containingTrackers.length !== 1) {
  fail(`expected ${tagHeading} exactly once across release trackers, found ${containingTrackers.length}`);
}

const shortstat = execFileSync("git", ["diff", "--shortstat", `${previousTag}..${tag}`], {
  cwd,
  encoding: "utf8",
});
const insertions = Number(shortstat.match(/([0-9]+) insertion/)?.[1] ?? 0);
const deletions = Number(shortstat.match(/([0-9]+) deletion/)?.[1] ?? 0);
const locLine = `${insertions + deletions} lines changed since \`${previousTag}\` (${insertions} insertions, ${deletions} deletions).`;
const trackerContents = containingTrackers[0].contents;
if (!trackerContents.includes(locLine)) {
  fail(`tracker section is missing the exact LOC line: ${locLine}`);
}

const sectionStart = trackerContents.split("\n").findIndex((line) => line === tagHeading);
const sectionLines = trackerContents.split("\n").slice(sectionStart + 1);
const nextSection = sectionLines.findIndex((line) => line.startsWith("## "));
const section = (nextSection === -1 ? sectionLines : sectionLines.slice(0, nextSection)).join("\n");
const requiredHeadings = [
  "#### Commit",
  "#### Released at",
  "#### Title",
  "#### One-line summary",
  "#### Pull requests",
  "#### Behavior changes and removals",
  "#### Lines of code changed since previous release",
];
let previousHeadingIndex = -1;
for (const heading of requiredHeadings) {
  const headingIndex = section.indexOf(heading);
  if (headingIndex === -1) {
    fail(`${tagHeading} section is missing ${heading}`);
  }
  if (headingIndex <= previousHeadingIndex) {
    fail(`${tagHeading} section has ${heading} out of order`);
  }
  previousHeadingIndex = headingIndex;
}
console.log(`${tagHeading} appears once with the exact LOC line and all required headings in order.`);

// ---------------------------------------------------------------------------
// Content checks: the docs entry must read as user-facing release notes.
// ---------------------------------------------------------------------------

const docsLines = docs.split("\n");
const entryStart = docsLines.findIndex((line) => line.includes(compareLink));
const entryLines = [docsLines[entryStart]];
for (const line of docsLines.slice(entryStart + 1)) {
  if (/^\s*## \[v/.test(line) || /^\s*<\/?Update\b/.test(line)) break;
  entryLines.push(line);
}
const entry = entryLines.join("\n");
const title = docsLines[entryStart].split("):").slice(1).join("):").trim();
if (!title) fail(`${tag} docs entry has no title after the compare link`);

const bullets = entryLines.filter((line) => /^\s*- /.test(line));
if (bullets.length < 2 || bullets.length > 6) {
  fail(`${tag} docs entry must have 2–6 bullets, found ${bullets.length}`);
}
if (/(^|[\s(])#[0-9]{2,}\b/.test(entry)) {
  fail(`${tag} docs entry mentions a PR number; keep PR numbers in the tracker table`);
}

// Repo jargon that means nothing to people using OpenWork.
const jargon = [
  /\bACME\b/i,
  /\bworlds\b/i,
  /\bWarden\b/i,
  /\bFreestyle\b/i,
  /\bevals?\b/i,
  /\btestkit\b/i,
  /\btypecheck/i,
  /\bCI\b/,
  /\bprewarm/i,
  /\bsnapshots?\b/i,
  /\bDaytona\b/i,
  /\bMCP Apps?\b/i,
  /\brefactor/i,
];
const jargonHits = jargon.map((pattern) => entry.match(pattern)?.[0]).filter(Boolean);
if (jargonHits.length > 0) {
  fail(`${tag} docs entry uses internal jargon end users will not understand: ${[...new Set(jargonHits)].join(", ")}`);
}
console.log(`${tag} docs entry has ${bullets.length} bullets, no PR numbers, and no internal jargon.`);

// ---------------------------------------------------------------------------
// Coverage: every product and website PR gets an explicit decision.
// ---------------------------------------------------------------------------

const rows = new Map();
for (const line of section.split("\n")) {
  const match = line.match(/^\|\s*#([0-9]+)\s*\|\s*([^|]*?)\s*\|\s*(Included|Omitted)\s*\|\s*([^|]*?)\s*\|\s*$/);
  if (match) rows.set(Number(match[1]), { audience: match[2], decision: match[3], reason: match[4] });
}
if (rows.size === 0) fail(`${tagHeading} Pull requests table has no rows in the | #PR | Audience | Included/Omitted | Reason | format`);
for (const [number, row] of rows) {
  if (!row.reason) fail(`${tagHeading} Pull requests row for #${number} has no reason`);
}

if (factsPath) {
  const facts = JSON.parse(readFileSync(resolve(cwd, factsPath), "utf8"));
  const required = facts.prs.filter((pr) => pr.audience === "product" || pr.audience === "website");
  const missing = required.filter((pr) => !rows.has(pr.number)).map((pr) => `#${pr.number}`);
  if (missing.length > 0) {
    fail(`${tagHeading} Pull requests table is missing product/website PR(s): ${missing.join(", ")}`);
  }
  const includedInternal = facts.prs
    .filter((pr) => pr.audience === "internal" && rows.get(pr.number)?.decision === "Included")
    .map((pr) => `#${pr.number}`);
  if (includedInternal.length > 0) {
    fail(`${tagHeading} marks internal-only PR(s) as Included: ${includedInternal.join(", ")}`);
  }
  const included = [...rows.values()].filter((row) => row.decision === "Included").length;
  if (required.length > 0 && included === 0) {
    fail(`${tagHeading} omits every product/website PR; include at least one user-visible change`);
  }
  console.log(`${tagHeading} decides every product/website PR (${required.length}); ${included} included.`);
}
