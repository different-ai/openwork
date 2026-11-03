import { randomUUID } from "node:crypto"
import type { SqlDriver } from "./sql.js"
import { migrateCells } from "./cells-store.js"
import {
  ackIndexUpdate,
  deferIndexUpdate,
  dropIndexUpdatesBefore,
  enqueueIndexUpdate,
  INDEX_SIZE_STEP_BYTES,
  indexSnapshotAll,
  nextIndexUpdateAt,
  pendingIndexUpdates,
  setIndexCapability,
  type PendingIndexUpdate,
} from "./storage/index-outbox.js"
import type { LargeBodyRef } from "./storage/large-bodies.js"
import { runMigrations } from "./storage/migrations.js"
import { storageSchema } from "./storage/schema.js"
import { z } from "zod"
import type { Usage } from "./model.js"
import { stepStateSchema, type StepState } from "./steps.js"
import { withoutAttachments } from "./tool-files.js"
import {
  ACTIVE,
  DESKTOP_VIEWS,
  attachmentSchema,
  desktopViewSchema,
  messageSchema,
  repeatLimitsSchema,
  turnStatusSchema,
  type Attachment,
  type DesktopView,
  type Execution,
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
  desktop: z.boolean().optional(),
  desktopViews: z.array(desktopViewSchema).optional(),
  reactions: z.boolean().optional(),
  tasks: z.boolean().optional(),
  documentNavigation: z.boolean().optional(),
  sandboxGateway: z.boolean().optional(),
  timeZone: z.string().optional(),
  autoTitle: z.boolean().optional(),
  memoryOf: z.string().optional(),
  memoryScope: z.literal("owner").optional(),
})
type SessionOptions = z.infer<typeof sessionOptions>
const tableColumns = z.array(z.object({ name: z.string() }).loose())
const turnRow = z.object({
  session_id: z.string(),
  message_id: z.string(),
  status: turnStatusSchema,
  model: z.string().nullable(),
  model_access_required: z.number().optional(),
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
  execution: z.string().nullable().optional(),
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
  desktop: boolean
  /** The desktop views this conversation may use (see DesktopView); null means all of them. */
  desktopViews: DesktopView[] | null
  /** Whether the model may react to the person's message with an emoji (the caller shows it). */
  reactions: boolean
  /** Whether the conversation may hand work to background tasks (start_task) and keep talking meanwhile. */
  tasks: boolean
  /** Whether the host opens a document beside this chat when the person explicitly asks (the `open_document` tool). */
  documentNavigation: boolean
  /** Whether this conversation's computer runs through the runner's sandbox gateway (SANDBOX_GATEWAY) instead of its own provider. */
  sandboxGateway: boolean
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
  /** `owner`: memory/ is the owner's, shared by all their conversations (see memory.ts); replaces memoryOf. */
  memoryScope: "owner" | null
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
  desktop?: boolean
  desktopViews?: DesktopView[] | null
  reactions?: boolean
  tasks?: boolean
  documentNavigation?: boolean
  sandboxGateway?: boolean
  owner?: string
  ref?: string
  timeZone?: string
  autoTitle?: boolean
  memoryOf?: string
  memoryScope?: "owner"
}

/** The settings part of a session, leaving out what the caller didn't set. */
function optionsOf(input: {
  repeats?: RepeatLimits | null
  files?: boolean
  computer?: boolean
  desktop?: boolean
  desktopViews?: DesktopView[] | null
  reactions?: boolean
  tasks?: boolean
  documentNavigation?: boolean
  sandboxGateway?: boolean
  timeZone?: string | null
  autoTitle?: boolean
  memoryOf?: string | null
  memoryScope?: "owner" | null
}): SessionOptions {
  return {
    ...(input.repeats ? { repeats: input.repeats } : {}),
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(input.computer !== undefined ? { computer: input.computer } : {}),
    ...(input.desktop !== undefined ? { desktop: input.desktop } : {}),
    ...(input.desktopViews !== undefined ? { desktopViews: input.desktopViews ?? [...DESKTOP_VIEWS] } : {}),
    ...(input.reactions !== undefined ? { reactions: input.reactions } : {}),
    ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
    ...(input.documentNavigation !== undefined ? { documentNavigation: input.documentNavigation } : {}),
    ...(input.sandboxGateway !== undefined ? { sandboxGateway: input.sandboxGateway } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
    ...(input.memoryOf ? { memoryOf: input.memoryOf } : {}),
    ...(input.memoryScope ? { memoryScope: input.memoryScope } : {}),
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
    ...(options.desktop ? { desktop: true } : {}),
    // Every view is the default, so only a narrower set is kept, in one order.
    ...(options.desktopViews && !DESKTOP_VIEWS.every(view => options.desktopViews!.includes(view)) ? { desktopViews: DESKTOP_VIEWS.filter(view => options.desktopViews!.includes(view)) } : {}),
    ...(options.reactions ? { reactions: true } : {}),
    ...(options.tasks ? { tasks: true } : {}),
    ...(options.documentNavigation ? { documentNavigation: true } : {}),
    ...(options.sandboxGateway ? { sandboxGateway: true } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(options.autoTitle ? { autoTitle: true } : {}),
    // Owner-scoped memory replaces another conversation's: never both.
    ...(options.memoryOf && !options.memoryScope ? { memoryOf: options.memoryOf } : {}),
    ...(options.memoryScope ? { memoryScope: options.memoryScope } : {}),
  }
  return Object.keys(ordered).length ? JSON.stringify(ordered) : null
}

/** The sandbox gateway (SANDBOX_GATEWAY) or the runner's own provider (HEADLESS_COMPUTER). */
export type ComputerSide = "gateway" | "direct"

export type Turn = {
  sessionId: string
  messageId: string
  status: TurnStatus
  model: string | null
  /** Nonsecret durable policy: callers must reacquire scoped access even after a rollout is disabled. */
  modelAccessRequired?: boolean
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
  /** `steps` for a turn that runs one step at a time (see steps.ts); its tasks and reports inherit it. */
  execution?: Execution
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

export function parseMessageRow(row: unknown): StoredMessage {
  const value = messageRow.parse(row)
  return {
    seq: value.seq,
    messageId: value.message_id,
    message: messageSchema.parse(JSON.parse(value.body)),
    ...(value.created_at === undefined ? {} : { createdAt: value.created_at }),
  }
}

export function toTurn(row: unknown): Turn {
  const value = turnRow.parse(row)
  return {
    sessionId: value.session_id,
    messageId: value.message_id,
    status: value.status,
    model: value.model,
    ...(value.model_access_required === 1 ? { modelAccessRequired: true } : {}),
    error: value.error,
    ...(value.error_detail ? { errorDetail: value.error_detail } : {}),
    usage: { inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens, outputTokens: value.output_tokens },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.parent ? { parent: value.parent } : {}),
    ...(value.title ? { title: value.title } : {}),
    // An unknown value (a newer runner's) runs as it always did.
    ...(value.execution === "steps" ? { execution: "steps" as const } : {}),
  }
}

/**
 * A turn's columns without its prompt and attachments (a prompt can be 100k characters), so listing turns reads only
 * their state. The prompt is read where it is needed (startTranscript, waitingPrompts).
 */
export const TURN_COLUMNS =
  "session_id, message_id, status, model, model_access_required, error, input_tokens, cached_input_tokens, output_tokens, created_at, updated_at, kind, parent, title, error_detail, execution"

/** Leaves out background tasks' own transcripts: the conversation hears from a task through its report. */
const CONVERSATION_ROWS = "message_id NOT IN (SELECT message_id FROM turns WHERE session_id = ? AND kind = 'task')"

/**
 * Durable state in SQLite, supplied by the host runtime. Every transcript step is written
 * before the next one starts, so a crash loses at most the in-flight step.
 */
export class Store {
  /** Called after every write to a turn or its transcript, so live readers can re-read. */
  onChange: ((sessionId: string, messageId: string, status?: TurnStatus) => void) | null = null

  /**
   * Why the schema couldn't be brought up to date, when it couldn't: the host reports it as `store_migration_failed`
   * and stops (createRuntime), as it does when startup recovery fails.
   */
  readonly migrationError: unknown = null
  /** Turns ended in this process so far: the sealer looks for work after one ends (see storage/sealer.ts). */
  turnsEnded = 0
  private transactionDepth = 0

  constructor(readonly db: SqlDriver, private readonly now: () => number = Date.now) {
    try {
      this.migrate()
    } catch (error) {
      this.migrationError = error
    }
  }

  /**
   * Schema changes are shared by every SQLite host; connection settings belong to the driver. Numbered migrations
   * (storage/migrations.ts): each runs once per database, in order, and is additive and repeatable.
   */
  migrate() {
    runMigrations(this.db, [
      // Every table and column from before numbered migrations; a no-op on any database that already has them.
      { version: 1, name: "base", up: () => this.baseSchema() },
      // Sealed segments, large bodies, the Den index outbox (storage/schema.ts).
      { version: 2, name: "session-storage", up: storageSchema },
      // Session cells: owner directory, owner-scoped memory, forwarding rows, splits (cells-store.ts).
      { version: 3, name: "session-cells", up: migrateCells },
      // When each conversation's computer is due to pause (see setComputerPause).
      { version: 4, name: "computer-pauses", up: (db) => db.exec(`
        CREATE TABLE IF NOT EXISTS computer_pauses (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          due_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS computer_pauses_by_due ON computer_pauses (due_at);
      `) },
      // Which side made each gateway conversation's computer: the sandbox gateway or the runner's own provider.
      { version: 5, name: "computer-sides", up: (db) => db.exec(`
        CREATE TABLE IF NOT EXISTS computer_sides (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          side TEXT NOT NULL,
          placed_at INTEGER NOT NULL
        );
      `) },
    ])
  }

  /** Migration 1: the schema as the ad-hoc column checks before numbered migrations left it. */
  private baseSchema() {
    this.db.exec(`
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
    // A turn's resume grant, encrypted (see resume-grants.ts), and finding interrupted turns without reading them all.
    if (!turnColumns.includes(RESUME_GRANT_COLUMN)) this.db.exec(`ALTER TABLE turns ADD COLUMN ${RESUME_GRANT_COLUMN} TEXT`)
    // Nonsecret downgrade guard: scoped inference must be reacquired, never replaced by a deployment key.
    if (!turnColumns.includes("model_access_required")) this.db.exec("ALTER TABLE turns ADD COLUMN model_access_required INTEGER NOT NULL DEFAULT 0")
    this.db.exec("CREATE INDEX IF NOT EXISTS turns_by_status ON turns (status)")
    // Step mode (see steps.ts): how a turn runs, its next step and the text a step's model call has written so far.
    if (!turnColumns.includes("execution")) this.db.exec("ALTER TABLE turns ADD COLUMN execution TEXT")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS step_schedule (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS step_schedule_by_due ON step_schedule (due_at);
      CREATE TABLE IF NOT EXISTS step_checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
    `)
  }

  close() {
    this.db.close()
  }

  /** One atomic transaction; a call inside another joins it (so a change and its index update commit together). */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn()
    this.transactionDepth += 1
    try {
      return this.db.transaction(fn)
    } finally {
      this.transactionDepth -= 1
    }
  }

  createSession(input: SessionInput): Session {
    const at = this.now()
    const id = `hs_${randomUUID().replaceAll("-", "")}`
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO sessions (id, title, instructions, options, owner, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, initialTitle(input), input.instructions ?? "", serializeOptions(optionsOf(input)), input.owner ?? null, input.ref ?? null, at, at)
      this.sessionCreated(id)
    })
    const session = this.getSession(id)
    if (!session) throw new Error("session_missing_after_create")
    return session
  }

  /** A new session starts with nothing hot, and the Den index hears of it (same transaction as its row). */
  private sessionCreated(id: string) {
    this.db.prepare("UPDATE sessions SET hot_bytes = 0 WHERE id = ?").run(id)
    enqueueIndexUpdate(this.db, id, this.now())
  }

  /**
   * Creates the session under a caller-chosen id, or updates its title and
   * instructions when it already exists. Lets a caller keep one durable
   * conversation per person without storing the runner's id itself.
   */
  putSession(id: string, input: SessionInput): { session: Session; created: boolean } {
    return this.transaction(() => this.putSessionRow(id, input))
  }

  private putSessionRow(id: string, input: SessionInput): { session: Session; created: boolean } {
    const existing = this.getSession(id)
    const at = this.now()
    if (!existing) {
      this.db
        .prepare("INSERT INTO sessions (id, title, instructions, options, owner, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, initialTitle(input), input.instructions ?? "", serializeOptions(optionsOf(input)), input.owner ?? null, input.ref ?? null, at, at)
      this.sessionCreated(id)
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
        // Renamed (or otherwise changed): a fresh index snapshot.
        enqueueIndexUpdate(this.db, id, at)
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
      desktop: options.desktop ?? false,
      desktopViews: options.desktopViews ?? null,
      reactions: options.reactions ?? false,
      tasks: options.tasks ?? false,
      documentNavigation: options.documentNavigation ?? false,
      sandboxGateway: options.sandboxGateway ?? false,
      owner: value.owner ?? null,
      ref: value.ref ?? null,
      timeZone: options.timeZone ?? null,
      autoTitle: options.autoTitle ?? false,
      memoryOf: options.memoryScope ? null : options.memoryOf ?? null,
      memoryScope: options.memoryScope ?? null,
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
    this.transaction(() => {
      this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id)
      enqueueIndexUpdate(this.db, id, this.now())
    })
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

  /**
   * Deletes the session's rows (its turns, messages, files and storage bookkeeping go with it) and queues the Den
   * index's `deleted` update, in one transaction. Objects in the blob store are the storage module's to delete
   * (SessionStorage.deleteSession), after this commits.
   */
  deleteSession(id: string, options: { inTransaction?: () => void } = {}) {
    return this.transaction(() => {
      enqueueIndexUpdate(this.db, id, this.now(), { deleted: true })
      options.inTransaction?.()
      return Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes) > 0
    })
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
    this.transaction(() => this.deleteHotTurns(sessionId, ids))
    for (const id of ids) this.onChange?.(sessionId, id)
    return ids
  }

  /**
   * Deletes these turns' hot rows (turn, transcript, large-body references) and keeps the session's hot byte count
   * and Den index snapshot current. Call inside a transaction. Returns the large-body storage keys nothing references
   * any more (the caller deletes those objects after the commit).
   */
  deleteHotTurns(sessionId: string, ids: string[]): string[] {
    const freed = new Set<string>()
    let bytes = 0
    for (const id of ids) {
      bytes += countRow.parse(
        this.db
          .prepare("SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS n FROM messages WHERE session_id = ? AND message_id = ?")
          .get(sessionId, id),
      ).n
      bytes += countRow.parse(
        this.db
          .prepare("SELECT COALESCE(SUM(LENGTH(CAST(prompt AS BLOB)) + COALESCE(LENGTH(CAST(attachments AS BLOB)), 0)), 0) AS n FROM turns WHERE session_id = ? AND message_id = ?")
          .get(sessionId, id),
      ).n
      for (const row of this.db
        .prepare("SELECT storage_key FROM large_bodies WHERE session_id = ? AND seq IN (SELECT seq FROM messages WHERE session_id = ? AND message_id = ?)")
        .all(sessionId, sessionId, id)) {
        freed.add(z.object({ storage_key: z.string() }).parse(row).storage_key)
      }
      this.db.prepare("DELETE FROM large_bodies WHERE session_id = ? AND seq IN (SELECT seq FROM messages WHERE session_id = ? AND message_id = ?)").run(sessionId, sessionId, id)
      this.db.prepare("DELETE FROM messages WHERE session_id = ? AND message_id = ?").run(sessionId, id)
      this.db.prepare("DELETE FROM turns WHERE session_id = ? AND message_id = ?").run(sessionId, id)
    }
    this.addHotBytes(sessionId, -bytes)
    enqueueIndexUpdate(this.db, sessionId, this.now())
    return [...freed].filter((key) => !this.db.prepare("SELECT 1 AS n FROM large_bodies WHERE storage_key = ? LIMIT 1").get(key))
  }

  /** Moves the session's hot byte count (when it is counted); an index update when it crosses a size step. */
  private addHotBytes(sessionId: string, delta: number) {
    if (delta === 0) return
    const row = this.db.prepare("SELECT hot_bytes FROM sessions WHERE id = ?").get(sessionId)
    const before = z.object({ hot_bytes: z.number().nullable() }).safeParse(row)
    if (!before.success || before.data.hot_bytes === null) return
    const after = Math.max(0, before.data.hot_bytes + delta)
    this.db.prepare("UPDATE sessions SET hot_bytes = ? WHERE id = ?").run(after, sessionId)
    if (Math.floor(after / INDEX_SIZE_STEP_BYTES) !== Math.floor(before.data.hot_bytes / INDEX_SIZE_STEP_BYTES)) enqueueIndexUpdate(this.db, sessionId, this.now())
  }

  /** Counts a session's hot bytes from its rows (a database from before they were kept, or after a rollback). */
  countHotBytes(sessionId: string): number {
    const messages = countRow.parse(this.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS n FROM messages WHERE session_id = ?").get(sessionId)).n
    const prompts = countRow.parse(
      this.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(prompt AS BLOB)) + COALESCE(LENGTH(CAST(attachments AS BLOB)), 0)), 0) AS n FROM turns WHERE session_id = ?").get(sessionId),
    ).n
    const total = messages + prompts
    this.db.prepare("UPDATE sessions SET hot_bytes = ? WHERE id = ?").run(total, sessionId)
    return total
  }

  getTurn(sessionId: string, messageId: string): Turn | null {
    const row = this.db.prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND message_id = ?`).get(sessionId, messageId)
    return row ? toTurn(row) : null
  }

  /** Every turn of the session. Not for reads a caller asks for: those are windowed (recentTurns, turnFamily). */
  listTurns(sessionId: string): Turn[] {
    return this.db
      .prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY created_at, rowid`)
      .all(sessionId)
      .map(toTurn)
  }

  /**
   * One turn with the background tasks it started and those tasks' reports, oldest first: everything a caller
   * following one turn looks at, however long the conversation is.
   */
  turnFamily(sessionId: string, messageId: string): Turn[] {
    return this.db
      .prepare(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND (
           message_id = ?
           OR (kind = 'task' AND parent = ?)
           OR (kind = 'report' AND parent IN (SELECT message_id FROM turns WHERE session_id = ? AND kind = 'task' AND parent = ?))
         ) ORDER BY rowid`,
      )
      .all(sessionId, messageId, messageId, sessionId, messageId)
      .map(toTurn)
  }

  /** The first queued or running turn; with `conversation`, background tasks don't count. */
  activeTurn(sessionId: string, options: { conversation?: boolean } = {}): Turn | null {
    const row = this.db
      .prepare(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND status IN (${[...ACTIVE].map(() => "?").join(", ")})${options.conversation ? " AND kind IS NOT 'task'" : ""} ORDER BY rowid LIMIT 1`,
      )
      .get(sessionId, ...ACTIVE)
    return row ? toTurn(row) : null
  }

  /** The session's newest background tasks, oldest first. */
  recentTasks(sessionId: string, limit: number): Turn[] {
    return this.db
      .prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND kind = 'task' ORDER BY rowid DESC LIMIT ?`)
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
    modelAccessRequired?: boolean
    execution?: Execution
  }): Turn {
    const at = this.now()
    const attachments = input.attachments?.length ? JSON.stringify(input.attachments) : null
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO turns (session_id, message_id, status, prompt, model, error, attachments, kind, parent, title, model_access_required, execution, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.sessionId,
          input.messageId,
          input.prompt,
          input.model,
          attachments,
          input.kind ?? null,
          input.parent ?? null,
          input.title ?? null,
          input.modelAccessRequired ? 1 : 0,
          input.execution ?? null,
          at,
          at,
        )
      this.addHotBytes(input.sessionId, Buffer.byteLength(input.prompt) + (attachments ? Buffer.byteLength(attachments) : 0))
    })
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
    this.updateStatus(sessionId, messageId, status, error, errorDetail)
    this.onChange?.(sessionId, messageId, status)
  }

  private updateStatus(sessionId: string, messageId: string, status: TurnStatus, error: string | null, errorDetail: string | null) {
    const at = this.now()
    this.transaction(() => {
      this.db
        .prepare("UPDATE turns SET status = ?, error = ?, error_detail = ?, updated_at = ? WHERE session_id = ? AND message_id = ?")
        .run(status, error, errorDetail, at, sessionId, messageId)
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, sessionId)
      // A turn started or ended: the Den index's activeTurnSince moves (same transaction).
      if (status !== "queued") enqueueIndexUpdate(this.db, sessionId, at)
    })
    if (!ACTIVE.has(status)) this.turnsEnded += 1
  }

  addUsage(sessionId: string, messageId: string, usage: Usage) {
    this.db
      .prepare(
        `UPDATE turns SET input_tokens = input_tokens + ?, cached_input_tokens = cached_input_tokens + ?,
         output_tokens = output_tokens + ? WHERE session_id = ? AND message_id = ?`,
      )
      .run(usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, sessionId, messageId)
  }

  /** Only a nonsecret boolean is durable; endpoint credentials stay in the runner's memory. */
  modelAccessRequired(sessionId: string, messageId: string): boolean {
    const row = this.db.prepare("SELECT model_access_required FROM turns WHERE session_id = ? AND message_id = ?").get(sessionId, messageId)
    return z.object({ model_access_required: z.number() }).parse(row).model_access_required === 1
  }

  requireModelAccess(sessionId: string, messageId: string) {
    this.db.prepare("UPDATE turns SET model_access_required = 1 WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
  }

  /** Keeps (or, with null, forgets) a turn's encrypted resume grant. Never part of a turn as callers read it. */
  setResumeGrant(sessionId: string, messageId: string, sealed: string | null) {
    this.db.prepare(`UPDATE turns SET ${RESUME_GRANT_COLUMN} = ? WHERE session_id = ? AND message_id = ?`).run(sealed, sessionId, messageId)
  }

  /**
   * The encrypted resume grant a turn resumes with: its own, else the one of the turn that started it (a report's
   * task, then that task's message). `holder` is the turn that keeps it.
   */
  resumeGrantOf(sessionId: string, messageId: string): { sealed: string; holder: string } | null {
    let id = messageId
    for (let hop = 0; hop < 3; hop += 1) {
      const row = this.db.prepare(`SELECT ${RESUME_GRANT_COLUMN}, kind, parent FROM turns WHERE session_id = ? AND message_id = ?`).get(sessionId, id)
      if (!row) return null
      const value = grantRow.parse(row)
      if (value.resume_grant) return { sealed: value.resume_grant, holder: id }
      if (!value.kind || !value.parent) return null
      id = value.parent
    }
    return null
  }

  /** Every interrupted turn stopped for one of these reasons, oldest first, across sessions. */
  interruptedTurns(errors: readonly string[]): Turn[] {
    if (errors.length === 0) return []
    return this.db
      .prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE status = 'interrupted' AND error IN (${errors.map(() => "?").join(", ")}) ORDER BY created_at, rowid`)
      .all(...errors)
      .map(toTurn)
  }

  /** Whether any turn, in any session, is queued or running. */
  hasActiveTurns(): boolean {
    return this.db.prepare(`SELECT 1 AS n FROM turns WHERE status IN (${[...ACTIVE].map(() => "?").join(", ")}) LIMIT 1`).get(...ACTIVE) !== undefined
  }

  /**
   * Marks every turn a previous process left queued or running as interrupted, except step-mode turns that can go
   * on from what is stored (queued, or running with a next step): the runner continues those (Runner.recoverSteps).
   */
  recoverInterruptedTurns() {
    const where = `status IN ('queued', 'running')
         AND NOT (execution IS 'steps' AND (status = 'queued' OR EXISTS (
           SELECT 1 FROM step_schedule WHERE step_schedule.session_id = turns.session_id AND step_schedule.message_id = turns.message_id
         )))`
    return this.transaction(() => {
      const sessions = this.db
        .prepare(`SELECT DISTINCT session_id FROM turns WHERE ${where}`)
        .all()
        .map((row) => z.object({ session_id: z.string() }).parse(row).session_id)
      const result = this.db.prepare(`UPDATE turns SET status = 'interrupted', error = 'runner_restarted', updated_at = ? WHERE ${where}`).run(this.now())
      // Those turns ended: the Den index's activeTurnSince moves.
      for (const sessionId of sessions) enqueueIndexUpdate(this.db, sessionId, this.now())
      return Number(result.changes)
    })
  }

  /** `body`: the message's large part, already in the blob store (see storage/large-bodies.ts). */
  appendMessage(sessionId: string, messageId: string, message: Message, body?: LargeBodyRef) {
    this.transaction(() => this.insertMessage(sessionId, messageId, message, body))
    this.onChange?.(sessionId, messageId)
  }

  private insertMessage(sessionId: string, messageId: string, message: Message, body?: LargeBodyRef) {
    // Sealed messages keep their seq: a new one never reuses one (a sealed turn's can be the newest).
    const row = countRow.parse(
      this.db
        .prepare("SELECT MAX(COALESCE((SELECT MAX(seq) FROM messages WHERE session_id = ?), 0), COALESCE((SELECT MAX(seq_to) FROM segments WHERE session_id = ?), 0)) AS n")
        .get(sessionId, sessionId),
    )
    const seq = row.n + 1
    const json = JSON.stringify(messageSchema.parse(message))
    this.db.prepare("INSERT INTO messages (session_id, seq, message_id, body, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, seq, messageId, json, this.now())
    if (body) {
      this.db
        .prepare("INSERT OR REPLACE INTO large_bodies (session_id, seq, part, storage_key, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, seq, body.part, body.storageKey, body.bytes, body.sha256)
    }
    this.addHotBytes(sessionId, Buffer.byteLength(json))
  }

  // ------------------------------------------------------------------ step mode (see steps.ts)

  /** A step-mode turn's run starts: it is running, and its first step is due at `dueAt`. */
  beginStepRun(sessionId: string, messageId: string, dueAt: number, state: StepState) {
    this.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO step_schedule (session_id, message_id, due_at, attempt, state) VALUES (?, ?, ?, 0, ?)")
        .run(sessionId, messageId, dueAt, JSON.stringify(stepStateSchema.parse(state)))
      this.db.prepare("DELETE FROM step_checkpoints WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
      this.updateStatus(sessionId, messageId, "running", null, null)
    })
    this.onChange?.(sessionId, messageId, "running")
  }

  /**
   * A step-mode turn's next step: null without one; `invalid` when its stored row can't be read (that turn fails,
   * nothing else does).
   */
  stepRow(sessionId: string, messageId: string): { dueAt: number; attempt: number; state: StepState } | "invalid" | null {
    const row = this.db.prepare("SELECT due_at, attempt, state FROM step_schedule WHERE session_id = ? AND message_id = ?").get(sessionId, messageId)
    if (!row) return null
    const value = stepRowSchema.safeParse(row)
    if (!value.success) return "invalid"
    let state: unknown
    try {
      state = JSON.parse(value.data.state)
    } catch {
      return "invalid"
    }
    const parsed = stepStateSchema.safeParse(state)
    return parsed.success ? { dueAt: value.data.due_at, attempt: value.data.attempt, state: parsed.data } : "invalid"
  }

  /** A step starts: its attempt is counted, and the step is due again at `retryAt` if it never commits. */
  startStepAttempt(sessionId: string, messageId: string, attempt: number, retryAt: number) {
    this.db.prepare("UPDATE step_schedule SET attempt = ?, due_at = ? WHERE session_id = ? AND message_id = ?").run(attempt, retryAt, sessionId, messageId)
  }

  /** Keeps a step's bookkeeping now, before the step commits (the model's answer before its tool calls run). */
  setStepState(sessionId: string, messageId: string, state: StepState) {
    this.db.prepare("UPDATE step_schedule SET state = ? WHERE session_id = ? AND message_id = ?").run(JSON.stringify(stepStateSchema.parse(state)), sessionId, messageId)
  }

  /** The step's model answer is kept (`pending`), so its streamed text so far is no longer needed. */
  keepStepAnswer(sessionId: string, messageId: string, state: StepState) {
    this.transaction(() => {
      this.setStepState(sessionId, messageId, state)
      this.db.prepare("DELETE FROM step_checkpoints WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
    })
  }

  /** The text model call `step` of a turn has written so far. */
  saveCheckpoint(sessionId: string, messageId: string, step: number, text: string) {
    this.db
      .prepare(
        `INSERT INTO step_checkpoints (session_id, message_id, step, text, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, message_id) DO UPDATE SET step = excluded.step, text = excluded.text, updated_at = excluded.updated_at`,
      )
      .run(sessionId, messageId, step, text, this.now())
  }

  stepCheckpoint(sessionId: string, messageId: string): { step: number; text: string } | null {
    const row = this.db.prepare("SELECT step, text FROM step_checkpoints WHERE session_id = ? AND message_id = ?").get(sessionId, messageId)
    const value = z.object({ step: z.number(), text: z.string() }).safeParse(row)
    return value.success ? value.data : null
  }

  deleteCheckpoint(sessionId: string, messageId: string) {
    this.db.prepare("DELETE FROM step_checkpoints WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
  }

  /**
   * One step, all of it or none: its messages and tool results, its usage, and either the turn's next step (with the
   * attempt reset) or how the turn ended. The step's checkpoint goes with it. Live readers hear of it after it commits.
   */
  commitStep(input: {
    sessionId: string
    messageId: string
    messages?: Message[]
    /** Each message's large part already in the blob store, by index (see storage/large-bodies.ts). */
    bodies?: Array<LargeBodyRef | undefined>
    usage?: Usage
    outcome: { next: { dueAt: number; state: StepState } } | { end: { status: TurnStatus; error?: string | null; errorDetail?: string | null } }
  }) {
    const { sessionId, messageId } = input
    this.transaction(() => {
      for (const [index, message] of (input.messages ?? []).entries()) this.insertMessage(sessionId, messageId, message, input.bodies?.[index])
      if (input.usage) this.addUsage(sessionId, messageId, input.usage)
      if ("next" in input.outcome) {
        this.db
          .prepare("UPDATE step_schedule SET due_at = ?, attempt = 0, state = ? WHERE session_id = ? AND message_id = ?")
          .run(input.outcome.next.dueAt, JSON.stringify(stepStateSchema.parse(input.outcome.next.state)), sessionId, messageId)
      } else {
        const { status, error, errorDetail } = input.outcome.end
        this.db.prepare("DELETE FROM step_schedule WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
        this.updateStatus(sessionId, messageId, status, error ?? null, errorDetail ?? null)
      }
      this.db.prepare("DELETE FROM step_checkpoints WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
    })
    if (input.messages?.length || "next" in input.outcome) this.onChange?.(sessionId, messageId)
    if ("end" in input.outcome) this.onChange?.(sessionId, messageId, input.outcome.end.status)
  }

  /** Forgets a turn's next step and checkpoint (its run is over). */
  endStepRun(sessionId: string, messageId: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM step_schedule WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
      this.db.prepare("DELETE FROM step_checkpoints WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
    })
  }

  /**
   * When the conversation's computer should pause if it is still idle. Kept here rather than in a timer, so a runner
   * that restarts (or a cell whose isolate is recycled) still pauses it: the host's background job reads it.
   */
  setComputerPause(sessionId: string, dueAt: number) {
    this.db
      .prepare("INSERT INTO computer_pauses (session_id, due_at) SELECT id, ? FROM sessions WHERE id = ? ON CONFLICT (session_id) DO UPDATE SET due_at = excluded.due_at")
      .run(dueAt, sessionId)
  }

  /** Where the conversation's computer was made (computer-route.ts), or null before one was placed. */
  computerSide(sessionId: string): ComputerSide | null {
    const row = this.db.prepare("SELECT side FROM computer_sides WHERE session_id = ?").get(sessionId)
    const parsed = z.object({ side: z.enum(["gateway", "direct"]) }).safeParse(row)
    return parsed.success ? parsed.data.side : null
  }

  setComputerSide(sessionId: string, side: ComputerSide) {
    this.db
      .prepare("INSERT INTO computer_sides (session_id, side, placed_at) SELECT id, ?, ? FROM sessions WHERE id = ? ON CONFLICT (session_id) DO UPDATE SET side = excluded.side, placed_at = excluded.placed_at")
      .run(side, this.now(), sessionId)
  }

  clearComputerSide(sessionId: string) {
    this.db.prepare("DELETE FROM computer_sides WHERE session_id = ?").run(sessionId)
  }

  clearComputerPause(sessionId: string) {
    this.db.prepare("DELETE FROM computer_pauses WHERE session_id = ?").run(sessionId)
  }

  dueComputerPauses(now: number): string[] {
    return this.db
      .prepare("SELECT session_id FROM computer_pauses WHERE due_at <= ? ORDER BY due_at")
      .all(now)
      .map((row) => z.object({ session_id: z.string() }).parse(row).session_id)
  }

  nextComputerPauseAt(): number | null {
    const row = z.object({ due_at: z.number().nullable() }).parse(this.db.prepare("SELECT MIN(due_at) AS due_at FROM computer_pauses").get())
    return row.due_at
  }

  /** Step-mode turns whose next step is due, oldest first. */
  dueSteps(now: number): Array<{ sessionId: string; messageId: string }> {
    return this.db
      .prepare("SELECT session_id, message_id FROM step_schedule WHERE due_at <= ? ORDER BY due_at, rowid")
      .all(now)
      .flatMap((row) => {
        const value = z.object({ session_id: z.string(), message_id: z.string() }).safeParse(row)
        return value.success ? [{ sessionId: value.data.session_id, messageId: value.data.message_id }] : []
      })
  }

  /** Every step-mode turn's next step and when it is due, earliest first. */
  scheduledSteps(): Array<{ sessionId: string; messageId: string; dueAt: number }> {
    return this.db
      .prepare("SELECT session_id, message_id, due_at FROM step_schedule ORDER BY due_at, rowid")
      .all()
      .flatMap((row) => {
        const value = z.object({ session_id: z.string(), message_id: z.string(), due_at: z.number() }).safeParse(row)
        return value.success ? [{ sessionId: value.data.session_id, messageId: value.data.message_id, dueAt: value.data.due_at }] : []
      })
  }

  /** When the earliest next step is due, or null without step-mode turns. */
  nextStepAt(): number | null {
    const row = this.db.prepare("SELECT MIN(due_at) AS n FROM step_schedule").get()
    const value = z.object({ n: z.number().nullable() }).safeParse(row)
    return value.success ? value.data.n : null
  }

  /**
   * The step-mode turns a previous process left going, in the order they were sent: `running` ones go on from their
   * next step, `queued` ones wait for their lane again. Never throws on what it reads: a turn whose row can't be read
   * fails on its own (`step_state_invalid`), and a running turn without a next step is interrupted as on any restart.
   */
  stepTurnsToContinue(): { running: StepTurnRef[]; queued: StepTurnRef[]; failed: number } {
    const running: StepTurnRef[] = []
    const queued: StepTurnRef[] = []
    let failed = 0
    const rows = this.db
      .prepare(
        `SELECT turns.session_id, turns.message_id, turns.status, turns.kind, step_schedule.state IS NOT NULL AS scheduled
         FROM turns LEFT JOIN step_schedule ON step_schedule.session_id = turns.session_id AND step_schedule.message_id = turns.message_id
         WHERE turns.execution = 'steps' AND turns.status IN ('queued', 'running') ORDER BY turns.rowid`,
      )
      .all()
    for (const row of rows) {
      const value = stepTurnRow.safeParse(row)
      const ids = z.object({ session_id: z.string(), message_id: z.string() }).safeParse(row)
      if (!ids.success) continue
      const { session_id: sessionId, message_id: messageId } = ids.data
      if (!value.success || (value.data.status === "running" && value.data.scheduled && this.stepRow(sessionId, messageId) === "invalid")) {
        this.failUnreadable(sessionId, messageId)
        failed += 1
        continue
      }
      const ref = { sessionId, messageId, kind: value.data.kind ?? undefined }
      if (value.data.status === "queued") queued.push(ref)
      else if (value.data.scheduled) running.push(ref)
      else this.setTurnStatus(sessionId, messageId, "interrupted", "runner_restarted")
    }
    return { running, queued, failed }
  }

  /** A step-mode turn whose stored state can't be read fails, without reading anything else of it. */
  failUnreadable(sessionId: string, messageId: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM step_schedule WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
      this.db.prepare("DELETE FROM step_checkpoints WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
      this.updateStatus(sessionId, messageId, "failed", "step_state_invalid", null)
    })
    this.onChange?.(sessionId, messageId, "failed")
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
        if (stripped === message) continue
        const json = JSON.stringify(messageSchema.parse(stripped))
        update.run(json, sessionId, value.seq)
        this.addHotBytes(sessionId, Buffer.byteLength(json) - Buffer.byteLength(value.body))
      }
    })
  }

  /** The whole transcript. Not for reads a caller asks for: a long conversation's can be hundreds of megabytes. */
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
            `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND rowid < (SELECT rowid FROM turns WHERE session_id = ? AND message_id = ?)
             ORDER BY rowid DESC LIMIT ?`,
          )
          .all(sessionId, sessionId, beforeMessageId, limit + 1)
      : this.db.prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`).all(sessionId, limit + 1)
    const turns = rows.slice(0, limit).map(toTurn).reverse()
    return { turns, hasEarlier: rows.length > limit }
  }

  /**
   * What caller-sent turns with no transcript yet were sent with: a message waiting behind the answer in progress, or
   * one stopped before it started. Its transcript only starts when it runs, so a reader shows it from this.
   */
  waitingPrompts(sessionId: string, messageIds: string[]): Map<string, string> {
    if (messageIds.length === 0) return new Map()
    const rows = this.db
      .prepare(
        `SELECT message_id, prompt FROM turns WHERE session_id = ? AND kind IS NULL AND message_id IN (${messageIds.map(() => "?").join(", ")})
         AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.session_id = turns.session_id AND messages.message_id = turns.message_id)`,
      )
      .all(sessionId, ...messageIds)
    return new Map(z.array(z.object({ message_id: z.string(), prompt: z.string() })).parse(rows).map((row) => [row.message_id, row.prompt]))
  }

  /**
   * The newest `limit` transcript messages of the turns from `firstMessageId` to `lastMessageId` (a window from
   * recentTurns, so a run of consecutive turns), oldest first. Only those rows are read, whatever the turns hold.
   */
  windowMessages(sessionId: string, firstMessageId: string, lastMessageId: string, limit: number): StoredMessage[] {
    return this.db
      .prepare(
        `SELECT seq, message_id, body, created_at FROM messages WHERE session_id = ? AND message_id IN (
           SELECT message_id FROM turns WHERE session_id = ?
             AND rowid >= (SELECT rowid FROM turns WHERE session_id = ? AND message_id = ?)
             AND rowid <= (SELECT rowid FROM turns WHERE session_id = ? AND message_id = ?)
         ) ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, sessionId, sessionId, firstMessageId, sessionId, lastMessageId, limit)
      .map(parseMessageRow)
      .reverse()
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

  /**
   * Every row of one conversation exactly as stored, to move it to another runner (GET /v1/sessions/:id/export),
   * except resume grants: they are secrets sealed with this runner's key, so the conversation's callers resume it there.
   */
  exportConversation(id: string): ConversationRows | null {
    const session = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
    if (!session) return null
    const rows = (table: ConversationTable) => z.array(sqlRow).parse(this.db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY rowid`).all(id))
    return { session: withoutBookkeeping(sqlRow.parse(session)), turns: rows("turns").map(withoutGrant), messages: rows("messages"), files: rows("files"), saved_files: rows("saved_files") }
  }

  /** The columns this database has for a table: an export from a newer runner can name ones it lacks. */
  columns(table: "sessions" | ConversationTable): Set<string> {
    return new Set(tableColumns.parse(this.db.prepare(`PRAGMA table_info(${table})`).all()).map((column) => column.name))
  }

  /** Writes an exported conversation in one transaction: all of it, or nothing. Columns must be checked first. */
  importConversation(conversation: ConversationRows) {
    const insert = (table: "sessions" | ConversationTable, row: SqlRow) => {
      const names = Object.keys(row)
      if (!names.length || names.some((name) => !/^[a-z_]+$/.test(name))) throw new Error("invalid_column")
      this.db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => row[name] ?? null))
    }
    this.transaction(() => {
      insert("sessions", withoutBookkeeping(conversation.session))
      for (const table of CONVERSATION_TABLES) for (const row of conversation[table]) insert(table, table === "turns" ? withoutGrant(row) : row)
      const id = z.string().parse(conversation.session.id)
      // Everything imported is hot; it is counted once here, and the Den index hears of the session.
      this.countHotBytes(id)
      enqueueIndexUpdate(this.db, id, this.now())
    })
  }

  // ------------------------------------------------------------------ Den index outbox (storage/index-outbox.ts)

  /** Keeps the Den index capability from the session's latest turn token. Never logged, never exported. */
  setIndexCapability(sessionId: string, capability: string): void {
    setIndexCapability(this.db, sessionId, capability)
  }

  pendingIndexUpdates(now: number, limit: number): PendingIndexUpdate[] {
    return pendingIndexUpdates(this.db, now, limit)
  }

  /** Den took this version: the row goes, unless a newer snapshot replaced it meanwhile. */
  ackIndexUpdate(sessionId: string, version: number): void {
    ackIndexUpdate(this.db, sessionId, version)
  }

  deferIndexUpdate(sessionId: string, version: number, retryAt: number): void {
    deferIndexUpdate(this.db, sessionId, version, retryAt)
  }

  nextIndexUpdateAt(): number | null {
    return nextIndexUpdateAt(this.db)
  }

  dropIndexUpdatesBefore(createdBefore: number): number {
    return dropIndexUpdatesBefore(this.db, createdBefore)
  }

  indexSnapshotAll(now: number): void {
    this.transaction(() => indexSnapshotAll(this.db, now))
  }

  /** Queues a fresh index snapshot of one session (same transaction as the caller's change). */
  enqueueIndexUpdate(sessionId: string, options: { deleted?: boolean } = {}) {
    enqueueIndexUpdate(this.db, sessionId, this.now(), options)
  }
}

/** Storage bookkeeping on a session row that belongs to this runner, not to the conversation: never exported. */
const BOOKKEEPING_COLUMNS = new Set(["hot_bytes", "index_capability", "index_version"])
function withoutBookkeeping(row: SqlRow): SqlRow {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !BOOKKEEPING_COLUMNS.has(name)))
}

export type StepTurnRef = { sessionId: string; messageId: string; kind: "task" | "report" | undefined }
const stepRowSchema = z.object({ due_at: z.number(), attempt: z.number(), state: z.string() })
const stepTurnRow = z.object({ status: z.enum(["queued", "running"]), kind: z.enum(["task", "report"]).nullable(), scheduled: z.number() })

const RESUME_GRANT_COLUMN = "resume_grant"
const grantRow = z.object({ resume_grant: z.string().nullable().optional(), kind: z.string().nullable().optional(), parent: z.string().nullable().optional() })
/** A turn row without its resume grant, which never leaves the runner that sealed it. */
function withoutGrant(row: SqlRow): SqlRow {
  const { [RESUME_GRANT_COLUMN]: _grant, ...rest } = row
  return rest
}

export const CONVERSATION_TABLES = ["turns", "messages", "files", "saved_files"] as const
type ConversationTable = (typeof CONVERSATION_TABLES)[number]
export const sqlRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
type SqlRow = z.infer<typeof sqlRow>
export type ConversationRows = { session: SqlRow } & Record<ConversationTable, SqlRow[]>
