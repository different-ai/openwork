#!/usr/bin/env node
// The required PR checks that need no packaging, run locally: `pnpm check`.
// The pre-push hook runs it, and CI ("Quick check") runs the same commands, so
// a red check is found here before a push instead of after. api-contract also
// needs local MySQL and is skipped without it; the API Contract workflow runs
// the same lint after a merge to dev.
//
// Usage: node scripts/check.mjs [--list] [name ...]
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contractDatabaseUnavailable } from "./den-contract-database.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each check: the command CI runs, and what to do when it is red. */
export const CHECKS = [
  {
    name: "typecheck",
    command: ["node", ".github/scripts/typecheck-shipped.mjs", "--all"],
    fix: "Fix the type errors above. Do not silence them with `any`, `as` or @ts-ignore.",
  },
  {
    name: "demo-desktops-types",
    command: ["pnpm", "exec", "tsc", "-p", "scripts/demo/tsconfig.json"],
    fix: "Fix the demo launcher type errors; do not silence or cast them away.",
  },
  {
    name: "demo-desktops",
    command: ["node", "--test", "scripts/demo/launch.test.ts"],
    fix: "Fix the offline demo snapshot, privacy, lifetime or cleanup regression; never bypass the allowlist.",
  },
  {
    name: "browser-secrets",
    command: ["node", "--conditions=development", "--test", "packages/computer-use/browser-secrets.test.mjs", "packages/computer-use/browser-task-secrets.test.mjs", "packages/computer-use/browser-secrets.review.test.mjs", "packages/computer-use/computer-control-secret-approval.test.mjs", "packages/computer-use/value-command.test.mjs", "packages/computer-use/browser-task-values.test.mjs", "packages/computer-use/value-use.test.mjs", "packages/computer-use/private-value-use.test.mjs", "packages/computer-use/computer-control-value-approval.test.mjs", "apps/desktop/electron/session-runner-computer-requests.test.mjs", "apps/desktop/test/ui-control-private-redact.test.mjs", "apps/desktop/electron/private-values.test.mjs"],
    fix: "Fix the secret isolation, approval or redaction regression above before enabling browser secret handles or private values.",
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
    name: "deployment-capabilities",
    command: ["pnpm", "--filter", "@openwork/managed-deployments", "test"],
    fix: "An installer, the Helm chart or Den no longer matches packages/managed-deployments/src/capabilities.ts. Update the catalog (and its gaps) in the same change; do not edit the test to fit.",
  },
  {
    name: "den-env-parity",
    command: ["pnpm", "--filter", "@openwork-ee/den-api", "test:env"],
    fix: "den-api now reads an existing installation's environment differently. Restore the old reading; if the change is intended, run `pnpm --filter @openwork-ee/den-api env:parity:write` and review every changed line.",
  },
  {
    name: "i18n",
    command: ["node", "scripts/i18n-audit.mjs", "--ci"],
    fix: "Add the missing key to apps/app/src/i18n/locales/en.ts, or remove the unused one.",
  },
  {
    name: "app-structure",
    command: ["node", "scripts/check-app-structure.mjs"],
    fix: "Move the code to the folder the message names. Do not add the violation to the baseline.",
  },
  {
    name: "package-names",
    command: ["node", "scripts/check-package-names.mjs"],
    fix: "Name the package @openwork/<folder> (@openwork-ee/<folder> under ee/), family first, as the message says.",
  },
  {
    name: "code-habits",
    command: ["node", "scripts/check-code-habits.mjs"],
    fix: "Remove the comment, effect, any, cast, non-null assertion, suppression or console.log as the message says. Do not add it to the baseline.",
  },
  {
    name: "prose-habits",
    command: ["node", "scripts/check-prose-habits.mjs"],
    fix: "Rewrite the flagged markdown line as the message says. Code blocks and inline code are not checked.",
  },
  {
    name: "api-contract",
    command: ["node", "scripts/check-api-contract.mjs"],
    unavailable: () => contractDatabaseUnavailable(),
    fix: "Fix the new API lint findings above (docs/api-style.md), or document a deliberate exception in .spectral.yaml overrides. Never raise the baseline.",
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
  const selected = selectChecks(argv.filter((arg) => !arg.startsWith("--")));
  const runnable = [];
  for (const check of selected) {
    const reason = skipReason(check) ?? (check.unavailable ? await check.unavailable() : null);
    if (reason) console.log(`skip ${check.name}: ${reason}; CI still runs it.`);
    else runnable.push(check);
  }
  const results = await Promise.all(runnable.map(run));
  const failed = results.filter((result) => result.code !== 0);
  for (const result of results) console.log(`${result.code === 0 ? "ok  " : "FAIL"} ${result.seconds.toFixed(1).padStart(5)}s ${result.check.name}`);
  for (const result of failed) {
    console.error(`\n--- ${result.check.name}: ${result.check.command.join(" ")}\n${result.output.trim()}\n\nFix: ${result.check.fix}`);
  }
  if (failed.length) console.error(`\n${failed.length} check(s) failed. Rerun one with \`pnpm check ${failed[0].check.name}\`.`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
