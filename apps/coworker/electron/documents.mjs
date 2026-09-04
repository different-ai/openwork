/**
 * Coworker documents: the clean Markdown companions to a conversation.
 *
 * A coworker answers in a few sentences and keeps the depth in a document
 * beside the chat — a plan, a brief, a comparison, notes. Documents live in the
 * coworker home as plain files (`documents/<id>.md` with frontmatter), so they
 * are readable, portable, and never a new platform object:
 *
 * - `documents/index.md` lists the active documents one line each and is
 *   loaded every turn (like `memory/index.md`), so the coworker always knows
 *   what it has without opening anything.
 * - `documents/.history/<id>/<revision>.md` keeps the last five revisions of
 *   each document so an update can be compared or reverted.
 * - `memory/style.jsonl` records when a reply ran long without a document; the
 *   index carries a one-line reminder until the coworker writes one.
 *
 * Every write is atomic (temp + rename), ids are validated, and a body that
 * looks like it carries a secret is refused with a sentence the coworker can
 * act on. No Electron imports here: exercised directly by `node --test`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.mjs";

export const DOCUMENTS_DIR = "documents";
export const DOCUMENTS_INDEX_FILE = path.join(DOCUMENTS_DIR, "index.md");
export const DOCUMENT_HISTORY_DIR = path.join(DOCUMENTS_DIR, ".history");
export const STYLE_LOG_FILE = path.join("memory", "style.jsonl");
/** How many earlier revisions of a document stay on disk beside the current one. */
export const HISTORY_LIMIT = 5;
/** How many style events the log keeps; older ones fall off the front. */
export const STYLE_LOG_LIMIT = 20;
export const HIGHLIGHT_LIMIT = 5;
/** The active set the coworker is asked to keep to; `context_set` warns above it, never refuses. */
export const ACTIVE_SET_TARGET = 5;
export const DOCUMENT_STATUSES = new Set(["active", "aside", "archived"]);
const UPDATED_BY = new Set(["coworker", "person"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_IDS = new Set(["index"]);

/** The one-line reason a body was refused, phrased for the coworker. */
const SECRET_PATTERNS = [
  { name: "a private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "an API key", pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "an AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "a signed web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "a password or secret value", pattern: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i },
];

/**
 * Returns a sentence when `text` looks like it carries a credential, or "" when
 * it reads clean. Documents hold plans and notes, never secrets.
 */
export function findSecretLike(text) {
  const source = String(text ?? "");
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(source)) {
      return `This looks like it contains ${name}. Documents are for plans and notes, never credentials — leave the secret out and try again.`;
    }
  }
  return "";
}

export function isDocumentId(value) {
  return typeof value === "string" && ID_PATTERN.test(value) && !RESERVED_IDS.has(value) && !value.includes("--");
}

/** `Launch plan: Q3` → `launch-plan-q3`; empty titles become `document`. */
export function documentIdFor(title) {
  const stem = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const id = stem || "document";
  return RESERVED_IDS.has(id) ? `${id}-1` : id;
}

function coworkerRoot(coworkersDir, slug) {
  const cleaned = String(slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) throw new Error(`Invalid coworker slug: ${slug}`);
  return path.join(coworkersDir, cleaned);
}

function documentPath(root, id) {
  if (!isDocumentId(id)) throw new Error(`Not a document id: ${id}`);
  return path.join(root, DOCUMENTS_DIR, `${id}.md`);
}

function historyDir(root, id) {
  if (!isDocumentId(id)) throw new Error(`Not a document id: ${id}`);
  return path.join(root, DOCUMENT_HISTORY_DIR, id);
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Write through a sibling temp file and rename so a reader never sees a half-written document. */
export async function writeAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, String(content ?? ""), "utf8");
  await rename(temp, target);
}

function cleanText(value, limit) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Up to five short lines; blanks dropped, each kept to one line. */
export function normalizeHighlights(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  return list
    .map((item) => cleanText(item, 160).replace(/^[-*•]\s*/, ""))
    .filter(Boolean)
    .slice(0, HIGHLIGHT_LIMIT);
}

