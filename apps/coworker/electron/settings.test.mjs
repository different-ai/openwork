import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  MAX_RUNS_PER_DAY_DEFAULT,
  MINIMUM_RUN_GAP_DEFAULT,
  PARALLEL_RUNS_DEFAULT,
  clampMaxRunsPerDay,
  clampMinimumRunGap,
  clampParallelRuns,
  readSettings,
  scheduleGuardrails,
  updateSettings,
} from "./settings.mjs";

const roots = [];
async function settingsFile() {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-settings-"));
  roots.push(root);
  return path.join(root, "coworker-settings.json");
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const defaults = {
  maxParallelLocalRuns: PARALLEL_RUNS_DEFAULT,
  minimumRunGapMinutes: MINIMUM_RUN_GAP_DEFAULT,
  maxRunsPerDay: MAX_RUNS_PER_DAY_DEFAULT,
};

test("the parallel-run limit has a sensible default and stays within 1–8", () => {
  assert.equal(clampParallelRuns(undefined), PARALLEL_RUNS_DEFAULT);
  assert.equal(clampParallelRuns("nonsense"), PARALLEL_RUNS_DEFAULT);
  assert.equal(clampParallelRuns(0), 1);
  assert.equal(clampParallelRuns(-3), 1);
  assert.equal(clampParallelRuns(3.4), 3);
  assert.equal(clampParallelRuns(6), 6);
  assert.equal(clampParallelRuns(99), 8);
});

test("schedule guardrails default to an hour between runs and four runs a day", () => {
  assert.equal(clampMinimumRunGap(undefined), 60);
  assert.equal(clampMinimumRunGap(15), 15);
  assert.equal(clampMinimumRunGap(30), 30);
  assert.equal(clampMinimumRunGap(45), 60);
  assert.equal(clampMinimumRunGap("nonsense"), 60);
  assert.equal(clampMaxRunsPerDay(undefined), 4);
  assert.equal(clampMaxRunsPerDay(0), 1);
  assert.equal(clampMaxRunsPerDay(6.6), 7);
  assert.equal(clampMaxRunsPerDay(100), 12);
  assert.deepEqual(scheduleGuardrails(defaults), { minimumGapMinutes: 60, maxRunsPerDay: 4 });
});

test("settings read, update, and survive a damaged file", async () => {
  const file = await settingsFile();
  assert.deepEqual(await readSettings(file), defaults);
  assert.deepEqual(await updateSettings(file, { maxParallelLocalRuns: 1 }), { ...defaults, maxParallelLocalRuns: 1 });
  assert.deepEqual(await readSettings(file), { ...defaults, maxParallelLocalRuns: 1 });
  assert.deepEqual(await updateSettings(file, { unrelated: true }), { ...defaults, maxParallelLocalRuns: 1 });
  assert.deepEqual(await updateSettings(file, { minimumRunGapMinutes: 30, maxRunsPerDay: 6 }), {
    maxParallelLocalRuns: 1,
    minimumRunGapMinutes: 30,
    maxRunsPerDay: 6,
  });
  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual(await readSettings(file), defaults);
});
