#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER = 128 * 1024 * 1024;

function buildRunNumber(name) {
  const match = name.match(/-alpha\.(\d+)(?=[^0-9]|$)/);
  return match ? Number(match[1]) : null;
}

export function selectAlphaAssetsToPrune(assets, keepBuilds) {
  const runNumbers = assets
    .map((asset) => buildRunNumber(asset.name))
    .filter((runNumber) => runNumber !== null);
  const retainedRuns = new Set(
    [...new Set(runNumbers)].sort((left, right) => right - left).slice(0, keepBuilds),
  );

  return assets.filter((asset) => {
    const runNumber = buildRunNumber(asset.name);
    return runNumber !== null && !retainedRuns.has(runNumber);
  });
}

function parsePaginatedArrays(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array from gh api.");
  if (parsed.every(Array.isArray)) return parsed.flat();
  if (parsed.every((item) => !Array.isArray(item))) return parsed;
  throw new Error("Expected gh api pagination output to contain arrays of assets.");
}

function parseArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--repo", "--tag", "--keep"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const keep = Number(options.keep);
  if (!options.repo || !options.tag || !Number.isInteger(keep) || keep <= 0) {
    throw new Error("Usage: node scripts/release/prune-alpha-assets.mjs --repo <owner/name> --tag <tag> --keep <positive-integer> [--dry-run]");
  }
  return { repo: options.repo, tag: options.tag, keep, dryRun: options.dryRun };
}

function getRelease(repo, tag) {
  const result = spawnSync("gh", ["api", `repos/${repo}/releases/tags/${tag}`], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/HTTP 404/i.test(result.stderr)) return null;
  throw new Error(result.stderr.trim() || `gh api failed with exit code ${result.status ?? "unknown"}.`);
}

function listAssets(repo, releaseId) {
  const output = execFileSync(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repo}/releases/${releaseId}/assets?per_page=100`],
    { encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  return parsePaginatedArrays(output);
}

function main() {
  const { repo, tag, keep, dryRun } = parseArgs(process.argv.slice(2));
  const release = getRelease(repo, tag);
  if (!release) {
    console.log(`Release ${tag} does not exist in ${repo}; nothing to prune.`);
    return;
  }

  const assets = listAssets(repo, release.id);
  const deletions = selectAlphaAssetsToPrune(assets, keep);
  if (deletions.length === 0) {
    console.log(`Nothing to prune from ${tag}; keeping the newest ${keep} alpha builds.`);
    return;
  }

  for (const asset of deletions) {
    if (dryRun) {
      console.log(`Would delete ${asset.name}`);
      continue;
    }
    console.log(`Deleting ${asset.name}`);
    execFileSync("gh", ["api", "-X", "DELETE", `repos/${repo}/releases/assets/${asset.id}`], {
      stdio: "inherit",
    });
  }

  console.log(dryRun
    ? `Dry run: would delete ${deletions.length} asset(s) from ${tag}.`
    : `Deleted ${deletions.length} asset(s) from ${tag}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
