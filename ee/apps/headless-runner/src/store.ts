import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { Usage } from "./model.js"
import { withoutAttachments } from "./tool-files.js"
import {
  ACTIVE,
  attachmentSchema,
  messageSchema,
  repeatLimitsSchema,
  turnStatusSchema,
  type Attachment,
  type Message,
  type RepeatLimits,
  type TurnStatus,
} from "./types.js"

const sessionRow = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  /** JSON of the caller's per-session settings; null for sessions created before there were any. */
  options: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
})
const sessionOptions = z.object({
  repeats: repeatLimitsSchema.optional(),
  files: z.boolean().optional(),
  computer: z.boolean().optional(),
  reactions: z.boolean().optional(),
  tasks: z.boolean().optional(),
  timeZone: z.string().optional(),
  autoTitle: z.boolean().optional(),
  memoryOf: z.string().optional(),
})
type SessionOptions = z.infer<typeof sessionOptions>
const tableColumns = z.array(z.object({ name: z.string() }).loose())
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
  kind: z.enum(["task", "report"]).nullable().optional(),
  parent: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  error_detail: z.string().nullable().optional(),
})
const messageRow = z.object({ seq: z.number(), message_id: z.string(), body: z.string(), created_at: z.number().optional() })
const fileRow = z.object({ path: z.string(), size: z.number(), updated_at: z.number() })
const countRow = z.object({ n: z.number() })

export type Session = {
  id: string
  title: string
  instructions: string
  /** The caller's limits for repeated steps; null uses the runner's defaults. */
  repeats: RepeatLimits | null
  /**
   * Whether this conversation keeps files (uploads, files the agent hands back) and has a computer. Both are off
   * unless the caller asks for them, so turning a capability on for the runner changes nothing for callers that
   * never asked (Slack replies and Automations keep their exact behavior). The runner must also be configured
   * for them; a conversation asking for a capability the runner lacks simply doesn't get it.
   */
  files: boolean
  computer: boolean
  /** Whether the model may react to the person's message with an emoji (the caller shows it). */
  reactions: boolean
  /** Whether the conversation may hand work to background tasks (start_task) and keep talking meanwhile. */
  tasks: boolean
  /**
   * Who the conversation belongs to, in the caller's own terms (for example one person in one organization), and
   * the caller's id for it. A caller with several conversations per person lists them by owner (GET /v1/sessions).
   */
  owner: string | null
  ref: string | null
  /** The person's IANA time zone: their messages are shown to the model with the time they sent them, in it. */
  timeZone: string | null
  /** Name the conversation after its first answer, while its title is empty. */
  autoTitle: boolean
  /** Another conversation of the same person whose memory/ this one reads and writes, so they remember together. */
  memoryOf: string | null
  createdAt: number
  updatedAt: number
}
/** What a caller may set on a session: its text, who it belongs to, and its settings (stored together as JSON). */
export type SessionInput = {
  title?: string
  instructions?: string
  repeats?: RepeatLimits
  files?: boolean
  computer?: boolean
  reactions?: boolean
  tasks?: boolean
  owner?: string
  ref?: string
  timeZone?: string
  autoTitle?: boolean
  memoryOf?: string
}

/** The settings part of a session, leaving out what the caller didn't set. */
function optionsOf(input: {
  repeats?: RepeatLimits | null
  files?: boolean
  computer?: boolean
  reactions?: boolean
  tasks?: boolean
  timeZone?: string | null
  autoTitle?: boolean
  memoryOf?: string | null
}): SessionOptions {
  return {
    ...(input.repeats ? { repeats: input.repeats } : {}),
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(input.computer !== undefined ? { computer: input.computer } : {}),
    ...(input.reactions !== undefined ? { reactions: input.reactions } : {}),
    ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
    ...(input.memoryOf ? { memoryOf: input.memoryOf } : {}),
  }
}

/** A new conversation's title: the caller's, or none yet when it is to be named after its first answer. */
const initialTitle = (input: SessionInput) => input.title ?? (input.autoTitle ? "" : "Untitled")

