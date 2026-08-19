#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTestRunAge, publishPr, readTestRunDirectory, scanTestRuns } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const resultsDir = join(repoRoot, "evals", "results");
const args = process.argv.slice(2);
let pr;
let testRunArg;
let dryRun = false;
let force = false;
let shouldOpen = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") continue;
  if (arg === "--dry-run") {
    dryRun = true;
    continue;
  }
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "--open") {
    shouldOpen = true;
    continue;
  }
  if (arg === "--pr" || arg === "--test-run") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--pr") pr = value;
    else testRunArg = value;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!dryRun && !shouldOpen && !pr) throw new Error("--pr <n> is required unless --dry-run or --open is set.");
if (shouldOpen && (pr || dryRun || force)) throw new Error("--open cannot be combined with --pr, --dry-run, or --force.");
const entries = (await scanTestRuns(resultsDir)).filter((entry) => entry.kind === "test-run");
let testRunDir;
let selectedTestRun;
if (testRunArg && testRunArg !== "latest") {
  const candidate = isAbsolute(testRunArg) ? testRunArg : resolve(process.cwd(), testRunArg);
  const stored = await readTestRunDirectory(candidate);
  if (stored) {
    testRunDir = candidate;
    selectedTestRun = stored.testRun;
  } else {
    const selected = entries.find((entry) => entry.directoryName === testRunArg || entry.name === testRunArg);
    testRunDir = selected?.directoryPath;
    selectedTestRun = selected?.testRun;
  }
} else {
  testRunDir = entries[0]?.directoryPath;
  selectedTestRun = entries[0]?.testRun;
}
if (!testRunDir || !selectedTestRun) throw new Error(`No test run found${testRunArg ? ` for ${testRunArg}` : ""}.`);

process.stdout.write(`Selected test run: ${selectedTestRun.name} · SHA ${selectedTestRun.gitSha ?? "unknown"} · ${formatTestRunAge(selectedTestRun.createdAt)}\n`);

if (shouldOpen) {
  if (process.platform !== "darwin") throw new Error("--open is only supported on darwin.");
  const indexPath = join(testRunDir, "index.html");
  if (!existsSync(indexPath)) throw new Error(`Selected test run has no index.html: ${indexPath}`);
  const opened = spawnSync("open", [indexPath], { stdio: "inherit" });
  if (opened.error || opened.status !== 0) throw opened.error ?? new Error(`open exited ${opened.status}`);
  process.exit(0);
}

const result = await publishPr({ pr, testRunDir, dryRun, force });
if (!dryRun) process.stdout.write(`${result.updated ? "Updated" : "Posted"} test evidence for PR ${pr}.\n`);
