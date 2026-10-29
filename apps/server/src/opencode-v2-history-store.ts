import { randomBytes } from "node:crypto";
import { importNodeSqlite } from "./runtime-db.js";

/** The engine's projected SQLite format, pinned and checked before any target write. */
export interface HistoryDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: Array<string | number>): unknown[];
    get(...params: Array<string | number>): unknown;
    run(...params: Array<string | number>): unknown;
  };
  close(): void;
}

export async function openHistoryDatabase(path: string): Promise<HistoryDatabase> {
  if (typeof process.versions.bun === "string") {
    const { Database, constants } = await import("bun:sqlite");
    // Bun's Linux SQLite does not enable URI filenames by default (macOS does).
    // Enable them explicitly so ATTACH honors mode=ro rather than treating the
    // URI as a literal filename. The main database still receives a plain path.
    return new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
  }
  return new (await importNodeSqlite()).DatabaseSync(path);
}

export function stringField(row: unknown, key: string): string {
  if (typeof row !== "object" || row === null || !(key in row)) return "";
  const value: unknown = Reflect.get(row, key);
  return typeof value === "string" ? value : "";
}

export function numberField(row: unknown, key: string): number {
  if (typeof row !== "object" || row === null || !(key in row)) return 0;
  const value: unknown = Reflect.get(row, key);
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : 0;
}

const VALUE_THRESHOLD = 4096;
const BATCH_ROWS = 64;

function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

export function attachHistory(db: HistoryDatabase, path: string, name: string): void {
  const uri = `file:${path.replace(/[%?#]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}?mode=ro`;
  db.exec(`ATTACH DATABASE '${uri.replaceAll("'", "''")}' AS ${identifier(name)}`);
}

