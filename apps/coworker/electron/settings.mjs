/**
 * App-wide Open Coworker settings, kept as one small JSON file beside the
 * server registry. Only settings that genuinely apply across coworkers live
 * here; everything about one coworker stays in its own `coworker.md`.
 */
import { readFile, rename, writeFile } from "node:fs/promises";

export const SETTINGS_FILE = "coworker-settings.json";

/** How many responsibilities may run at the same time on this Mac. */
export const PARALLEL_RUNS_MIN = 1;
export const PARALLEL_RUNS_MAX = 8;
export const PARALLEL_RUNS_DEFAULT = 2;

/**
 * Guardrails for schedules a coworker sets up itself: the least time between
 * two runs of one assignment, and the most runs one assignment may make in a
 * day. A schedule outside them is refused with a sentence the coworker relays.
 */
export const MINIMUM_RUN_GAP_CHOICES = [15, 30, 60];
export const MINIMUM_RUN_GAP_DEFAULT = 60;
export const MAX_RUNS_PER_DAY_MIN = 1;
export const MAX_RUNS_PER_DAY_MAX = 12;
export const MAX_RUNS_PER_DAY_DEFAULT = 4;

export function clampParallelRuns(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return PARALLEL_RUNS_DEFAULT;
  return Math.min(PARALLEL_RUNS_MAX, Math.max(PARALLEL_RUNS_MIN, Math.round(number)));
}

/** Snap to one of the offered gaps; anything else falls back to the default. */
export function clampMinimumRunGap(value) {
  const number = Number(value);
  return MINIMUM_RUN_GAP_CHOICES.includes(number) ? number : MINIMUM_RUN_GAP_DEFAULT;
}

export function clampMaxRunsPerDay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MAX_RUNS_PER_DAY_DEFAULT;
  return Math.min(MAX_RUNS_PER_DAY_MAX, Math.max(MAX_RUNS_PER_DAY_MIN, Math.round(number)));
}

export function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    maxParallelLocalRuns: clampParallelRuns(source.maxParallelLocalRuns),
    minimumRunGapMinutes: clampMinimumRunGap(source.minimumRunGapMinutes),
    maxRunsPerDay: clampMaxRunsPerDay(source.maxRunsPerDay),
  };
}

/** The two guardrails a schedule is checked against, as the schedule module expects them. */
export function scheduleGuardrails(settings) {
  return { minimumGapMinutes: settings.minimumRunGapMinutes, maxRunsPerDay: settings.maxRunsPerDay };
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
