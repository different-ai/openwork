import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PARALLEL_RUNS_DEFAULT, clampParallelRuns, readSettings, updateSettings } from "./settings.mjs";

const roots = [];
async function settingsFile() {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-settings-"));
  roots.push(root);
  return path.join(root, "coworker-settings.json");
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("the parallel-run limit has a sensible default and stays within 1–4", () => {
  assert.equal(clampParallelRuns(undefined), PARALLEL_RUNS_DEFAULT);
  assert.equal(clampParallelRuns("nonsense"), PARALLEL_RUNS_DEFAULT);
  assert.equal(clampParallelRuns(0), 1);
  assert.equal(clampParallelRuns(-3), 1);
  assert.equal(clampParallelRuns(3.4), 3);
  assert.equal(clampParallelRuns(99), 4);
});

test("settings read, update, and survive a damaged file", async () => {
  const file = await settingsFile();
  assert.deepEqual(await readSettings(file), { maxParallelLocalRuns: PARALLEL_RUNS_DEFAULT });
  assert.deepEqual(await updateSettings(file, { maxParallelLocalRuns: 1 }), { maxParallelLocalRuns: 1 });
  assert.deepEqual(await readSettings(file), { maxParallelLocalRuns: 1 });
  assert.deepEqual(await updateSettings(file, { unrelated: true }), { maxParallelLocalRuns: 1 });
  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual(await readSettings(file), { maxParallelLocalRuns: PARALLEL_RUNS_DEFAULT });
});