function transaction(db: HistoryDatabase, run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try { run(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}

const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function payloadSessions(db: HistoryDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS openwork_payload_session (token TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS openwork_payload_session_session ON openwork_payload_session(session_id, token)`);
}

/** Native conversion reads a whole session into JS. Substitute reversible,
 * unique payload references first; SQLite keeps the full values off that heap.
 * Each session and its payload map commit together, making restart idempotent. */
export async function externalizeHistory(db: HistoryDatabase, signal?: AbortSignal,
  progress?: (done: number, total: number) => void): Promise<void> {
  db.exec(`CREATE TABLE IF NOT EXISTS openwork_payload (
    token TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS openwork_externalized (session_id TEXT PRIMARY KEY)`);
  payloadSessions(db);
  const mapToken = db.prepare("INSERT INTO openwork_payload_session VALUES (?, ?)");
  const sessions = db.prepare("SELECT id FROM session ORDER BY id").all();
  let done = 0;
  for (const session of sessions) {
    signal?.throwIfAborted();
    const sessionId = stringField(session, "id");
    if (db.prepare("SELECT 1 FROM openwork_externalized WHERE session_id = ?").get(sessionId)) { progress?.(++done, sessions.length); continue; }
    transaction(db, () => {
      for (const table of ["message", "part"]) {
        const rows = db.prepare(`SELECT id FROM ${table} WHERE session_id = ? ORDER BY id`).all(sessionId);
        for (const row of rows) {
          const id = stringField(row, "id");
          const paths = db.prepare(`SELECT fullkey AS path, key FROM ${table}, json_tree(${table}.data)
            WHERE ${table}.id = ? AND type = 'text' AND length(atom) >= ?`).all(id, VALUE_THRESHOLD);
          for (const entry of paths) {
            const path = stringField(entry, "path");
            const token = `OWPAYLOAD${randomBytes(24).toString("hex")}END`;
            const header = stringField(db.prepare(`SELECT CASE WHEN ? = 'url' AND json_extract(data, ?) LIKE 'data:%,%'
              THEN substr(json_extract(data, ?), 1, instr(json_extract(data, ?), ',')) ELSE '' END AS header
              FROM ${table} WHERE id = ?`).get(stringField(entry, "key"), path, path, path, id), "header");
            // A data URL is decoded by the native converter. A base64 reference
            // survives that normalization, and also survives tool file URIs.
            if (header) {
              const encodedToken = Buffer.from(token).toString("base64");
              db.prepare(`INSERT INTO openwork_payload SELECT ?, substr(json_extract(data, ?), ?) FROM ${table} WHERE id = ?`)
                .run(encodedToken, path, header.length + 1, id);
              mapToken.run(encodedToken, sessionId);
              if (!header.endsWith(";base64,")) encodeDataUrl(db, encodedToken);
              const normalizedHeader = header.endsWith(";base64,") ? header : `${header.slice(0, -1)};base64,`;
              db.prepare(`UPDATE ${table} SET data = json_replace(data, ?, ?) WHERE id = ?`).run(path, normalizedHeader + encodedToken, id);
              // Tool file URLs keep their original encoding; keep a separate
              // full-URI mapping ahead of the normalized attachment mapping.
              const uriToken = normalizedHeader + encodedToken;
              db.prepare(`INSERT INTO openwork_payload SELECT ?, json_extract(data, ?) FROM original.${table} WHERE id = ?`)
                .run(uriToken, path, id);
              mapToken.run(uriToken, sessionId);
            } else {
              db.prepare(`INSERT INTO openwork_payload SELECT ?, json_extract(data, ?) FROM ${table} WHERE id = ?`)
                .run(token, path, id);
              mapToken.run(token, sessionId);
              db.prepare(`UPDATE ${table} SET data = json_replace(data, ?, ?) WHERE id = ?`).run(path, token, id);
            }
          }
        }
      }
      db.prepare("INSERT INTO openwork_externalized VALUES (?)").run(sessionId);
    });
    progress?.(++done, sessions.length);
    await yieldTurn();
  }
}

/** Percent-encoded data URLs need normalization into base64 too. Read bounded
 * slices, retain incomplete percent escapes and base64 triples across slices. */
function encodeDataUrl(db: HistoryDatabase, token: string): void {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS payload_chunks (n INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("DELETE FROM temp.payload_chunks");
  let offset = 1;
  let suffix = "";
  let remainder = Buffer.alloc(0);
  let n = 0;
  while (true) {
    const chunk = stringField(db.prepare("SELECT substr(value, ?, 65536) AS value FROM openwork_payload WHERE token = ?").get(offset, token), "value");
    if (!chunk) break;
    offset += Array.from(chunk).length;
    let text = suffix + chunk;
    const tail = /%[0-9a-f]?$/i.exec(text);
    suffix = tail?.[0] ?? "";
    text = text.slice(0, text.length - suffix.length);
    const bytes: number[] = [];
    for (let at = 0; at < text.length;) {
      if (text[at] === "%") {
        const hex = text.slice(at + 1, at + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error("Invalid data URL; the original history is unchanged.");
        bytes.push(parseInt(hex, 16)); at += 3;
      } else {
        const point = text.codePointAt(at);
        if (point === undefined) break;
        bytes.push(...Buffer.from(String.fromCodePoint(point)));
        at += point > 0xffff ? 2 : 1;
      }
    }
    const joined = Buffer.concat([remainder, Buffer.from(bytes)]);
    const end = joined.length - joined.length % 3;
    db.prepare("INSERT INTO temp.payload_chunks VALUES (?, ?)").run(n++, joined.subarray(0, end).toString("base64"));
    remainder = joined.subarray(end);
  }
  if (suffix) throw new Error("Invalid data URL; the original history is unchanged.");
  db.prepare("INSERT INTO temp.payload_chunks VALUES (?, ?)").run(n, remainder.toString("base64"));
  db.prepare("UPDATE openwork_payload SET value = (SELECT group_concat(data, '') FROM (SELECT data FROM temp.payload_chunks ORDER BY n)) WHERE token = ?").run(token);
}

/** Old staged copies have no mapping. Walk their still-externalized v1 atoms
 * once, using payload primary-key lookups, never payload-value scans. A data URL
 * has both a full-URI token and its 80-character base64 token. Unmapped tokens
 * remain in openwork_payload and are handled by the exact global fallback. */
function backfillPayloadSessions(db: HistoryDatabase): void {
  payloadSessions(db);
  db.exec("CREATE TABLE IF NOT EXISTS openwork_payload_session_backfill (completed INTEGER PRIMARY KEY)");
  if (db.prepare("SELECT 1 FROM openwork_payload_session_backfill").get()) return;
  transaction(db, () => {
    for (const table of ["message", "part"]) {
      db.exec(`INSERT OR IGNORE INTO openwork_payload_session (token, session_id)
        SELECT p.token, s.session_id FROM ${table} s, json_tree(s.data) j
        JOIN openwork_payload p ON p.token = j.atom
          OR (j.atom LIKE 'data:%' AND p.token = substr(j.atom, -80))
        WHERE j.type = 'text'`);
    }
    db.exec("INSERT INTO openwork_payload_session_backfill VALUES (1)");
  });
}

/** Rehydrate native projections within SQLite, never JSON.parse/stringify a
 * full message. Only marker-bearing messages need session-local token lookups. */
export async function restoreHistoryPayloads(db: HistoryDatabase, signal?: AbortSignal,
  progress?: (done: number, total: number) => void): Promise<void> {
  signal?.throwIfAborted();
  backfillPayloadSessions(db);
  db.exec("CREATE TABLE IF NOT EXISTS openwork_restored (message_id TEXT PRIMARY KEY)");
  const total = numberField(db.prepare("SELECT count(*) AS n FROM session_message").get(), "n");
  let done = numberField(db.prepare("SELECT count(*) AS n FROM openwork_restored r JOIN session_message m ON m.id = r.message_id").get(), "n");
  progress?.(done, total);
  const marker = db.prepare("SELECT 1 FROM session_message WHERE id = ? AND (instr(data, 'OWPAYLOAD') > 0 OR instr(data, 'T1dQQVlMT0FE') > 0)");
  const replace = db.prepare(`UPDATE session_message SET data = replace(data, ?,
    (SELECT substr(json_quote(value), 2, length(json_quote(value)) - 2) FROM openwork_payload WHERE token = ?)) WHERE id = ?`);
  const unmapped = Boolean(db.prepare(`SELECT 1 FROM openwork_payload p LEFT JOIN openwork_payload_session s ON s.token = p.token
    WHERE s.token IS NULL LIMIT 1`).get());
  const globalTokens = db.prepare(`SELECT token FROM openwork_payload WHERE instr((SELECT data FROM session_message WHERE id = ?), token) > 0
    ORDER BY length(token) DESC`);
  let cursor = "";
  while (true) {
    const rows = db.prepare("SELECT id, session_id FROM session_message WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BATCH_ROWS);
    if (!rows.length) break;
    for (const row of rows) {
      signal?.throwIfAborted();
      const id = stringField(row, "id"); cursor = id;
      if (db.prepare("SELECT 1 FROM openwork_restored WHERE message_id = ?").get(id)) continue;
      transaction(db, () => {
        if (marker.get(id)) {
          const tokens = unmapped ? globalTokens.all(id) : db.prepare(`SELECT token FROM openwork_payload_session WHERE session_id = ?
            AND instr((SELECT data FROM session_message WHERE id = ?), token) > 0 ORDER BY length(token) DESC`)
            .all(stringField(row, "session_id"), id);
          for (const item of tokens) {
            const token = stringField(item, "token"); replace.run(token, token, id);
          }
          if (marker.get(id)) {
            if (db.prepare(`SELECT 1 FROM session_message m WHERE m.id = ? AND EXISTS
              (SELECT 1 FROM openwork_payload p WHERE instr(m.data, p.token) > 0)`).get(id)) throw new Error("Unresolved history payload");
          }
        }
        db.prepare("INSERT INTO openwork_restored VALUES (?)").run(id);
      });
      done++;
    }
    progress?.(done, total);
    await yieldTurn();
  }
}

function columns(db: HistoryDatabase, table: string, schema: string): string[] {
  return db.prepare(`SELECT name FROM pragma_table_info(?, ?) ORDER BY cid`).all(table, schema).map(row => stringField(row, "name"));
}

/** Nullable columns a newer v1 engine adds that the pinned v2 target does not
 * have yet. The copy keeps the target's columns; the value stays in the original
 * v1 database, which is never changed. OpenCode v1.18.33 records project
 * archiving, which the pinned v2 does not read. */
const ADDITIVE_SOURCE_COLUMNS: Readonly<Record<string, readonly string[]>> = { project: ["time_archived"] };

function sameSchema(db: HistoryDatabase, table: string): string[] {
  const target = columns(db, table, "main");
  const additive = (name: string) => !target.includes(name) && (ADDITIVE_SOURCE_COLUMNS[table] ?? []).includes(name);
  const shape = (schema: string) => db.prepare(`SELECT name, upper(type) AS type, "notnull", pk FROM pragma_table_info(?, ?) ORDER BY name`).all(table, schema);
  const converted = shape("converted");
  const tolerated = converted.filter(row => additive(stringField(row, "name")) && !numberField(row, "notnull") && !numberField(row, "pk"));
  const source = columns(db, table, "converted").filter(name => !tolerated.some(row => stringField(row, "name") === name));
  if (!source.length || JSON.stringify([...target].sort()) !== JSON.stringify([...source].sort())) throw new Error(`Unsupported OpenCode history schema (${table}); nothing was overwritten. Missing: ${target.filter(name => !source.includes(name)).join(", ")}; extra: ${source.filter(name => !target.includes(name)).join(", ")}`);
  if (JSON.stringify(shape("main")) !== JSON.stringify(converted.filter(row => !tolerated.includes(row)))) throw new Error(`Unsupported OpenCode history column types (${table}); nothing was overwritten.`);
  return target;
}

/** Reconcile an old, uncheckpointed projection atomically. Archive before every
 * replacement (including sequence changes). Never overwrite v2-authored turns.
 * Extra system rows are archived, not retained alongside a converter's new
 * system row: duplicate tool-availability state is not safe to replay. */
function refreshExistingSession(db: HistoryDatabase, id: string, sourceKey: string, messageColumns: string): boolean {
  const missing = db.prepare(`SELECT 1 FROM converted.session_message s LEFT JOIN main.session_message t ON t.id = s.id
    WHERE s.session_id = ? AND t.id IS NULL LIMIT 1`).get(id);
  if (!missing) return false;
  if (db.prepare(`SELECT 1 FROM converted.session_message s JOIN main.session_message t ON t.id = s.id
    WHERE s.session_id = ? AND t.session_id != s.session_id LIMIT 1`).get(id)) throw new Error("History message identity conflict; existing v2 messages were preserved.");
  const diverged = db.prepare(`SELECT 1 FROM main.session_message t LEFT JOIN converted.session_message s ON s.id = t.id
    WHERE t.session_id = ? AND t.type IN ('user', 'assistant') AND s.id IS NULL LIMIT 1`).get(id);
  db.prepare(`INSERT INTO openwork_v2_replaced_message (source_key, id, session_id, seq, type, data, time_created, time_updated)
    SELECT ?, id, session_id, seq, type, data, time_created, time_updated FROM session_message WHERE session_id = ?`).run(sourceKey, id);
  if (!diverged) {
    db.prepare("DELETE FROM session_message WHERE session_id = ?").run(id);
    db.prepare(`INSERT INTO session_message (${messageColumns}) SELECT ${messageColumns} FROM converted.session_message WHERE session_id = ?`).run(id);
  } else {
    // Keep existing data/ids/timestamps exactly; only seq changes to interleave
    // earlier missing turns. Negative staging seqs avoid the unique index even
    // when the old converter numbered from one and the new one from zero.
    db.exec("CREATE TEMP TABLE IF NOT EXISTS history_order (id TEXT PRIMARY KEY, seq INTEGER NOT NULL); DELETE FROM temp.history_order");
    db.prepare(`INSERT INTO temp.history_order SELECT id, row_number() OVER (ORDER BY time_created, seq, id) - 1 FROM (
      SELECT id, time_created, seq FROM main.session_message WHERE session_id = ?1
      UNION ALL SELECT s.id, s.time_created, s.seq FROM converted.session_message s
        WHERE s.session_id = ?1 AND NOT EXISTS (SELECT 1 FROM main.session_message t WHERE t.id = s.id))`).run(id);
    db.prepare("UPDATE session_message SET seq = -(SELECT seq FROM temp.history_order o WHERE o.id = session_message.id) - 1 WHERE session_id = ?").run(id);
    db.prepare(`INSERT INTO session_message (id, session_id, seq, type, data, time_created, time_updated)
      SELECT s.id, s.session_id, -o.seq - 1, s.type, s.data, s.time_created, s.time_updated
      FROM converted.session_message s JOIN temp.history_order o ON o.id = s.id
      WHERE s.session_id = ? AND NOT EXISTS (SELECT 1 FROM main.session_message t WHERE t.id = s.id)`).run(id);
    db.prepare("UPDATE session_message SET seq = (SELECT seq FROM temp.history_order o WHERE o.id = session_message.id) WHERE session_id = ?").run(id);
    db.exec("DELETE FROM temp.history_order");
  }
  return true;
}

function advanceHistorySequence(db: HistoryDatabase, id: string): void {
  // Preserve the current owner and never rewind an existing event log.
  db.prepare(`INSERT INTO event_sequence (aggregate_id, seq, owner_id)
    SELECT ?, max(coalesce((SELECT max(seq) FROM session_message WHERE session_id = ?1), 0),
      coalesce((SELECT seq FROM converted.event_sequence WHERE aggregate_id = ?1), 0)), NULL
    ON CONFLICT(aggregate_id) DO UPDATE SET seq = max(event_sequence.seq, excluded.seq)`).run(id);
}

/** Pre-ownership checkpoints only represented sessions the copy created.
 * Preserve that meaning when upgrading an already interrupted database. */
export function ensureHistoryCopyOwnership(db: HistoryDatabase): void {
  if (db.prepare("SELECT 1 FROM pragma_table_info('openwork_history_copy') WHERE name = 'created_session'").get()) return;
  db.exec("ALTER TABLE openwork_history_copy ADD COLUMN created_session INTEGER NOT NULL DEFAULT 1");
}

/** The target engine must be stopped. Rows, their original v1 archive and the
 * checkpoint live in the same SQLite DB. A kill rolls back only the active batch. */
export async function copyHistoryBatches(options: {
  database: HistoryDatabase; sourceKey: string;
  progress(sessionId: string, outcome: "imported" | "skipped"): void;
  batch?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ imported: number; skipped: number }> {
  const db = options.database;
  const sessionTarget = sameSchema(db, "session_v2");
  const sessionColumns = sessionTarget.map(identifier).join(", ");
  // OpenCode v2 cannot unarchive a chat yet, so a copied v1 archive would lock
  // it read-only forever. Copy it as active; openwork_v1_session keeps the time.
  const sessionValues = sessionTarget.map(name => name === "time_archived" ? "NULL" : identifier(name)).join(", ");
  const messageColumns = sameSchema(db, "session_message").map(identifier).join(", ");
  const projectColumns = sameSchema(db, "project").map(identifier).join(", ");
  sameSchema(db, "event_sequence");
  if (db.prepare("SELECT 1 FROM original.session s LEFT JOIN converted.session_v2 t ON t.id = s.id WHERE t.id IS NULL LIMIT 1").get()) {
    throw new Error("The native converter did not account for every original chat. Original history and staging were preserved.");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS openwork_history_copy (
      source_key TEXT, session_id TEXT, cursor INTEGER NOT NULL DEFAULT -1, completed INTEGER NOT NULL DEFAULT 0,
      created_session INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (source_key, session_id));
    CREATE TABLE IF NOT EXISTS openwork_v1_message (source_key TEXT, id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL, PRIMARY KEY (source_key, id));
    CREATE TABLE IF NOT EXISTS openwork_v1_part (source_key TEXT, id TEXT, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL, PRIMARY KEY (source_key, id));
    CREATE TABLE IF NOT EXISTS openwork_v1_session (source_key TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY (source_key, id));
    CREATE TABLE IF NOT EXISTS openwork_v2_replaced_message (source_key TEXT, id TEXT, session_id TEXT,
      seq INTEGER, type TEXT, data TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, PRIMARY KEY (source_key, id))`);
  ensureHistoryCopyOwnership(db);
  db.exec("PRAGMA foreign_keys = ON");
  transaction(db, () => {
    db.exec(`INSERT OR IGNORE INTO project (${projectColumns}) SELECT ${projectColumns} FROM converted.project`);
  });
  const sessions = db.prepare("SELECT id FROM converted.session_v2 WHERE id IN (SELECT id FROM original.session) ORDER BY id").all();
  let imported = 0;
  let skipped = 0;
  for (const session of sessions) {
    options.signal?.throwIfAborted();
    const id = stringField(session, "id");
    const checkpoint = db.prepare("SELECT cursor, completed FROM openwork_history_copy WHERE source_key = ? AND session_id = ?").get(options.sourceKey, id);
    if (numberField(checkpoint, "completed")) { skipped++; options.progress(id, "skipped"); continue; }
    let unchanged = false;
    let cursor = checkpoint ? numberField(checkpoint, "cursor") : -1;
    transaction(db, () => {
      if (checkpoint) return;
      const existingSession = db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(id);
      if (existingSession) {
        unchanged = !refreshExistingSession(db, id, options.sourceKey, messageColumns);
        // Recovery may release this checkpoint before raw archiving finishes.
        // Make its retained projection safe for the next native writer now.
        advanceHistorySequence(db, id);
        cursor = numberField(db.prepare("SELECT coalesce(max(seq), -1) AS seq FROM converted.session_message WHERE session_id = ?").get(id), "seq");
      } else {
        db.prepare(`INSERT INTO session_v2 (${sessionColumns}) SELECT ${sessionValues} FROM converted.session_v2 WHERE id = ?`).run(id);
      }
      db.prepare("INSERT INTO openwork_history_copy (source_key, session_id, cursor, created_session) VALUES (?, ?, ?, ?)")
        .run(options.sourceKey, id, cursor, existingSession ? 0 : 1);
    });
    while (true) {
      options.signal?.throwIfAborted();
      const batch = db.prepare("SELECT id, seq FROM converted.session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(id, cursor, BATCH_ROWS);
      if (!batch.length) break;
      transaction(db, () => {
        for (const message of batch) {
          const messageId = stringField(message, "id");
          const existing = db.prepare("SELECT 1 FROM session_message WHERE id = ?").get(messageId);
          if (existing) {
            const same = db.prepare(`SELECT 1 FROM main.session_message t JOIN converted.session_message s ON s.id = t.id
              WHERE t.id = ? AND t.session_id = s.session_id AND t.type = s.type AND t.seq = s.seq AND t.data = s.data`).get(messageId);
            if (!same) throw new Error("History message identity conflict; existing v2 messages were preserved.");
          } else {
            db.prepare(`INSERT INTO session_message (${messageColumns}) SELECT ${messageColumns} FROM converted.session_message WHERE id = ?`).run(messageId);
          }
          cursor = numberField(message, "seq");
        }
        db.prepare("UPDATE openwork_history_copy SET cursor = ? WHERE source_key = ? AND session_id = ?").run(cursor, options.sourceKey, id);
      });
      await options.batch?.();
      await yieldTurn();
    }
    // Archive every original row, including legacy fields the native projection
    // does not represent. Batches remain in SQLite, even for a single huge part.
    for (const table of ["message", "part"]) {
      let rowCursor = "";
      while (true) {
        options.signal?.throwIfAborted();
        const rows = db.prepare(`SELECT id FROM original.${table} WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`).all(id, rowCursor, BATCH_ROWS);
        if (!rows.length) break;
        const last = stringField(rows[rows.length - 1], "id");
        transaction(db, () => {
          const rawColumns = table === "message" ? "id, session_id, time_created, time_updated, data" : "id, message_id, session_id, time_created, time_updated, data";
          db.prepare(`INSERT OR IGNORE INTO openwork_v1_${table} SELECT ?, ${rawColumns} FROM original.${table}
            WHERE session_id = ? AND id > ? AND id <= ?`).run(options.sourceKey, id, rowCursor, last);
        });
        rowCursor = last;
        await options.batch?.();
        await yieldTurn();
      }
    }
    transaction(db, () => {
      const fields = columns(db, "session", "original").flatMap(column => [`'${column.replaceAll("'", "''")}'`, identifier(column)]).join(", ");
      db.prepare(`INSERT OR IGNORE INTO openwork_v1_session SELECT ?, id, json_object(${fields}) FROM original.session WHERE id = ?`).run(options.sourceKey, id);
      const missing = db.prepare(`SELECT 1 FROM converted.session_message s LEFT JOIN main.session_message t ON t.id = s.id
        WHERE s.session_id = ? AND (t.id IS NULL OR t.session_id != s.session_id OR t.type != s.type) LIMIT 1`).get(id);
      if (missing) throw new Error("History verification failed; migration can be resumed.");
      for (const table of ["message", "part"]) {
        if (db.prepare(`SELECT 1 FROM original.${table} s LEFT JOIN openwork_v1_${table} t ON t.id = s.id AND t.source_key = ?
          WHERE s.session_id = ? AND (t.id IS NULL OR t.data != s.data) LIMIT 1`).get(options.sourceKey, id)) throw new Error("Original history verification failed");
      }
      advanceHistorySequence(db, id);
      db.prepare("UPDATE openwork_history_copy SET completed = 1 WHERE source_key = ? AND session_id = ?").run(options.sourceKey, id);
    });
    if (unchanged) { skipped++; options.progress(id, "skipped"); }
    else { imported++; options.progress(id, "imported"); }
  }
  return { imported, skipped };
}
