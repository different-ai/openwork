/**
 * Workers: long-lived sub-agents a coworker (or the person) starts for one
 * goal that outlives a single reply.
 *
 * A Worker is a real native session in the coworker's own workspace. Its
 * record lives beside the coworker home as `workers/<id>/worker.json` plus an
 * append-only `workers/<id>/findings.jsonl` of what it reported, and
 * `workers.json` lists which native threads are Workers so they never read as
 * discussions or assignments. Metadata is written through a temp file and
 * rename; appends are serialized per Worker; Workers are stopped, never
 * deleted. Execution (turns, the parallel-run gate, the review trigger) lives
 * in the main process; everything here is plain Node and unit-tested.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCoworkerFile } from "./coworkers.mjs";

export const WORKERS_DIR = "workers";
export const WORKERS_REGISTRY_FILE = "workers.json";
export const WORKER_SCHEMA_VERSION = 1;
/** Live Workers per coworker; more must wait for one to stop. */
export const MAX_LIVE_WORKERS = 3;
/** Turns a Worker gets when nobody chose a lifespan. */
export const DEFAULT_TURN_BUDGET = 10;
export const MAX_TURN_BUDGET = 100;
/** The coworker reviews at most once per this window; findings in between batch. */
export const REVIEW_DEBOUNCE_MS = 60_000;
export const WORKER_THREAD_TITLE_PREFIX = "Worker: ";

export const WORKER_STATUSES = ["starting", "running", "waiting", "paused", "finished", "cancelled", "failed"];
const TERMINAL_STATUSES = new Set(["finished", "cancelled", "failed"]);
const WAITING_FOR = new Set(["", "turn", "decision"]);
const SPAWNERS = new Set(["coworker", "person"]);
const EVENT_KINDS = new Set(["finding", "status", "steer", "review"]);
const REPORT_KINDS = new Set(["finding", "decision", "done"]);
const WORKER_ID = /^wrk_[a-z0-9]{8,32}$/;
const MAX_EVENTS_READ = 400;
const MAX_FINDING_TEXT = 4_000;

