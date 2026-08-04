#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER = 128 * 1024 * 1024;
const RELEASE_GROUPS = [
  { group: "alpha", pattern: /^alpha-macos-v\d/ },
  { group: "dev", pattern: /^v[0-9a-f]{7}-dev$/ },
  { group: "channel-alias", pattern: /^(knoppers|kitkat)-\d/ },
  { group: "channel-build", pattern: /^(canary|experimental)-macos-v\d/ },
];
const SIDECAR_GROUPS = [
  { group: "sidecar-orchestrator", pattern: /^openwork-orchestrator-v\d/ },
  { group: "sidecar-openwrk", pattern: /^openwrk-v\d/ },
];

export function selectReleasesToPurge(releases, { includeSidecarBundles, protectedTags }) {
  const protection = new Set(protectedTags);
  const groups = includeSidecarBundles
    ? [...RELEASE_GROUPS, ...SIDECAR_GROUPS]
    : RELEASE_GROUPS;

  return releases.flatMap((release) => {
    const tag = release.tag_name;
    if (
      typeof tag !== "string"
      || tag === "alpha-macos-latest"
      || /^v\d+\.\d+\.\d+/.test(tag)
      || protection.has(tag)
    ) {
      return [];
    }
    const matchedGroup = groups.find(({ pattern }) => pattern.test(tag));
    return matchedGroup ? [{ tag, group: matchedGroup.group }] : [];
  });
}

function parsePaginatedArrays(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array from gh api.");
  if (parsed.every(Array.isArray)) return parsed.flat();
  if (parsed.every((item) => !Array.isArray(item))) return parsed;
  throw new Error("Expected gh api pagination output to contain arrays of releases.");
}

function parseArgs(args) {
  const options = { execute: false, includeSidecarBundles: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute") {
      options.execute = true;
      continue;
    }
    if (arg === "--include-sidecar-bundles") {
      options.includeSidecarBundles = true;
      continue;
    }
    if (["--repo", "--out"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.repo) {
    throw new Error("Usage: node scripts/release/purge-legacy-releases.mjs --repo <owner/name> [--execute] [--include-sidecar-bundles] [--out <path>]");
  }
  return options;
}

async function readManifestProtectedTags(repo) {
  const url = `https://github.com/${repo}/releases/download/alpha-macos-latest/latest-mac.yml`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch the live alpha manifest (${response.status} ${response.statusText}); refusing to continue.`);
  }
  const manifest = await response.text();
  const tags = new Set();
  for (const match of manifest.matchAll(/\/releases\/download\/([^/\s"'?#]+)\//g)) {
    tags.add(decodeURIComponent(match[1]));
  }
  return tags;
}

function listReleases(repo) {
  const output = execFileSync(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`],
    { encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  return parsePaginatedArrays(output);
}

function printPlan(selections, groupNames, protectedMatches, manifestTags) {
  const counts = new Map(groupNames.map((group) => [group, 0]));
  for (const { group } of selections) counts.set(group, counts.get(group) + 1);

  console.log("Group\tCount");
  for (const [group, count] of counts) console.log(`${group}\t${count}`);
  console.log(`total\t${selections.length}`);
  console.log("Live alpha manifest release tags:");
  console.log(manifestTags.size > 0 ? [...manifestTags].sort().map((tag) => `  ${tag}`).join("\n") : "  (none)");
  console.log("Protected matching tags excluded from deletion:");
  console.log(protectedMatches.length > 0 ? protectedMatches.map((tag) => `  ${tag}`).join("\n") : "  (none)");
}

function writePlan(path, selections, releases) {
  const releasesByTag = new Map(releases.map((release) => [release.tag_name, release]));
  const rows = selections.map(({ tag, group }) => {
    const release = releasesByTag.get(tag);
    return `${tag}\t${group}\t${release.created_at}`;
  });
  writeFileSync(path, `tag\tgroup\tcreated_at\n${rows.join("\n")}${rows.length ? "\n" : ""}`, "utf8");
  console.log(`Wrote ${selections.length} release(s) to ${path}.`);
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestTags = await readManifestProtectedTags(options.repo);
  const releases = listReleases(options.repo);
  const selectionOptions = {
    includeSidecarBundles: options.includeSidecarBundles,
    protectedTags: manifestTags,
  };
  const selections = selectReleasesToPurge(releases, selectionOptions);
  const withoutManifestProtection = selectReleasesToPurge(releases, {
    ...selectionOptions,
    protectedTags: [],
  });
  const selectedTags = new Set(selections.map(({ tag }) => tag));
  const protectedMatches = withoutManifestProtection
    .map(({ tag }) => tag)
    .filter((tag) => !selectedTags.has(tag));
  const groupNames = [
    ...RELEASE_GROUPS.map(({ group }) => group),
    ...(options.includeSidecarBundles ? SIDECAR_GROUPS.map(({ group }) => group) : []),
  ];

  printPlan(selections, groupNames, protectedMatches, manifestTags);
  if (options.out) writePlan(options.out, selections, releases);
  if (!options.execute) {
    console.log("Dry run only; pass --execute to delete these releases and tags.");
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (let index = 0; index < selections.length; index += 1) {
    const { tag, group } = selections[index];
    console.log(`Deleting ${tag} (${group})`);
    const result = spawnSync(
      "gh",
      ["release", "delete", tag, "--repo", options.repo, "--cleanup-tag", "--yes"],
      { stdio: "inherit" },
    );
    if (result.status === 0) deleted += 1;
    else failed += 1;
    if (index < selections.length - 1) await delay(150);
  }
  console.log(`Deletion complete: ${deleted} deleted, ${failed} failed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
