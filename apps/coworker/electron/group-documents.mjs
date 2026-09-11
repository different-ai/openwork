/** Shared Markdown documents only. Execution and native caller verification belong to collaboration. */
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { appendGroupEvent, getGroup, GROUPS_DIR, isGroupId } from "./groups.mjs";
import {
  documentIdFor, findSecretLike, HISTORY_LIMIT, isDocumentId, normalizeHighlights,
  parseDocument, serializeDocument, writeAtomic,
} from "./documents.mjs";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.mjs";

export const GROUP_DOCUMENT_BODY_LIMIT = 100_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const writes = new Map();
const saveKeys = new Set(["id", "expectedRevision", "title", "summary", "highlights", "body"]);
const line = (value) => value.replace(/\s+/g, " ").trim();

function revisionNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("A positive integer revision is required.");
  return value;
}

function serialize(document) {
  const { data, body } = parseFrontmatter(serializeDocument(document));
  return serializeFrontmatter({ ...data, groupId: document.groupId, author: document.author, authorSlug: document.authorSlug }, body);
}

/**
 * resolveCaller(context) MUST verify a main-owned IPC identity or live native
 * ToolContext, never fields supplied in a tool's arguments. It returns
 * { kind: "person" } or { kind: "coworker", slug, name, groupId?: string }.
 * A native group/consultation caller is also pinned to that originating group.
 * Use one desktop process: queues span instances, not separate OS processes.
 */