export function newWorkerId() {
  return `wrk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newEventId() {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function isWorkerId(value) {
  return typeof value === "string" && WORKER_ID.test(value);
}

export function isWorkerFinished(worker) {
  return TERMINAL_STATUSES.has(worker.status);
}

/** Workers that still exist for the coworker: everything not finished, stopped, or failed. */
export function liveWorkers(workers) {
  return workers.filter((worker) => !isWorkerFinished(worker));
}

export function workerThreadTitle(name) {
  return `${WORKER_THREAD_TITLE_PREFIX}${name}`;
}

function workerDir(coworkersDir, slug, id) {
  if (!isWorkerId(id)) throw new Error("Invalid Worker id.");
  return resolveCoworkerFile(coworkersDir, slug, path.join(WORKERS_DIR, id));
}

function metadataPath(coworkersDir, slug, id) {
  return path.join(workerDir(coworkersDir, slug, id), "worker.json");
}

function findingsPath(coworkersDir, slug, id) {
  return path.join(workerDir(coworkersDir, slug, id), "findings.jsonl");
}

function cleanText(value, maximum) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanTimestamp(value, fallback = null) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * How long a Worker lives: until a moment, for a number of turns, or until
 * someone stops it. Missing input means the default turn budget, so a Worker
 * can never be started without a bound the person did not choose.
 */
export function normalizeLifespan(input, { now = Date.now() } = {}) {
  if (input === undefined || input === null) return { kind: "turns", max: DEFAULT_TURN_BUDGET, used: 0 };
  if (!input || typeof input !== "object") throw new Error("A Worker's lifespan must be until a time, a number of turns, or until stopped.");
  if (input.kind === "until") {
    const at = Number(input.at);
    if (!Number.isFinite(at)) throw new Error("A Worker's deadline needs a time.");
    if (at <= now) throw new Error("A Worker's deadline must be in the future.");
    return { kind: "until", at: Math.floor(at) };
  }
  if (input.kind === "turns") {
    const max = Math.round(Number(input.max));
    if (!Number.isFinite(max) || max < 1 || max > MAX_TURN_BUDGET) throw new Error(`A Worker gets between 1 and ${MAX_TURN_BUDGET} turns.`);
    const used = Math.round(Number(input.used));
    return { kind: "turns", max, used: Number.isFinite(used) && used > 0 ? Math.min(used, max) : 0 };
  }
  if (input.kind === "open") return { kind: "open" };
  throw new Error("A Worker's lifespan must be until a time, a number of turns, or until stopped.");
}

/** True once the lifespan is used up (a deadline that passed or a spent turn budget). */
export function lifespanSpent(lifespan, now = Date.now()) {
  if (lifespan.kind === "until") return now >= lifespan.at;
  if (lifespan.kind === "turns") return lifespan.used >= lifespan.max;
  return false;
}

/** One more turn taken against the lifespan. */
export function lifespanAfterTurn(lifespan) {
  if (lifespan.kind !== "turns") return lifespan;
  return { ...lifespan, used: Math.min(lifespan.max, lifespan.used + 1) };
}

/** The lifespan in plain words for the Worker's own prompt. */
export function describeLifespanForPrompt(lifespan, now = Date.now()) {
  if (lifespan.kind === "until") {
    const at = new Date(lifespan.at);
    const sameDay = at.toDateString() === new Date(now).toDateString();
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return sameDay ? `until ${time} today` : `until ${at.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} at ${time}`;
  }
  if (lifespan.kind === "turns") {
    const left = Math.max(0, lifespan.max - lifespan.used);
    return `${left} of ${lifespan.max} turns left`;
  }
  return "until you are stopped";
}

function normalizeStoredWorker(raw) {
  if (!raw || typeof raw !== "object" || !isWorkerId(raw.id)) return null;
  let lifespan;
  try {
    lifespan = raw.lifespan?.kind === "until"
      ? { kind: "until", at: cleanTimestamp(raw.lifespan.at, 0) }
      : normalizeLifespan(raw.lifespan, { now: 0 });
  } catch {
    lifespan = { kind: "turns", max: DEFAULT_TURN_BUDGET, used: 0 };
  }
  return {
    schemaVersion: WORKER_SCHEMA_VERSION,
    id: raw.id,
    slug: typeof raw.slug === "string" ? raw.slug : "",
    name: typeof raw.name === "string" && raw.name ? raw.name : "Worker",
    goal: typeof raw.goal === "string" ? raw.goal : "",
    threadId: typeof raw.threadId === "string" ? raw.threadId : "",
    spawnedBy: SPAWNERS.has(raw.spawnedBy) ? raw.spawnedBy : "person",
    spawnedFromThreadId: typeof raw.spawnedFromThreadId === "string" ? raw.spawnedFromThreadId : "",
    status: WORKER_STATUSES.includes(raw.status) ? raw.status : "failed",
    waitingFor: WAITING_FOR.has(raw.waitingFor) ? raw.waitingFor : "",
    lifespan,
    createdAt: cleanTimestamp(raw.createdAt, 0),
    updatedAt: cleanTimestamp(raw.updatedAt, 0),
    endedAt: cleanTimestamp(raw.endedAt),
    lastFindingAt: cleanTimestamp(raw.lastFindingAt),
    steerCount: Number.isFinite(raw.steerCount) ? Math.max(0, Math.floor(raw.steerCount)) : 0,
    error: typeof raw.error === "string" ? raw.error : "",
  };
}

async function writeMetadata(coworkersDir, worker) {
  const target = metadataPath(coworkersDir, worker.slug, worker.id);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(worker, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return worker;
}

/** Creation is serialized per coworker so two spawns can never both take the last place. */
const createQueues = new Map();

export async function createWorker(coworkersDir, slug, input, { now = Date.now() } = {}) {
  const name = cleanText(input?.name, 80).replace(/\s+/g, " ");
  const goal = cleanText(input?.goal, 4_000);
  if (!name) throw new Error("A Worker needs a name.");
  if (!goal) throw new Error("A Worker needs a goal.");
  if (!SPAWNERS.has(input?.spawnedBy)) throw new Error("A Worker is started by the coworker or by the person.");
  const lifespan = normalizeLifespan(input.lifespan, { now });
  const previous = createQueues.get(slug) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const live = liveWorkers(await listWorkers(coworkersDir, slug));
    if (live.length >= MAX_LIVE_WORKERS) {
      throw new Error(`${MAX_LIVE_WORKERS} Workers are already running. Stop one, or wait for one to finish.`);
    }
    const worker = {
      schemaVersion: WORKER_SCHEMA_VERSION,
      id: newWorkerId(),
      slug,
      name,
      goal,
      threadId: "",
      spawnedBy: input.spawnedBy,
      spawnedFromThreadId: cleanText(input.spawnedFromThreadId, 240),
      status: "starting",
      waitingFor: "",
      lifespan,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      lastFindingAt: null,
      steerCount: 0,
      error: "",
    };
    await writeMetadata(coworkersDir, worker);
    await writeFile(findingsPath(coworkersDir, slug, worker.id), "", { flag: "a" });
    return worker;
  });
  createQueues.set(slug, run);
  try {
    return await run;
  } finally {
    if (createQueues.get(slug) === run) createQueues.delete(slug);
  }
}

export async function getWorker(coworkersDir, slug, id) {
  const raw = JSON.parse(await readFile(metadataPath(coworkersDir, slug, id), "utf8"));
  const worker = normalizeStoredWorker(raw);
  if (!worker) throw new Error("Worker record is unreadable.");
  return { ...worker, slug };
}

/** Every Worker of one coworker, newest first, finished ones included. */
export async function listWorkers(coworkersDir, slug) {
  let entries = [];
  try {
    entries = await readdir(resolveCoworkerFile(coworkersDir, slug, WORKERS_DIR), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const workers = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isWorkerId(entry.name)) continue;
    try {
      workers.push(await getWorker(coworkersDir, slug, entry.name));
    } catch {
      // A half-written Worker folder is skipped rather than failing the whole list.
    }
  }
  return workers.sort((a, b) => b.createdAt - a.createdAt);
}

const updateLocks = new Map();

/**
 * Change one Worker's record. Updates are serialized per Worker so a turn
 * settling can never overwrite a stop that arrived while it ran. A Worker
 * that has finished, stopped, or failed does not change status again.
 */
export async function updateWorker(coworkersDir, slug, id, patch = {}, { now = Date.now() } = {}) {
  const key = metadataPath(coworkersDir, slug, id);
  const previous = updateLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const current = await getWorker(coworkersDir, slug, id);
    const next = { ...current, updatedAt: now };
    if (patch.status !== undefined && patch.status !== current.status) {
      if (!WORKER_STATUSES.includes(patch.status)) throw new Error("Unknown Worker status.");
      if (isWorkerFinished(current)) throw new Error("This Worker has already stopped.");
      next.status = patch.status;
      if (TERMINAL_STATUSES.has(patch.status)) {
        next.endedAt = now;
        next.waitingFor = "";
      }
    }
    if (patch.waitingFor !== undefined) {
      if (!WAITING_FOR.has(patch.waitingFor)) throw new Error("Unknown Worker wait reason.");
      if (!TERMINAL_STATUSES.has(next.status)) next.waitingFor = patch.waitingFor;
    }
    if (patch.name !== undefined) next.name = cleanText(patch.name, 80).replace(/\s+/g, " ") || current.name;
    if (patch.threadId !== undefined) next.threadId = cleanText(patch.threadId, 240);
    if (patch.lifespan !== undefined) next.lifespan = normalizeLifespan(patch.lifespan, { now: 0 });
    if (patch.lastFindingAt !== undefined) next.lastFindingAt = cleanTimestamp(patch.lastFindingAt);
    if (patch.steerCount !== undefined) next.steerCount = Math.max(0, Math.floor(Number(patch.steerCount) || 0));
    if (patch.error !== undefined) next.error = cleanText(patch.error, 2_000);
    return writeMetadata(coworkersDir, next);
  });
  updateLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (updateLocks.get(key) === run) updateLocks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Findings: what the Worker reported, plus steering and status, append-only.

export function normalizeEvent(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object") throw new Error("A Worker event is required.");
  if (!EVENT_KINDS.has(input.kind)) throw new Error("Unknown Worker event kind.");
  const event = {
    id: typeof input.id === "string" && input.id ? input.id : newEventId(),
    at: Number.isFinite(input.at) ? input.at : now,
    kind: input.kind,
    text: cleanText(input.text, MAX_FINDING_TEXT),
  };
  if (input.kind === "finding") event.report = REPORT_KINDS.has(input.report) ? input.report : "finding";
  if (SPAWNERS.has(input.by)) event.by = input.by;
  if (typeof input.turnId === "string" && input.turnId) event.turnId = input.turnId;
  if (typeof input.reviewThreadId === "string" && input.reviewThreadId) event.reviewThreadId = input.reviewThreadId;
  if (Array.isArray(input.findingIds)) event.findingIds = input.findingIds.filter((id) => typeof id === "string" && id);
  if (typeof input.error === "string" && input.error) event.error = cleanText(input.error, 2_000);
  return event;
}

export function parseEvents(content) {
  const lines = content.split("\n");
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && EVENT_KINDS.has(parsed.kind) && typeof parsed.id === "string") events.push(parsed);
    } catch (error) {
      // Only a truncated final line (an interrupted append) is tolerated.
      if (index === lines.length - 1 || (index === lines.length - 2 && lines[lines.length - 1] === "")) break;
      throw error;
    }
  }
  return events;
}

export async function readWorkerEvents(coworkersDir, slug, id, { limit = MAX_EVENTS_READ } = {}) {
  let content = "";
  try {
    content = await readFile(findingsPath(coworkersDir, slug, id), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const events = parseEvents(content);
  return events.length > limit ? events.slice(events.length - limit) : events;
}

/** One append chain per Worker, so two events never interleave a line. */
const appendQueues = new Map();

export async function appendWorkerEvent(coworkersDir, slug, id, input, { now = Date.now() } = {}) {
  const target = findingsPath(coworkersDir, slug, id);
  const event = normalizeEvent(input, { now });
  const previous = appendQueues.get(target) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    });
  appendQueues.set(target, run);
  try {
    return await run;
  } finally {
    if (appendQueues.get(target) === run) appendQueues.delete(target);
  }
}

// ---------------------------------------------------------------------------
// Registry: which native threads are Workers (same shape as `discussions.json`).

export async function readWorkerRegistry(coworkersDir, slug) {
  try {
    const parsed = JSON.parse(await readFile(resolveCoworkerFile(coworkersDir, slug, WORKERS_REGISTRY_FILE), "utf8"));
    const ids = Array.isArray(parsed?.threadIds) ? parsed.threadIds : [];
    return [...new Set(ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

const registryLocks = new Map();

export async function registerWorkerThread(coworkersDir, slug, threadId) {
  const target = resolveCoworkerFile(coworkersDir, slug, WORKERS_REGISTRY_FILE);
  const previous = registryLocks.get(target) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const current = await readWorkerRegistry(coworkersDir, slug);
    const id = cleanText(threadId, 240);
    if (!id) throw new Error("A Worker thread id is required.");
    if (current.includes(id)) return current;
    const next = [...current, id];
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, threadIds: next }, null, 2)}\n`, "utf8");
    await rename(temp, target);
    return next;
  });
  registryLocks.set(target, run);
  try {
    return await run;
  } finally {
    if (registryLocks.get(target) === run) registryLocks.delete(target);
  }
}

