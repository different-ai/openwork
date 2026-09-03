/**
 * Local Open Coworker responsibilities.
 *
 * These records deliberately reuse OpenWork's Automation schedule contract and
 * occurrence calculation, widened by two local-only kinds (an interval and a
 * custom timetable, see `src/lib/local-schedule.ts`), while remaining honest
 * about placement: the desktop process is the scheduler, so runs happen only
 * while Open Coworker is open.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  ScheduleError,
  checkScheduleGuardrails,
  nextLocalOccurrence,
  parseLocalSchedule,
} from "../src/lib/local-schedule.ts";
import { resolveCoworkerFile } from "./coworkers.mjs";

export const LOCAL_RESPONSIBILITIES_FILE = "local-responsibilities.json";

/** Runs kept per responsibility: enough to read a trend, never a log. */
export const RUN_HISTORY_LIMIT = 12;
/** Result summaries are the coworker's own last words for the run, bounded. */
export const RUN_SUMMARY_LIMIT = 1_200;

const RUN_STATUSES = ["queued", "running", "succeeded", "failed"];
const RUN_TRIGGERS = ["scheduled", "recovery", "manual", "resume"];

function cleanString(value, maximum = 100_000) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanTimestamp(value, fallback = null) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function cleanRun(value) {
  if (!value || typeof value !== "object") return null;
  const status = RUN_STATUSES.includes(value.status) ? value.status : "failed";
  const trigger = RUN_TRIGGERS.includes(value.trigger) ? value.trigger : "manual";
  return {
    id: cleanString(value.id, 160) || randomUUID(),
    status,
    trigger,
    queuedAt: cleanTimestamp(value.queuedAt),
    startedAt: cleanTimestamp(value.startedAt, 0),
    finishedAt: cleanTimestamp(value.finishedAt),
    threadId: cleanString(value.threadId, 240),
    error: cleanString(value.error, 2_000),
    summary: cleanString(value.summary, RUN_SUMMARY_LIMIT),
  };
}

/** Newest first, bounded; `latestRun` is always `runs[0]` (or null). */
function cleanRuns(value, latestRun) {
  const source = Array.isArray(value) ? value : latestRun ? [latestRun] : [];
  const seen = new Set();
  const runs = [];
  for (const candidate of source) {
    const run = cleanRun(candidate);
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    runs.push(run);
  }
  runs.sort((left, right) => (right.queuedAt ?? right.startedAt) - (left.queuedAt ?? left.startedAt));
  return runs.slice(0, RUN_HISTORY_LIMIT);
}

function cleanRecord(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanString(value.id, 160);
  const name = cleanString(value.name, 120);
  const instructions = cleanString(value.instructions);
  if (!id || !name || !instructions) return null;
  let schedule;
  try {
    schedule = parseLocalSchedule(value.schedule);
  } catch {
    return null;
  }
  const runs = cleanRuns(value.runs, cleanRun(value.latestRun));
  return {
    id,
    name,
    instructions,
    schedule,
    state: value.state === "paused" ? "paused" : "active",
    nextDueAt: cleanTimestamp(value.nextDueAt),
    latestRun: runs[0] ?? null,
    runs,
    createdAt: cleanTimestamp(value.createdAt, 0),
    updatedAt: cleanTimestamp(value.updatedAt, 0),
  };
}

/** Put `run` at the head of the history (replacing an entry with the same id) and refresh `latestRun`. */
function withRun(record, run) {
  const runs = cleanRuns([run, ...record.runs.filter((existing) => existing.id !== run.id)], null);
  return { ...record, runs, latestRun: runs[0] ?? null };
}

