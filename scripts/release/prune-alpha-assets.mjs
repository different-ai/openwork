#!/usr/bin/env node
import { createGithubReleaseClient } from "./github-release.mjs";
import { isTransientNetworkFailure } from "./network-retry.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const github = createGithubReleaseClient();

function buildRunNumber(name) {
  const match = name.match(/-alpha\.(\d+)(?=[^0-9]|$)/);
  return match ? Number(match[1]) : null;
}

export function selectAlphaAssetsToPrune(assets, keepBuilds, protectedRunNumber = null) {
  const runNumbers = assets
    .map((asset) => buildRunNumber(asset.name))
    .filter((runNumber) => runNumber !== null);
  const retainedRuns = new Set(
    [...new Set(runNumbers)].sort((left, right) => right - left).slice(0, keepBuilds),
  );

  return assets.filter((asset) => {
    const runNumber = buildRunNumber(asset.name);
    return runNumber !== null && runNumber !== protectedRunNumber && !retainedRuns.has(runNumber);
  });
}

function parseArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--allow-transient-failure") continue;
    if (["--repo", "--tag", "--keep", "--protect-run"].includes(arg)) {
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
  const protectedRunNumber = options["protect-run"] === undefined ? null : Number(options["protect-run"]);
  if (protectedRunNumber !== null && (!Number.isSafeInteger(protectedRunNumber) || protectedRunNumber <= 0)) {
    throw new Error("--protect-run requires a positive run number.");
  }
  return { repo: options.repo, tag: options.tag, keep, dryRun: options.dryRun, protectedRunNumber };
}

async function main() {
  const { repo, tag, keep, dryRun, protectedRunNumber } = parseArgs(process.argv.slice(2));
  const release = await github.getRelease(repo, tag);
  if (!release) {
    console.log(`Release ${tag} does not exist in ${repo}; nothing to prune.`);
    return;
  }

  const assets = await github.listAssets(repo, release.id);
  const deletions = selectAlphaAssetsToPrune(assets, keep, protectedRunNumber);
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
    await github.deleteAsset(repo, asset.id);
  }

  console.log(dryRun
    ? `Dry run: would delete ${deletions.length} asset(s) from ${tag}.`
    : `Deleted ${deletions.length} asset(s) from ${tag}.`);
}

// Cleanup runs only after publication succeeded. It may defer on an exhausted
// transport outage, but permission, validation and other deterministic failures
// remain fatal. Callers must explicitly opt in; standalone pruning stays strict.
export function canDeferPruning(error, args) {
  return args.includes("--allow-transient-failure")
    && isTransientNetworkFailure(error instanceof Error ? error.message : String(error));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canDeferPruning(error, process.argv.slice(2))) {
      console.warn(`::warning::Alpha retention cleanup deferred after network retries; the published build is unaffected.`);
      console.warn(message);
    } else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}