// ---------------------------------------------------------------------------
// Prompts and reports: the words between the app, the Worker, and the coworker.

export const BEGIN_BODY = "Begin working toward the goal now.";
export const CONTINUE_BODY = "Continue toward the goal from your last finding.";
export const RECOVERED_STATUS = "Paused when the app closed; resumes on the next turn.";

/**
 * Every Worker turn opens with the same frame: who it is, the goal, how long
 * it has, and the reporting contract the app parses afterwards.
 */
export function workerTurnPrompt({ worker, coworkerName, body, now = Date.now() }) {
  return [
    `You are a Worker named "${worker.name}" started by ${coworkerName}. You work in ${coworkerName}'s workspace with the same files, memory, and tools.`,
    "",
    "Your goal:",
    worker.goal,
    "",
    `Lifespan: ${describeLifespanForPrompt(worker.lifespan, now)}.`,
    `You are a Worker, not ${coworkerName}: never start, steer, or stop Workers, never set up or change assignments, and never change ${coworkerName}'s memory or soul (those tools are ${coworkerName}'s), and leave ${coworkerName}'s memory files alone.`,
    "Work in bounded steps. After each meaningful step, end your turn with a section titled \"Finding\": 2–6 sentences a person can read. If you need a decision before you can go on, end instead with a section titled \"Needs a decision\" and list the options. When the goal is met, end with a section titled \"Done\" and your final finding.",
    "",
    body,
  ].join("\n");
}

