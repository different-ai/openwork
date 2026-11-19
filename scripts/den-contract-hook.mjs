#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isContractInput(path) {
  return path.startsWith("ee/apps/den-api/src/")
    || path.startsWith("ee/apps/den-api/scripts/")
    || /^ee\/packages\/[^/]+\/(src\/|package\.json$)/.test(path)
    || path.startsWith("packages/types/src/")
    || path.startsWith("packages/features/src/")
    || path.startsWith("packages/mcp-apps/")
    || path.startsWith("packages/sdk/script/")
    || path.startsWith("scripts/den-contract")
    || /^packages\/[^/]+\/package\.json$/.test(path)
    || path === "packages/sdk/tsconfig.json"
    || ["package.json", "pnpm-lock.yaml", "constants.json", "pnpm-workspace.yaml", "ee/apps/den-api/tsconfig.json", "apps/app/package.json", "ee/apps/den-api/package.json", "packages/sdk/package.json"].includes(path);
}

export function runContractHook({ cwd = process.cwd(), generate } = {}) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const paths = (args) => git(args).split("\0").filter(Boolean);
  const staged = paths(["diff", "--cached", "--no-renames", "--name-only", "-z"]);
  if (!staged.some(isContractInput)) return false;

  const conflicts = paths(["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (conflicts.length) throw new Error("Resolve source conflicts before generating the API contract.");

  const unstaged = paths(["diff", "--name-only", "-z"]);
  const untracked = paths(["ls-files", "--others", "--exclude-standard", "-z"]);
  const unsafe = [...new Set([...unstaged, ...untracked].filter((path) => isContractInput(path)))];
  if (unsafe.length) {
    throw new Error(`Contract generation stopped: unstaged or untracked contract inputs:\n${unsafe.join("\n")}\nStage the intended changes or finish the partial commit first. Nothing was generated.`);
  }

  console.log("Validating OpenAPI and SDK from this commit's sources...");
  if (generate) generate();
  else execFileSync("pnpm", ["den:contract"], { cwd, stdio: "inherit", shell: process.platform === "win32" });
  // Generated outputs are ignored; the index stays exactly as the contributor staged it.
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runContractHook(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