async function readStore(coworkersDir, slug) {
  const file = resolveCoworkerFile(coworkersDir, slug, LOCAL_RESPONSIBILITIES_FILE);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const source = Array.isArray(parsed?.items) ? parsed.items : [];
    return source.map(cleanRecord).filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

let temporarySequence = 0;

async function writeStore(coworkersDir, slug, items) {
  const file = resolveCoworkerFile(coworkersDir, slug, LOCAL_RESPONSIBILITIES_FILE);
  temporarySequence += 1;
  const temporary = `${file}.${process.pid}.${temporarySequence}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/**
 * Every change to one coworker's store goes through here, one at a time, so a
 * run finishing while another is queued can never overwrite the other's write.
 * `change` receives the current items and returns `{ items, result }`.
 */
const storeLocks = new Map();

async function mutateStore(coworkersDir, slug, change) {
  const key = resolveCoworkerFile(coworkersDir, slug, LOCAL_RESPONSIBILITIES_FILE);
  const previous = storeLocks.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const items = await readStore(coworkersDir, slug);
    const { items: next, result, changed = true } = await change(items);
    if (changed) await writeStore(coworkersDir, slug, next);
    return result;
  });
  storeLocks.set(key, run.then(() => undefined, () => undefined));
  try {
    return await run;
  } finally {
    if (storeLocks.get(key) === run) storeLocks.delete(key);
  }
}

export async function listLocalResponsibilities(coworkersDir, slug) {
  return readStore(coworkersDir, slug);
}

/**
 * Read and check a schedule for this Mac: the local superset of the shared
 * contract, then the app's guardrails when they are given. Every failure is a
 * `ScheduleError` whose message is a sentence for the person or the coworker.
 */
export function acceptLocalSchedule(value, { guardrails = null, defaultTimezone, now = Date.now() } = {}) {
  const schedule = parseLocalSchedule(value, defaultTimezone ? { defaultTimezone } : {});
  if (guardrails) {
    const verdict = checkScheduleGuardrails(schedule, guardrails, now);
    if (!verdict.ok) throw new ScheduleError(verdict.reason);
  }
  return schedule;
}

export async function createLocalResponsibility(coworkersDir, slug, input, now = Date.now(), options = {}) {
  const name = cleanString(input?.name, 120);
  const instructions = cleanString(input?.instructions);
  if (!name) throw new Error("Responsibility name is required");
  if (!instructions) throw new Error("Responsibility instructions are required");
  const schedule = acceptLocalSchedule(input?.schedule, { ...options, now });
  const createdAt = Math.max(0, Math.floor(now));
  const record = {
    id: randomUUID(),
    name,
    instructions,
    schedule,
    state: "active",
    nextDueAt: nextLocalOccurrence(schedule, createdAt),
    latestRun: null,
    runs: [],
    createdAt,
    updatedAt: createdAt,
  };
  return mutateStore(coworkersDir, slug, (items) => ({ items: [...items, record], result: record }));
}

export async function setLocalResponsibilityActive(coworkersDir, slug, id, active, now = Date.now()) {
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const updatedAt = Math.max(0, Math.floor(now));
    const updated = {
      ...current,
      state: active ? "active" : "paused",
      nextDueAt: active ? nextLocalOccurrence(current.schedule, updatedAt) : current.nextDueAt,
      updatedAt,
    };
    return { items: items.with(index, updated), result: updated };
  });
}

/**
 * Change what a responsibility is called, what it does, when it runs, or
 * whether it is active. A new schedule takes effect from now; a paused
 * responsibility that resumes gets its next occurrence from now as well.
 */
export async function updateLocalResponsibility(coworkersDir, slug, id, patch, now = Date.now(), options = {}) {
  const source = patch && typeof patch === "object" ? patch : {};
  const name = source.name === undefined ? undefined : cleanString(source.name, 120);
  const instructions = source.instructions === undefined ? undefined : cleanString(source.instructions);
  if (name === "") throw new Error("Responsibility name is required");
  if (instructions === "") throw new Error("Responsibility instructions are required");
  const schedule = source.schedule === undefined ? undefined : acceptLocalSchedule(source.schedule, { ...options, now });
  const active = typeof source.active === "boolean" ? source.active : undefined;
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const updatedAt = Math.max(0, Math.floor(now));
    const nextState = active === undefined ? current.state : active ? "active" : "paused";
    const nextSchedule = schedule ?? current.schedule;
    const rescheduled = schedule !== undefined || (nextState === "active" && current.state !== "active");
    const updated = {
      ...current,
      ...(name !== undefined ? { name } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      schedule: nextSchedule,
      state: nextState,
      nextDueAt: rescheduled && nextState === "active" ? nextLocalOccurrence(nextSchedule, updatedAt) : current.nextDueAt,
      updatedAt,
    };
    return { items: items.with(index, updated), result: updated };
  });
}

export async function deleteLocalResponsibility(coworkersDir, slug, id) {
  await mutateStore(coworkersDir, slug, (items) => {
    const remaining = items.filter((item) => item.id !== id);
    if (remaining.length === items.length) throw new Error("Local responsibility not found");
    return { items: remaining, result: undefined };
  });
}

function cleanTrigger(trigger) {
  return RUN_TRIGGERS.includes(trigger) ? trigger : "manual";
}

/** Only scheduled occurrences advance the schedule; manual and resumed runs leave it alone. */
function advanceForTrigger(record, trigger, at) {
  const scheduled = trigger === "scheduled" || trigger === "recovery";
  if (!scheduled) return record;
  return {
    ...record,
    state: record.schedule.kind === "once" ? "paused" : record.state,
    nextDueAt: nextLocalOccurrence(record.schedule, at),
  };
}

/**
 * Record a run that is waiting for a free slot on this Mac. The schedule
 * advances now, exactly as it would for a run that started immediately, so a
 * queued occurrence is never counted twice.
 */
export async function queueLocalResponsibilityRun(
  coworkersDir,
  slug,
  id,
  { trigger = "manual", now = Date.now() } = {},
) {
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const queuedAt = Math.max(0, Math.floor(now));
    const run = {
      id: randomUUID(),
      status: "queued",
      trigger: cleanTrigger(trigger),
      queuedAt,
      startedAt: 0,
      finishedAt: null,
      threadId: "",
      error: "",
      summary: "",
    };
    const updated = { ...withRun(advanceForTrigger(current, run.trigger, queuedAt), run), updatedAt: queuedAt };
    return { items: items.with(index, updated), result: updated };
  });
}

/** Drop a run that never started. Anything already running or finished is untouched. */
export async function cancelQueuedLocalRun(coworkersDir, slug, id, runId, now = Date.now()) {
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const run = current.runs.find((candidate) => candidate.id === runId);
    if (!run || run.status !== "queued") return { items, result: current, changed: false };
    const runs = current.runs.filter((candidate) => candidate.id !== runId);
    const updated = { ...current, runs, latestRun: runs[0] ?? null, updatedAt: Math.max(0, Math.floor(now)) };
    return { items: items.with(index, updated), result: updated };
  });
}

/**
 * Start a run. Pass `runId` to promote a queued run; pass `threadId` to resume
 * inside an earlier run's native thread instead of opening a new one.
 */
export async function beginLocalResponsibilityRun(
  coworkersDir,
  slug,
  id,
  { trigger = "manual", now = Date.now(), runId = "", threadId = "" } = {},
) {
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const startedAt = Math.max(0, Math.floor(now));
    const queued = runId ? current.runs.find((candidate) => candidate.id === runId && candidate.status === "queued") : null;
    const run = {
      id: queued?.id ?? randomUUID(),
      status: "running",
      trigger: queued?.trigger ?? cleanTrigger(trigger),
      queuedAt: queued?.queuedAt ?? null,
      startedAt,
      finishedAt: null,
      threadId: cleanString(threadId, 240),
      error: "",
      summary: "",
    };
    // A queued run already advanced the schedule when it was queued.
    const advanced = queued ? current : advanceForTrigger(current, run.trigger, startedAt);
    const updated = { ...withRun(advanced, run), updatedAt: startedAt };
    return { items: items.with(index, updated), result: updated };
  });
}

export async function attachLocalResponsibilityThread(coworkersDir, slug, id, runId, threadId) {
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const run = current.runs.find((candidate) => candidate.id === runId);
    if (!run) return { items, result: current, changed: false };
    const updated = withRun(current, { ...run, threadId: cleanString(threadId, 240) });
    return { items: items.with(index, updated), result: updated };
  });
}

export const INTERRUPTED_RUN_MESSAGE = "Open Coworker closed before this local run finished.";

/**
 * A run recorded as `running` with no live executor in this process was cut
 * off by a quit, crash, or engine stop. Mark it failed with a plain reason so
 * the UI never shows a phantom "Running" state and the next due occurrence
 * can proceed. The schedule was already advanced when the run began, so no
 * occurrence is replayed.
 */
export async function reconcileInterruptedLocalRuns(
  coworkersDir,
  slug,
  { activeRunIds = new Set(), now = Date.now() } = {},
) {
  return mutateStore(coworkersDir, slug, (items) => {
    const finishedAt = Math.max(0, Math.floor(now));
    let changed = false;
    const reconciled = items.map((item) => {
      if (activeRunIds.has(item.id)) return item;
      const interrupted = item.runs.filter((run) => run.status === "running");
      if (interrupted.length === 0) return item;
      changed = true;
      let next = item;
      for (const run of interrupted) {
        next = withRun(next, { ...run, status: "failed", finishedAt, error: INTERRUPTED_RUN_MESSAGE });
      }
      return { ...next, updatedAt: finishedAt };
    });
    return { items: reconciled, result: reconciled, changed };
  });
}

export async function finishLocalResponsibilityRun(
  coworkersDir,
  slug,
  id,
  runId,
  { status, error = "", summary = "", now = Date.now() },
) {
  return mutateStore(coworkersDir, slug, (items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Local responsibility not found");
    const current = items[index];
    const run = current.runs.find((candidate) => candidate.id === runId);
    if (!run) return { items, result: current, changed: false };
    const updatedAt = Math.max(0, Math.floor(now));
    const updated = {
      ...withRun(current, {
        ...run,
        status: status === "succeeded" ? "succeeded" : "failed",
        finishedAt: updatedAt,
        error: cleanString(error, 2_000),
        summary: cleanString(summary, RUN_SUMMARY_LIMIT),
      }),
      updatedAt,
    };
    return { items: items.with(index, updated), result: updated };
  });
}
