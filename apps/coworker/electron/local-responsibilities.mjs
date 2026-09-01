/**
 * Local Open Coworker responsibilities.
 *
 * These records deliberately reuse OpenWork's Automation schedule contract and
 * occurrence calculation, while remaining honest about placement: the desktop
 * process is the scheduler, so runs happen only while Open Coworker is open.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { nextAutomationOccurrence } from "@openwork/automations";
import { automationScheduleSchema } from "@openwork/types/automations";
import { resolveCoworkerFile } from "./coworkers.mjs";

export const LOCAL_RESPONSIBILITIES_FILE = "local-responsibilities.json";

function cleanString(value, maximum = 100_000) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanRun(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["running", "succeeded", "failed"].includes(value.status) ? value.status : "failed";
  const trigger = ["scheduled", "recovery", "manual"].includes(value.trigger) ? value.trigger : "manual";
  return {
    id: cleanString(value.id, 160) || randomUUID(),
    status,
    trigger,
    startedAt: Number.isFinite(value.startedAt) ? Math.max(0, Math.floor(value.startedAt)) : 0,
    finishedAt: Number.isFinite(value.finishedAt) ? Math.max(0, Math.floor(value.finishedAt)) : null,
    threadId: cleanString(value.threadId, 240),
    error: cleanString(value.error, 2_000),
  };
}

function cleanRecord(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanString(value.id, 160);
  const name = cleanString(value.name, 120);
  const instructions = cleanString(value.instructions);
  if (!id || !name || !instructions) return null;
  const parsedSchedule = automationScheduleSchema.safeParse(value.schedule);
  if (!parsedSchedule.success) return null;
  return {
    id,
    name,
    instructions,
    schedule: parsedSchedule.data,
    state: value.state === "paused" ? "paused" : "active",
    nextDueAt: Number.isFinite(value.nextDueAt) ? Math.max(0, Math.floor(value.nextDueAt)) : null,
    latestRun: cleanRun(value.latestRun),
    createdAt: Number.isFinite(value.createdAt) ? Math.max(0, Math.floor(value.createdAt)) : 0,
    updatedAt: Number.isFinite(value.updatedAt) ? Math.max(0, Math.floor(value.updatedAt)) : 0,
  };
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

async function writeStore(coworkersDir, slug, items) {
  const file = resolveCoworkerFile(coworkersDir, slug, LOCAL_RESPONSIBILITIES_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function listLocalResponsibilities(coworkersDir, slug) {
  return readStore(coworkersDir, slug);
}

export async function createLocalResponsibility(coworkersDir, slug, input, now = Date.now()) {
  const name = cleanString(input?.name, 120);
  const instructions = cleanString(input?.instructions);
  if (!name) throw new Error("Responsibility name is required");
  if (!instructions) throw new Error("Responsibility instructions are required");
  const schedule = automationScheduleSchema.parse(input?.schedule);
  const createdAt = Math.max(0, Math.floor(now));
  const record = {
    id: randomUUID(),
    name,
    instructions,
    schedule,
    state: "active",
    nextDueAt: nextAutomationOccurrence(schedule, createdAt),
    latestRun: null,
    createdAt,
    updatedAt: createdAt,
  };
  const items = await readStore(coworkersDir, slug);
  items.push(record);
  await writeStore(coworkersDir, slug, items);
  return record;
}

export async function setLocalResponsibilityActive(coworkersDir, slug, id, active, now = Date.now()) {
  const items = await readStore(coworkersDir, slug);
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error("Local responsibility not found");
  const current = items[index];
  const updatedAt = Math.max(0, Math.floor(now));
  const updated = {
    ...current,
    state: active ? "active" : "paused",
    nextDueAt: active ? nextAutomationOccurrence(current.schedule, updatedAt) : current.nextDueAt,
    updatedAt,
  };
  items[index] = updated;
  await writeStore(coworkersDir, slug, items);
  return updated;
}

export async function deleteLocalResponsibility(coworkersDir, slug, id) {
  const items = await readStore(coworkersDir, slug);
  const remaining = items.filter((item) => item.id !== id);
  if (remaining.length === items.length) throw new Error("Local responsibility not found");
  await writeStore(coworkersDir, slug, remaining);
}

export async function beginLocalResponsibilityRun(
  coworkersDir,
  slug,
  id,
  { trigger = "manual", now = Date.now() } = {},
) {
  const items = await readStore(coworkersDir, slug);
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error("Local responsibility not found");
  const current = items[index];
  const startedAt = Math.max(0, Math.floor(now));
  const run = {
    id: randomUUID(),
    status: "running",
    trigger: ["scheduled", "recovery", "manual"].includes(trigger) ? trigger : "manual",
    startedAt,
    finishedAt: null,
    threadId: "",
    error: "",
  };
  const scheduled = run.trigger !== "manual";
  const nextDueAt = scheduled ? nextAutomationOccurrence(current.schedule, startedAt) : current.nextDueAt;
  const updated = {
    ...current,
    state: scheduled && current.schedule.kind === "once" ? "paused" : current.state,
    nextDueAt,
    latestRun: run,
    updatedAt: startedAt,
  };
  items[index] = updated;
  await writeStore(coworkersDir, slug, items);
  return updated;
}

export async function attachLocalResponsibilityThread(coworkersDir, slug, id, runId, threadId) {
  const items = await readStore(coworkersDir, slug);
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error("Local responsibility not found");
  const current = items[index];
  if (current.latestRun?.id !== runId) return current;
  const updated = { ...current, latestRun: { ...current.latestRun, threadId: cleanString(threadId, 240) } };
  items[index] = updated;
  await writeStore(coworkersDir, slug, items);
  return updated;
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
  const items = await readStore(coworkersDir, slug);
  const finishedAt = Math.max(0, Math.floor(now));
  let changed = false;
  const reconciled = items.map((item) => {
    const run = item.latestRun;
    if (!run || run.status !== "running" || activeRunIds.has(item.id)) return item;
    changed = true;
    return {
      ...item,
      latestRun: { ...run, status: "failed", finishedAt, error: INTERRUPTED_RUN_MESSAGE },
      updatedAt: finishedAt,
    };
  });
  if (changed) await writeStore(coworkersDir, slug, reconciled);
  return reconciled;
}

export async function finishLocalResponsibilityRun(
  coworkersDir,
  slug,
  id,
  runId,
  { status, error = "", now = Date.now() },
) {
  const items = await readStore(coworkersDir, slug);
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error("Local responsibility not found");
  const current = items[index];
  if (current.latestRun?.id !== runId) return current;
  const updatedAt = Math.max(0, Math.floor(now));
  const updated = {
    ...current,
    latestRun: {
      ...current.latestRun,
      status: status === "succeeded" ? "succeeded" : "failed",
      finishedAt: updatedAt,
      error: cleanString(error, 2_000),
    },
    updatedAt,
  };
  items[index] = updated;
  await writeStore(coworkersDir, slug, items);
  return updated;
}