export function createGroupDocuments({ coworkersDir, resolveCaller, now = Date.now }) {
  if (typeof resolveCaller !== "function") throw new Error("Shared documents require a trusted caller resolver.");
  const root = path.resolve(coworkersDir);

  // No caller supplies a path. Refuse symlinks at every app-owned path segment.
  async function safePath(...segments) {
    let target = root;
    for (const segment of segments) {
      target = path.join(target, segment);
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new Error("Shared document storage cannot follow symbolic links.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return target;
  }

  async function access(groupId, context) {
    if (context === undefined || context === null) throw new Error("Trusted caller context is required.");
    const caller = await resolveCaller(context);
    if (!caller || !["person", "coworker"].includes(caller.kind)) throw new Error("Trusted caller context is required.");
    if (!isGroupId(groupId)) throw new Error("Invalid group id.");
    if (caller.kind === "coworker" && (typeof caller.slug !== "string" || !SLUG.test(caller.slug) || typeof caller.name !== "string" || !caller.name.trim()
      || (caller.groupId && caller.groupId !== groupId))) throw new Error("This group is not available to this caller.");
    await safePath(GROUPS_DIR, groupId, "group.json");
    const group = await getGroup(root, groupId);
    if (group.id !== groupId || group.archivedAt !== null || (caller.kind === "coworker" && !group.participantSlugs.includes(caller.slug))) {
      throw new Error("This group is not available to this caller.");
    }
    return caller.kind === "person"
      ? { updatedBy: "person", author: "You", authorSlug: "" }
      : { updatedBy: "coworker", author: line(caller.name).slice(0, 80), authorSlug: caller.slug };
  }

  async function serial(groupId, context, run) {
    if (!isGroupId(groupId)) throw new Error("Invalid group id.");
    const key = path.join(root, GROUPS_DIR, groupId);
    const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => run(await access(groupId, context)));
    writes.set(key, pending);
    try { return await pending; } finally { if (writes.get(key) === pending) writes.delete(key); }
  }

  function documentPath(groupId, id, revision) {
    if (!isDocumentId(id)) throw new Error("Invalid shared document id.");
    return revision === undefined
      ? safePath(GROUPS_DIR, groupId, "shared", "documents", `${id}.md`)
      : safePath(GROUPS_DIR, groupId, "shared", "documents", ".history", id, `${revisionNumber(revision)}.md`);
  }

  async function names(...segments) {
    try { return await readdir(await safePath(...segments)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function read(groupId, id, revision) {
    const raw = await readFile(await documentPath(groupId, id, revision), "utf8");
    const { data } = parseFrontmatter(raw);
    const record = parseDocument(raw, id);
    if (data.id !== id || data.groupId !== groupId || !Number.isSafeInteger(data.revision) || data.revision < 1
      || (revision !== undefined && data.revision !== revision) || typeof data.author !== "string" || !data.author
      || !["person", "coworker"].includes(data.updatedBy)
      || typeof data.authorSlug !== "string" || (data.updatedBy === "coworker" ? !SLUG.test(data.authorSlug) : data.authorSlug !== "")) {
      throw new Error("Shared document identity or author is unreadable. The file has been kept.");
    }
    return { ...record, groupId, author: data.author, authorSlug: data.authorSlug };
  }

  async function history(groupId, id) {
    const current = await read(groupId, id);
    const revisions = (await names(GROUPS_DIR, groupId, "shared", "documents", ".history", id))
      .filter((name) => /^[1-9]\d*\.md$/.test(name)).map((name) => Number(name.slice(0, -3)))
      .filter((revision) => revision < current.revision).sort((a, b) => b - a);
    return Promise.all(revisions.map((revision) => read(groupId, id, revision)));
  }

  function inputFor(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !saveKeys.has(key))) {
      throw new Error("Use document fields only; identity, author and file paths are not writable.");
    }
    if (input.id !== undefined) {
      if (!isDocumentId(input.id)) throw new Error("Invalid shared document id.");
      revisionNumber(input.expectedRevision);
    } else if (input.expectedRevision !== undefined) throw new Error("Only an existing document has an expected revision.");
    if (typeof input.title !== "string" || !line(input.title) || input.title.length > 120) throw new Error("A shared document needs a title of at most 120 characters.");
    if (typeof input.body !== "string" || input.body.length > GROUP_DOCUMENT_BODY_LIMIT) throw new Error("A shared document needs a body of at most 100,000 characters.");
    if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 240)) throw new Error("A summary is at most 240 characters.");
    if (input.highlights !== undefined && (!Array.isArray(input.highlights) || input.highlights.length > 5
      || input.highlights.some((item) => typeof item !== "string" || item.length > 160))) throw new Error("Use up to five highlights of at most 160 characters each.");
    const secret = findSecretLike([input.title, input.summary, ...(input.highlights ?? []), input.body].join("\n"));
    if (secret) throw new Error(secret);
    return input;
  }

  async function save(groupId, input, author, context, restoring = false) {
    inputFor(input);
    const current = input.id ? await read(groupId, input.id) : null;
    if (current && current.revision !== input.expectedRevision) {
      const error = new Error(`This document changed. Read revision ${current.revision}, reconcile your draft, then save again.`);
      error.code = "GROUP_DOCUMENT_CONFLICT";
      error.currentRevision = current.revision;
      throw error;
    }
    if (current?.status === "archived") throw new Error("This document is archived.");
    let id = current?.id ?? documentIdFor(input.title);
    if (!current) {
      const existing = new Set(await names(GROUPS_DIR, groupId, "shared", "documents"));
      const base = id;
      for (let suffix = 2; existing.has(`${id}.md`); suffix++) id = `${base}-${suffix}`;
    }
    const at = now();
    const body = input.body.replace(/^\n+/, "").replace(/\s+$/, "");
    const next = {
      id, groupId, title: line(input.title), summary: input.summary === undefined ? current?.summary ?? "" : line(input.summary),
      highlights: input.highlights === undefined ? current?.highlights ?? [] : normalizeHighlights(input.highlights),
      status: current?.status ?? "active", createdAt: current?.createdAt ?? at, updatedAt: at,
      revision: current ? current.revision + 1 : 1, ...author, body: body ? `${body}\n` : "",
    };
    if (current && !restoring && ["title", "summary", "body"].every((key) => current[key] === next[key])
      && JSON.stringify(current.highlights) === JSON.stringify(next.highlights)) return { ...current, changed: false };
    revisionNumber(next.revision);
    // Check membership and the native execution again after waiting/reading, before writing.
    Object.assign(next, await access(groupId, context));
    const target = await documentPath(groupId, id);
    if (current) await writeAtomic(await documentPath(groupId, id, current.revision), serialize(current));
    // Pruning precedes the commit so an I/O failure is never reported as a failed save after it succeeded.
    const kept = (await names(GROUPS_DIR, groupId, "shared", "documents", ".history", id))
      .filter((name) => /^[1-9]\d*\.md$/.test(name)).map((name) => Number(name.slice(0, -3))).sort((a, b) => b - a);
    for (const revision of kept.slice(HISTORY_LIMIT)) await rm(await documentPath(groupId, id, revision));
    await writeAtomic(target, serialize(next));
    return { ...next, changed: true };
  }

  return {
    list: (groupId, context) => serial(groupId, context, async () => {
      const items = [];
      for (const name of await names(GROUPS_DIR, groupId, "shared", "documents")) {
        const id = name.endsWith(".md") ? name.slice(0, -3) : "";
        if (!isDocumentId(id)) continue;
        const { body, ...record } = await read(groupId, id);
        items.push({ ...record, words: body.trim() ? body.trim().split(/\s+/).length : 0 });
      }
      return items.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
    }),
    read: (groupId, id, context) => serial(groupId, context, () => read(groupId, id)),
    revisions: (groupId, id, context) => serial(groupId, context, () => history(groupId, id)),
    save: (groupId, input, context) => serial(groupId, context, (author) => save(groupId, input, author, context)),
    restore: (groupId, id, revision, expectedRevision, context) => serial(groupId, context, async (author) => {
      revisionNumber(revision); revisionNumber(expectedRevision);
      const earlier = (await history(groupId, id)).find((entry) => entry.revision === revision);
      if (!earlier) throw new Error("That revision is no longer available.");
      return save(groupId, { id, expectedRevision, title: earlier.title, summary: earlier.summary, highlights: earlier.highlights, body: earlier.body }, author, context, true);
    }),
  };
}