/** Stable JSON for the options column (null when there is nothing to keep), so equal settings compare equal. */
function serializeOptions(options: SessionOptions) {
  const ordered = {
    ...(options.repeats ? { repeats: options.repeats } : {}),
    ...(options.files ? { files: true } : {}),
    ...(options.computer ? { computer: true } : {}),
    ...(options.reactions ? { reactions: true } : {}),
    ...(options.tasks ? { tasks: true } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(options.autoTitle ? { autoTitle: true } : {}),
    ...(options.memoryOf ? { memoryOf: options.memoryOf } : {}),
  }
  return Object.keys(ordered).length ? JSON.stringify(ordered) : null
}

export type Turn = {
  sessionId: string
  messageId: string
  status: TurnStatus
  model: string | null
  error: string | null
  /**
   * What the model provider said when the turn failed (its error message and request id), for logs and support.
   * Never shown to the person as is.
   */
  errorDetail?: string
  usage: Usage
  createdAt: number
  updatedAt: number
  /**
   * Set for turns the runner started itself: a background `task` (its own lane; `parent` is the turn that started
   * it, `title` its name) and the `report` that brings a finished task back to the conversation (`parent` is the
   * task). Turns a caller sends have none of these.
   */
  kind?: "task" | "report"
  parent?: string
  title?: string
}
export type StoredMessage = { seq: number; messageId: string; message: Message; createdAt?: number }
export type FileEntry = { path: string; size: number; updatedAt: number }

const savedFileRow = z.object({
  id: z.string(),
  session_id: z.string(),
  name: z.string(),
  media_type: z.string(),
  size: z.number(),
  source: z.enum(["user", "agent"]),
  storage_key: z.string(),
  created_at: z.number(),
  updated_at: z.number().nullable().optional(),
})

/** A file the person sent or the agent handed back; its bytes live in the blob store. */
export type SavedFile = {
  id: string
  sessionId: string
  name: string
  mediaType: string
  size: number
  source: "user" | "agent"
  createdAt: number
  /** When its bytes last changed: the agent revised it in place. Equal to createdAt for an unchanged file. */
  updatedAt: number
}

function toSavedFile(row: unknown): { file: SavedFile; storageKey: string } {
  const value = savedFileRow.parse(row)
  return {
    file: {
      id: value.id,
      sessionId: value.session_id,
      name: value.name,
      mediaType: value.media_type,
      size: value.size,
      source: value.source,
      createdAt: value.created_at,
      updatedAt: value.updated_at ?? value.created_at,
    },
    storageKey: value.storage_key,
  }
}

function parseMessageRow(row: unknown): StoredMessage {
  const value = messageRow.parse(row)
  return {
    seq: value.seq,
    messageId: value.message_id,
    message: messageSchema.parse(JSON.parse(value.body)),
    ...(value.created_at === undefined ? {} : { createdAt: value.created_at }),
  }
}

function toTurn(row: unknown): Turn {
  const value = turnRow.parse(row)
  return {
    sessionId: value.session_id,
    messageId: value.message_id,
    status: value.status,
    model: value.model,
    error: value.error,
    ...(value.error_detail ? { errorDetail: value.error_detail } : {}),
    usage: { inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens, outputTokens: value.output_tokens },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.parent ? { parent: value.parent } : {}),
    ...(value.title ? { title: value.title } : {}),
  }
}

/** Leaves out background tasks' own transcripts: the conversation hears from a task through its report. */
const CONVERSATION_ROWS = "message_id NOT IN (SELECT message_id FROM turns WHERE session_id = ? AND kind = 'task')"

/**
 * Durable state in one SQLite file (WAL mode). Every transcript step is written
 * before the next one starts, so a crash loses at most the in-flight step.
 */
