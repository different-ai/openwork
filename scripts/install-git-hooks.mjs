#!/usr/bin/env node
// Points this clone's Git hooks at .githooks. `pnpm install` runs it with
// --auto, which never fails an install and never replaces hooks you already
// have; `pnpm hooks:install` reports why it could not.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const auto = process.argv.includes("--auto");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, out: (result.stdout ?? "").trim() };
}

function install() {
  if (auto && process.env.CI) return null;
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return "This is not a Git checkout.";
  const root = top.out;
  if (!existsSync(resolve(root, ".githooks/pre-push"))) return "This checkout does not contain .githooks.";
  const configured = git(["config", "--get", "core.hooksPath"], root);
  if (configured.status !== 0 && configured.status !== 1) return "Could not read Git hook configuration.";
  if (!auto && git(["config", "--local", "openwork.contractHook", "true"], root).status === 0) {
    console.log("Turned on the contract pre-commit hook. Turn it off with git config --local --unset openwork.contractHook.");
  }
  if (configured.out === ".githooks") return null;
  // A path set outside this clone that names no folder here runs no hooks, so there is nothing to replace.
  const local = git(["config", "--local", "--get", "core.hooksPath"], root).out;
  if (configured.out && (local || existsSync(resolve(root, configured.out)))) return `Existing core.hooksPath is ${configured.out}; refusing to replace your hooks.`;
  for (const name of ["pre-commit", "pre-push"]) {
    const hook = git(["rev-parse", "--git-path", `hooks/${name}`], root);
    if (hook.status === 0 && existsSync(resolve(root, hook.out))) return `An existing ${name} hook is installed; call the one in .githooks from it instead.`;
  }
  if (git(["config", "--local", "core.hooksPath", ".githooks"], root).status !== 0) return "Could not write Git hook configuration.";
  console.log("Installed Git hooks: pre-push runs `pnpm check`. Disable with git config --local --unset core.hooksPath.");
  return null;
}

const problem = install();
if (problem && !auto) {
  console.error(problem);
  process.exit(1);
}