/** Arguments only: no slug, author, native session identity or file path is model-writable. */
export function groupDocumentToolCatalog() {
  const groupId = { type: "string", pattern: "^grp_[a-z0-9]{8,32}$" };
  const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" };
  const revision = { type: "integer", minimum: 1 };
  const tool = (name, description, properties, required, extra = {}) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false, ...extra } });
  return [
    tool("group_documents", "List documents explicitly shared with this group. Private documents remain separate.", { groupId }, ["groupId"]),
    tool("group_document_read", "Read a group document and its revision before editing it.", { groupId, id }, ["groupId", "id"]),
    tool("group_document_save", "Create or update a shared document. Reconcile conflicts before retrying; never overwrite another writer blindly. Only share material authorized for this group.", {
      groupId, id, expectedRevision: revision, title: { type: "string", minLength: 1, maxLength: 120 },
      summary: { type: "string", maxLength: 240 }, highlights: { type: "array", maxItems: 5, items: { type: "string", maxLength: 160 } },
      body: { type: "string", maxLength: GROUP_DOCUMENT_BODY_LIMIT },
    }, ["groupId", "title", "body"], { dependentRequired: { id: ["expectedRevision"], expectedRevision: ["id"] } }),
    tool("group_document_revisions", "Read the retained earlier revisions of this shared document.", { groupId, id }, ["groupId", "id"]),
    tool("group_document_restore", "Restore an earlier revision as a new attributed revision. Requires the current revision; reconcile conflicts first.", { groupId, id, revision, expectedRevision: revision }, ["groupId", "id", "revision", "expectedRevision"]),
  ];
}

const toolSchemas = new Map(groupDocumentToolCatalog().map(({ name, inputSchema }) => {
  const { dependentRequired = {}, ...schema } = inputSchema;
  // Zod's JSON Schema reader does not support dependentRequired yet.
  return [name, z.fromJSONSchema(schema).superRefine((input, context) => {
    for (const [key, required] of Object.entries(dependentRequired)) {
      if (input[key] !== undefined && required.some((field) => input[field] === undefined)) {
        context.addIssue({ code: "custom", path: [key], message: "An existing shared document requires both id and expectedRevision." });
      }
    }
  })];
}));

export function validateGroupDocumentArguments(name, args) {
  const schema = toolSchemas.get(name);
  if (!schema) throw new Error("Unknown shared-document tool.");
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error(`Invalid shared-document arguments: ${parsed.error.issues[0].message}`);
  return parsed.data;
}

/** Called by collaboration.context while it owns the exact running native execution. */
export function assertGroupDocumentToolContext({ slug, context, name, args, entry, snapshot, workspaceId, active }) {
  if (typeof name !== "string" || !name.startsWith("coworker_")) throw new Error("Unknown native shared-document tool.");
  validateGroupDocumentArguments(name.slice("coworker_".length), args);
  const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
  const part = message?.parts.find((item) => item.type === "tool" && item.callId === context.callID);
  const parent = snapshot.messages.find((item) => item.id === entry?.messageId && item.role === "user");
  if (!active || !entry?.owner || entry.state !== "running" || !entry.sentAt
    || !["group", "consultation"].includes(entry.owner.kind) || !isGroupId(entry.owner.conversationId)
    || entry.owner.groupId !== entry.owner.conversationId || args.groupId !== entry.owner.conversationId
    || entry.owner.slug !== slug || entry.owner.threadId !== context.sessionID
    || !workspaceId || workspaceId !== entry.workspaceId || snapshot.threadId !== context.sessionID
    || typeof context.directory !== "string" || !context.directory || typeof snapshot.directory !== "string" || !snapshot.directory
    || path.resolve(context.directory) !== path.resolve(snapshot.directory)
    || !parent?.parts.some((item) => item.type === "text" && item.text && !item.synthetic && !item.ignored)
    || message?.parentId !== entry.messageId || message.completedAt != null || message.error
    || part?.tool !== name || part.toolStatus !== "running" || !isDeepStrictEqual(part.toolInput, args)) {
    throw new Error("Shared documents require this exact running tool call in its originating group.");
  }
}

