import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, selectChecks, skipReason } from "./check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("every check names a script that exists and says how to fix a failure", () => {
  for (const check of CHECKS) {
    assert.ok(check.fix.length > 20, `${check.name} has no fix`);
    const script = check.command.find((part) => /\.(mjs|ts)$/.test(part));
    if (script) assert.ok(existsSync(resolve(root, script)), `${check.name}: ${script} is missing`);
  }
});

test("the checks CI requires are the commands pnpm check runs", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/quick-check.yml"), "utf8");
  for (const command of [
    "node scripts/check-outbound-access.mjs",
    "node scripts/check-node-source-imports.mjs",
    "pnpm features:check",
    "node .github/scripts/typecheck-shipped.mjs --all",
    "node scripts/check-app-structure.mjs",
    "node scripts/check-package-names.mjs",
    "node scripts/check-code-habits.mjs",
    "node scripts/check-prose-habits.mjs",
  ]) {
    assert.ok(workflow.includes(command), `quick-check.yml no longer runs: ${command}`);
    assert.ok(CHECKS.some((check) => check.command.join(" ") === command), `pnpm check does not run: ${command}`);
  }
});

test("browser secret regressions run both locally and in the required CI check", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/quick-check.yml"), "utf8");
  const check = CHECKS.find((item) => item.name === "browser-secrets");
  assert.ok(check);
  for (const path of check.command.filter((part) => part.endsWith(".test.mjs"))) {
    assert.ok(workflow.includes(path), `quick-check.yml no longer runs ${path}`);
  }
});

test("a check whose tool is absent is skipped, not failed", () => {
  const features = CHECKS.find((check) => check.name === "features");
  assert.equal(skipReason(features, { has: () => false }), "helm is not installed");
  assert.equal(skipReason(features, { has: () => true }), null);
});

test("an unknown check name is an error that lists the known ones", () => {
  assert.throws(() => selectChecks(["typo"]), /Unknown check: typo\. Known: typecheck/);
  assert.deepEqual(selectChecks(["i18n"]).map((check) => check.name), ["i18n"]);
});

test("the API contract check skips without local MySQL and lints like the API Contract workflow", async () => {
  const { contractDatabaseUnavailable } = await import("./den-contract-database.mjs");
  const refused = async () => { throw new Error("connect ECONNREFUSED"); };
  const accepted = async () => ({ end: async () => {} });
  assert.match(await contractDatabaseUnavailable({ connect: refused }), /local MySQL is not reachable/);
  assert.equal(await contractDatabaseUnavailable({ connect: accepted }), null);
  assert.match(await contractDatabaseUnavailable({ url: "mysql://root:password@db.example.com:3306" }), /remote databases are never used/);
  assert.ok(CHECKS.some((check) => check.name === "api-contract" && check.unavailable));
  const workflow = readFileSync(resolve(root, ".github/workflows/api-contract.yml"), "utf8");
  assert.ok(workflow.includes("pnpm api:lint"), "api-contract.yml no longer runs the Spectral lint");
  assert.ok(readFileSync(resolve(root, "scripts/check-api-contract.mjs"), "utf8").includes("scripts/api-lint.mjs"));
});
