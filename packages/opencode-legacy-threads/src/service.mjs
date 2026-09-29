import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export const ENGINE_VERSION = "0.0.0-beta-19086";
export const PROVENANCE_KEY = "openworkLegacyHistory";
export const isLegacyThread = id => typeof id === "string" && /^v1:[a-f0-9]{24}:ses_[A-Za-z0-9]+$/.test(id);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = path => realpath(path).catch(() => normalize(path));
const json = value => typeof value === "string" ? JSON.parse(value) : value;
const object = value => { const result = json(value); return record(result) ? result : {}; };
const previewObject = value => { try { return object(value); } catch { return { legacyUnreadable: true }; } };

export class LegacyHistoryError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "LegacyHistoryError"; this.code = code; this.status = status; }
}

function pageSize(value = 100) {
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new LegacyHistoryError("legacy_invalid_page", "Choose a page size between 1 and 200.");
  return value;
}
function decodeCursor(value, kind, scope) {
  if (!value) return null;
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString());
    if (record(data) && data.kind === kind && data.scope === scope && typeof data.id === "string" && Number.isFinite(data.time)) return data;
  } catch { /* Report an invalid cursor, without exposing its contents. */ }
  throw new LegacyHistoryError("legacy_invalid_cursor", "This history page expired. Refresh the chat list.");
}
function cursor(kind, scope, row, time) { return Buffer.from(JSON.stringify({ kind, scope, id: row.id, time: row[time] })).toString("base64url"); }

async function openReadOnly(path) {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true, strict: true });
  }
  // Keep this opaque: Bun must not eagerly resolve Node's SQLite builtin.
  const specifier = "node:sqlite";
  const { DatabaseSync } = await import(specifier);
  return new DatabaseSync(path, { readOnly: true });
}