/** Steering arrives as the Worker's next turn, attributed to who sent it. */
export function steerBody(steers, coworkerName) {
  return steers
    .map((steer) => `Steering from ${steer.by === "coworker" ? coworkerName : `the person ${coworkerName} works for`}: ${steer.text}`)
    .join("\n\n");
}

const REPORT_TITLES = [
  { pattern: /^needs?\s+a\s+decision$/i, kind: "decision" },
  { pattern: /^finding$/i, kind: "finding" },
  { pattern: /^done$/i, kind: "done" },
];

function reportTitle(line) {
  const bare = line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/[:.\s]+$/, "")
    .trim();
  return REPORT_TITLES.find(({ pattern }) => pattern.test(bare)) ?? null;
}

/** `Finding: text on the same line` splits into the title and its first line. */
function inlineReport(line) {
  const match = /^\s*(?:#{1,6}\s*)?[*_]*(Finding|Needs? a decision|Done)[*_]*\s*:\s*(.*)$/i.exec(line);
  if (!match) return null;
  const title = reportTitle(match[1]);
  return title ? { kind: title.kind, rest: match[2].replace(/^[*_\s]+/, "").trim() } : null;
}

/**
 * Read the Worker's visible reply back into what it means for the app: a
 * finding to pass on, a decision it is waiting for, or that it is done. A reply
 * that skipped the contract still counts as a finding (its text, bounded), so
 * an update is never lost; an empty reply reports nothing.
 */
export function parseWorkerReport(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!source) return { kind: "none", text: "" };
  const lines = source.split("\n");
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const title = reportTitle(line);
    if (title) {
      sections.push({ kind: title.kind, start: index + 1, end: lines.length, firstLine: "" });
      if (sections.length > 1) sections[sections.length - 2].end = index;
      continue;
    }
    const inline = inlineReport(line);
    if (inline) {
      sections.push({ kind: inline.kind, start: index + 1, end: lines.length, firstLine: inline.rest });
      if (sections.length > 1) sections[sections.length - 2].end = index;
    }
  }
  if (sections.length === 0) return { kind: "finding", text: source.slice(0, MAX_FINDING_TEXT) };
  const textOf = (section) => [section.firstLine, ...lines.slice(section.start, section.end)].join("\n").trim().slice(0, MAX_FINDING_TEXT);
  const done = sections.find((section) => section.kind === "done");
  const last = sections[sections.length - 1];
  if (done) {
    // "Done" may stand alone; the finding before it then carries the words.
    const finding = [...sections].reverse().find((section) => section.kind === "finding" && textOf(section));
    return { kind: "done", text: textOf(done) || (finding ? textOf(finding) : "Done.") };
  }
  return { kind: last.kind, text: textOf(last) || (last.kind === "decision" ? "Needs a decision." : source.slice(0, MAX_FINDING_TEXT)) };
}

