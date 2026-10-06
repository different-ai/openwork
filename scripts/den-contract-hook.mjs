#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const contractOutputs = ["packages/docs/openapi.json", "packages/sdk/src/gen"];

export function isContractInput(path) {
  return path.startsWith("ee/apps/den-api/src/")
    || path.startsWith("ee/apps/den-api/scripts/")
    || /^ee\/packages\/[^/]+\/(src\/|package\.json$)/.test(path)
    || path.startsWith("packages/types/src/")
    || path.startsWith("packages/mcp-apps/")
    || path.startsWith("packages/sdk/script/")
    || ["package.json", "pnpm-lock.yaml", "apps/app/package.json", "ee/apps/den-api/package.json", "packages/sdk/package.json", "scripts/den-contract.mjs"].includes(path);
}

function isOutput(path) {
  return path === contractOutputs[0] || path.startsWith(`${contractOutputs[1]}/`);
}

export function runContractHook({ cwd = process.cwd(), generate } = {}) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const paths = (args) => git(args).split("\0").filter(Boolean);
  const staged = paths(["diff", "--cached", "--no-renames", "--name-only", "-z"]);
  if (!staged.some((path) => isContractInput(path) || isOutput(path))) return false;

  const conflicts = paths(["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (conflicts.length) throw new Error("Resolve source conflicts, then run pnpm den:contract and stage the generated files before committing.");

  const unstaged = paths(["diff", "--name-only", "-z"]);
  const untracked = paths(["ls-files", "--others", "--exclude-standard", "-z"]);
  const unsafe = [...new Set([...unstaged, ...untracked].filter((path) => isContractInput(path) || isOutput(path)))];
  if (unsafe.length) {
    throw new Error(`Contract generation stopped: unstaged or untracked contract inputs/outputs:\n${unsafe.join("\n")}\nStage the intended changes or finish the partial commit first. Nothing was generated or staged.`);
  }

  console.log("Updating OpenAPI and SDK for this commit...");
  if (generate) generate();
  else execFileSync("pnpm", ["den:contract"], { cwd, stdio: "inherit", shell: process.platform === "win32" });
  // Only generated outputs enter the index; never stage source or unrelated work.
  git(["add", "--", ...contractOutputs]);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runContractHook(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
