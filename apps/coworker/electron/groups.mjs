/**
 * Group chats: several coworkers in one conversation with the person.
 *
 * A group lives beside the coworker homes under `<coworkersDir>/.groups/<id>/`
 * as `group.json` (who is in it and which native thread each participant uses
 * for it) plus an append-only `timeline.jsonl` of what was said. Metadata is
 * written through a temp file and rename; timeline appends are serialized per
 * group so two turns never interleave a line. Groups are archived, not deleted.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const GROUPS_DIR = ".groups";
export const GROUP_SCHEMA_VERSION = 1;
/** How many turn records a group keeps; older ones fall off, their timeline lines stay. */
export const MAX_TURNS = 50;
/** What the timeline says for speakers a quit or crash cut off. */
export const INTERRUPTED_TURN_MESSAGE = "Stopped when the app closed";
const GROUP_ID = /^grp_[a-z0-9]{8,32}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVENT_KINDS = new Set(["user", "coworker", "status", "action"]);
const TURN_STATUSES = new Set(["routing", "running", "succeeded", "partial", "failed", "stopped"]);
/** `passed` is a speaker that had nothing to add; it counts as finished and is never re-run. */
const SPEAKER_STATUSES = new Set(["queued", "running", "succeeded", "passed", "failed", "stopped"]);
const SPEAKER_PARTS = new Set(["reply", "follow-up", "wrap-up"]);
const TURN_MODES = new Set(["sequential", "parallel"]);
const ROUTED_BY = new Set(["facilitator", "mentions", "fallback"]);
const MAX_TIMELINE_READ = 400;
const MAX_PROMPT_CHARS = 20_000;
const MAX_TEXT_CHARS = 2_000;

/** One append chain per group id, so writes to a timeline never interleave. */
const appendQueues = new Map();
/** One metadata chain per group id, so two turn updates never lose each other's write. */
const metadataQueues = new Map();

