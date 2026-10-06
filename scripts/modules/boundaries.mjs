// Runs dependency-cruiser over the Den module roots (W0-08).
//
//   node scripts/modules/boundaries.mjs check     new error-severity violations fail; warnings only report
//   node scripts/modules/boundaries.mjs report    markdown report (for $GITHUB_STEP_SUMMARY)
//   node scripts/modules/boundaries.mjs baseline  rewrite known-violations.json with the current
//                                                 error-severity violations (warnings are never baselined)
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRUISE_ROOTS } from "./depcruise-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const depcruise = resolve(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const BASELINE = "scripts/modules/known-violations.json";

function run(args, capture) {
  return spawnSync(process.execPath, [depcruise, "--config", ".dependency-cruiser.mjs", ...args, ...CRUISE_ROOTS], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const command = process.argv[2];
if (command === "check") {
  process.exitCode = run(["--ignore-known", BASELINE, "--output-type", "err-long"], false).status ?? 1;
} else if (command === "report") {
  process.exitCode = run(["--ignore-known", BASELINE, "--output-type", "markdown"], false).status ?? 1;
} else if (command === "baseline") {
  const result = run(["--output-type", "json"], true);
  if (!result.stdout) {
    process.exitCode = 1;
  } else {
    const violations = JSON.parse(result.stdout).summary.violations
      .filter((violation) => violation.rule.severity === "error")
      .sort((a, b) => compareStrings(a.rule.name, b.rule.name) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
    writeFileSync(resolve(repoRoot, BASELINE), `${JSON.stringify(violations, null, 2)}\n`);
    console.log(`boundaries: wrote ${violations.length} error-severity violations to ${BASELINE}`);
  }
} else {
  console.error("usage: node scripts/modules/boundaries.mjs <check|report|baseline>");
  process.exitCode = 2;
}