/** Frontmatter → a document record; anything malformed falls back to safe defaults. */
export function parseDocument(content, fallbackId = "") {
  const { data, body } = parseFrontmatter(content);
  const id = isDocumentId(data.id) ? data.id : fallbackId;
  const revision = Number(data.revision);
  return {
    id,
    title: cleanText(data.title, 120) || "Untitled document",
    summary: cleanText(data.summary, 240),
    highlights: normalizeHighlights(data.highlights),
    status: DOCUMENT_STATUSES.has(data.status) ? data.status : "active",
    createdAt: Number.isFinite(Number(data.createdAt)) ? Number(data.createdAt) : 0,
    updatedAt: Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : 0,
    updatedBy: UPDATED_BY.has(data.updatedBy) ? data.updatedBy : "coworker",
    revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
    body: String(body ?? "").replace(/^\n+/, ""),
  };
}

export function serializeDocument(document) {
  return serializeFrontmatter(
    {
      id: document.id,
      title: document.title,
      summary: document.summary,
      highlights: document.highlights,
      status: document.status,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy,
      revision: document.revision,
    },
    `\n${String(document.body ?? "").replace(/^\n+/, "").replace(/\s+$/, "")}\n`,
  );
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function normalizeHeading(value) {
  return String(value ?? "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every `##`-or-deeper heading in a body, in order, with its level. */
export function listSections(body) {
  const sections = [];
  let inFence = false;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = HEADING.exec(line);
    if (match && match[1].length >= 2) sections.push({ level: match[1].length, heading: match[2].trim() });
  }
  return sections;
}

/**
 * Replace one `##` section — the heading line and everything up to the next
 * heading of the same or higher level — with new content, or append the
 * section when the heading is not there yet. The coworker sends one section,
 * not the whole document.
 */
export function patchSection(body, heading, content) {
  const wanted = normalizeHeading(heading);
  if (!wanted) throw new Error("Say which section to update (its `##` heading).");
  const lines = String(body ?? "").replace(/\s+$/, "").split(/\r?\n/);
  const replacement = `## ${String(heading).replace(/^#+\s*/, "").trim()}\n\n${String(content ?? "").trim()}`;
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = HEADING.exec(line);
    if (!match) continue;
    if (start === -1) {
      if (match[1].length >= 2 && normalizeHeading(match[2]) === wanted) {
        start = index;
        level = match[1].length;
      }
      continue;
    }
    if (match[1].length <= level) {
      const before = lines.slice(0, start).join("\n").replace(/\s+$/, "");
      const after = lines.slice(index).join("\n");
      return { body: `${before ? `${before}\n\n` : ""}${replacement}\n\n${after}\n`, action: "replaced" };
    }
  }
  if (start !== -1) {
    const before = lines.slice(0, start).join("\n").replace(/\s+$/, "");
    return { body: `${before ? `${before}\n\n` : ""}${replacement}\n`, action: "replaced" };
  }
  const existing = lines.join("\n").replace(/\s+$/, "");
  return { body: `${existing ? `${existing}\n\n` : ""}${replacement}\n`, action: "appended" };
}

/** The `# Title` line the coworker may or may not have written; the frontmatter title wins. */
function withoutLeadingTitle(body, title) {
  const lines = String(body ?? "").replace(/^\n+/, "").split(/\r?\n/);
  const first = lines[0] ?? "";
  const match = /^#\s+(.+?)\s*#*\s*$/.exec(first);
  if (match && normalizeHeading(match[1]) === normalizeHeading(title)) return lines.slice(1).join("\n").replace(/^\n+/, "");
  return lines.join("\n");
}

async function readDocumentFile(root, id) {
  const target = documentPath(root, id);
  let content;
  try {
    content = await readFile(target, "utf8");
  } catch {
    throw new Error(`There is no document with the id "${id}".`);
  }
  return parseDocument(content, id);
}

/** Every document on disk, newest update first, without bodies. */
export async function listDocuments(coworkersDir, slug, { includeArchived = true } = {}) {
  const root = coworkerRoot(coworkersDir, slug);
  const dir = path.join(root, DOCUMENTS_DIR);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const documents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
    const id = entry.name.slice(0, -3);
    if (!isDocumentId(id)) continue;
    try {
      const { body, ...record } = parseDocument(await readFile(path.join(dir, entry.name), "utf8"), id);
      if (!includeArchived && record.status === "archived") continue;
      documents.push({ ...record, words: countWords(body) });
    } catch {
      // A malformed file stays on disk but out of the list.
    }
  }
  documents.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  return documents;
}

