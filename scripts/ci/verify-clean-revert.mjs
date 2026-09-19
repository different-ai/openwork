#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!["--base", "--head", "--reverted"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  if (!options.base || !options.head) {
    throw new Error("Usage: node scripts/ci/verify-clean-revert.mjs --base <sha> --head <sha> [--reverted <sha>]");
  }
  if (options.reverted && !SHA_PATTERN.test(options.reverted)) {
    throw new Error("--reverted must be a full 40-character commit SHA.");
  }
  return options;
}

function command(run, args, cwd, allowFailure = false) {
  const result = run("git", args, { cwd, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result;
}

function parseRevertedSha(message) {
  const matches = [...message.matchAll(/This reverts commit ([0-9a-f]{40})/gi)];
  const shas = new Set(matches.map((match) => match[1].toLowerCase()));
  if (shas.size === 0) throw new Error("head commit message has no 'This reverts commit <40-hex>' line");
  if (shas.size > 1) throw new Error("head commit message names multiple distinct reverted commits; only single-commit reverts are supported");
  return [...shas][0];
}

export function verifyCleanRevert(options, run = spawnSync) {
  for (const name of ["base", "head", "reverted"]) {
    if ((name !== "reverted" || options[name]) && !SHA_PATTERN.test(options[name] ?? "")) {
      throw new Error(`${name} must be a full 40-character commit SHA.`);
    }
  }
  const cwd = process.cwd();
  let reverted = options.reverted?.toLowerCase();
  if (!reverted) {
    const message = command(run, ["log", "-1", "--format=%B", options.head], cwd).stdout;
    reverted = parseRevertedSha(message);
  }

  const parents = command(run, ["rev-list", "--parents", "-n", "1", reverted], cwd).stdout.trim().split(/\s+/);
  if (parents.length > 2) throw new Error("reverted commit is a merge commit; only non-merge commits are supported");

  const ancestor = command(run, ["merge-base", "--is-ancestor", reverted, options.base], cwd, true);
  if (ancestor.status !== 0) throw new Error("reverted commit is not an ancestor of the PR base");

  const tempRoot = mkdtempSync(resolve(tmpdir(), "verify-clean-revert-"));
  const worktree = resolve(tempRoot, "worktree");
  let added = false;
  try {
    command(run, ["worktree", "add", "--detach", worktree, options.base], cwd);
    added = true;
    const revert = command(run, ["revert", "--no-commit", "--no-edit", reverted], worktree, true);
    if (revert.status !== 0) throw new Error("revert does not apply cleanly to PR base");

    const expectedTree = command(run, ["write-tree"], worktree).stdout.trim();
    const headTree = command(run, ["rev-parse", `${options.head}^{tree}`], cwd).stdout.trim();
    if (expectedTree !== headTree) throw new Error("PR tree is not the exact inverse of the reverted commit");
    return reverted;
  } finally {
    if (added) command(run, ["worktree", "remove", "--force", worktree], cwd, true);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  let reverted = "";
  try {
    const options = parseArgs(process.argv.slice(2));
    reverted = options.reverted?.toLowerCase() ?? "";
    reverted = verifyCleanRevert(options);
    console.log(`PASS clean-revert of ${reverted}`);
    console.log("verdict=pass");
    console.log(`reverted=${reverted}`);
  } catch (error) {
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    console.log("verdict=fail");
    console.log(`reverted=${reverted}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