/** All operations open a read-only connection and close their consistent snapshot. */
export function createLegacyHistoryService({ legacyDatabase, targetDatabase }) {
  if (typeof legacyDatabase !== "string" || !isAbsolute(legacyDatabase)) throw new LegacyHistoryError("legacy_invalid_source", "Configure an absolute v1 database path.");
  async function snapshot(operation) {
    let source;
    try { source = await realpath(legacyDatabase); await stat(source); }
    catch { throw new LegacyHistoryError("legacy_missing", "No v1 history found for this profile.", 404); }
    if (targetDatabase && source === await canonical(targetDatabase)) throw new LegacyHistoryError("legacy_invalid_source", "V1 history and the v2 database must be separate.");
    const sourceID = createHash("sha256").update(source).digest("hex").slice(0, 24);
    const db = await openReadOnly(source);
    try {
      db.exec("PRAGMA query_only=ON; BEGIN");
      for (const [table, required] of [["session", ["id", "directory", "parent_id", "title", "time_created", "time_updated"]], ["message", ["id", "session_id", "data", "time_created", "time_updated"]], ["part", ["id", "message_id", "session_id", "data", "time_created", "time_updated"]]]) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        if (required.some(name => !columns.has(name))) throw new LegacyHistoryError("legacy_unsupported", "This database is not supported v1 SQLite history. Your history was not changed.");
      }
      return await operation(db, sourceID);
    } finally { db.close(); }
  }
  const reference = (sourceID, id) => `v1:${sourceID}:${id}`;
  function originalID(ref, sourceID) {
    if (!isLegacyThread(ref) || !ref.startsWith(`v1:${sourceID}:`)) throw new LegacyHistoryError("legacy_not_found", "V1 chat not found in this profile.", 404);
    return ref.slice(`v1:${sourceID}:`.length);
  }
  async function scopedSession(db, id, directory) {
    const selected = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
    if (!selected) throw new LegacyHistoryError("legacy_not_found", "V1 chat not found.", 404);
    const seen = new Set(); let root = selected;
    while (root.parent_id) {
      if (seen.has(root.id) || seen.size >= 256) throw new LegacyHistoryError("legacy_invalid_ancestry", "V1 chat ancestry is invalid.");
      seen.add(root.id);
      root = db.prepare("SELECT * FROM session WHERE id = ?").get(root.parent_id);
      if (!root) throw new LegacyHistoryError("legacy_invalid_ancestry", "The parent v1 chat is missing.");
    }
    if (!isAbsolute(root.directory) || await canonical(root.directory) !== await canonical(directory)) throw new LegacyHistoryError("legacy_not_found", "V1 chat not found in this workspace.", 404);
    return { selected, home: root.directory };
  }
  function summary(row, sourceID, home = row.directory) {
    return { id: reference(sourceID, row.id), projectID: row.project_id ?? "global", slug: row.slug ?? row.id,
      directory: home, title: row.title ?? "Untitled chat", version: row.version ?? "1.18.30",
      ...(row.parent_id ? { parentID: reference(sourceID, row.parent_id) } : {}),
      time: { created: row.time_created, updated: row.time_updated, ...(row.time_archived ? { archived: row.time_archived } : {}) },
      legacyReference: { sourceID, sessionID: row.id },
    };
  }
  return {
    async list({ directory, search = "", limit = 100, before, parentReference }) {
      const home = await canonical(directory); const size = pageSize(limit);
      return snapshot(async (db, sourceID) => {
        const parentID = parentReference ? originalID(parentReference, sourceID) : null;
        if (parentID) await scopedSession(db, parentID, directory);
        const scope = `${sourceID}:${home}:${search}:${parentID ?? ""}`; const anchor = decodeCursor(before, "list", scope);
        const rootDirectories = db.prepare("SELECT DISTINCT directory FROM session WHERE parent_id IS NULL").all();
        const allowed = [];
        for (const root of rootDirectories) if (isAbsolute(root.directory) && await canonical(root.directory) === home) allowed.push(root.directory);
        if (!allowed.length) return { data: [], nextCursor: null };
        // A child's working directory may differ. Ownership follows the root.
        const rows = db.prepare(`WITH RECURSIVE owned(id, home, depth) AS (
          SELECT id, directory, 0 FROM session WHERE parent_id IS NULL
          UNION ALL SELECT child.id, owned.home, owned.depth + 1 FROM session child JOIN owned ON child.parent_id = owned.id WHERE owned.depth < 256
        ) SELECT session.*, owned.home AS legacy_home FROM session JOIN owned ON session.id = owned.id
          WHERE owned.home IN (${allowed.map(() => "?").join(",")}) AND instr(lower(coalesce(title, '')), lower(?)) > 0
          ${parentID ? "AND parent_id = ?" : ""}
          ${anchor ? "AND (time_updated < ? OR (time_updated = ? AND session.id < ?))" : ""}
          ORDER BY time_updated DESC, session.id DESC LIMIT ?`).all(...allowed, search, ...(parentID ? [parentID] : []),
          ...(anchor ? [anchor.time, anchor.time, anchor.id] : []), size + 1);
        const selected = rows.slice(0, size);
        // Project the authorized workspace spelling, like OpenWork's mounted
        // routes. The source may contain a realpath for a symlinked workspace.
        return { data: selected.map(row => summary(row, sourceID, directory)), nextCursor: rows.length > size ? cursor("list", scope, selected.at(-1), "time_updated") : null };
      });
    },
    async read({ directory, reference: ref, limit = 100, before, messageID }) {
      const size = pageSize(limit);
      return snapshot(async (db, sourceID) => {
        const id = originalID(ref, sourceID); const { selected, home } = await scopedSession(db, id, directory);
        const scope = `${sourceID}:${id}`; const anchor = decodeCursor(before, "read", scope);
        const rows = messageID ? db.prepare("SELECT * FROM message WHERE session_id = ? AND id = ?").all(id, messageID)
          : db.prepare(`SELECT * FROM message WHERE session_id = ? ${anchor ? "AND (time_created < ? OR (time_created = ? AND id < ?))" : ""} ORDER BY time_created DESC, id DESC LIMIT ?`)
            .all(id, ...(anchor ? [anchor.time, anchor.time, anchor.id] : []), size + 1);
        const page = rows.slice(0, size);
        const data = page.toReversed().map(row => ({ info: { role: "user", time: { created: row.time_created }, ...previewObject(row.data), id: row.id, sessionID: ref },
          parts: db.prepare("SELECT * FROM part WHERE session_id = ? AND message_id = ? ORDER BY id").all(id, row.id)
            .map(part => { const value = previewObject(part.data); return { ...(value.legacyUnreadable ? { type: "text", text: "This historical part has invalid metadata and cannot be converted." } : value), id: part.id, messageID: row.id, sessionID: ref }; }) }));
        return { session: summary(selected, sourceID, directory), data, nextCursor: !messageID && rows.length > size ? cursor("read", scope, page.at(-1), "time_created") : null };
      });
    },
    async prepareImport({ directory, reference: ref }) {
      const [{ Schema }, { SessionTransfer }, { transformSession }] = await Promise.all([
        import("effect"), import("@opencode-ai/schema/session-transfer"), import("./vendor/migration-19086.mjs"),
      ]);
      return snapshot(async (db, sourceID) => {
        const id = originalID(ref, sourceID); const { home } = await scopedSession(db, id, directory);
        const family = db.prepare(`WITH RECURSIVE family(id) AS (SELECT id FROM session WHERE id = ? UNION SELECT s.id FROM session s JOIN family ON s.parent_id = family.id)
          SELECT session.* FROM session JOIN family ON session.id = family.id`).all(id);
        const pending = new Map(family.map(row => [row.id, row]));
        for (let row = pending.get(id); row?.parent_id;) {
          row = db.prepare("SELECT * FROM session WHERE id = ?").get(row.parent_id);
          if (!row || pending.has(row.id)) throw new LegacyHistoryError("legacy_invalid_ancestry", "V1 chat ancestry is invalid.");
          pending.set(row.id, row);
        }
        const sessions = []; const warnings = [];
        while (pending.size) {
          const eligible = [...pending.values()].filter(row => !row.parent_id || !pending.has(row.parent_id));
          if (!eligible.length) throw new LegacyHistoryError("legacy_invalid_ancestry", "V1 chat ancestry is invalid.");
          for (const row of eligible) {
            const messages = db.prepare("SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ?").all(row.id);
            const parts = db.prepare("SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ?").all(row.id);
            const transformed = transformSession({ session: { ...row, agent: row.agent ?? null, model: row.model ? json(row.model) : null }, messages, parts });
            if (transformed.warnings.length) throw new LegacyHistoryError("legacy_malformed", "Some v1 history rows could not be converted. Keep reading the original chat; no history was imported.");
            for (const part of parts) {
              const value = object(part.data);
              if (value.type === "file" && !String(value.url).startsWith("data:")) warnings.push({ sessionID: row.id, reason: "attachment_unavailable", message: "A linked attachment is unavailable in the converted history." });
              if (value.type === "file" && String(value.url).startsWith("data:") && !String(value.url).includes(",")) warnings.push({ sessionID: row.id, reason: "attachment_unavailable", message: "A malformed attachment is unavailable in the converted history." });
              if (value.type === "subtask") warnings.push({ sessionID: row.id, reason: "subtask_projection", message: "Delegation-only turns may be omitted from the parent transcript. Related child chats are copied." });
              if (value.type === "retry") warnings.push({ sessionID: row.id, reason: "retry_omitted", message: "Historical retry notices are omitted from the converted transcript." });
              if (value.type === "compaction" && !transformed.messages.some(message => message.id === part.message_id && message.type === "compaction")) warnings.push({sessionID:row.id,reason:"compaction_omitted",message:"An unfinished compaction boundary is omitted from the converted transcript."});
            }
            const state = transformed.session;
            const payload = { info: { id: row.id, projectID: row.project_id ?? "global", location: { directory: row.directory },
              ...(row.parent_id ? { parentID: row.parent_id } : {}), title: row.title ?? "Untitled chat",
              ...(state.agent ? { agent: state.agent } : {}), ...(state.model ? { model: state.model } : {}),
              cost: state.cost, tokens: { input: state.tokens_input, output: state.tokens_output, reasoning: state.tokens_reasoning, cache: { read: state.tokens_cache_read, write: state.tokens_cache_write } },
              time: { created: row.time_created, updated: row.time_updated, ...(row.time_archived ? { archived: row.time_archived } : {}) },
              metadata: { ...(row.metadata ? object(row.metadata) : {}), [PROVENANCE_KEY]: { sourceID, sessionID: row.id, converterVersion: ENGINE_VERSION } },
            }, messages: transformed.messages.map(message => ({ id: message.id, type: message.type, ...message.data })) };
            // Decode and encode with the exact native transfer schema, including timestamps.
            const valid = Schema.encodeSync(SessionTransfer.Data)(Schema.decodeUnknownSync(SessionTransfer.Data)(payload));
            sessions.push({ ...valid, location: { directory: row.directory } }); pending.delete(row.id);
          }
        }
        return { sourceID, sessionID: id, homeDirectory: home, sessions, warnings,
          resets: ["Session permissions will use v2 defaults.", "V1 revert state will not carry over."], converterVersion: ENGINE_VERSION };
      });
    },
  };
}

