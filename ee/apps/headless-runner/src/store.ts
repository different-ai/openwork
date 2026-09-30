import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { Usage } from "./model.js"
import { ACTIVE, messageSchema, turnStatusSchema, type Message, type TurnStatus } from "./types.js"

const sessionRow = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
})
const turnRow = z.object({
  session_id: z.string(),
  message_id: z.string(),
  status: turnStatusSchema,
  model: z.string().nullable(),
  error: z.string().nullable(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
})
const messageRow = z.object({ seq: z.number(), message_id: z.string(), body: z.string() })
const fileRow = z.object({ path: z.string(), size: z.number(), updated_at: z.number() })
const countRow = z.object({ n: z.number() })

export type Session = { id: string; title: string; instructions: string; createdAt: number; updatedAt: number }
export type Turn = {
  sessionId: string
  messageId: string
  status: TurnStatus
  model: string | null
  error: string | null
  usage: Usage
  createdAt: number
  updatedAt: number
}
export type StoredMessage = { seq: number; messageId: string; message: Message }
export type FileEntry = { path: string; size: number; updatedAt: number }

function toTurn(row: unknown): Turn {
  const value = turnRow.parse(row)
  return {
    sessionId: value.session_id,
    messageId: value.message_id,
    status: value.status,
    model: value.model,
    error: value.error,
    usage: { inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens, outputTokens: value.output_tokens },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

/**
 * Durable state in one SQLite file (WAL mode). Every transcript step is written
 * before the next one starts, so a crash loses at most the in-flight step.
 */
export class Store {
  readonly db: DatabaseSync

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        error TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS files (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, path)
      );
    `)
  }

  close() {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = fn()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  createSession(input: { title?: string; instructions?: string }): Session {
    const at = this.now()
    const session = {
      id: `hs_${randomUUID().replaceAll("-", "")}`,
      title: input.title ?? "Untitled",
      instructions: input.instructions ?? "",
      createdAt: at,
      updatedAt: at,
    }
    this.db
      .prepare("INSERT INTO sessions (id, title, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(session.id, session.title, session.instructions, at, at)
    return session
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
    if (!row) return null
    const value = sessionRow.parse(row)
    return {
      id: value.id,
      title: value.title,
      instructions: value.instructions,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }

  deleteSession(id: string) {
    return Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes) > 0
  }

  getTurn(sessionId: string, messageId: string): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE session_id = ? AND message_id = ?").get(sessionId, messageId)
    return row ? toTurn(row) : null
  }

  listTurns(sessionId: string): Turn[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId)
      .map(toTurn)
  }

  activeTurn(sessionId: string): Turn | null {
    return this.listTurns(sessionId).find((turn) => ACTIVE.has(turn.status)) ?? null
  }

  /** Inserts the turn and its user message atomically. */
  admitTurn(input: { sessionId: string; messageId: string; prompt: string; model: string | null }): Turn {
    const at = this.now()
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO turns (session_id, message_id, status, model, error, created_at, updated_at) VALUES (?, ?, 'queued', ?, NULL, ?, ?)",
        )
        .run(input.sessionId, input.messageId, input.model, at, at)
      this.appendMessage(input.sessionId, input.messageId, { role: "user", text: input.prompt })
    })
    const turn = this.getTurn(input.sessionId, input.messageId)
    if (!turn) throw new Error("turn_admission_failed")
    return turn
  }

  setTurnStatus(sessionId: string, messageId: string, status: TurnStatus, error: string | null = null) {
    const at = this.now()
    this.db
      .prepare("UPDATE turns SET status = ?, error = ?, updated_at = ? WHERE session_id = ? AND message_id = ?")
      .run(status, error, at, sessionId, messageId)
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, sessionId)
  }

  addUsage(sessionId: string, messageId: string, usage: Usage) {
    this.db
      .prepare(
        `UPDATE turns SET input_tokens = input_tokens + ?, cached_input_tokens = cached_input_tokens + ?,
         output_tokens = output_tokens + ? WHERE session_id = ? AND message_id = ?`,
      )
      .run(usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, sessionId, messageId)
  }

  /** Marks every turn a previous process left queued or running as interrupted. */
  recoverInterruptedTurns() {
    const result = this.db
      .prepare(
        "UPDATE turns SET status = 'interrupted', error = 'runner_restarted', updated_at = ? WHERE status IN ('queued', 'running')",
      )
      .run(this.now())
    return Number(result.changes)
  }

  appendMessage(sessionId: string, messageId: string, message: Message) {
    const row = countRow.parse(
      this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE session_id = ?").get(sessionId),
    )
    this.db
      .prepare("INSERT INTO messages (session_id, seq, message_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, row.n + 1, messageId, JSON.stringify(messageSchema.parse(message)), this.now())
  }

  messages(sessionId: string): StoredMessage[] {
    return this.db
      .prepare("SELECT seq, message_id, body FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId)
      .map((row) => {
        const value = messageRow.parse(row)
        return { seq: value.seq, messageId: value.message_id, message: messageSchema.parse(JSON.parse(value.body)) }
      })
  }

  listFiles(sessionId: string): FileEntry[] {
    return this.db
      .prepare("SELECT path, size, updated_at FROM files WHERE session_id = ? ORDER BY path")
      .all(sessionId)
      .map((row) => {
        const value = fileRow.parse(row)
        return { path: value.path, size: value.size, updatedAt: value.updated_at }
      })
  }

  readFile(sessionId: string, path: string): string | null {
    const row = this.db.prepare("SELECT content FROM files WHERE session_id = ? AND path = ?").get(sessionId, path)
    return row ? z.object({ content: z.string() }).parse(row).content : null
  }

  writeFile(sessionId: string, path: string, content: string) {
    this.db
      .prepare(
        `INSERT INTO files (session_id, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, path) DO UPDATE SET content = excluded.content, size = excluded.size, updated_at = excluded.updated_at`,
      )
      .run(sessionId, path, content, Buffer.byteLength(content), this.now())
  }

  deleteFile(sessionId: string, path: string) {
    return Number(this.db.prepare("DELETE FROM files WHERE session_id = ? AND path = ?").run(sessionId, path).changes) > 0
  }
}
