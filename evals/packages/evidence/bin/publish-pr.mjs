#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRollAge, publishPr, readRollFile, scanRolls } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const resultsDir = join(repoRoot, "evals", "results");
const args = process.argv.slice(2);
let pr;
let rollArg;
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
  if (arg === "--pr" || arg === "--roll") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--pr") pr = value;
    else rollArg = value;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!dryRun && !shouldOpen && !pr) throw new Error("--pr <n> is required unless --dry-run or --open is set.");
if (shouldOpen && (pr || dryRun || force)) throw new Error("--open cannot be combined with --pr, --dry-run, or --force.");
const entries = (await scanRolls(resultsDir)).filter((entry) => entry.kind === "roll");
let rollDir;
let selectedRoll;
if (rollArg) {
  const candidate = isAbsolute(rollArg) ? rollArg : resolve(process.cwd(), rollArg);
  if (existsSync(join(candidate, "roll.json"))) {
    rollDir = candidate;
    selectedRoll = await readRollFile(join(candidate, "roll.json"));
  }
  else {
    const selected = entries.find((entry) => entry.directoryName === rollArg || entry.name === rollArg);
    rollDir = selected?.directoryPath;
    selectedRoll = selected?.roll;
  }
} else {
  rollDir = entries[0]?.directoryPath;
  selectedRoll = entries[0]?.roll;
}
if (!rollDir || !selectedRoll) throw new Error(`No photo roll found${rollArg ? ` for ${rollArg}` : ""}.`);

process.stdout.write(`Selected roll: ${selectedRoll.name} · SHA ${selectedRoll.gitSha ?? "unknown"} · ${formatRollAge(selectedRoll.createdAt)}\n`);

if (shouldOpen) {
  if (process.platform !== "darwin") throw new Error("--open is only supported on darwin.");
  const indexPath = join(rollDir, "index.html");
  if (!existsSync(indexPath)) throw new Error(`Selected roll has no index.html: ${indexPath}`);
  const opened = spawnSync("open", [indexPath], { stdio: "inherit" });
  if (opened.error || opened.status !== 0) throw opened.error ?? new Error(`open exited ${opened.status}`);
  process.exit(0);
}

const result = await publishPr({ pr, rollDir, dryRun, force });
if (!dryRun) process.stdout.write(`${result.updated ? "Updated" : "Posted"} photo roll for PR ${pr}.\n`);
