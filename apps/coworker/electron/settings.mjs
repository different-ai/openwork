/**
 * App-wide Open Coworker settings, kept as one small JSON file beside the
 * server registry. Only settings that genuinely apply across coworkers live
 * here; everything about one coworker stays in its own `coworker.md`.
 */
import { readFile, rename, writeFile } from "node:fs/promises";

export const SETTINGS_FILE = "coworker-settings.json";

/** How many responsibilities may run at the same time on this Mac. */
export const PARALLEL_RUNS_MIN = 1;
export const PARALLEL_RUNS_MAX = 4;
export const PARALLEL_RUNS_DEFAULT = 2;

export function clampParallelRuns(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return PARALLEL_RUNS_DEFAULT;
  return Math.min(PARALLEL_RUNS_MAX, Math.max(PARALLEL_RUNS_MIN, Math.round(number)));
}

export function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    maxParallelLocalRuns: clampParallelRuns(source.maxParallelLocalRuns),
  };
}

export async function readSettings(file) {
  try {
    return normalizeSettings(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return normalizeSettings({});
    throw error;
  }
}

export async function updateSettings(file, patch) {
  const current = await readSettings(file);
  const next = normalizeSettings({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  return next;
}