export class Store {
  readonly db: DatabaseSync
  /** Called after every write to a turn or its transcript, so live readers can re-read. */
  onChange: ((sessionId: string, messageId: string, status?: TurnStatus) => void) | null = null

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
        prompt TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS messages_by_turn ON messages (session_id, message_id, seq);
      CREATE TABLE IF NOT EXISTS saved_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        source TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS saved_files_by_session ON saved_files (session_id, created_at);
    `)
    // Columns added after the first release; existing rows keep their defaults.
    const columnsOf = (table: string) => tableColumns.parse(this.db.prepare(`PRAGMA table_info(${table})`).all()).map((column) => column.name)
    // Per-session settings (repeat limits).
    if (!columnsOf("sessions").includes("options")) this.db.exec("ALTER TABLE sessions ADD COLUMN options TEXT")
    // The files a person sent with a turn.
    if (!columnsOf("turns").includes("attachments")) this.db.exec("ALTER TABLE turns ADD COLUMN attachments TEXT")
    // A saved file the agent revises keeps its id; this is when its bytes last changed.
    if (!columnsOf("saved_files").includes("updated_at")) this.db.exec("ALTER TABLE saved_files ADD COLUMN updated_at INTEGER")
    // Background tasks and their reports (see Turn.kind), and what the provider said when a turn failed.
    const turnColumns = columnsOf("turns")
    for (const column of ["kind", "parent", "title", "error_detail"]) {
      if (!turnColumns.includes(column)) this.db.exec(`ALTER TABLE turns ADD COLUMN ${column} TEXT`)
    }
    // Several conversations per person (Session.owner, .ref), and where a long conversation's context starts now
    // (see contextMessages).
    const sessionColumns = columnsOf("sessions")
    for (const column of ["owner", "ref"]) {
      if (!sessionColumns.includes(column)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`)
    }
    if (!sessionColumns.includes("context_from")) this.db.exec("ALTER TABLE sessions ADD COLUMN context_from INTEGER")
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_by_owner ON sessions (owner, updated_at)")
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

  createSession(input: SessionInput): Session {
    const at = this.now()
    const id = `hs_${randomUUID().replaceAll("-", "")}`
    this.db
      .prepare("INSERT INTO sessions (id, title, instructions, options, owner, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, initialTitle(input), input.instructions ?? "", serializeOptions(optionsOf(input)), input.owner ?? null, input.ref ?? null, at, at)
    const session = this.getSession(id)
    if (!session) throw new Error("session_missing_after_create")
    return session
  }

  /**
   * Creates the session under a caller-chosen id, or updates its title and
   * instructions when it already exists. Lets a caller keep one durable
   * conversation per person without storing the runner's id itself.
   */
  putSession(id: string, input: SessionInput): { session: Session; created: boolean } {
    const existing = this.getSession(id)
    const at = this.now()
    if (!existing) {
      this.db
        .prepare("INSERT INTO sessions (id, title, instructions, options, owner, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, initialTitle(input), input.instructions ?? "", serializeOptions(optionsOf(input)), input.owner ?? null, input.ref ?? null, at, at)
    } else {
      // Settings the caller leaves out keep their current value.
      const options = { ...optionsOf(existing), ...optionsOf(input) }
      const changed =
        (input.title !== undefined && input.title !== existing.title) ||
        (input.instructions !== undefined && input.instructions !== existing.instructions) ||
        (input.owner !== undefined && input.owner !== existing.owner) ||
        (input.ref !== undefined && input.ref !== existing.ref) ||
        serializeOptions(options) !== serializeOptions(optionsOf(existing))
      if (changed) {
        this.db
          .prepare("UPDATE sessions SET title = ?, instructions = ?, options = ?, owner = ?, ref = ?, updated_at = ? WHERE id = ?")
          .run(
            input.title ?? existing.title,
            input.instructions ?? existing.instructions,
            serializeOptions(options),
            input.owner ?? existing.owner,
            input.ref ?? existing.ref,
            at,
            id,
          )
      }
    }
    const session = this.getSession(id)
    if (!session) throw new Error("session_missing_after_put")
    return { session, created: !existing }
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
    if (!row) return null
    const value = sessionRow.parse(row)
    const parsed = value.options ? sessionOptions.safeParse(JSON.parse(value.options)) : null
    const options: SessionOptions = parsed?.success ? parsed.data : {}
    return {
      id: value.id,
      title: value.title,
      instructions: value.instructions,
      repeats: options.repeats ?? null,
      files: options.files ?? false,
      computer: options.computer ?? false,
      reactions: options.reactions ?? false,
      tasks: options.tasks ?? false,
      owner: value.owner ?? null,
      ref: value.ref ?? null,
      timeZone: options.timeZone ?? null,
      autoTitle: options.autoTitle ?? false,
      memoryOf: options.memoryOf ?? null,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }

  /**
   * One owner's conversations that have at least one message, most recently active first. `updatedAt` moves when a
   * turn changes, so it is when the conversation was last used.
   */
  listSessions(owner: string, limit: number): Array<{ id: string; ref: string | null; title: string; createdAt: number; updatedAt: number }> {
    return this.db
      .prepare(
        `SELECT id, ref, title, created_at, updated_at FROM sessions
         WHERE owner = ? AND EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.id)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(owner, limit)
      .map((row) => {
        const value = z.object({ id: z.string(), ref: z.string().nullable(), title: z.string(), created_at: z.number(), updated_at: z.number() }).parse(row)
        return { id: value.id, ref: value.ref, title: value.title, createdAt: value.created_at, updatedAt: value.updated_at }
      })
  }

  /** Names a conversation without counting as activity: the list order stays when it was last used. */
  setTitle(id: string, title: string) {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id)
  }

  /**
   * Where the model's view of a long conversation starts (a message seq at the start of a turn), or null while it
   * still sees the whole conversation. It only moves forward, in big steps (see buildContext), so the start of the
   * context stays the same for many turns and the model provider's prompt cache keeps hitting.
   */
  contextFrom(id: string): number | null {
    const row = this.db.prepare("SELECT context_from FROM sessions WHERE id = ?").get(id)
    return row ? z.object({ context_from: z.number().nullable() }).parse(row).context_from : null
  }

  setContextFrom(id: string, seq: number) {
    this.db.prepare("UPDATE sessions SET context_from = ? WHERE id = ?").run(seq, id)
  }

  deleteSession(id: string) {
    return Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes) > 0
  }

  /**
   * Removes a message from the conversation with everything it led to: its transcript, the background tasks it
   * started and their reports. With `andAfter`, every message sent after it goes too (editing a message replays the
   * conversation from there). Returns the removed message ids; null when one of them is still queued or running,
   * so nothing is removed from under a live answer.
   */
  deleteTurns(sessionId: string, messageId: string, options: { andAfter?: boolean } = {}): string[] | null {
    const turns = this.listTurns(sessionId)
    const rootOf = (id: string) => id.split(".")[0] ?? id
    const index = turns.findIndex((turn) => turn.messageId === messageId)
    if (index === -1) return []
    // The conversation's own messages from here on; tasks and reports go with the message that started them.
    const roots = new Set(
      options.andAfter ? turns.slice(index).filter((turn) => turn.kind === undefined).map((turn) => turn.messageId) : [rootOf(messageId)],
    )
    const removed = turns.filter((turn) => roots.has(rootOf(turn.messageId)))
    if (removed.some((turn) => ACTIVE.has(turn.status))) return null
    const ids = removed.map((turn) => turn.messageId)
    this.transaction(() => {
      const deleteMessages = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND message_id = ?")
      const deleteTurn = this.db.prepare("DELETE FROM turns WHERE session_id = ? AND message_id = ?")
      for (const id of ids) {
        deleteMessages.run(sessionId, id)
        deleteTurn.run(sessionId, id)
      }
    })
    for (const id of ids) this.onChange?.(sessionId, id)
    return ids
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

  /** The first queued or running turn; with `conversation`, background tasks don't count. */
  activeTurn(sessionId: string, options: { conversation?: boolean } = {}): Turn | null {
    const row = this.db
      .prepare(
        `SELECT * FROM turns WHERE session_id = ? AND status IN (${[...ACTIVE].map(() => "?").join(", ")})${options.conversation ? " AND kind IS NOT 'task'" : ""} ORDER BY rowid LIMIT 1`,
      )
      .get(sessionId, ...ACTIVE)
    return row ? toTurn(row) : null
  }

  /** The session's newest background tasks, oldest first. */
  recentTasks(sessionId: string, limit: number): Turn[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND kind = 'task' ORDER BY rowid DESC LIMIT ?")
      .all(sessionId, limit)
      .map(toTurn)
      .reverse()
  }

  /** Tasks that haven't finished: waiting, running, or paused to be resumed. */
  openTaskCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND kind = 'task' AND status IN ('queued', 'running', 'interrupted')")
      .get(sessionId)
    return countRow.parse(row).n
  }

  /** How many tasks a turn has started. */
  taskCount(sessionId: string, parent: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND kind = 'task' AND parent = ?").get(sessionId, parent)
    return countRow.parse(row).n
  }

  /**
   * Records the turn and its prompt. The user message joins the transcript only
   * when the turn starts, so a follow-up queued behind a running turn is never
   * interleaved into that turn's transcript.
   */
  admitTurn(input: {
    sessionId: string
    messageId: string
    prompt: string
    model: string | null
    attachments?: Attachment[]
    kind?: "task" | "report"
    parent?: string
    title?: string
  }): Turn {
    const at = this.now()
    this.db
      .prepare(
        "INSERT INTO turns (session_id, message_id, status, prompt, model, error, attachments, kind, parent, title, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.sessionId,
        input.messageId,
        input.prompt,
        input.model,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        input.kind ?? null,
        input.parent ?? null,
        input.title ?? null,
        at,
        at,
      )
    const turn = this.getTurn(input.sessionId, input.messageId)
    if (!turn) throw new Error("turn_admission_failed")
    return turn
  }

  /** Appends the turn's user message the first time the turn starts. */
  startTranscript(sessionId: string, messageId: string) {
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT 1 AS n FROM messages WHERE session_id = ? AND message_id = ? LIMIT 1")
        .get(sessionId, messageId)
      if (existing) return
      const row = this.db.prepare("SELECT prompt, attachments FROM turns WHERE session_id = ? AND message_id = ?").get(sessionId, messageId)
      if (!row) throw new Error("unknown_turn")
      const value = z.object({ prompt: z.string(), attachments: z.string().nullable() }).parse(row)
      const attachments = value.attachments ? z.array(attachmentSchema).parse(JSON.parse(value.attachments)) : []
      this.appendMessage(sessionId, messageId, { role: "user", text: value.prompt, ...(attachments.length ? { attachments } : {}) })
    })
  }

  setTurnStatus(sessionId: string, messageId: string, status: TurnStatus, error: string | null = null, errorDetail: string | null = null) {
    const at = this.now()
    this.db
      .prepare("UPDATE turns SET status = ?, error = ?, error_detail = ?, updated_at = ? WHERE session_id = ? AND message_id = ?")
      .run(status, error, errorDetail, at, sessionId, messageId)
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, sessionId)
    this.onChange?.(sessionId, messageId, status)
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
    this.onChange?.(sessionId, messageId)
  }

  /** Replaces the image and PDF bytes in one turn's tool results with the note later turns see instead. */
  stripAttachments(sessionId: string, messageId: string) {
    const rows = this.db
      .prepare("SELECT seq, message_id, body FROM messages WHERE session_id = ? AND message_id = ? ORDER BY seq")
      .all(sessionId, messageId)
    const update = this.db.prepare("UPDATE messages SET body = ? WHERE session_id = ? AND seq = ?")
    this.transaction(() => {
      for (const row of rows) {
        const value = messageRow.parse(row)
        const message = messageSchema.parse(JSON.parse(value.body))
        const stripped = withoutAttachments(message)
        if (stripped !== message) update.run(JSON.stringify(messageSchema.parse(stripped)), sessionId, value.seq)
      }
    })
  }

  messages(sessionId: string): StoredMessage[] {
    return this.db
      .prepare("SELECT seq, message_id, body, created_at FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId)
      .map(parseMessageRow)
  }

  /** One turn's transcript, without reading the rest of the session. */
  turnMessages(sessionId: string, messageId: string): StoredMessage[] {
    return this.db
      .prepare("SELECT seq, message_id, body, created_at FROM messages WHERE session_id = ? AND message_id = ? ORDER BY seq")
      .all(sessionId, messageId)
      .map(parseMessageRow)
  }

  /**
   * The part of the transcript the model's context is built from, in whole turns: a turn is never split, since its
   * tool results would lose the calls they answer. Once the conversation has outgrown the context it starts at
   * `contextFrom`; until then rows are read newest first and reading stops, after finishing the turn being read,
   * once the older turns' estimated size passes the budget. Either way a step reads about one context's worth of
   * rows, however long the conversation gets. `partial` says the conversation goes back further than the rows.
   */
  contextMessages(sessionId: string, currentMessageId: string, budget: number): { rows: StoredMessage[]; partial: boolean } {
    const from = this.contextFrom(sessionId)
    if (from !== null) {
      const rows = this.db
        .prepare(`SELECT seq, message_id, body, created_at FROM messages WHERE session_id = ? AND seq >= ? AND ${CONVERSATION_ROWS} ORDER BY seq`)
        .all(sessionId, from, sessionId)
        .map(parseMessageRow)
      return { rows, partial: true }
    }
    const rows: StoredMessage[] = []
    let used = 0
    let seenCurrent = false
    let partial = false
    for (const row of this.db
      .prepare(`SELECT seq, message_id, body, created_at FROM messages WHERE session_id = ? AND ${CONVERSATION_ROWS} ORDER BY seq DESC`)
      .iterate(sessionId, sessionId)) {
      const entry = parseMessageRow(row)
      if (seenCurrent && used > budget && entry.messageId !== rows.at(-1)?.messageId) {
        partial = true
        break
      }
      rows.push(entry)
      if (entry.messageId === currentMessageId) {
        seenCurrent = true
        continue
      }
      // Earlier turns are compacted for the model (see buildContext); this estimate errs on the large side.
      used += entry.message.role === "tool" ? Math.min(entry.message.output.length, 1_000) + 200 : JSON.stringify(entry.message).length
    }
    return { rows: rows.reverse(), partial }
  }

  /** The newest `limit` turns, optionally only those before `beforeMessageId`, oldest first. */
  recentTurns(sessionId: string, limit: number, beforeMessageId?: string): { turns: Turn[]; hasEarlier: boolean } {
    const rows = beforeMessageId
      ? this.db
          .prepare(
            `SELECT * FROM turns WHERE session_id = ? AND rowid < (SELECT rowid FROM turns WHERE session_id = ? AND message_id = ?)
             ORDER BY rowid DESC LIMIT ?`,
          )
          .all(sessionId, sessionId, beforeMessageId, limit + 1)
      : this.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT ?").all(sessionId, limit + 1)
    const turns = rows.slice(0, limit).map(toTurn).reverse()
    return { turns, hasEarlier: rows.length > limit }
  }

  /** The transcript of the given turns only. */
  messagesForTurns(sessionId: string, messageIds: string[]): StoredMessage[] {
    if (messageIds.length === 0) return []
    return this.db
      .prepare(
        `SELECT seq, message_id, body, created_at FROM messages WHERE session_id = ? AND message_id IN (${messageIds.map(() => "?").join(", ")}) ORDER BY seq`,
      )
      .all(sessionId, ...messageIds)
      .map(parseMessageRow)
  }

  /** The files under memory/, which the model sees at the start of every turn. */
  memoryFiles(sessionId: string): Array<{ path: string; content: string }> {
    return this.db
      .prepare("SELECT path, content FROM files WHERE session_id = ? AND path LIKE 'memory/%' ORDER BY path")
      .all(sessionId)
      .map((row) => z.object({ path: z.string(), content: z.string() }).parse(row))
  }

  addSavedFile(file: SavedFile & { storageKey: string }) {
    this.db
      .prepare("INSERT INTO saved_files (id, session_id, name, media_type, size, source, storage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(file.id, file.sessionId, file.name, file.mediaType, file.size, file.source, file.storageKey, file.createdAt, file.updatedAt)
  }

  /** Records a new version of a saved file's bytes (same id, same storage key). */
  updateSavedFile(sessionId: string, id: string, change: { size: number; mediaType: string; updatedAt: number }) {
    this.db
      .prepare("UPDATE saved_files SET size = ?, media_type = ?, updated_at = ? WHERE session_id = ? AND id = ?")
      .run(change.size, change.mediaType, change.updatedAt, sessionId, id)
  }

  /** Newest first. */
  listSavedFiles(sessionId: string): SavedFile[] {
    return this.db
      .prepare("SELECT * FROM saved_files WHERE session_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(sessionId)
      .map((row) => toSavedFile(row).file)
  }

  getSavedFile(sessionId: string, id: string): { file: SavedFile; storageKey: string } | null {
    const row = this.db.prepare("SELECT * FROM saved_files WHERE session_id = ? AND id = ?").get(sessionId, id)
    return row ? toSavedFile(row) : null
  }

  deleteSavedFile(sessionId: string, id: string) {
    return Number(this.db.prepare("DELETE FROM saved_files WHERE session_id = ? AND id = ?").run(sessionId, id).changes) > 0
  }

  /** Storage keys of every saved file in a session, so deleting the session can delete their bytes. */
  /** Bytes kept for a conversation, across all its saved files. */
  savedFilesBytes(sessionId: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM saved_files WHERE session_id = ?").get(sessionId)
    return countRow.parse(row).n
  }

  savedFileKeys(sessionId: string): string[] {
    return this.db
      .prepare("SELECT storage_key FROM saved_files WHERE session_id = ?")
      .all(sessionId)
      .map((row) => z.object({ storage_key: z.string() }).parse(row).storage_key)
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