const imports = new Map();
export async function continueLegacyThread(plan, target, { allowOmissions = false } = {}) {
  if (plan.warnings.length && !allowOmissions) throw new LegacyHistoryError("legacy_omissions", "Review conversion omissions before continuing.", 409);
  const previous = imports.get(target.key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const matches = (value, id) => {
      const info = record(value?.data) ? value.data : value;
      const source = info?.metadata?.[PROVENANCE_KEY];
      return source?.sourceID === plan.sourceID && source?.sessionID === id && source?.converterVersion === plan.converterVersion;
    };
    for (const payload of plan.sessions) {
      const id = payload.info.id; const existing = await target.get(id);
      if (existing) {
        if (!matches(existing, id)) throw new LegacyHistoryError("legacy_conflict", "A different v2 chat already uses this ID. Open the existing v2 chat; it was not overwritten.", 409);
      } else {
        try { await target.import(payload); }
        catch (error) {
          // Native import may commit before a connection is interrupted.
          const recovered = await target.get(id);
          if (!recovered || !matches(recovered, id)) throw error;
        }
      }
      await target.onImported?.(id, plan.homeDirectory);
    }
    return { sessionID: plan.sessionID };
  });
  imports.set(target.key, job);
  try { return await job; } finally { if (imports.get(target.key) === job) imports.delete(target.key); }
}
