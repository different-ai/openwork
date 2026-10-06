// Shrink-only ratchet for scripts/modules/known-violations.json (W0-08).
// Run: node scripts/modules/check-boundary-ratchet.mjs   (needs origin/dev: git fetch origin dev)
//
// The baseline may only lose entries compared with origin/dev. The one exception is the PR
// that flips enforced-modules.json `core` from false to true: it may add Core rule entries
// once. Entries that no longer occur are reported so the file can be shrunk.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRUISE_ROOTS } from "./depcruise-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const BASELINE = "scripts/modules/known-violations.json";
const ENFORCED = "scripts/modules/enforced-modules.json";

function entryKey(entry) {
  return `${entry.rule.name}: ${entry.from} -> ${entry.to}`;
}

/**
 * @param {{ base: object[], head: object[], baseEnforced: { core: boolean }, headEnforced: { core: boolean }, current?: object[] }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function compareBaselines({ base, head, baseEnforced, headEnforced, current }) {
  const errors = [];
  const warnings = [];
  const baseKeys = new Set(base.map(entryKey));
  const coreFlip = !baseEnforced.core && headEnforced.core;
  for (const entry of head) {
    if (baseKeys.has(entryKey(entry))) continue;
    if (coreFlip && entry.rule.name.startsWith("core-")) continue;
    errors.push(`${entryKey(entry)} was added to known-violations.json; fix the import instead (the baseline only shrinks)`);
  }
  if (current) {
    const currentKeys = new Set(current.map(entryKey));
    for (const entry of head) {
      if (!currentKeys.has(entryKey(entry))) warnings.push(`${entryKey(entry)} is now clean; remove it from known-violations.json`);
    }
  }
  return { errors, warnings };
}

function readFromOriginDev(path, fallback) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/dev"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    throw new Error("origin/dev is not available; run `git fetch origin dev` first");
  }
  try {
    return JSON.parse(execFileSync("git", ["show", `origin/dev:${path}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return fallback;
  }
}

function currentViolations() {
  const depcruise = resolve(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
  const result = spawnSync(
    process.execPath,
    [depcruise, "--config", ".dependency-cruiser.mjs", "--output-type", "json", ...CRUISE_ROOTS],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (!result.stdout) throw new Error(`depcruise produced no output:\n${result.stderr}`);
  return JSON.parse(result.stdout).summary.violations;
}

function main() {
  const head = JSON.parse(readFileSync(resolve(repoRoot, BASELINE), "utf8"));
  const headEnforced = JSON.parse(readFileSync(resolve(repoRoot, ENFORCED), "utf8"));
  const base = readFromOriginDev(BASELINE, []);
  const baseEnforced = readFromOriginDev(ENFORCED, { core: false, modules: [] });
  const { errors, warnings } = compareBaselines({
    base,
    head,
    baseEnforced,
    headEnforced,
    current: head.length > 0 ? currentViolations() : undefined,
  });
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);
  if (errors.length > 0) {
    console.error(`check-boundary-ratchet failed:\n- ${errors.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`check-boundary-ratchet: ${head.length} known violations (origin/dev: ${base.length})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