export function newGroupId() {
  return `grp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newEventId() {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newTurnId() {
  return `turn_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function clipText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * A turn's status follows its speakers: running while any is still to come,
 * succeeded when every one finished (or had nothing to add), failed or stopped
 * when nobody finished, partial for any other mix.
 */
export function deriveTurnStatus(speakers) {
  if (speakers.length === 0) return "routing";
  if (speakers.some((speaker) => speaker.status === "queued" || speaker.status === "running")) return "running";
  const finished = speakers.filter((speaker) => speaker.status === "succeeded" || speaker.status === "passed").length;
  if (finished === speakers.length) return "succeeded";
  if (finished > 0) return "partial";
  return speakers.every((speaker) => speaker.status === "failed") ? "failed" : "stopped";
}

function normalizeSpeaker(raw, index) {
  if (!raw || typeof raw !== "object" || !SLUG.test(raw.slug)) return null;
  return {
    slug: raw.slug,
    order: Number.isFinite(raw.order) ? raw.order : index,
    status: SPEAKER_STATUSES.has(raw.status) ? raw.status : "queued",
    part: SPEAKER_PARTS.has(raw.part) ? raw.part : "reply",
    brief: clipText(raw.brief, MAX_TEXT_CHARS),
    threadId: clipText(raw.threadId, 240),
    error: clipText(raw.error, MAX_TEXT_CHARS),
    startedAt: finiteOrNull(raw.startedAt),
    endedAt: finiteOrNull(raw.endedAt),
  };
}

function normalizeTurn(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const speakers = Array.isArray(raw.speakers) ? raw.speakers.map(normalizeSpeaker).filter(Boolean) : [];
  return {
    id: raw.id,
    clientMessageId: clipText(raw.clientMessageId, 240),
    prompt: clipText(raw.prompt, MAX_PROMPT_CHARS),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    status: TURN_STATUSES.has(raw.status) ? raw.status : deriveTurnStatus(speakers),
    mode: TURN_MODES.has(raw.mode) ? raw.mode : "sequential",
    routedBy: ROUTED_BY.has(raw.routedBy) ? raw.routedBy : "fallback",
    speakers,
  };
}

export function isGroupId(value) {
  return typeof value === "string" && GROUP_ID.test(value);
}

function groupDir(coworkersDir, id) {
  if (!isGroupId(id)) throw new Error("Invalid group id.");
  return path.join(coworkersDir, GROUPS_DIR, id);
}

function metadataPath(coworkersDir, id) {
  return path.join(groupDir(coworkersDir, id), "group.json");
}

function timelinePath(coworkersDir, id) {
  return path.join(groupDir(coworkersDir, id), "timeline.jsonl");
}

export function normalizeParticipantSlugs(input) {
  if (!Array.isArray(input)) throw new Error("A group needs its participants as a list of coworker slugs.");
  const slugs = [];
  for (const raw of input) {
    const slug = typeof raw === "string" ? raw.trim() : "";
    if (!SLUG.test(slug)) throw new Error(`Invalid coworker slug: ${String(raw)}`);
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  if (slugs.length < 2) throw new Error("A group chat needs at least two coworkers.");
  return slugs;
}

function normalizeName(name, fallback) {
  const trimmed = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  return (trimmed || fallback).slice(0, 80);
}

async function writeMetadata(coworkersDir, group) {
  const target = metadataPath(coworkersDir, group.id);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(group, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return group;
}

/** Read, change, and write one group's metadata without interleaving another change to it. */
async function mutateGroup(coworkersDir, id, change) {
  if (!isGroupId(id)) throw new Error("Invalid group id.");
  const previous = metadataQueues.get(id) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const group = await getGroup(coworkersDir, id);
      const outcome = await change(group);
      if (outcome.next !== group) await writeMetadata(coworkersDir, outcome.next);
      return outcome.result;
    });
  metadataQueues.set(id, run);
  try {
    return await run;
  } finally {
    if (metadataQueues.get(id) === run) metadataQueues.delete(id);
  }
}

function normalizeStoredGroup(raw) {
  if (!raw || typeof raw !== "object" || !isGroupId(raw.id)) return null;
  return {
    schemaVersion: GROUP_SCHEMA_VERSION,
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "Group chat",
    participantSlugs: Array.isArray(raw.participantSlugs) ? raw.participantSlugs.filter((slug) => typeof slug === "string" && SLUG.test(slug)) : [],
    participantThreadIds: raw.participantThreadIds && typeof raw.participantThreadIds === "object" ? { ...raw.participantThreadIds } : {},
    facilitatorModel: typeof raw.facilitatorModel === "string" ? raw.facilitatorModel : "",
    facilitatorThreadId: typeof raw.facilitatorThreadId === "string" ? raw.facilitatorThreadId : "",
    turns: Array.isArray(raw.turns) ? raw.turns.map(normalizeTurn).filter(Boolean).slice(-MAX_TURNS) : [],
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    archivedAt: Number.isFinite(raw.archivedAt) ? raw.archivedAt : null,
  };
}

export async function createGroup(coworkersDir, { name, participantSlugs }, { now = Date.now() } = {}) {
  const slugs = normalizeParticipantSlugs(participantSlugs);
  const group = {
    schemaVersion: GROUP_SCHEMA_VERSION,
    id: newGroupId(),
    name: normalizeName(name, "Group chat"),
    participantSlugs: slugs,
    participantThreadIds: {},
    facilitatorModel: "",
    facilitatorThreadId: "",
    turns: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  await writeMetadata(coworkersDir, group);
  await writeFile(timelinePath(coworkersDir, group.id), "", { flag: "a" });
  return group;
}

export async function getGroup(coworkersDir, id) {
  const raw = JSON.parse(await readFile(metadataPath(coworkersDir, id), "utf8"));
  const group = normalizeStoredGroup(raw);
  if (!group) throw new Error("Group metadata is unreadable.");
  return group;
}

export async function listGroups(coworkersDir) {
  let entries = [];
  try {
    entries = await readdir(path.join(coworkersDir, GROUPS_DIR), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const groups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isGroupId(entry.name)) continue;
    try {
      groups.push(await getGroup(coworkersDir, entry.name));
    } catch {
      // A half-written group folder is skipped rather than failing the whole list.
    }
  }
  return groups.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateGroup(coworkersDir, id, patch = {}, { now = Date.now() } = {}) {
  return mutateGroup(coworkersDir, id, (group) => {
    const next = { ...group, updatedAt: now };
    if (patch.name !== undefined) next.name = normalizeName(patch.name, group.name);
    if (patch.participantSlugs !== undefined) next.participantSlugs = normalizeParticipantSlugs(patch.participantSlugs);
    if (patch.participantThreadIds !== undefined) {
      if (!patch.participantThreadIds || typeof patch.participantThreadIds !== "object") throw new Error("participantThreadIds must map slugs to thread ids.");
      next.participantThreadIds = { ...group.participantThreadIds };
      for (const [slug, threadId] of Object.entries(patch.participantThreadIds)) {
        if (!SLUG.test(slug)) throw new Error(`Invalid coworker slug: ${slug}`);
        if (typeof threadId !== "string" || !threadId) delete next.participantThreadIds[slug];
        else next.participantThreadIds[slug] = threadId;
      }
    }
    if (patch.facilitatorModel !== undefined) next.facilitatorModel = typeof patch.facilitatorModel === "string" ? patch.facilitatorModel : "";
    if (patch.facilitatorThreadId !== undefined) next.facilitatorThreadId = typeof patch.facilitatorThreadId === "string" ? patch.facilitatorThreadId : "";
    return { next, result: next };
  });
}

export async function archiveGroup(coworkersDir, id, { now = Date.now() } = {}) {
  return mutateGroup(coworkersDir, id, (group) => {
    const next = { ...group, archivedAt: now, updatedAt: now };
    return { next, result: next };
  });
}

function normalizeSpeakerInputs(input) {
  if (!Array.isArray(input)) throw new Error("A turn's speakers are a list.");
  const seen = new Set();
  const speakers = [];
  input.forEach((raw, index) => {
    const speaker = normalizeSpeaker({ ...raw, order: index }, index);
    if (!speaker) throw new Error(`Invalid speaker: ${JSON.stringify(raw)}`);
    // The same coworker may reply and later wrap up, but never twice in the same part.
    const key = `${speaker.slug}:${speaker.part}`;
    if (seen.has(key)) throw new Error(`Duplicate speaker: ${speaker.slug}`);
    seen.add(key);
    speakers.push(speaker);
  });
  return speakers;
}

/**
 * Open a turn for one message from the person: the record first, then the
 * visible user line. The same `clientMessageId` never opens a second turn — a
 * double Send comes back with the turn that already exists.
 */
export async function beginGroupTurn(coworkersDir, id, { clientMessageId, prompt }, { now = Date.now() } = {}) {
  const messageId = clipText(clientMessageId, 240);
  if (!messageId) throw new Error("A turn needs the message's client id.");
  const text = clipText(prompt, MAX_PROMPT_CHARS).trim();
  if (!text) throw new Error("A turn needs the person's message.");
  const outcome = await mutateGroup(coworkersDir, id, (group) => {
    const existing = group.turns.find((turn) => turn.clientMessageId === messageId);
    if (existing) return { next: group, result: { group, turn: existing, created: false } };
    const turn = {
      id: newTurnId(),
      clientMessageId: messageId,
      prompt: text,
      createdAt: now,
      updatedAt: now,
      status: "routing",
      mode: "sequential",
      routedBy: "fallback",
      speakers: [],
    };
    const next = { ...group, turns: [...group.turns, turn].slice(-MAX_TURNS), updatedAt: now };
    return { next, result: { group: next, turn, created: true } };
  });
  if (!outcome.created) return { ...outcome, userEvent: null };
  const userEvent = await appendGroupEvent(coworkersDir, id, { kind: "user", text, turnId: outcome.turn.id, clientMessageId: messageId }, { now });
  return { ...outcome, userEvent };
}

/**
 * Change one turn: its speakers (whole list, in speaking order), one speaker's
 * progress, how it was routed, or its status. The status follows the speakers
 * unless the patch sets it explicitly (recovery marks a turn `partial`).
 */
export async function updateGroupTurn(coworkersDir, id, turnId, patch = {}, { now = Date.now() } = {}) {
  return mutateGroup(coworkersDir, id, (group) => {
    const index = group.turns.findIndex((turn) => turn.id === turnId);
    if (index === -1) throw new Error("That turn is no longer recorded.");
    const current = group.turns[index];
    let speakers = current.speakers;
    if (patch.speakers !== undefined) speakers = normalizeSpeakerInputs(patch.speakers);
    if (patch.speaker !== undefined) {
      const { slug, part = "reply", ...changes } = patch.speaker ?? {};
      const target = speakers.findIndex((speaker) => speaker.slug === slug && speaker.part === part);
      if (target === -1) throw new Error("That coworker is not part of this turn.");
      const merged = normalizeSpeaker({ ...speakers[target], ...changes, slug, part, order: speakers[target].order }, target);
      speakers = speakers.with(target, merged);
    }
    const turn = {
      ...current,
      speakers,
      mode: TURN_MODES.has(patch.mode) ? patch.mode : current.mode,
      routedBy: ROUTED_BY.has(patch.routedBy) ? patch.routedBy : current.routedBy,
      status: TURN_STATUSES.has(patch.status) ? patch.status : deriveTurnStatus(speakers),
      updatedAt: now,
    };
    const next = { ...group, turns: group.turns.with(index, turn), updatedAt: now };
    return { next, result: turn };
  });
}

/**
 * A turn still `routing` or `running` with no live run in this process was cut
 * off by a quit, crash, or reload. Its unfinished speakers become `stopped`
 * with a plain reason, the turn becomes `partial` so the view can offer
 * Continue, and one quiet line says so in the timeline. Finished replies are
 * never touched, so nothing that was said is lost or repeated.
 */
export async function reconcileInterruptedGroupTurns(coworkersDir, { activeTurnIds = new Set(), nameFor = (slug) => slug, now = Date.now() } = {}) {
  const groups = await listGroups(coworkersDir);
  const recovered = [];
  for (const group of groups) {
    const interrupted = group.turns.filter((turn) => (turn.status === "routing" || turn.status === "running") && !activeTurnIds.has(turn.id));
    if (interrupted.length === 0) continue;
    await mutateGroup(coworkersDir, group.id, (current) => {
      const turns = current.turns.map((turn) => {
        if (!interrupted.some((candidate) => candidate.id === turn.id)) return turn;
        const speakers = turn.speakers.map((speaker) =>
          speaker.status === "queued" || speaker.status === "running"
            ? { ...speaker, status: "stopped", error: INTERRUPTED_TURN_MESSAGE, endedAt: now }
            : speaker,
        );
        return { ...turn, speakers, status: "partial", updatedAt: now };
      });
      return { next: { ...current, turns, updatedAt: now }, result: current };
    });
    for (const turn of interrupted) {
      const unfinished = turn.speakers.filter((speaker) => speaker.status === "queued" || speaker.status === "running").map((speaker) => nameFor(speaker.slug));
      const who = unfinished.length === 0 ? "anyone" : listNames(unfinished);
      await appendGroupEvent(coworkersDir, group.id, { kind: "status", turnId: turn.id, status: "interrupted", text: `${INTERRUPTED_TURN_MESSAGE} before ${who} replied.` }, { now });
      recovered.push({ groupId: group.id, turnId: turn.id });
    }
  }
  return recovered;
}

/** "Scout", "Scout and Editor", "Scout, Editor and Ops". */
export function listNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function normalizeEvent(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object") throw new Error("A timeline event is required.");
  if (!EVENT_KINDS.has(input.kind)) throw new Error("Unknown timeline event kind.");
  const text = typeof input.text === "string" ? input.text : "";
  const slug = typeof input.slug === "string" ? input.slug : "";
  if ((input.kind === "coworker" || input.kind === "action") && !SLUG.test(slug)) throw new Error("A coworker message names its coworker.");
  const event = {
    id: typeof input.id === "string" && input.id ? input.id : newEventId(),
    at: Number.isFinite(input.at) ? input.at : now,
    kind: input.kind,
    text,
  };
  if (slug) event.slug = slug;
  if (typeof input.turnId === "string" && input.turnId) event.turnId = input.turnId;
  if (typeof input.clientMessageId === "string" && input.clientMessageId) event.clientMessageId = input.clientMessageId;
  if (typeof input.status === "string" && input.status) event.status = input.status;
  if (typeof input.threadId === "string" && input.threadId) event.threadId = input.threadId;
  // An action line links what the group did (an assignment, say) to where it lives.
  if (typeof input.action === "string" && input.action) event.action = input.action;
  if (typeof input.title === "string" && input.title) event.title = input.title;
  return event;
}

export function parseTimeline(content) {
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

export async function readGroupTimeline(coworkersDir, id, { limit = MAX_TIMELINE_READ } = {}) {
  let content = "";
  try {
    content = await readFile(timelinePath(coworkersDir, id), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const events = parseTimeline(content);
  return events.length > limit ? events.slice(events.length - limit) : events;
}

export async function appendGroupEvent(coworkersDir, id, input, { now = Date.now() } = {}) {
  const target = timelinePath(coworkersDir, id);
  const event = normalizeEvent(input, { now });
  const previous = appendQueues.get(id) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    });
  appendQueues.set(id, run);
  try {
    return await run;
  } finally {
    if (appendQueues.get(id) === run) appendQueues.delete(id);
  }
}
