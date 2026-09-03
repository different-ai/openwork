/**
 * What a coworker keeps about itself and the person, changed deliberately.
 *
 * Working memory, long-term memories, and the soul stay plain Markdown files
 * in the coworker home; this module is the one path that changes them on the
 * coworker's behalf (its `memory_*` and `soul_*` tools) and on the person's
 * (the Memory view). Every write is atomic, refuses secrets, keeps the files
 * small, and leaves a line in `memory/changes.jsonl` so the Memory view can
 * show what changed and undo it — undo being a recorded change itself.
 *
 * No Electron imports: exercised by `node --test electron/self-memory.test.mjs`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createLongTermMemory,
  deleteLongTermMemory,
  listLongTermMemories,
  resolveCoworkerFile,
} from "./coworkers.mjs";
import { memoryFileNameFor, memoryTitle } from "./memory-index.mjs";

export const SOUL_FILE = "soul.md";
export const WORKING_MEMORY_FILE = "memory/working.md";
export const MEMORY_INDEX_FILE = "memory/index.md";
export const LONG_TERM_DIR = "memory/long-term";
export const CHANGES_FILE = "memory/changes.jsonl";

/** Recent changes kept per coworker; older lines fall off the end. */
export const CHANGES_LIMIT = 60;
/** Bullets working memory may hold in total: it is curated, never a log. */
export const WORKING_MEMORY_BULLET_LIMIT = 30;
/** One remembered fact, bounded. */
export const MEMORY_TEXT_LIMIT = 600;
/** Snapshot kept per file per change so undo can restore it. */
export const CHANGE_TEXT_LIMIT = 64_000;
/** The soul's four sections, in the order the template writes them. */
export const SOUL_SECTIONS = ["Role", "Mission", "Principles", "Communication"];
/** Sections that hold one paragraph rather than bullets. */
const PARAGRAPH_SECTIONS = new Set(["Role", "Mission"]);
const WORKING_NOW_HEADING = "Now";
const WORKING_PLACEHOLDERS = new Set(["nothing yet. i was just created", "(empty)"]);
const DEFAULT_TOPIC = "General";

export const SECRET_REFUSAL = "That looks like a secret or a credential, so I won't keep it in memory. Ask the person to store it somewhere safe instead.";

/** A problem in words the coworker can relay to the person. */
export class MemoryError extends Error {}

// ---------------------------------------------------------------------------
// Secrets

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:password|passwd|passphrase|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|client[ _-]?secret)\b\s*(?:is|=|:)\s*\S{4,}/i,
  /\b[0-9a-f]{40,}\b/i,
  /\b(?:\d[ -]?){13,19}\b/,
];

/** Whether text looks like a secret or credential; the coworker never stores it. */
export function looksLikeSecret(text) {
  const value = String(text ?? "");
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function refuseSecrets(...texts) {
  if (texts.some((text) => looksLikeSecret(text))) throw new MemoryError(SECRET_REFUSAL);
}

// ---------------------------------------------------------------------------
// Markdown helpers

function normalizeLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").toLowerCase();
}

function cleanFact(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) throw new MemoryError("Say what to remember.");
  if (value.length > MEMORY_TEXT_LIMIT) throw new MemoryError(`Keep one memory under ${MEMORY_TEXT_LIMIT} characters; split it or leave out what is not needed.`);
  return value.replace(/^[-*]\s+/, "");
}

function isBullet(line) {
  return /^\s*[-*]\s+/.test(line);
}

function bulletText(line) {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

/**
 * Split Markdown into a preamble and `## ` sections. Each section keeps its
 * raw lines so serialization never touches a section that was not changed.
 */
export function parseSections(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections };
}

export function serializeSections({ preamble, sections }) {
  const parts = [preamble.join("\n").replace(/\n+$/, "")];
  for (const section of sections) {
    const body = section.lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    parts.push(`## ${section.name}${body ? `\n\n${body}` : ""}`);
  }
  return `${parts.filter((part, index) => index === 0 ? part.length > 0 : true).join("\n\n")}\n`;
}

