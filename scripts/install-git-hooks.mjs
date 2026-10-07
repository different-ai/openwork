#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
if (configured.status !== 0 && configured.status !== 1) throw new Error("Could not read Git hook configuration.");
const current = configured.stdout.trim();
if (!existsSync(resolve(root, ".githooks/pre-commit"))) throw new Error("This checkout does not contain the contract pre-commit hook.");
if (current && current !== ".githooks") throw new Error(`Existing core.hooksPath is ${current}; refusing to replace your hooks.`);
const hook = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], { cwd: root, encoding: "utf8" }).trim();
if (!current && existsSync(resolve(root, hook))) throw new Error("An existing pre-commit hook is installed; compose the contract hook with it instead.");
execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: root });
console.log("Installed the optional contract pre-commit hook. Disable with git config --local --unset core.hooksPath.");
