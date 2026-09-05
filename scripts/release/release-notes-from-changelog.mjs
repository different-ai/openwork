#!/usr/bin/env node
// Extract one release's entry from packages/docs/changelog.mdx and print it as
// GitHub Release notes markdown. Lines of the existing release body that carry
// the Windows code-signing note (*Windows ...*) are preserved at the end so the
// generated notes replace only the static "What's new" boilerplate.
//
// Usage:
//   node scripts/release/release-notes-from-changelog.mjs <tag> [--docs <path>] [--existing-body <path>]

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const tag = args.find((arg) => !arg.startsWith("--"));
let docsPath = "packages/docs/changelog.mdx";
let existingBodyPath = null;

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--docs") docsPath = args[index + 1];
  if (args[index] === "--existing-body") existingBodyPath = args[index + 1];
}

function fail(message) {
  console.error(`release-notes-from-changelog: ${message}`);
  process.exit(1);
}

if (!tag || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
  fail("usage: release-notes-from-changelog.mjs <vX.Y.Z> [--docs <path>] [--existing-body <path>]");
}

const docs = readFileSync(docsPath, "utf8").split("\n");
const headingPattern = /^\s*## \[(v[0-9]+\.[0-9]+\.[0-9]+)\]\((https:\/\/github\.com\/[^)]+)\):\s*(.+?)\s*$/;

let start = -1;
let compareUrl = "";
let title = "";
for (let index = 0; index < docs.length; index += 1) {
  const match = docs[index].match(headingPattern);
  if (match && match[1] === tag) {
    start = index;
    compareUrl = match[2];
    title = match[3];
    break;
  }
}
if (start === -1) fail(`${tag} is not documented in ${docsPath}`);

const body = [];
for (let index = start + 1; index < docs.length; index += 1) {
  const line = docs[index];
  if (headingPattern.test(line) || /^\s*<\/Update>/.test(line) || /^\s*<Update\b/.test(line)) break;
  body.push(line.replace(/^ {2}/, ""));
}
while (body.length > 0 && body[0].trim() === "") body.shift();
while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
if (body.length === 0) fail(`${tag} has an empty changelog entry in ${docsPath}`);

const preserved = [];
if (existingBodyPath) {
  for (const line of readFileSync(existingBodyPath, "utf8").split("\n")) {
    if (/^\*Windows .*\*\s*$/.test(line)) preserved.push(line.trim());
  }
}

const notes = [
  `## ${title}`,
  "",
  ...body,
  "",
  `Full changelog: https://openworklabs.com/docs/changelog · [Compare](${compareUrl})`,
];
if (preserved.length > 0) notes.push("", ...preserved);

process.stdout.write(`${notes.join("\n")}\n`);