function countWords(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export async function readDocument(coworkersDir, slug, id) {
  return readDocumentFile(coworkerRoot(coworkersDir, slug), id);
}

async function uniqueId(root, title) {
  const base = documentIdFor(title);
  let id = base;
  for (let attempt = 2; await pathExists(documentPath(root, id)); attempt += 1) {
    id = `${base.slice(0, 44)}-${attempt}`;
  }
  return id;
}

/** Keep the outgoing revision so the update can be compared or reverted, then prune to the last five. */
async function keepRevision(root, document) {
  const dir = historyDir(root, document.id);
  await writeAtomic(path.join(dir, `${document.revision}.md`), serializeDocument(document));
  const kept = (await readdir(dir))
    .map((name) => /^(\d+)\.md$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  for (const revision of kept.slice(HISTORY_LIMIT)) {
    await rm(path.join(dir, `${revision}.md`), { force: true });
  }
}

/**
 * A new document from the coworker (or the person). Title, summary, highlights,
 * and body are cleaned; the id is derived from the title and made unique.
 */
export async function createDocument(coworkersDir, slug, input, { now = Date.now(), by = "coworker" } = {}) {
  const root = coworkerRoot(coworkersDir, slug);
  const title = cleanText(input?.title, 120);
  if (!title) throw new Error("A document needs a title.");
  const body = String(input?.body ?? "");
  const secret = findSecretLike(`${title}\n${input?.summary ?? ""}\n${normalizeHighlights(input?.highlights).join("\n")}\n${body}`);
  if (secret) throw new Error(secret);
  const id = await uniqueId(root, title);
  const document = {
    id,
    title,
    summary: cleanText(input?.summary, 240),
    highlights: normalizeHighlights(input?.highlights),
    status: "active",
    createdAt: now,
    updatedAt: now,
    updatedBy: UPDATED_BY.has(by) ? by : "coworker",
    revision: 1,
    body: withoutLeadingTitle(body, title),
  };
  await writeAtomic(documentPath(root, id), serializeDocument(document));
  await writeDocumentsIndex(coworkersDir, slug);
  return document;
}

/**
 * Update a document: a whole new body, or one `##` section by heading. Summary
 * and highlights refresh when given. Every update is a new revision; the one
 * it replaces goes to history.
 */
export async function updateDocument(coworkersDir, slug, id, input, { now = Date.now(), by = "coworker" } = {}) {
  const root = coworkerRoot(coworkersDir, slug);
  const current = await readDocumentFile(root, id);
  if (current.status === "archived") throw new Error(`"${current.title}" is archived. Only the person can bring it back.`);
  let body = current.body;
  let section = "";
  let sectionAction = "";
  if (input?.patch && typeof input.patch === "object") {
    const patched = patchSection(body, input.patch.heading, input.patch.content);
    body = patched.body;
    section = String(input.patch.heading ?? "").replace(/^#+\s*/, "").trim();
    sectionAction = patched.action;
  } else if (typeof input?.body === "string") {
    body = withoutLeadingTitle(input.body, typeof input?.title === "string" && input.title.trim() ? input.title : current.title);
  }
  const next = {
    ...current,
    title: typeof input?.title === "string" && cleanText(input.title, 120) ? cleanText(input.title, 120) : current.title,
    summary: typeof input?.summary === "string" ? cleanText(input.summary, 240) : current.summary,
    highlights: input?.highlights !== undefined ? normalizeHighlights(input.highlights) : current.highlights,
    body,
    updatedAt: now,
    updatedBy: UPDATED_BY.has(by) ? by : "coworker",
    revision: current.revision + 1,
  };
  const secret = findSecretLike(`${next.title}\n${next.summary}\n${next.highlights.join("\n")}\n${next.body}`);
  if (secret) throw new Error(secret);
  const unchanged = next.body === current.body && next.summary === current.summary && next.title === current.title
    && next.highlights.join("\n") === current.highlights.join("\n");
  if (unchanged) return { ...current, section, sectionAction: "unchanged", changed: false };
  await keepRevision(root, current);
  await writeAtomic(documentPath(root, id), serializeDocument(next));
  await writeDocumentsIndex(coworkersDir, slug);
  return { ...next, section, sectionAction, changed: true };
}

/** Earlier revisions of a document, newest first, each with its content. */
export async function listRevisions(coworkersDir, slug, id) {
  const root = coworkerRoot(coworkersDir, slug);
  const dir = historyDir(root, id);
  if (!(await pathExists(dir))) return [];
  const revisions = [];
  for (const name of await readdir(dir)) {
    const match = /^(\d+)\.md$/.exec(name);
    if (!match) continue;
    try {
      revisions.push(parseDocument(await readFile(path.join(dir, name), "utf8"), id));
    } catch {
      // Skip an unreadable revision rather than hide the rest.
    }
  }
  revisions.sort((a, b) => b.revision - a.revision);
  return revisions;
}

/** Bring an earlier revision back as a new revision by the person; nothing in history is lost. */
export async function restoreRevision(coworkersDir, slug, id, revision, { now = Date.now() } = {}) {
  const wanted = Number(revision);
  const earlier = (await listRevisions(coworkersDir, slug, id)).find((entry) => entry.revision === wanted);
  if (!earlier) throw new Error(`Revision ${revision} of "${id}" is not in the history any more.`);
  return updateDocument(
    coworkersDir,
    slug,
    id,
    { title: earlier.title, summary: earlier.summary, highlights: earlier.highlights, body: earlier.body },
    { now, by: "person" },
  );
}

async function setStatus(root, id, status, now) {
  const current = await readDocumentFile(root, id);
  if (current.status === status) return current;
  const next = { ...current, status, updatedAt: now };
  await writeAtomic(documentPath(root, id), serializeDocument(next));
  return next;
}

/**
 * The coworker's active set: what the current work needs. Ids listed as active
 * become active, ids listed as aside are put aside; archived documents are left
 * alone (only the person archives or restores). Unknown ids are reported, not
 * fatal, so one typo never loses the rest of the call.
 */
export async function setContext(coworkersDir, slug, input, { now = Date.now() } = {}) {
  const root = coworkerRoot(coworkersDir, slug);
  const active = normalizeIdList(input?.active);
  const aside = normalizeIdList(input?.aside);
  const both = active.filter((id) => aside.includes(id));
  if (both.length > 0) throw new Error(`A document cannot be both active and put aside: ${both.join(", ")}.`);
  const known = new Map((await listDocuments(coworkersDir, slug)).map((document) => [document.id, document]));
  const unknown = [];
  const changed = [];
  const skippedArchived = [];
  for (const [ids, status] of [[active, "active"], [aside, "aside"]]) {
    for (const id of ids) {
      const document = known.get(id);
      if (!document) {
        unknown.push(id);
        continue;
      }
      if (document.status === "archived") {
        skippedArchived.push(id);
        continue;
      }
      if (document.status !== status) {
        const updated = await setStatus(root, id, status, now);
        changed.push({ id, title: updated.title, status });
      }
    }
  }
  await writeDocumentsIndex(coworkersDir, slug);
  const documents = await listDocuments(coworkersDir, slug);
  const activeCount = documents.filter((document) => document.status === "active").length;
  return {
    changed,
    unknown,
    skippedArchived,
    activeCount,
    overTarget: activeCount > ACTIVE_SET_TARGET,
  };
}

function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

/** Person-only: put a document away for good (still on disk, listed behind the Archived link). */
export async function archiveDocument(coworkersDir, slug, id, { now = Date.now() } = {}) {
  const root = coworkerRoot(coworkersDir, slug);
  const updated = await setStatus(root, id, "archived", now);
  await writeDocumentsIndex(coworkersDir, slug);
  return updated;
}

/** Person-only: make a document active or put it aside from the Documents view. */
export async function setDocumentStatus(coworkersDir, slug, id, status, { now = Date.now() } = {}) {
  if (!DOCUMENT_STATUSES.has(status)) throw new Error(`Unknown document status: ${status}`);
  const root = coworkerRoot(coworkersDir, slug);
  const updated = await setStatus(root, id, status, now);
  await writeDocumentsIndex(coworkersDir, slug);
  return updated;
}

// ---------------------------------------------------------------------------
// The always-loaded index and the style log behind its reminder line.

// The facts only (`id — title — summary`); what the index is for is the contract's (`## Files`), said once.
const INDEX_HEADER = [
  "# Documents",
  "",
  "Active documents, one line each (`id — title — summary`):",
  "",
].join("\n");

/** The index Markdown for a set of documents, plus the reminder when the style log asks for one. */
export function renderDocumentsIndex(documents, { reminder = "" } = {}) {
  const active = documents.filter((document) => document.status === "active");
  const aside = documents.filter((document) => document.status === "aside");
  const lines = [INDEX_HEADER];
  if (active.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const document of active) {
      const edited = document.updatedBy === "person" ? " · edited by the person — ask before rewriting it" : "";
      lines.push(`- ${document.id} — ${document.title} — ${document.summary || "(no summary yet)"}${edited}`);
    }
  }
  if (aside.length > 0) {
    lines.push("", `Put aside (${aside.length}): ${aside.map((document) => document.id).join(", ")}. Not loaded; \`documents_list\` shows them and \`context_set\` brings one back.`);
  }
  if (reminder) lines.push("", "## Reminder", "", reminder);
  return `${lines.join("\n")}\n`;
}

export function documentsIndexTemplate() {
  return renderDocumentsIndex([]);
}

/** Regenerate `documents/index.md` from the files on disk and the style log. */
export async function writeDocumentsIndex(coworkersDir, slug) {
  const root = coworkerRoot(coworkersDir, slug);
  const documents = await listDocuments(coworkersDir, slug);
  const reminder = styleReminder(await readStyleEvents(coworkersDir, slug));
  await writeAtomic(path.join(root, DOCUMENTS_INDEX_FILE), renderDocumentsIndex(documents, { reminder }));
}

/** Create `documents/` and its index when a coworker home lacks them; existing files are left alone. */
export async function ensureDocumentsHome(coworkersDir, slug) {
  const root = coworkerRoot(coworkersDir, slug);
  await mkdir(path.join(root, DOCUMENTS_DIR), { recursive: true });
  if (!(await pathExists(path.join(root, DOCUMENTS_INDEX_FILE)))) await writeDocumentsIndex(coworkersDir, slug);
}

/** Style events, oldest first: `{ at, kind: "long-reply" | "document", messageId?, chars? }`. */
export async function readStyleEvents(coworkersDir, slug) {
  const root = coworkerRoot(coworkersDir, slug);
  let text;
  try {
    text = await readFile(path.join(root, STYLE_LOG_FILE), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") events.push(parsed);
    } catch {
      // A damaged line is dropped; the rest of the log still counts.
    }
  }
  return events;
}

/**
 * Record a style event: `long-reply` when a reply ran long with no document in
 * that turn, `document` when the coworker wrote or refreshed one (which clears
 * the reminder). The same message is never recorded twice; the log stays short.
 */
export async function recordStyleEvent(coworkersDir, slug, event, { now = Date.now() } = {}) {
  const kind = event?.kind === "document" ? "document" : "long-reply";
  const messageId = String(event?.messageId ?? "").trim();
  const events = await readStyleEvents(coworkersDir, slug);
  if (messageId && events.some((entry) => entry.messageId === messageId)) return { recorded: false, events };
  const entry = {
    at: now,
    kind,
    ...(messageId ? { messageId } : {}),
    ...(Number.isFinite(event?.chars) ? { chars: Math.round(event.chars) } : {}),
  };
  const next = [...events, entry].slice(-STYLE_LOG_LIMIT);
  const root = coworkerRoot(coworkersDir, slug);
  await writeAtomic(path.join(root, STYLE_LOG_FILE), `${next.map((item) => JSON.stringify(item)).join("\n")}\n`);
  await writeDocumentsIndex(coworkersDir, slug);
  return { recorded: true, events: next };
}

/** One line for the index while the newest style event is a long reply; empty otherwise. */
export function styleReminder(events) {
  const last = Array.isArray(events) ? events[events.length - 1] : undefined;
  if (!last || last.kind !== "long-reply") return "";
  return "My last reply ran long with no document behind it. Next time: the point first, a few sentences, at most three highlights — and the depth in a document (`document_create` or `document_update`), named in the message.";
}
