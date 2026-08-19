#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeTestRun } from "../src/test-evidence.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const testRunsDir = join(repoRoot, "evals", "results", "test-runs");
const args = process.argv.slice(2);
let testRunArg;
let force = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") continue;
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "--test-run") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--test-run requires a value.");
    testRunArg = value;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!testRunArg) throw new Error("--test-run <path|directory-id|latest|name> is required.");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hasTestRun(directory) {
  try {
    await access(join(directory, "test-run.json"));
    return true;
  } catch {
    return false;
  }
}

async function recordedTestRuns() {
  let entries;
  try {
    entries = await readdir(testRunsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const testRuns = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(testRunsDir, entry.name);
    try {
      const value = JSON.parse(await readFile(join(directory, "test-run.json"), "utf8"));
      if (!isRecord(value) || typeof value.name !== "string" || typeof value.createdAt !== "string") continue;
      testRuns.push({ directory, directoryId: entry.name, name: value.name, createdAt: value.createdAt });
    } catch {
      // Ignore incomplete or corrupt test-run directories while resolving a selection.
    }
  }
  return testRuns.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function resolveTestRun() {
  if (testRunArg === "latest") return (await recordedTestRuns())[0]?.directory;
  const candidates = [
    isAbsolute(testRunArg) ? testRunArg : resolve(process.cwd(), testRunArg),
    resolve(repoRoot, testRunArg),
    join(testRunsDir, testRunArg),
  ];
  for (const candidate of candidates) {
    if (await hasTestRun(candidate)) return candidate;
  }
  const testRuns = await recordedTestRuns();
  return testRuns.find((testRun) => testRun.directoryId === testRunArg || testRun.name === testRunArg)?.directory;
}

const testRunDir = await resolveTestRun();
if (!testRunDir) throw new Error(`No test run found for ${testRunArg}.`);

const result = await judgeTestRun(testRunDir, { force });
for (const error of result.errors) process.stderr.write(`Pending: ${error}\n`);
process.stdout.write(`Judged ${result.judgedValidations} visual validation(s): ${result.failedValidations} failed, ${result.pendingValidations} pending.\n${result.testRunPath}\n`);
process.exitCode = result.pendingValidations > 0 ? 2 : result.failedValidations > 0 ? 1 : 0;