/**
 * What one settled (or failed) turn means for the Worker: the record patch,
 * the events to append, and whether to continue, hold, or stop. The record is
 * the one read after the turn, so a stop or pause that arrived while the turn
 * ran wins over the turn's own outcome.
 */
export function nextWorkerState(worker, outcome, { now = Date.now(), hasPendingSteer = false } = {}) {
  if (isWorkerFinished(worker)) return { patch: {}, events: [], schedule: "stop" };
  const lifespan = lifespanAfterTurn(worker.lifespan);
  if (outcome.kind === "failed") {
    const error = cleanText(outcome.error, 2_000) || "The turn did not finish.";
    return {
      patch: { status: "failed", lifespan, error },
      events: [{ kind: "status", text: `Didn't finish: ${error}` }],
      schedule: "stop",
    };
  }
  const report = outcome.report ?? { kind: "none", text: "" };
  const events = report.kind === "none" ? [] : [{ kind: "finding", report: report.kind, text: report.text }];
  const finding = report.kind === "none" ? {} : { lastFindingAt: now };
  if (report.kind === "done") {
    return { patch: { status: "finished", lifespan, ...finding }, events, schedule: "stop" };
  }
  if (lifespanSpent(lifespan, now)) {
    return {
      patch: { status: "finished", lifespan, ...finding },
      events: [...events, { kind: "status", text: "Finished: reached the end of its lifespan." }],
      schedule: "stop",
    };
  }
  if (worker.status === "paused") {
    return { patch: { lifespan, ...finding }, events, schedule: "hold" };
  }
  if (report.kind === "decision" && !hasPendingSteer) {
    return { patch: { status: "waiting", waitingFor: "decision", lifespan, ...finding }, events, schedule: "hold" };
  }
  return { patch: { status: "waiting", waitingFor: "turn", lifespan, ...finding }, events, schedule: "continue" };
}

export const REVIEW_OPENER = "Review these updates from your Workers.";

function workerStatusForPrompt(worker, now) {
  const lifespan = describeLifespanForPrompt(worker.lifespan, now);
  switch (worker.status) {
    case "running":
      return `working on it, ${lifespan}`;
    case "waiting":
      return worker.waitingFor === "decision" ? "waiting for a decision" : `waiting for its turn, ${lifespan}`;
    case "paused":
      return "paused";
    case "finished":
      return "done";
    case "cancelled":
      return "stopped";
    case "failed":
      return "didn't finish";
    default:
      return "starting";
  }
}