function findSection(document, name) {
  const wanted = name.trim().toLowerCase();
  return document.sections.find((section) => section.name.trim().toLowerCase() === wanted) ?? null;
}

function sectionBullets(section) {
  return section.lines.filter(isBullet).map(bulletText);
}

/** Replace a section's bullets while keeping any prose above them. */
function setSectionBullets(section, bullets) {
  const prose = [];
  for (const line of section.lines) {
    if (isBullet(line)) break;
    prose.push(line);
  }
  const lead = prose.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  section.lines = [...(lead ? [lead, ""] : []), ...bullets.map((bullet) => `- ${bullet}`)];
}

// ---------------------------------------------------------------------------
// Soul

/** The soul as its four sections; missing sections are reported, never invented. */
export function parseSoul(text) {
  const document = parseSections(text);
  return {
    document,
    sections: Object.fromEntries(SOUL_SECTIONS.map((name) => {
      const section = findSection(document, name);
      if (!section) return [name, null];
      return [name, PARAGRAPH_SECTIONS.has(name)
        ? { kind: "paragraph", text: section.lines.join("\n").trim() }
        : { kind: "bullets", items: sectionBullets(section) }];
    })),
  };
}

export const SOUL_CHANGE_KINDS = ["add", "replace", "remove", "rewrite"];

function cleanSoulSection(value) {
  const match = SOUL_SECTIONS.find((name) => name.toLowerCase() === String(value ?? "").trim().toLowerCase());
  if (!match) throw new MemoryError(`The soul has four sections I can change: ${SOUL_SECTIONS.join(", ")}.`);
  return match;
}

