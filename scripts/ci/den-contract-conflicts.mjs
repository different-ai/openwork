#!/usr/bin/env node
// Classifies what merging the base branch into a PR head would conflict on.
// When every conflicted path is part of the generated Den API contract, the
// Den Contract Conflicts workflow resolves the merge by regenerating the
// contract (`pnpm den:contract`) from the merged route source.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GENERATED_CONTRACT_PATHS = ["packages/docs/openapi.json", "packages/sdk/src/gen/"];

export function isGeneratedContractPath(path) {
  return GENERATED_CONTRACT_PATHS.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!["--base", "--head"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  if (!options.base || !options.head) {
    throw new Error("Usage: node scripts/ci/den-contract-conflicts.mjs --base <ref> --head <ref>");
  }
  return options;
}

// `clean`: merges without conflicts. `generated`: only generated contract
// files conflict, so regeneration resolves it. `manual`: anything else.
export function classifyConflicts(options, run = spawnSync) {
  const result = run(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", options.base, options.head],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status === 0) return { status: "clean", files: [] };
  if (result.status !== 1) {
    throw new Error(result.stderr.trim() || `git merge-tree failed with exit code ${result.status ?? "unknown"}.`);
  }
  // First line is the merged tree id; the conflicted paths follow.
  const files = [...new Set(result.stdout.split("\n").slice(1).filter(Boolean))].sort();
  if (files.length === 0) return { status: "manual", files };
  return { status: files.every(isGeneratedContractPath) ? "generated" : "manual", files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(classifyConflicts(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