function reportVerb(report) {
  if (report === "decision") return "needs a decision";
  if (report === "done") return "finished";
  if (report === "failed") return "didn't finish";
  return "reported";
}

/**
 * The turn that wakes the coworker: its Workers as they stand, the new
 * findings, and what to do with them. Visible text only. The renderer
 * recognises the opener and shows the message as one action line.
 */
export function reviewPrompt({ coworkerName, workers, findings, toolsAvailable = false, now = Date.now() }) {
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  const roster = workers.length > 0
    ? workers.map((worker) => `- "${worker.name}" (${worker.id}) — ${workerStatusForPrompt(worker, now)} — started by ${worker.spawnedBy === "coworker" ? "you" : "the person"}`)
    : ["- none"];
  const updates = findings.map((finding) => {
    const worker = byId.get(finding.workerId);
    const name = worker?.name ?? finding.workerName ?? "Worker";
    return `Worker "${name}" ${reportVerb(finding.report)}: ${finding.text}`;
  });
  return [
    REVIEW_OPENER,
    "",
    `You are ${coworkerName}. Your Workers right now:`,
    ...roster,
    "",
    "New updates:",
    ...updates,
    "",
    toolsAvailable
      ? "Review these updates. Reply to the person in a few sentences with what changed and what you will do. If a Worker waits for a decision you can make, or is going the wrong way, steer it with your Worker tools now. Stop a Worker only when its goal is met or the person asked; never stop a Worker the person started unless they ask. If a decision needs the person, ask with the question tool."
      : "Review these updates. Reply to the person in a few sentences with what changed and what you will do. If a Worker needs steering or should stop, say so plainly; if a decision needs the person, ask them.",
  ].join("\n");
}

/**
 * Findings queue per coworker and wake it at most once per debounce window.
 * The first finding schedules a review at once; later ones inside the window
 * join the same review. `review(slug, findings)` resolves `"reviewed"` when
 * the coworker saw them, `"hold"` when it could not yet (no open discussion,
 * a reply still in progress): held findings try again after the window. A
 * review that throws is retried once after the window, then dropped.
 */
export function createReviewScheduler({
  review,
  debounceMs = REVIEW_DEBOUNCE_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onDropped = () => undefined,
}) {
  const queues = new Map();

  function queueFor(slug) {
    let queue = queues.get(slug);
    if (!queue) {
      queue = { pending: [], timer: null, running: false, lastStartedAt: null, failures: 0 };
      queues.set(slug, queue);
    }
    return queue;
  }

  function schedule(slug) {
    const queue = queueFor(slug);
    if (queue.timer || queue.running || queue.pending.length === 0) return;
    const wait = queue.lastStartedAt === null ? 0 : Math.max(0, queue.lastStartedAt + debounceMs - now());
    queue.timer = setTimer(() => {
      queue.timer = null;
      void run(slug);
    }, wait);
  }

  async function run(slug) {
    const queue = queueFor(slug);
    if (queue.running || queue.pending.length === 0) return;
    queue.running = true;
    queue.lastStartedAt = now();
    const batch = queue.pending.splice(0);
    let outcome = "failed";
    try {
      outcome = await review(slug, batch);
    } catch {
      outcome = "failed";
    }
    queue.running = false;
    if (outcome === "reviewed") {
      queue.failures = 0;
      if (queue.pending.length > 0) schedule(slug);
      return;
    }
    if (outcome === "hold") {
      // Not the coworker's fault: keep everything and try again after the window.
      queue.pending.unshift(...batch);
      schedule(slug);
      return;
    }
    queue.failures += 1;
    if (queue.failures <= 1) {
      queue.pending.unshift(...batch);
      schedule(slug);
      return;
    }
    queue.failures = 0;
    onDropped(slug, batch);
    if (queue.pending.length > 0) schedule(slug);
  }

  return {
    add(slug, finding) {
      queueFor(slug).pending.push(finding);
      schedule(slug);
    },
    pending(slug) {
      return [...queueFor(slug).pending];
    },
    /** Try again now for findings held or failed earlier (for example once a discussion exists). */
    retry(slug) {
      schedule(slug);
    },
    clear(slug) {
      const queue = queueFor(slug);
      if (queue.timer) clearTimer(queue.timer);
      queues.delete(slug);
    },
  };
}

