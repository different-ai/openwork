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
const GROUP_ID = /^grp_[a-z0-9]{8,32}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVENT_KINDS = new Set(["user", "coworker", "status"]);
const MAX_TIMELINE_READ = 400;

/** One append chain per group id, so writes to a timeline never interleave. */
const appendQueues = new Map();

export function newGroupId() {
  return `grp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newEventId() {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
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

function normalizeStoredGroup(raw) {
  if (!raw || typeof raw !== "object" || !isGroupId(raw.id)) return null;
  return {
    schemaVersion: GROUP_SCHEMA_VERSION,
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "Group chat",
    participantSlugs: Array.isArray(raw.participantSlugs) ? raw.participantSlugs.filter((slug) => typeof slug === "string" && SLUG.test(slug)) : [],
    participantThreadIds: raw.participantThreadIds && typeof raw.participantThreadIds === "object" ? { ...raw.participantThreadIds } : {},
    facilitatorModel: typeof raw.facilitatorModel === "string" ? raw.facilitatorModel : "",
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
  const group = await getGroup(coworkersDir, id);
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
  return writeMetadata(coworkersDir, next);
}

export async function archiveGroup(coworkersDir, id, { now = Date.now() } = {}) {
  const group = await getGroup(coworkersDir, id);
  return writeMetadata(coworkersDir, { ...group, archivedAt: now, updatedAt: now });
}

export function normalizeEvent(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object") throw new Error("A timeline event is required.");
  if (!EVENT_KINDS.has(input.kind)) throw new Error("Unknown timeline event kind.");
  const text = typeof input.text === "string" ? input.text : "";
  const slug = typeof input.slug === "string" ? input.slug : "";
  if (input.kind === "coworker" && !SLUG.test(slug)) throw new Error("A coworker message names its coworker.");
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
