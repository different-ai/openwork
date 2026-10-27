import { createHash } from "node:crypto"
import { z } from "zod"
import { FILE_LIMITS } from "./files.js"
import type { SqlDriver, SqlValue } from "./sql.js"

/**
 * What session cells keep in SQLite, beside the conversation tables (see OWNER-CELLS.md, "Session cells"):
 *
 * - `cells_meta`: a session cell's owner (stored at creation, checked on every request), import and split state.
 * - `owner_memory`: memory/ files shared by all of one owner's conversations (`memoryScope: "owner"`).
 * - `owner_directory`: in an owner cell, one row per chat that lives in its own session cell, for listing.
 * - `session_forwards`: in an owner cell, legacy chats moved to their own cell; their requests are forwarded there.
 * - `directory_outbox`: in a session cell, the latest directory entry not yet acknowledged by the owner cell.
 * - `split_progress`: in an owner cell, the chat being moved and its attempts.
 * - `split_handoff`: in an owner cell, a moved chat's storage bookkeeping not yet handed to its session cell.
 *
 * Every host has these tables (Node keeps them empty except owner_memory); only `src/worker/` makes cell calls.
 */
export function migrateCells(db: SqlDriver) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cells_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_memory (
      owner TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner, path)
    );
    CREATE TABLE IF NOT EXISTS owner_directory (
      session_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      has_turns INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS owner_directory_by_owner ON owner_directory (owner, updated_at);
    CREATE TABLE IF NOT EXISTS session_forwards (
      session_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      cell TEXT NOT NULL,
      moved_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS directory_outbox (
      session_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      version INTEGER NOT NULL,
      entry TEXT NOT NULL,
      acked INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS split_progress (
      session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS split_handoff (
      session_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL
    );
  `)
}

/** Tables of this module: they describe cells, never one conversation's content, so a move never copies them. */
const CELLS_TABLES = new Set(["cells_meta", "owner_memory", "owner_directory", "session_forwards", "directory_outbox", "split_progress", "split_handoff"])
/**
 * Not copied when a chat moves: its pending Den index update. The session cell queues a fresh one, numbered above
 * everything the owner cell sent, once the owner cell hands over (see Handoff).
 */
const NOT_COPIED = new Set(["index_outbox"])
/**
 * Copied, but not part of the fingerprint: the storage engine's bookkeeping, which background work changes without
 * changing the conversation (seal retries). Columns of `sessions` likewise (hot byte count, index version and
 * capability).
 */
const BOOKKEEPING_TABLES = new Set(["seal_state"])
const BOOKKEEPING_COLUMNS = new Set(["hot_bytes", "index_version", "index_capability"])

/** A chat's line in its owner's list: no content beyond its title. */
export const directoryEntry = z
  .object({
    title: z.string().max(400),
    ref: z.string().max(200).nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    /** Listing shows only conversations with a message, as for legacy chats. */
    hasTurns: z.boolean(),
    deleted: z.boolean(),
  })
  .strict()
export type DirectoryEntry = z.infer<typeof directoryEntry>
export type ListedSession = { id: string; ref: string | null; title: string; createdAt: number; updatedAt: number }
export type MemoryFile = { path: string; content: string; updatedAt?: number }
export type MemoryWrite = { ok: true; size: number } | { ok: false; message: string }
/**
 * A moved chat's storage bookkeeping as the owner cell had it when the chat left: the Den index version it reached
 * and its capability, and object deletions pending under the chat's prefix (`sessions/<id>/`).
 */
export const handoffSchema = z
  .object({
    indexVersion: z.number().int().min(0),
    capability: z.string().nullable(),
    deletions: z.array(z.object({ key: z.string(), kind: z.string(), due_at: z.number(), attempt: z.number() }).strict()),
  })
  .strict()
export type Handoff = z.infer<typeof handoffSchema>

const rowValue = z.union([z.string(), z.number(), z.null()])
export const cellRow = z.record(z.string(), rowValue)
export type CellRow = z.infer<typeof cellRow>
const COLUMN = /^[a-z_][a-z0-9_]*$/
const TABLE = /^[a-z][a-z0-9_]*$/
const memoryRow = z.object({ path: z.string(), content: z.string() })
const ownerMemoryRow = z.object({ path: z.string(), content: z.string(), updated_at: z.number() })
const directoryRow = z.object({ session_id: z.string(), ref: z.string().nullable(), title: z.string(), created_at: z.number(), updated_at: z.number() })
const outboxRow = z.object({ session_id: z.string(), owner: z.string(), version: z.number(), entry: z.string(), acked: z.number(), attempt: z.number(), next_attempt_at: z.number() })
const progressRow = z.object({ session_id: z.string(), state: z.string(), attempt: z.number(), next_attempt_at: z.number() })
const sessionOptionsRow = z.object({ id: z.string(), options: z.string().nullable(), created_at: z.number() })
const nameRow = z.object({ name: z.string() })
const countRow = z.object({ n: z.number() })
/** The parts of a session's options this module reads and rewrites; everything else is kept as it is. */
const optionsShape = z.object({ memoryOf: z.string().optional(), memoryScope: z.literal("owner").optional() }).loose()

/** Backoff for retried cell calls: immediately three times, then 30 s, 2 min, 10 min, then hourly. */
export function retryDelay(attempt: number) {
  if (attempt <= 3) return 0
  return [30_000, 120_000, 600_000][attempt - 4] ?? 3_600_000
}

export class CellsStore {
  private depth = 0

  /**
   * `transaction`: the Store's, so a transaction here inside one of the Store's (or the other way round) is part of
   * it; SQLite drivers here don't nest. Without it, this store keeps its own.
   */
  constructor(
    readonly db: SqlDriver,
    private readonly now: () => number = Date.now,
    private readonly transaction?: <T>(fn: () => T) => T,
  ) {}

  /** The session-cell tables of a Store's database, sharing its transactions. */
  static of(store: { db: SqlDriver; transaction<T>(fn: () => T): T }) {
    return new CellsStore(store.db, Date.now, (fn) => store.transaction(fn))
  }

  /** One transaction; inside another (this store's, or the Store's when shared), part of that one. */
  atomic<T>(fn: () => T): T {
    if (this.transaction) return this.transaction(fn)
    if (this.depth > 0) return fn()
    this.depth += 1
    try {
      return this.db.transaction(fn)
    } finally {
      this.depth -= 1
    }
  }

  // ------------------------------------------------------------------ meta

  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM cells_meta WHERE key = ?").get(key)
    return row ? z.object({ value: z.string() }).parse(row).value : null
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM cells_meta WHERE key = ?").run(key)
    else this.db.prepare("INSERT INTO cells_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  /** A session cell's owner: set once, by the first creating request or import; null while unclaimed. */
  cellOwner(): string | null {
    return this.meta("owner")
  }

  /** Claims this session cell for `owner` unless it already has one; returns the owner it has now. */
  claimCellOwner(owner: string): string {
    this.db.prepare("INSERT OR IGNORE INTO cells_meta (key, value) VALUES ('owner', ?)").run(owner)
    return this.cellOwner() ?? owner
  }

  // ------------------------------------------------------------------ owner-scoped memory

  ownerMemoryFiles(owner: string): MemoryFile[] {
    this.adoptOwnerMemory(owner)
    return this.db
      .prepare("SELECT path, content, updated_at FROM owner_memory WHERE owner = ? ORDER BY path")
      .all(owner)
      .map((row) => {
        const value = ownerMemoryRow.parse(row)
        return { path: value.path, content: value.content, updatedAt: value.updated_at }
      })
  }

  readOwnerMemory(owner: string, path: string): string | null {
    this.adoptOwnerMemory(owner)
    const row = this.db.prepare("SELECT content FROM owner_memory WHERE owner = ? AND path = ?").get(owner, path)
    return row ? z.object({ content: z.string() }).parse(row).content : null
  }

  /** Writes one memory file within the same limits as a conversation's scratch files. */
  writeOwnerMemory(owner: string, path: string, content: string): MemoryWrite {
    this.adoptOwnerMemory(owner)
    const size = Buffer.byteLength(content)
    if (size > FILE_LIMITS.maxFileBytes) return { ok: false, message: `File is larger than ${FILE_LIMITS.maxFileBytes} bytes.` }
    const files = this.db.prepare("SELECT path, size FROM owner_memory WHERE owner = ?").all(owner).map((row) => z.object({ path: z.string(), size: z.number() }).parse(row))
    const existing = files.find((file) => file.path === path)
    if (!existing && files.length >= FILE_LIMITS.maxFiles) return { ok: false, message: `Memory already has ${FILE_LIMITS.maxFiles} files.` }
    const total = files.reduce((sum, file) => sum + file.size, 0) - (existing?.size ?? 0) + size
    if (total > FILE_LIMITS.maxSessionBytes) return { ok: false, message: `Memory would exceed ${FILE_LIMITS.maxSessionBytes} bytes.` }
    this.db
      .prepare(
        `INSERT INTO owner_memory (owner, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, path) DO UPDATE SET content = excluded.content, size = excluded.size, updated_at = excluded.updated_at`,
      )
      .run(owner, path, content, size, this.now())
    return { ok: true, size }
  }

  /**
   * An imported conversation's owner memory: each file is written unless this owner already has a newer (or the same)
   * version of it; nothing is deleted. Importing several of one owner's conversations so keeps the newest of each file.
   */
  mergeOwnerMemory(owner: string, files: Array<{ path: string; content: string; updated_at: number }>) {
    this.atomic(() => {
      for (const file of files) {
        this.db
          .prepare(
            `INSERT INTO owner_memory (owner, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (owner, path) DO UPDATE SET content = excluded.content, size = excluded.size, updated_at = excluded.updated_at
             WHERE excluded.updated_at > owner_memory.updated_at`,
          )
          .run(owner, file.path, file.content, Buffer.byteLength(file.content), file.updated_at)
      }
    })
  }

  deleteOwnerMemory(owner: string, path: string): boolean {
    this.adoptOwnerMemory(owner)
    return Number(this.db.prepare("DELETE FROM owner_memory WHERE owner = ? AND path = ?").run(owner, path).changes) > 0
  }

  /**
   * Once per owner: the memory their legacy conversations share becomes the owner's. The root is the conversation
   * most others point at with `memoryOf` (Workbot's main chat), else the oldest one that has memory/ files. Its
   * memory/ files move to `owner_memory`, and it and every conversation sharing it switch to `memoryScope: "owner"`,
   * all in one transaction. Conversations sharing another one's memory keep a copy of it as their own. Idempotent.
   */
  adoptOwnerMemory(owner: string) {
    const key = `memory_adopted:${owner}`
    if (this.meta(key) !== null) return
    this.atomic(() => {
      if (this.meta(key) !== null) return
      const sessions = this.db
        .prepare("SELECT id, options, created_at FROM sessions WHERE owner = ? ORDER BY created_at, rowid")
        .all(owner)
        .map((row) => {
          const value = sessionOptionsRow.parse(row)
          let parsed: unknown = {}
          try {
            parsed = value.options ? JSON.parse(value.options) : {}
          } catch {
            parsed = {}
          }
          const options = optionsShape.safeParse(parsed)
          return { id: value.id, options: options.success ? options.data : {} }
        })
      const ids = new Set(sessions.map((session) => session.id))
      const referrers = new Map<string, number>()
      for (const session of sessions) {
        const target = session.options.memoryOf
        if (!session.options.memoryScope && target && ids.has(target)) referrers.set(target, (referrers.get(target) ?? 0) + 1)
      }
      let root: string | null = null
      for (const [id, count] of referrers) if (root === null || count > (referrers.get(root) ?? 0)) root = id
      if (root === null) {
        const withMemory = this.db
          .prepare("SELECT session_id FROM files WHERE path LIKE 'memory/%' AND session_id IN (SELECT id FROM sessions WHERE owner = ?) GROUP BY session_id")
          .all(owner)
          .map((row) => z.object({ session_id: z.string() }).parse(row).session_id)
        root = sessions.find((session) => withMemory.includes(session.id) && !session.options.memoryScope)?.id ?? null
      }
      const at = this.now()
      if (root !== null) {
        for (const file of this.memoryFilesOf(root)) {
          this.db
            .prepare("INSERT OR IGNORE INTO owner_memory (owner, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(owner, file.path, file.content, Buffer.byteLength(file.content), at)
        }
        this.db.prepare("DELETE FROM files WHERE session_id = ? AND path LIKE 'memory/%'").run(root)
      }
      for (const session of sessions) {
        const target = session.options.memoryOf
        if (session.options.memoryScope) continue
        if (session.id === root || (target && target === root)) {
          const { memoryOf: _memoryOf, ...rest } = session.options
          this.setOptions(session.id, { ...rest, memoryScope: "owner" })
        } else if (target && ids.has(target)) {
          // Shared another conversation's memory, which is not the owner's: keeps a copy as its own.
          for (const file of this.memoryFilesOf(target)) {
            this.db
              .prepare("INSERT OR IGNORE INTO files (session_id, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)")
              .run(session.id, file.path, file.content, Buffer.byteLength(file.content), at)
          }
          const { memoryOf: _memoryOf, ...rest } = session.options
          this.setOptions(session.id, rest)
        }
      }
      this.setMeta(key, String(at))
    })
  }

  private memoryFilesOf(sessionId: string): MemoryFile[] {
    return this.db.prepare("SELECT path, content FROM files WHERE session_id = ? AND path LIKE 'memory/%' ORDER BY path").all(sessionId).map((row) => memoryRow.parse(row))
  }

  private setOptions(sessionId: string, options: Record<string, unknown>) {
    this.db.prepare("UPDATE sessions SET options = ? WHERE id = ?").run(Object.keys(options).length ? JSON.stringify(options) : null, sessionId)
  }

  // ------------------------------------------------------------------ owner directory (owner cell)

  /** Applies a session cell's entry unless a newer one is already here; a deleted chat leaves a tombstone. */
  upsertDirectory(owner: string, sessionId: string, version: number, entry: DirectoryEntry) {
    this.atomic(() => {
      this.db
        .prepare(
          `INSERT INTO owner_directory (session_id, owner, title, ref, created_at, updated_at, has_turns, deleted, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id) DO UPDATE SET title = excluded.title, ref = excluded.ref, created_at = excluded.created_at,
             updated_at = excluded.updated_at, has_turns = excluded.has_turns, deleted = excluded.deleted, version = excluded.version
           WHERE excluded.version > owner_directory.version AND owner_directory.owner = excluded.owner`,
        )
        .run(sessionId, owner, entry.title, entry.ref, entry.createdAt, entry.updatedAt, entry.hasTurns ? 1 : 0, entry.deleted ? 1 : 0, version)
      // A deleted chat's legacy id no longer forwards: it is simply unknown, as any deleted chat.
      if (entry.deleted) this.db.prepare("DELETE FROM session_forwards WHERE session_id = ? AND owner = ?").run(sessionId, owner)
    })
  }

  /** One owner's chats in session cells that have a message, most recently used first (as Store.listSessions). */
  directorySessions(owner: string, limit: number): ListedSession[] {
    return this.db
      .prepare("SELECT session_id, ref, title, created_at, updated_at FROM owner_directory WHERE owner = ? AND deleted = 0 AND has_turns = 1 ORDER BY updated_at DESC LIMIT ?")
      .all(owner, limit)
      .map((row) => {
        const value = directoryRow.parse(row)
        return { id: value.session_id, ref: value.ref, title: value.title, createdAt: value.created_at, updatedAt: value.updated_at }
      })
  }

  directoryHas(owner: string, sessionId: string): boolean {
    return this.db.prepare("SELECT 1 AS n FROM owner_directory WHERE owner = ? AND session_id = ? AND deleted = 0").get(owner, sessionId) !== undefined
  }

  // ------------------------------------------------------------------ forwarding rows (owner cell)

  /** The cell a moved legacy chat now lives in, or null. */
  forwardOf(sessionId: string): { owner: string; cell: string } | null {
    const row = this.db.prepare("SELECT owner, cell FROM session_forwards WHERE session_id = ?").get(sessionId)
    return row ? z.object({ owner: z.string(), cell: z.string() }).parse(row) : null
  }

  // ------------------------------------------------------------------ directory outbox (session cell)

  /** The chat's directory entry as it is now; null when it doesn't exist (yet, or any more). */
  currentEntry(sessionId: string): DirectoryEntry | null {
    const row = this.db
      .prepare("SELECT title, ref, created_at, updated_at, EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.id) AS has_turns FROM sessions WHERE id = ?")
      .get(sessionId)
    if (!row) return null
    const value = z.object({ title: z.string(), ref: z.string().nullable().optional(), created_at: z.number(), updated_at: z.number(), has_turns: z.number() }).parse(row)
    return { title: value.title, ref: value.ref ?? null, createdAt: value.created_at, updatedAt: value.updated_at, hasTurns: value.has_turns === 1, deleted: false }
  }

  /**
   * Queues the chat's current entry for its owner cell when it changed since the last one queued: a new version,
   * due now. A chat that existed and is gone is queued as deleted. Returns the version due, or null when unchanged.
   */
  refreshDirectory(sessionId: string, owner: string): number | null {
    if (this.meta("import") === "copying") return null
    const row = this.outbox(sessionId)
    const current = this.currentEntry(sessionId)
    let entry: DirectoryEntry
    if (current) entry = current
    else if (row) {
      const previous = directoryEntry.safeParse(JSON.parse(row.entry))
      if (!previous.success || previous.data.deleted) return null
      // A deleted chat's tombstone keeps no title, here or in the owner's directory.
      entry = { ...previous.data, title: "", ref: null, deleted: true, updatedAt: this.now() }
    } else return null
    const serialized = JSON.stringify(entry)
    if (row && row.entry === serialized) return null
    const version = (row?.version ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO directory_outbox (session_id, owner, version, entry, acked, attempt, next_attempt_at) VALUES (?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT (session_id) DO UPDATE SET owner = excluded.owner, version = excluded.version, entry = excluded.entry, attempt = 0, next_attempt_at = excluded.next_attempt_at`,
      )
      .run(sessionId, owner, version, serialized, this.now())
    return version
  }

  /** Records `entry` as already known to the owner cell (it wrote it itself, moving the chat here). */
  seedDirectory(sessionId: string, owner: string, entry: DirectoryEntry, version: number) {
    this.db
      .prepare(
        `INSERT INTO directory_outbox (session_id, owner, version, entry, acked, attempt, next_attempt_at) VALUES (?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT (session_id) DO UPDATE SET owner = excluded.owner, version = excluded.version, entry = excluded.entry, acked = excluded.acked, attempt = 0`,
      )
      .run(sessionId, owner, version, JSON.stringify(entry), version)
  }

  private outbox(sessionId: string) {
    const row = this.db.prepare("SELECT * FROM directory_outbox WHERE session_id = ?").get(sessionId)
    return row ? outboxRow.parse(row) : null
  }

  /** The entry to send, when one is waiting and due (or `now` omitted: whenever due). */
  pendingDirectory(): { sessionId: string; owner: string; version: number; entry: DirectoryEntry; dueAt: number } | null {
    const row = this.db.prepare("SELECT * FROM directory_outbox WHERE acked < version ORDER BY next_attempt_at LIMIT 1").get()
    if (!row) return null
    const value = outboxRow.parse(row)
    const entry = directoryEntry.safeParse(JSON.parse(value.entry))
    if (!entry.success) return null
    return { sessionId: value.session_id, owner: value.owner, version: value.version, entry: entry.data, dueAt: value.next_attempt_at }
  }

  ackDirectory(sessionId: string, version: number) {
    this.db.prepare("UPDATE directory_outbox SET acked = ?, attempt = 0 WHERE session_id = ? AND version >= ? AND acked < ?").run(version, sessionId, version, version)
  }

  /** Counts a failed send and makes it due again after the backoff; returns the attempt number. */
  deferDirectory(sessionId: string, version: number): number {
    const row = this.outbox(sessionId)
    if (!row || row.version !== version) return 0
    const attempt = row.attempt + 1
    this.db.prepare("UPDATE directory_outbox SET attempt = ?, next_attempt_at = ? WHERE session_id = ? AND version = ?").run(attempt, this.now() + retryDelay(attempt), sessionId, version)
    return attempt
  }

  // ------------------------------------------------------------------ owner split (owner cell, session cell)

  /** Every table holding one conversation's rows (by `session_id`), plus `sessions`, sessions first. */
  sessionTables(): string[] {
    const names = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
      .all()
      .map((row) => nameRow.parse(row).name)
      // The runner's own tables only: never the host's (`_cf_…`, `_litestream_…`), which celld refuses to describe.
      .filter((name) => TABLE.test(name) && !CELLS_TABLES.has(name) && name !== "sessions")
      .filter((name) => this.columns(name).has("session_id"))
    return ["sessions", ...names]
  }

  /** What a move copies: everything of the conversation but its pending index update. */
  copyTables(): string[] {
    return this.sessionTables().filter((name) => !NOT_COPIED.has(name))
  }

  columns(table: string): Set<string> {
    if (!COLUMN.test(table)) return new Set()
    return new Set(z.array(z.object({ name: z.string() }).loose()).parse(this.db.prepare(`PRAGMA table_info(${table})`).all()).map((column) => column.name))
  }

  private keyColumn(table: string) {
    return table === "sessions" ? "id" : "session_id"
  }

  /** One page of a conversation's rows in one table, in insertion order, each without its rowid. */
  exportPage(table: string, sessionId: string, afterRowid: number, maxBytes: number): { rows: CellRow[]; lastRowid: number; done: boolean } {
    if (!COLUMN.test(table)) throw new Error("invalid_table")
    const rows: CellRow[] = []
    let bytes = 0
    let lastRowid = afterRowid
    for (;;) {
      const page = this.db
        .prepare(`SELECT rowid AS cells_rowid, * FROM ${table} WHERE ${this.keyColumn(table)} = ? AND rowid > ? ORDER BY rowid LIMIT 64`)
        .all(sessionId, lastRowid)
      for (const raw of page) {
        const { cells_rowid: rowid, ...rest } = cellRow.parse(raw)
        const size = JSON.stringify(rest).length
        if (rows.length > 0 && bytes + size > maxBytes) return { rows, lastRowid, done: false }
        rows.push(rest)
        bytes += size
        lastRowid = Number(rowid)
      }
      if (page.length < 64) return { rows, lastRowid, done: true }
    }
  }

  /**
   * SHA-256 over the conversation's content and state, table by table in insertion order, each row's columns sorted
   * by name (rowids left out): equal on both cells exactly when the copy is lossless, and different after any change
   * to the conversation. The storage engine's bookkeeping (BOOKKEEPING_TABLES, BOOKKEEPING_COLUMNS, the index outbox,
   * pending object deletions) is left out: background work changes it without changing the conversation.
   */
  fingerprint(sessionId: string): string {
    const hash = createHash("sha256")
    for (const table of this.copyTables().filter((name) => !BOOKKEEPING_TABLES.has(name))) {
      let after = 0
      let rows = 0
      for (;;) {
        const page = this.db
          .prepare(`SELECT rowid AS cells_rowid, * FROM ${table} WHERE ${this.keyColumn(table)} = ? AND rowid > ? ORDER BY rowid LIMIT 256`)
          .all(sessionId, after)
        for (const raw of page) {
          const { cells_rowid: rowid, ...rest } = cellRow.parse(raw)
          after = Number(rowid)
          rows += 1
          const content = Object.entries(rest).filter(([name, value]) => value !== null && !(table === "sessions" && BOOKKEEPING_COLUMNS.has(name)))
          hash.update(JSON.stringify(content.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))))
          hash.update("\n")
        }
        if (page.length < 256) break
      }
      // Empty tables count too, so a table missing on one side changes nothing only when it holds no rows.
      if (rows > 0) hash.update(`#${table}:${rows}\n`)
    }
    return hash.digest("hex")
  }

  /** Inserts copied rows into one table; columns must exist here (a newer runner's rows fail). */
  importRows(table: string, rows: CellRow[]) {
    if (!this.copyTables().includes(table)) throw new Error(`unknown_table:${table}`)
    const known = this.columns(table)
    this.atomic(() => {
      for (const row of rows) {
        const names = Object.keys(row)
        if (!names.length || names.some((name) => !COLUMN.test(name) || !known.has(name))) throw new Error(`unknown_column:${table}`)
        this.db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name): SqlValue => row[name] ?? null))
      }
    })
  }

  /**
   * Deletes a conversation's rows only, never its objects (segments, large bodies, saved files' bytes): after a move
   * the other cell references the same objects.
   */
  deleteSessionRows(sessionId: string) {
    this.atomic(() => {
      for (const table of this.sessionTables().filter((name) => name !== "sessions")) this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
    })
  }

  /**
   * A conversation that must not move now: a turn queued or running (a task too), a step scheduled, or a turn waiting
   * for the runner to resume it with its grant.
   */
  busy(sessionId: string): boolean {
    const active = this.db.prepare("SELECT 1 AS n FROM turns WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1").get(sessionId)
    if (active) return true
    if (this.db.prepare("SELECT 1 AS n FROM step_schedule WHERE session_id = ? LIMIT 1").get(sessionId)) return true
    return this.columns("turns").has("resume_grant") && this.db.prepare("SELECT 1 AS n FROM turns WHERE session_id = ? AND status = 'interrupted' AND resume_grant IS NOT NULL LIMIT 1").get(sessionId) !== undefined
  }

  /** The owner's legacy conversations still in this cell, most recently used first. */
  legacySessions(owner: string): string[] {
    return this.db
      .prepare("SELECT id FROM sessions WHERE owner = ? ORDER BY updated_at DESC, rowid DESC")
      .all(owner)
      .map((row) => z.object({ id: z.string() }).parse(row).id)
  }

  progress(sessionId: string) {
    const row = this.db.prepare("SELECT session_id, state, attempt, next_attempt_at FROM split_progress WHERE session_id = ?").get(sessionId)
    return row ? progressRow.parse(row) : null
  }

  /** The earliest time a waiting conversation may be tried again. */
  nextProgressAt(): number | null {
    const row = this.db.prepare("SELECT MIN(next_attempt_at) AS n FROM split_progress").get()
    return z.object({ n: z.number().nullable() }).parse(row).n
  }

  /** Counts an attempt to move a conversation before it starts, so a crash loop still backs off. */
  startProgress(sessionId: string, state: string): number {
    const attempt = (this.progress(sessionId)?.attempt ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO split_progress (session_id, state, attempt, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, attempt = excluded.attempt, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
      )
      .run(sessionId, state, attempt, this.now() + retryDelay(attempt + 1), this.now())
    return attempt
  }

  /** A busy or failed conversation is tried again later. */
  deferProgress(sessionId: string, state: string, at: number) {
    this.db
      .prepare(
        `INSERT INTO split_progress (session_id, state, attempt, next_attempt_at, updated_at) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
      )
      .run(sessionId, state, at, this.now())
  }

  /**
   * The move's last step, in one transaction: the forwarding row, the directory row, and the conversation's rows
   * leave this cell. Only after the session cell confirmed a copy with this exact fingerprint.
   */
  finishMove(input: { sessionId: string; owner: string; cell: string; entry: DirectoryEntry; version: number }) {
    this.atomic(() => {
      // The bookkeeping as it is now, handed to the session cell next (sendHandoff); it leaves this cell with the rows.
      const handoff = this.handoffOf(input.sessionId)
      this.db.prepare("INSERT OR REPLACE INTO split_handoff (session_id, payload, attempt, next_attempt_at) VALUES (?, ?, 0, 0)").run(input.sessionId, JSON.stringify(handoff))
      for (const deletion of handoff.deletions) this.db.prepare("DELETE FROM storage_deletions WHERE key = ?").run(deletion.key)
      this.db.prepare("INSERT OR REPLACE INTO session_forwards (session_id, owner, cell, moved_at) VALUES (?, ?, ?, ?)").run(input.sessionId, input.owner, input.cell, this.now())
      this.upsertDirectory(input.owner, input.sessionId, input.version, input.entry)
      this.deleteSessionRows(input.sessionId)
      this.db.prepare("DELETE FROM split_progress WHERE session_id = ?").run(input.sessionId)
    })
  }

  /** A chat's storage bookkeeping here (see Handoff). */
  handoffOf(sessionId: string): Handoff {
    const session = this.columns("sessions").has("index_version")
      ? z.object({ index_version: z.number().nullable(), index_capability: z.string().nullable() }).safeParse(this.db.prepare("SELECT index_version, index_capability FROM sessions WHERE id = ?").get(sessionId))
      : null
    const outbox = this.hasTable("index_outbox")
      ? z.object({ version: z.number(), capability: z.string().nullable() }).safeParse(this.db.prepare("SELECT version, capability FROM index_outbox WHERE session_id = ?").get(sessionId))
      : null
    const prefix = `sessions/${sessionId}/`
    const deletions = this.hasTable("storage_deletions")
      ? this.db
          .prepare("SELECT key, kind, due_at, attempt FROM storage_deletions WHERE substr(key, 1, ?) = ?")
          .all(prefix.length, prefix)
          .map((row) => z.object({ key: z.string(), kind: z.string(), due_at: z.number(), attempt: z.number() }).parse(row))
      : []
    return {
      indexVersion: Math.max(session?.success ? session.data.index_version ?? 0 : 0, outbox?.success ? outbox.data.version : 0),
      capability: (session?.success ? session.data.index_capability : null) ?? (outbox?.success ? outbox.data.capability : null),
      deletions,
    }
  }

  private hasTable(table: string) {
    return this.columns(table).size > 0
  }

  /** A moved chat whose bookkeeping its session cell hasn't taken yet, when one is due. */
  pendingHandoff(): { sessionId: string; handoff: Handoff; dueAt: number } | null {
    const row = this.db.prepare("SELECT session_id, payload, next_attempt_at FROM split_handoff ORDER BY next_attempt_at LIMIT 1").get()
    if (!row) return null
    const value = z.object({ session_id: z.string(), payload: z.string(), next_attempt_at: z.number() }).parse(row)
    const handoff = handoffSchema.safeParse(JSON.parse(value.payload))
    if (!handoff.success) {
      this.db.prepare("DELETE FROM split_handoff WHERE session_id = ?").run(value.session_id)
      return null
    }
    return { sessionId: value.session_id, handoff: handoff.data, dueAt: value.next_attempt_at }
  }

  handoffDone(sessionId: string) {
    this.db.prepare("DELETE FROM split_handoff WHERE session_id = ?").run(sessionId)
  }

  /** Counts a failed handoff and makes it due again after the backoff; returns the attempt number. */
  deferHandoff(sessionId: string): number {
    const row = z.object({ attempt: z.number() }).safeParse(this.db.prepare("SELECT attempt FROM split_handoff WHERE session_id = ?").get(sessionId))
    const attempt = (row.success ? row.data.attempt : 0) + 1
    this.db.prepare("UPDATE split_handoff SET attempt = ?, next_attempt_at = ? WHERE session_id = ?").run(attempt, this.now() + retryDelay(attempt), sessionId)
    return attempt
  }

  /**
   * In the session cell: takes the owner cell's bookkeeping. The index version never goes below what the owner cell
   * reached, the newest capability is kept, the pending object deletions are queued here, the hot bytes are counted
   * again, and a fresh index snapshot is queued (numbered above all of it).
   */
  applyHandoff(sessionId: string, handoff: Handoff, enqueueIndexUpdate: () => void, countHotBytes: () => void) {
    this.atomic(() => {
      if (this.columns("sessions").has("index_version")) {
        this.db
          .prepare("UPDATE sessions SET index_version = MAX(COALESCE(index_version, 0), ?), index_capability = COALESCE(?, index_capability) WHERE id = ?")
          .run(handoff.indexVersion, handoff.capability, sessionId)
      }
      if (this.hasTable("storage_deletions")) {
        for (const deletion of handoff.deletions) {
          this.db.prepare("INSERT OR IGNORE INTO storage_deletions (key, kind, due_at, attempt) VALUES (?, ?, ?, ?)").run(deletion.key, deletion.kind, deletion.due_at, deletion.attempt)
        }
      }
      if (this.db.prepare("SELECT 1 AS n FROM sessions WHERE id = ?").get(sessionId)) {
        countHotBytes()
        enqueueIndexUpdate()
      }
      this.setMeta("index_hold", null)
    })
  }
}