// ---------------------------------------------------------------------------
// The coworker's own Worker tools, served beside its document tools by the
// app's loopback MCP server (`coworker-tools.mjs`). Names reach the model as
// `coworker_<tool>`. The bearer token names the coworker, so no tool takes a
// coworker from the model; the Worker id is the only handle it passes.

const WORKER_ID_SCHEMA = { type: "string", description: "The Worker id, as listed by workers_list or returned when it was started." };

/** What the coworker can do with its Workers, in its own plain words. */
export function workerToolCatalog() {
  return [
    {
      name: "workers_list",
      description: `List my Workers — the long-lived helpers I start for one goal each — with status, lifespan left, and their last finding. Check it before starting another: at most ${MAX_LIVE_WORKERS} can be live at once.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "worker_spawn",
      description: `Start a Worker for one goal that outlives this reply: watching something over time, a long research pass, a multi-step job. It works in my workspace with my files and tools, reports a finding after each bounded step, and each finding wakes me to review it. Give it a short name and a goal that says what done looks like. Choose its lifespan: a number of turns (default ${DEFAULT_TURN_BUDGET}), a deadline, or until stopped. Then tell the person in a sentence what I started. Never start a Worker to answer a quick question, and never from inside a Worker.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short and specific, e.g. \"Market scan\"." },
          goal: { type: "string", description: "What done looks like, what to watch or produce, and any limits." },
          lifespan: {
            type: "object",
            description: "How long it lives. Omit for the default number of turns.",
            properties: {
              kind: { type: "string", enum: ["turns", "until", "open"] },
              turns: { type: "integer", minimum: 1, maximum: MAX_TURN_BUDGET, description: "With kind turns: how many bounded steps." },
              until: { type: "string", description: "With kind until: when it must stop, as an ISO 8601 date-time." },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        required: ["name", "goal"],
        additionalProperties: false,
      },
    },
    {
      name: "worker_steer",
      description: "Send a Worker a correction, more context, or the decision it is waiting for. It takes the message as its next step. Use it after reviewing a finding that needs a change of course.",
      inputSchema: {
        type: "object",
        properties: { id: WORKER_ID_SCHEMA, text: { type: "string", description: "What to do differently, in plain words." } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "worker_cancel",
      description: "Stop a Worker for good: the goal is met well enough, it is going the wrong way, or the person asked. Say why in a few words. A stopped Worker keeps its findings but never works again.",
      inputSchema: {
        type: "object",
        properties: { id: WORKER_ID_SCHEMA, reason: { type: "string", description: "Why it stops, in a few words." } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "worker_findings",
      description: "Read what one Worker has reported so far, oldest first, including any steering and reviews.",
      inputSchema: {
        type: "object",
        properties: { id: WORKER_ID_SCHEMA, limit: { type: "integer", minimum: 1, maximum: 100, description: "How many recent events; default 20." } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];
}

/** A Worker as a tool result names it: the fields the app's receipts and the model both read. */
export function workerCard(worker, extra = {}) {
  return {
    id: worker.id,
    name: worker.name,
    status: worker.status,
    waitingFor: worker.waitingFor,
    lifespan: worker.lifespan,
    lastFindingAt: worker.lastFindingAt,
    ...extra,
  };
}

/** The tool's lifespan argument as the record the store keeps; missing means the default turn budget. */
export function lifespanFromToolArgs(input, { now = Date.now() } = {}) {
  if (input === undefined || input === null) return normalizeLifespan(undefined, { now });
  if (!input || typeof input !== "object") throw new Error("lifespan must be an object with a kind.");
  if (input.kind === "turns") return normalizeLifespan({ kind: "turns", max: input.turns ?? DEFAULT_TURN_BUDGET }, { now });
  if (input.kind === "until") {
    const at = typeof input.until === "string" ? Date.parse(input.until) : Number(input.until);
    if (!Number.isFinite(at)) throw new Error("With kind until, give the stop time as an ISO 8601 date-time.");
    return normalizeLifespan({ kind: "until", at }, { now });
  }
  if (input.kind === "open") return { kind: "open" };
  throw new Error("lifespan.kind must be turns, until, or open.");
}

function describeWorkerForModel(worker, now) {
  const status = workerStatusForPrompt(worker, now);
  const last = worker.lastFindingAt ? ` — last finding ${Math.max(1, Math.round((now - worker.lastFindingAt) / 60_000))} min ago` : "";
  return `- ${worker.id} — "${worker.name}" — ${status}${last}\n    goal: ${worker.goal.replace(/\s+/g, " ").slice(0, 200)}`;
}

/**
 * Tool handlers for the coworker's Workers. Starting, steering, and stopping
 * go through the main process (`spawn`, `steer`, `cancel`), which owns the
 * turn loop and this Mac's run limit; listing and findings read the store.
 * Each returns `{ text, structured }`: a plain sentence for the model and the
 * card the app's receipts read.
 */
export function createWorkerToolHandlers({ coworkersDir, spawn, steer, cancel, now = Date.now }) {
  const idOf = (args) => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!isWorkerId(id)) throw new Error("Name the Worker by its id, as listed by workers_list.");
    return id;
  };
  return {
    workers_list: async (slug) => {
      const workers = await listWorkers(coworkersDir, slug);
      const live = liveWorkers(workers);
      const ended = workers.filter((worker) => isWorkerFinished(worker)).slice(0, 5);
      const at = now();
      const lines = [];
      lines.push(live.length === 0 ? `No live Workers (${MAX_LIVE_WORKERS} may run at once).` : `Live Workers (${live.length} of ${MAX_LIVE_WORKERS}):`);
      for (const worker of live) lines.push(describeWorkerForModel(worker, at));
      if (ended.length > 0) {
        lines.push("Recently ended:");
        for (const worker of ended) lines.push(describeWorkerForModel(worker, at));
      }
      return { text: lines.join("\n"), structured: { workers: workers.map((worker) => workerCard(worker)) } };
    },
    worker_spawn: async (slug, args) => {
      const worker = await spawn(slug, {
        name: typeof args.name === "string" ? args.name : "",
        goal: typeof args.goal === "string" ? args.goal : "",
        lifespan: lifespanFromToolArgs(args.lifespan, { now: now() }),
      });
      return {
        text: `Started Worker "${worker.name}" (id ${worker.id}), ${describeLifespanForPrompt(worker.lifespan, now())}. It will report a finding after each step and each finding wakes you. Now tell the person in a sentence what you started.`,
        structured: { worker: workerCard(worker, { action: "started" }) },
      };
    },
    worker_steer: async (slug, args) => {
      const worker = await steer(slug, idOf(args), typeof args.text === "string" ? args.text : "");
      return {
        text: `Steered "${worker.name}"; it takes that as its next step${worker.status === "running" ? " once its current step settles" : ""}.`,
        structured: { worker: workerCard(worker, { action: "steered" }) },
      };
    },
    worker_cancel: async (slug, args) => {
      const id = idOf(args);
      const before = await getWorker(coworkersDir, slug, id);
      if (isWorkerFinished(before)) {
        return {
          text: `"${before.name}" had already ${workerStatusForPrompt(before, now()) === "done" ? "finished" : workerStatusForPrompt(before, now())}; nothing to stop.`,
          structured: { worker: workerCard(before, { action: "unchanged" }) },
        };
      }
      const worker = await cancel(slug, id, typeof args.reason === "string" ? args.reason : "");
      return {
        text: `Stopped "${worker.name}". Its findings stay in the Workers view; it will not work again.`,
        structured: { worker: workerCard(worker, { action: "stopped" }) },
      };
    },
    worker_findings: async (slug, args) => {
      const id = idOf(args);
      const worker = await getWorker(coworkersDir, slug, id);
      const limit = Number.isFinite(Number(args.limit)) ? Math.min(100, Math.max(1, Math.round(Number(args.limit)))) : 20;
      const events = await readWorkerEvents(coworkersDir, slug, id, { limit });
      const at = now();
      const lines = [`"${worker.name}" — ${workerStatusForPrompt(worker, at)}. ${events.length === 0 ? "Nothing reported yet." : "Events, oldest first:"}`];
      for (const event of events) {
        const when = new Date(event.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        if (event.kind === "finding") lines.push(`- ${when} ${event.report === "decision" ? "needs a decision" : event.report === "done" ? "done" : "finding"}: ${event.text}`);
        else if (event.kind === "steer") lines.push(`- ${when} steered by ${event.by === "coworker" ? "you" : "the person"}: ${event.text}`);
        else if (event.kind === "review") lines.push(`- ${when} ${event.error ? "review did not go through" : "you reviewed this"}`);
        else lines.push(`- ${when} ${event.text}`);
      }
      return { text: lines.join("\n"), structured: { worker: workerCard(worker, { action: "read" }), events } };
    },
  };
}
