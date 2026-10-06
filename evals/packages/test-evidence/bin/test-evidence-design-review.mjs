#!/usr/bin/env node
// Review the design of every screenshot in a recorded test run: measured
// layout rules, plus a critique against evals/design-review/rubric.md and
// DESIGN.md when OPENAI_API_KEY or ANTHROPIC_API_KEY is set.
//   pnpm --dir evals design:review -- --test-run latest [--no-vision] [--force]
import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDesignReview, reviewDesign } from "../src/design-review.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const testRunsDir = join(repoRoot, "evals", "results", "test-runs");
const args = process.argv.slice(2);
let testRunArg;
let vision = true;
let force = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") continue;
  if (arg === "--no-vision") { vision = false; continue; }
  if (arg === "--force") { force = true; continue; }
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

async function hasTestRun(directory) {
  return access(join(directory, "test-run.json")).then(() => true, () => false);
}

async function recordedTestRuns() {
  const entries = await readdir(testRunsDir, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(testRunsDir, entry.name);
    try {
      const value = JSON.parse(await readFile(join(directory, "test-run.json"), "utf8"));
      if (typeof value?.name === "string" && typeof value?.createdAt === "string") runs.push({ directory, directoryId: entry.name, name: value.name, createdAt: value.createdAt });
    } catch {
      // Skip incomplete runs while resolving a selection.
    }
  }
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function resolveTestRun() {
  if (testRunArg === "latest") return (await recordedTestRuns())[0]?.directory;
  for (const candidate of [isAbsolute(testRunArg) ? testRunArg : resolve(process.cwd(), testRunArg), resolve(repoRoot, testRunArg), join(testRunsDir, testRunArg)]) {
    if (await hasTestRun(candidate)) return candidate;
  }
  const runs = await recordedTestRuns();
  return runs.find((run) => run.directoryId === testRunArg || run.name === testRunArg)?.directory;
}

const testRunDir = await resolveTestRun();
if (!testRunDir) throw new Error(`No test run found for ${testRunArg}.`);
const record = JSON.parse(await readFile(join(testRunDir, "test-run.json"), "utf8"));
const review = await reviewDesign(testRunDir, { vision, bypassCache: force });
process.stdout.write(`${renderDesignReview(record.name ?? testRunDir, review)}${join(testRunDir, "design-review.json")}\n`);