/** The only transport entry points: trusted person IPC or admitted native group tools. */
export function createGroupDocumentService({ coworkersDir, coworkerFor, resolveContext, captureArtifact = async () => {}, publish = (groupId, event) => appendGroupEvent(coworkersDir, groupId, event) }) {
  const callers = new WeakMap();
  const person = Object.freeze({});
  callers.set(person, async () => ({ kind: "person" }));
  const store = createGroupDocuments({ coworkersDir, resolveCaller: async (identity) => {
    const resolve = callers.get(identity);
    if (!resolve) throw new Error("Unrecognized shared-document caller.");
    return resolve();
  } });
  async function announce(result, entry) {
    if (!result.changed) return result;
    try {
      await publish(result.groupId, {
        id: `evt_document_${result.id}_${result.revision}`, kind: "status", status: "document",
        documentId: result.id, revision: result.revision,
        ...(entry ? { executionId: entry.id, turnId: entry.owner.turnId, threadId: entry.owner.threadId } : {}),
        text: `${result.author} updated ${result.title} · revision ${result.revision}`,
        ...(result.authorSlug ? { slug: result.authorSlug } : {}),
      });
      return result;
    } catch {
      // The file is already committed. Retrying a successful write would create another revision.
      return { ...result, announcementFailed: true };
    }
  }
  return {
    list: (groupId) => store.list(groupId, person),
    read: (groupId, id) => store.read(groupId, id, person),
    save: async (groupId, input) => announce(await store.save(groupId, input, person)),
    revisions: (groupId, id) => store.revisions(groupId, id, person),
    restore: async (groupId, id, revision, expectedRevision) => announce(await store.restore(groupId, id, revision, expectedRevision, person)),
    async executeNative(slug, { name, args, context }) {
      args = validateGroupDocumentArguments(name, args);
      const native = { sessionID: context?.sessionID, messageID: context?.messageID, callID: context?.callID, directory: context?.directory };
      const trusted = await resolveContext(slug, native, { name: `coworker_${name}`, args });
      const groupId = trusted.entry.owner.conversationId;
      if (args.groupId !== groupId) throw new Error("The document does not belong to this native group.");
      const identity = Object.freeze({});
      callers.set(identity, async () => {
        trusted.assertActive();
        const coworker = await coworkerFor(slug);
        // Native sessions canonicalize paths; macOS /var and /private/var can name the same workspace.
        const [coworkerPath, nativePath] = await Promise.all([realpath(coworker.path), realpath(native.directory)]);
        trusted.assertActive();
        if (coworker.slug !== slug || coworker.workspaceId !== trusted.entry.workspaceId || coworkerPath !== nativePath) {
          throw new Error("The originating coworker's workspace changed.");
        }
        return { kind: "coworker", slug: coworker.slug, name: coworker.name, groupId };
      });
      try {
        let result;
        switch (name) {
          case "group_documents": result = await store.list(groupId, identity); break;
          case "group_document_read": result = await store.read(groupId, args.id, identity); break;
          case "group_document_revisions": result = await store.revisions(groupId, args.id, identity); break;
          case "group_document_save": {
            const { groupId: requestedGroupId, ...input } = args;
            result = await announce(await store.save(groupId, input, identity), trusted.entry);
            break;
          }
          case "group_document_restore": result = await announce(await store.restore(groupId, args.id, args.revision, args.expectedRevision, identity), trusted.entry); break;
        }
        if (["group_document_read", "group_document_save", "group_document_restore"].includes(name)) {
          try { await captureArtifact(trusted.entry, result, result.changed ? args.id ? "modified" : "created" : "used", { kind: "group", groupId }, trusted.callId); }
          catch { result = { ...result, eventReferenceFailed: true }; }
        }
        return { text: JSON.stringify(result) };
      } finally { callers.delete(identity); }
    },
  };
}