function cleanChange(value) {
  const source = value && typeof value === "object" ? value : {};
  const kind = SOUL_CHANGE_KINDS.includes(source.kind) ? source.kind : "";
  if (!kind) throw new MemoryError("A soul change is one of: add, replace, remove, or rewrite.");
  // Newlines stay so a rewrite can list several lines; other whitespace collapses.
  const text = String(source.text ?? "").replace(/[^\S\n]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const target = String(source.target ?? "").replace(/\s+/g, " ").trim();
  if (kind !== "remove" && !text) throw new MemoryError(`Say what to ${kind === "rewrite" ? "write" : kind}.`);
  if ((kind === "replace" || kind === "remove") && !target) throw new MemoryError(`Name the line to ${kind}.`);
  if (text.length > MEMORY_TEXT_LIMIT) throw new MemoryError(`Keep a soul change under ${MEMORY_TEXT_LIMIT} characters.`);
  refuseSecrets(text);
  return { kind, text, target };
}

/**
 * Apply one change inside one section of the soul and leave every other
 * section byte for byte as it was. Returns the new text and a one-line
 * account of what happened.
 */
export function applySoulChange(soulText, sectionName, changeInput) {
  const section = cleanSoulSection(sectionName);
  const change = cleanChange(changeInput);
  const document = parseSections(soulText);
  let target = findSection(document, section);
  if (!target) {
    target = { name: section, lines: [] };
    document.sections.push(target);
  }
  if (PARAGRAPH_SECTIONS.has(section)) {
    const paragraph = target.lines.join("\n").trim();
    let next;
    if (change.kind === "rewrite") next = change.text;
    else if (change.kind === "add") next = paragraph ? `${paragraph} ${change.text}` : change.text;
    else {
      const index = paragraph.toLowerCase().indexOf(change.target.toLowerCase());
      if (index === -1) throw new MemoryError(`I couldn't find "${change.target}" in the ${section} section.`);
      const before = paragraph.slice(0, index);
      const after = paragraph.slice(index + change.target.length);
      next = change.kind === "replace" ? `${before}${change.text}${after}` : `${before}${after}`;
      next = next.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
    }
    target.lines = next ? [next] : [];
  } else {
    const bullets = sectionBullets(target);
    const matches = (bullet) => normalizeLine(bullet) === normalizeLine(change.target) || bullet.toLowerCase().includes(change.target.toLowerCase());
    let next;
    if (change.kind === "rewrite") {
      next = change.text.split(/\n|(?:^|\s)-\s+/).map((line) => line.trim()).filter(Boolean);
    } else if (change.kind === "add") {
      next = bullets.some((bullet) => normalizeLine(bullet) === normalizeLine(change.text)) ? bullets : [...bullets, change.text];
    } else {
      const index = bullets.findIndex(matches);
      if (index === -1) throw new MemoryError(`I couldn't find a line about "${change.target}" in the ${section} section.`);
      next = change.kind === "replace" ? bullets.with(index, change.text) : bullets.filter((_, position) => position !== index);
    }
    setSectionBullets(target, next);
  }
  const summary = change.kind === "add"
    ? `Updated ${section}: added "${change.text}"`
    : change.kind === "replace"
      ? `Updated ${section}: replaced "${change.target}" with "${change.text}"`
      : change.kind === "remove"
        ? `Updated ${section}: removed "${change.target}"`
        : `Updated ${section}: rewrote it`;
  return { text: serializeSections(document), summary, section, change };
}

// ---------------------------------------------------------------------------
// Atomic files and the changes log

async function readOptional(target) {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

let temporarySequence = 0;

async function writeAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  temporarySequence += 1;
  const temporary = `${target}.${process.pid}.${temporarySequence}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

function clipSnapshot(text) {
  if (text === null) return null;
  return text.length > CHANGE_TEXT_LIMIT ? text.slice(0, CHANGE_TEXT_LIMIT) : text;
}

function cleanInput(value) {
  if (!value || typeof value !== "object") return {};
  const text = JSON.stringify(value);
  return text.length > 4_000 ? { note: "input too long to keep" } : JSON.parse(text);
}

async function readChangeLines(coworkersDir, slug) {
  const raw = await readOptional(resolveCoworkerFile(coworkersDir, slug, CHANGES_FILE));
  if (!raw) return [];
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.id === "string") entries.push(parsed);
    } catch {
      // A line cut short by a crash is dropped; the memory files themselves are the truth.
    }
  }
  return entries;
}

const changeQueues = new Map();

/** Append one change, keeping the log bounded; appends to one coworker are serialized. */
async function appendChange(coworkersDir, slug, entry) {
  const key = resolveCoworkerFile(coworkersDir, slug, CHANGES_FILE);
  const previous = changeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const entries = [...await readChangeLines(coworkersDir, slug), entry].slice(-CHANGES_LIMIT);
    await writeAtomic(key, `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`);
    return entry;
  });
  changeQueues.set(key, run.then(() => undefined, () => undefined));
  try {
    return await run;
  } finally {
    if (changeQueues.get(key) === run) changeQueues.delete(key);
  }
}

/** Recent changes, newest first, without the file snapshots (those stay on disk for undo). */
export async function readChanges(coworkersDir, slug, { limit = 20 } = {}) {
  const entries = await readChangeLines(coworkersDir, slug);
  const undone = new Set(entries.filter((entry) => typeof entry.undoes === "string").map((entry) => entry.undoes));
  return entries
    .slice()
    .reverse()
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      id: entry.id,
      at: entry.at,
      actor: entry.actor,
      tool: entry.tool,
      input: entry.input ?? {},
      output: entry.output ?? "",
      files: (entry.files ?? []).map((file) => ({ path: file.path, ...changeExcerpts(file.before, file.after) })),
      undoes: entry.undoes ?? null,
      undone: undone.has(entry.id),
    }));
}

function excerpt(text) {
  if (text === null || text === undefined) return null;
  const single = String(text).replace(/\s+/g, " ").trim();
  return single.length > 160 ? `${single.slice(0, 159)}…` : single;
}

/** The part of each text that differs, so the Memory view can show what changed rather than whole files. */
function changeExcerpts(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) {
    return { before: excerpt(before ?? null), after: excerpt(after ?? null) };
  }
  const left = String(before);
  const right = String(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return { before: excerpt(left.slice(prefix, left.length - suffix)), after: excerpt(right.slice(prefix, right.length - suffix)) };
}

/**
 * Run `mutate` while watching the named files; the files that actually
 * changed are recorded as one change with their full before and after text.
 */
export async function trackChange(coworkersDir, slug, paths, meta, mutate) {
  const targets = [...new Set(paths)].map((relative) => ({ relative, absolute: resolveCoworkerFile(coworkersDir, slug, relative) }));
  const before = new Map();
  for (const target of targets) before.set(target.relative, await readOptional(target.absolute));
  const result = await mutate();
  const files = [];
  for (const target of targets) {
    const after = await readOptional(target.absolute);
    const prior = before.get(target.relative) ?? null;
    if (after !== prior) files.push({ path: target.relative, before: clipSnapshot(prior), after: clipSnapshot(after) });
  }
  if (files.length === 0) return { change: null, result };
  const change = await appendChange(coworkersDir, slug, {
    id: randomUUID(),
    at: Number.isFinite(meta.now) ? meta.now : Date.now(),
    actor: meta.actor === "person" || meta.actor === "undo" ? meta.actor : "coworker",
    tool: String(meta.tool ?? "edit"),
    input: cleanInput(meta.input),
    output: String(meta.output ?? "").split("\n")[0].slice(0, 300),
    files,
    ...(meta.undoes ? { undoes: meta.undoes } : {}),
  });
  return { change, result };
}

/** Write one memory file atomically as the person, recording the change. */
export async function writeTrackedFile(coworkersDir, slug, relativePath, content, meta = {}) {
  const target = resolveCoworkerFile(coworkersDir, slug, relativePath);
  return trackChange(coworkersDir, slug, [relativePath], { actor: "person", tool: "edit", ...meta, input: { path: relativePath } }, async () => {
    await writeAtomic(target, String(content ?? ""));
  });
}

/** Restore the files a change touched to how they were before it; the undo is itself a change. */
export async function undoChange(coworkersDir, slug, changeId, { now = Date.now() } = {}) {
  const entries = await readChangeLines(coworkersDir, slug);
  const entry = entries.find((candidate) => candidate.id === changeId);
  if (!entry) throw new MemoryError("That change is no longer in the list.");
  if (entries.some((candidate) => candidate.undoes === changeId)) throw new MemoryError("That change was already undone.");
  const paths = (entry.files ?? []).map((file) => file.path);
  const { change } = await trackChange(coworkersDir, slug, paths, { actor: "undo", tool: "undo", undoes: changeId, input: { undoes: changeId }, output: entry.output, now }, async () => {
    for (const file of entry.files ?? []) {
      const target = resolveCoworkerFile(coworkersDir, slug, file.path);
      if (file.before === null || file.before === undefined) await rm(target, { force: true });
      else await writeAtomic(target, file.before);
    }
  });
  return change;
}

// ---------------------------------------------------------------------------
// Memory

async function readWorking(coworkersDir, slug) {
  return (await readOptional(resolveCoworkerFile(coworkersDir, slug, WORKING_MEMORY_FILE))) ?? "# Working memory\n";
}

function workingBulletCount(document) {
  return document.sections.reduce((total, section) => total + sectionBullets(section).filter((bullet) => !WORKING_PLACEHOLDERS.has(normalizeLine(bullet))).length, 0);
}

/** Add a fact to the `Now` section of working memory; placeholders give way, duplicates are skipped. */
function addWorkingFact(text, fact) {
  const document = parseSections(text);
  let now = findSection(document, WORKING_NOW_HEADING);
  if (!now) {
    now = { name: WORKING_NOW_HEADING, lines: [] };
    document.sections.unshift(now);
  }
  const bullets = sectionBullets(now).filter((bullet) => !WORKING_PLACEHOLDERS.has(normalizeLine(bullet)));
  if (bullets.some((bullet) => normalizeLine(bullet) === normalizeLine(fact))) return { text, added: false, count: workingBulletCount(document) };
  if (workingBulletCount(document) >= WORKING_MEMORY_BULLET_LIMIT) {
    throw new MemoryError(`Working memory already holds ${WORKING_MEMORY_BULLET_LIMIT} items. Forget what is done or move what is durable to long-term memory before adding more.`);
  }
  setSectionBullets(now, [...bullets, fact]);
  return { text: serializeSections(document), added: true, count: workingBulletCount(document) };
}

/** Remove the bullet matching `target` from any section; returns the removed line or null. */
function removeBullet(text, target) {
  const document = parseSections(text);
  const wanted = normalizeLine(target);
  for (const section of document.sections) {
    const bullets = sectionBullets(section);
    const index = bullets.findIndex((bullet) => normalizeLine(bullet) === wanted);
    const loose = index === -1 ? bullets.findIndex((bullet) => bullet.toLowerCase().includes(target.trim().toLowerCase())) : index;
    if (loose === -1) continue;
    const removed = bullets[loose];
    setSectionBullets(section, bullets.filter((_, position) => position !== loose));
    return { text: serializeSections(document), removed };
  }
  return null;
}

/** Append a bullet to a long-term memory file, keeping its heading first and skipping duplicates. */
function addLongTermFact(text, title, fact) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const bullets = lines.filter(isBullet).map(bulletText);
  if (bullets.some((bullet) => normalizeLine(bullet) === normalizeLine(fact))) return { text, added: false };
  const body = lines.join("\n").replace(/\n+$/, "");
  const withHeading = body.trim() ? body : `# ${title}`;
  return { text: `${withHeading}\n${bullets.length > 0 || !withHeading.trim() ? "" : "\n"}- ${fact}\n`, added: true };
}

async function findLongTermMemory(coworkersDir, slug, topic) {
  const memories = await listLongTermMemories(coworkersDir, slug);
  const file = memoryFileNameFor(topic);
  const wanted = normalizeLine(topic);
  return memories.find((memory) => memory.exists && (memory.file === file || normalizeLine(memory.title) === wanted)) ?? null;
}

/**
 * `memory_remember`: a fact into working memory (what the current work needs)
 * or into a long-term topic file (what stays true). A fact promoted from
 * working memory leaves it, and the answer says it was moved.
 */
export async function rememberFact(coworkersDir, slug, { text, kind, topic }, { now = Date.now() } = {}) {
  const fact = cleanFact(text);
  refuseSecrets(fact, topic);
  const where = kind === "long-term" ? "long-term" : kind === "working" || kind === undefined || kind === null ? "working" : "";
  if (!where) throw new MemoryError('Memory has two places: "working" for the current work and "long-term" for what stays true.');
  if (where === "working") {
    const working = await readWorking(coworkersDir, slug);
    const next = addWorkingFact(working, fact);
    if (!next.added) return { output: `Already in working memory: ${fact}`, change: null };
    const { change } = await trackChange(coworkersDir, slug, [WORKING_MEMORY_FILE], {
      tool: "memory_remember",
      input: { text: fact, kind: where },
      output: `Remembered in working memory: ${fact}`,
      now,
    }, () => writeAtomic(resolveCoworkerFile(coworkersDir, slug, WORKING_MEMORY_FILE), next.text));
    return { output: `Remembered in working memory: ${fact}\nWorking memory now holds ${next.count} item${next.count === 1 ? "" : "s"}.`, change };
  }
  const title = String(topic ?? "").replace(/\s+/g, " ").trim() || DEFAULT_TOPIC;
  const existing = await findLongTermMemory(coworkersDir, slug, title);
  const working = await readWorking(coworkersDir, slug);
  const promoted = removeBullet(working, fact);
  const verb = promoted ? "Moved to long-term memory" : "Remembered in long-term memory";
  const file = existing ? existing.file : null;
  const touched = [WORKING_MEMORY_FILE, MEMORY_INDEX_FILE, ...(file ? [`${LONG_TERM_DIR}/${file}`] : [])];
  let createdFile = "";
  let added = true;
  const { change } = await trackChange(coworkersDir, slug, touched, {
    tool: "memory_remember",
    input: { text: fact, kind: where, topic: title },
    output: `${verb} (${title}): ${fact}`,
    now,
  }, async () => {
    let target = file;
    let current = "";
    if (!target) {
      const created = await createLongTermMemory(coworkersDir, slug, { title, summary: title });
      target = created.file;
      createdFile = target;
      current = (await readOptional(resolveCoworkerFile(coworkersDir, slug, `${LONG_TERM_DIR}/${target}`))) ?? "";
    } else {
      current = (await readOptional(resolveCoworkerFile(coworkersDir, slug, `${LONG_TERM_DIR}/${target}`))) ?? "";
    }
    const next = addLongTermFact(current, title, fact);
    added = next.added;
    if (next.added) await writeAtomic(resolveCoworkerFile(coworkersDir, slug, `${LONG_TERM_DIR}/${target}`), next.text);
    if (promoted) await writeAtomic(resolveCoworkerFile(coworkersDir, slug, WORKING_MEMORY_FILE), promoted.text);
  });
  // A new file was not in the watched list; record it in the same change so undo can remove it.
  if (change && createdFile) {
    const created = resolveCoworkerFile(coworkersDir, slug, `${LONG_TERM_DIR}/${createdFile}`);
    change.files.push({ path: `${LONG_TERM_DIR}/${createdFile}`, before: null, after: clipSnapshot(await readOptional(created)) });
    await rewriteChange(coworkersDir, slug, change);
  }
  if (!added && !promoted) return { output: `Already in long-term memory (${title}): ${fact}`, change };
  return { output: `${verb} (${title}): ${fact}${promoted ? "\nIt is no longer in working memory." : ""}`, change };
}

async function rewriteChange(coworkersDir, slug, change) {
  const key = resolveCoworkerFile(coworkersDir, slug, CHANGES_FILE);
  const entries = (await readChangeLines(coworkersDir, slug)).map((entry) => (entry.id === change.id ? change : entry));
  await writeAtomic(key, `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

/**
 * `memory_forget`: drop a line from working memory or a long-term memory, or
 * a whole long-term memory when the target names it.
 */
export async function forgetFact(coworkersDir, slug, { target }, { now = Date.now() } = {}) {
  const wanted = String(target ?? "").replace(/\s+/g, " ").trim();
  if (!wanted) throw new MemoryError("Say what to forget.");
  const working = await readWorking(coworkersDir, slug);
  const fromWorking = removeBullet(working, wanted);
  if (fromWorking) {
    const { change } = await trackChange(coworkersDir, slug, [WORKING_MEMORY_FILE], {
      tool: "memory_forget",
      input: { target: wanted },
      output: `Forgot from working memory: ${fromWorking.removed}`,
      now,
    }, () => writeAtomic(resolveCoworkerFile(coworkersDir, slug, WORKING_MEMORY_FILE), fromWorking.text));
    return { output: `Forgot from working memory: ${fromWorking.removed}`, change };
  }
  const memories = (await listLongTermMemories(coworkersDir, slug)).filter((memory) => memory.exists);
  const whole = memories.find((memory) => normalizeLine(memory.title) === normalizeLine(wanted) || memory.file === memoryFileNameFor(wanted));
  if (whole) {
    const { change } = await trackChange(coworkersDir, slug, [MEMORY_INDEX_FILE, `${LONG_TERM_DIR}/${whole.file}`], {
      tool: "memory_forget",
      input: { target: wanted },
      output: `Forgot the long-term memory "${whole.title}"`,
      now,
    }, () => deleteLongTermMemory(coworkersDir, slug, whole.file));
    return { output: `Forgot the long-term memory "${whole.title}" and its line in the index.`, change };
  }
  for (const memory of memories) {
    const current = (await readOptional(resolveCoworkerFile(coworkersDir, slug, memory.path))) ?? "";
    const removed = removeBulletFromFile(current, wanted);
    if (!removed) continue;
    const { change } = await trackChange(coworkersDir, slug, [memory.path], {
      tool: "memory_forget",
      input: { target: wanted },
      output: `Forgot from ${memory.title}: ${removed.removed}`,
      now,
    }, () => writeAtomic(resolveCoworkerFile(coworkersDir, slug, memory.path), removed.text));
    return { output: `Forgot from the long-term memory "${memory.title}": ${removed.removed}`, change };
  }
  throw new MemoryError(`I couldn't find anything in memory about "${wanted}".`);
}

/** Long-term files have no sections; remove a matching bullet anywhere in them. */
function removeBulletFromFile(text, target) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const wanted = normalizeLine(target);
  let index = lines.findIndex((line) => isBullet(line) && normalizeLine(bulletText(line)) === wanted);
  if (index === -1) index = lines.findIndex((line) => isBullet(line) && bulletText(line).toLowerCase().includes(target.trim().toLowerCase()));
  if (index === -1) return null;
  const removed = bulletText(lines[index]);
  return { text: `${lines.filter((_, position) => position !== index).join("\n").replace(/\n+$/, "")}\n`, removed };
}

/** `soul_update`: one change inside one section of the soul, recorded. */
export async function updateSoul(coworkersDir, slug, { section, change }, { now = Date.now(), actor = "coworker" } = {}) {
  const target = resolveCoworkerFile(coworkersDir, slug, SOUL_FILE);
  const current = (await readOptional(target)) ?? "";
  const applied = applySoulChange(current, section, change);
  const { change: recorded } = await trackChange(coworkersDir, slug, [SOUL_FILE], {
    actor,
    tool: "soul_update",
    input: { section: applied.section, change: applied.change },
    output: applied.summary,
    now,
  }, () => writeAtomic(target, applied.text));
  return { output: applied.summary, change: recorded, text: applied.text };
}

const READ_LIMIT = 12_000;

function clipRead(text) {
  return text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n…(cut here; the file is longer)` : text;
}

/** `self_read`: the coworker's own files, so it can answer from them honestly. */
export async function readSelf(coworkersDir, slug, { what } = {}) {
  const choice = String(what ?? "everything").trim().toLowerCase();
  const parts = [];
  const wants = (name) => choice === "everything" || choice === "all" || choice === name || (choice === "memory" && name !== "soul");
  if (wants("soul")) parts.push(`## soul.md\n\n${(await readOptional(resolveCoworkerFile(coworkersDir, slug, SOUL_FILE))) ?? "(no soul file)"}`);
  if (wants("working")) parts.push(`## memory/working.md\n\n${await readWorking(coworkersDir, slug)}`);
  if (wants("long-term")) {
    const memories = (await listLongTermMemories(coworkersDir, slug)).filter((memory) => memory.exists);
    if (memories.length === 0) parts.push("## Long-term memory\n\n(none yet)");
    for (const memory of memories) {
      const content = (await readOptional(resolveCoworkerFile(coworkersDir, slug, memory.path))) ?? "";
      parts.push(`## ${memory.path}\n\n${content.trim() || `# ${memoryTitle(content, memory.file)}`}`);
    }
  }
  if (parts.length === 0) throw new MemoryError('Ask for "soul", "working", "long-term", "memory", or "everything".');
  return { output: clipRead(parts.join("\n\n")) };
}
