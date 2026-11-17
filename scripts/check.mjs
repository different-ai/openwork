#!/usr/bin/env node
// The required PR checks that need no database or packaging, run locally:
// `pnpm check`. The pre-push hook runs it, and CI ("Quick check") runs the
// same commands, so a red check is found here before a push instead of after.
//
// Usage: node scripts/check.mjs [--list] [name ...]
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportProcessTiming } from "./lib/process-timing.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each check: the command CI runs, and what to do when it is red. */
export const CHECKS = [
  {
    name: "typecheck",
    command: ["node", ".github/scripts/typecheck-shipped.mjs", "--all"],
    fix: "Fix the type errors above. Do not silence them with `any`, `as` or @ts-ignore.",
  },
  {
    name: "node-source-imports",
    command: ["node", "scripts/check-node-source-imports.mjs"],
    fix: "Den API and the Gateway load this source in plain Node: import what Node can resolve, as the message says.",
  },
  {
    name: "outbound-access",
    command: ["node", "scripts/check-outbound-access.mjs"],
    fix: "Declare the new outbound host in docs/enterprise/outbound-access.json, or remove the call.",
  },
  {
    name: "features",
    command: ["pnpm", "features:check"],
    needs: "helm",
    fix: "Run `pnpm features:sync` and commit what it writes.",
  },
  {
    name: "i18n",
    command: ["node", "scripts/i18n-audit.mjs", "--ci"],
    fix: "Add the missing key to apps/app/src/i18n/locales/en.ts, or remove the unused one.",
  },
  {
    name: "spec-lint",
    command: ["pnpm", "--dir", "evals", "lint:specs"],
    requires: "evals/node_modules",
    fix: "Follow the rule named above; `write-a-spec` explains the spec layers.",
  },
];

function onPath(binary) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [binary], { stdio: "ignore" }).status === 0;
}

/** Why a check cannot run here, or null when it can. */
export function skipReason(check, { root = ROOT, has = onPath } = {}) {
  if (check.needs && !has(check.needs)) return `${check.needs} is not installed`;
  if (check.requires && !existsSync(resolve(root, check.requires))) return `${check.requires} is missing`;
  return null;
}

export function selectChecks(names, checks = CHECKS) {
  if (!names.length) return checks;
  const unknown = names.filter((name) => !checks.some((check) => check.name === name));
  if (unknown.length) throw new Error(`Unknown check: ${unknown.join(", ")}. Known: ${checks.map((check) => check.name).join(", ")}.`);
  return checks.filter((check) => names.includes(check.name));
}

function run(check) {
  return new Promise((done) => {
    const started = performance.now();
    const [command, ...args] = check.command;
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => done({ check, code: 1, output: String(error), seconds: 0 }));
    child.on("close", (code) => done({ check, code, output, seconds: (performance.now() - started) / 1000 }));
  });
}

async function main(argv) {
  if (argv.includes("--list")) {
    for (const check of CHECKS) console.log(`${check.name.padEnd(20)} ${check.command.join(" ")}`);
    return 0;
  }
  if (!existsSync(resolve(ROOT, "node_modules"))) {
    console.error("Dependencies are not installed. Run `pnpm install`, then `pnpm check`.");
    return 1;
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const selected = selectChecks(argv.filter((arg) => !arg.startsWith("--")));
  const runnable = [];
  const skipped = [];
  for (const check of selected) {
    const reason = skipReason(check);
    if (reason) {
      console.log(`skip ${check.name}: ${reason}; CI still runs it.`);
      skipped.push({ step: check.name, seconds: 0, outcome: "skipped" });
    } else runnable.push(check);
  }
  const results = await Promise.all(runnable.map(run));
  const failed = results.filter((result) => result.code !== 0);
  for (const result of results) console.log(`${result.code === 0 ? "ok  " : "FAIL"} ${result.seconds.toFixed(1).padStart(5)}s ${result.check.name}`);
  for (const result of failed) {
    console.error(`\n--- ${result.check.name}: ${result.check.command.join(" ")}\n${result.output.trim()}\n\nFix: ${result.check.fix}`);
  }
  if (failed.length) console.error(`\n${failed.length} check(s) failed. Rerun one with \`pnpm check ${failed[0].check.name}\`.`);
  await reportProcessTiming({
    process: "check",
    startedAt,
    totalSeconds: (performance.now() - started) / 1000,
    outcome: failed.length ? "fail" : "ok",
    steps: [...results.map((result) => ({
      step: result.check.name,
      seconds: result.seconds,
      outcome: result.code === 0 ? "ok" : "fail",
    })), ...skipped],
  });
  return failed.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
