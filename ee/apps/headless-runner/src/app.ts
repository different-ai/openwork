import { timingSafeEqual } from "node:crypto"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { routePath } from "hono/route"
import { streamSSE } from "hono/streaming"
import type { ErrorReporter } from "./error-reporting.js"
import type { SessionEvents } from "./events.js"
import { SavedFileLimitError, type SavedFiles } from "./saved-files.js"
import { formatBytes } from "./tool-files.js"
import { z } from "zod"
import { normalizePath } from "./files.js"
import type { Runner } from "./runner.js"
import { CONVERSATION_TABLES, sqlRow, type StoredMessage, type Store } from "./store.js"
import { ACTIVE, repeatLimitsSchema, turnCredentialsSchema, turnStatusSchema, type SessionComputer } from "./types.js"

const createSessionBody = z
  .object({
    title: z.string().max(200).optional(),
    instructions: z.string().max(20_000).optional(),
    repeats: repeatLimitsSchema.optional(),
    /** Keep files in this conversation (needs HEADLESS_FILES). Off unless asked for. */
    files: z.boolean().optional(),
    /** Give this conversation a Linux computer (needs HEADLESS_COMPUTER). Off unless asked for. */
    computer: z.boolean().optional(),
    /** Let the model react to the person's message with one emoji (the `react` tool). Off unless asked for. */
    reactions: z.boolean().optional(),
    /** Let the conversation hand longer work to background tasks (start_task) and keep talking. Off unless asked for. */
    tasks: z.boolean().optional(),
    /** Who the conversation belongs to, in the caller's terms, so the caller can list one person's conversations. */
    owner: z.string().min(1).max(200).optional(),
    /** The caller's own id for the conversation, returned when listing. */
    ref: z.string().min(1).max(200).optional(),
    /** The person's IANA time zone; the model sees when each message was sent, in it. */
    timeZone: z.string().min(1).max(64).refine(isTimeZone, "unknown time zone").optional(),
    /** Name the conversation after its first answer, while its title is empty. */
    autoTitle: z.boolean().optional(),
    /** Another conversation of the same person whose memory/ this one shares. It must exist. */
    memoryOf: z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/).optional(),
  })
  .strict()
const messageIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
/** Caller-chosen session ids share the runner's `hs_` prefix so they can never collide with other ids. */
const sessionIdSchema = z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/)
const listQuery = z.object({ owner: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(200).default(50) })

function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}
const sendBody = z
  .object({
    messageId: messageIdSchema,
    prompt: z.string().max(100_000),
    model: z.string().min(1).max(256).optional(),
    credentials: turnCredentialsSchema.default({}),
    /** Ids of saved files (POST /v1/sessions/:id/saved-files) sent with this message. */
    attachments: z.array(z.string().regex(/^fl_[a-f0-9]{32}$/)).optional(),
    /**
     * The conversation's answer in progress wraps up at its next safe point (now, if it is writing; after the step it is
     * running otherwise), keeping what it wrote, and this message is answered next with all of that in view.
     */
    interrupt: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.prompt.trim().length > 0 || (body.attachments?.length ?? 0) > 0, "prompt or attachments is required")
const abortBody = z.object({ messageId: messageIdSchema.optional() }).strict()
/** Turns a session read returns when the caller doesn't say how many: about a screenful (Workbot's first page). */
export const DEFAULT_READ_TURNS = 30
/** The most turns one session read returns; asking for more gets this many, and `before` pages further back. */
export const MAX_READ_TURNS = 200
const readQuery = z.object({
  /** One turn: its transcript, and the turn with the background tasks it started and their reports. */
  messageId: messageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(100),
  /** `none` leaves tool outputs out, for callers that poll a long turn and only need its steps. */
  outputs: z.enum(["full", "none"]).default("full"),
  /**
   * Without `messageId`, only the newest `turns` turns (before `before`, a messageId) and their messages, so reading
   * a long conversation costs the same as reading a short one. `limit` still caps the messages returned.
   */
  turns: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .transform((turns) => Math.min(turns ?? DEFAULT_READ_TURNS, MAX_READ_TURNS)),
  before: messageIdSchema.optional(),
})

/** What the assistant wrote in one turn, its messages joined. */
function assistantText(entries: StoredMessage[], messageId: string) {
  return entries
    .filter((entry) => entry.messageId === messageId)
    .flatMap((entry) => (entry.message.role === "assistant" && entry.message.text ? [entry.message.text] : []))
    .join("\n\n")
}

/** A conversation moving to another runner: every row as stored. Kept files' bytes stay in the blob store. */
const EXPORT_FORMAT = "openwork-headless-conversation"
const exportedConversation = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(1),
    session: sqlRow,
    turns: z.array(sqlRow),
    messages: z.array(sqlRow),
    files: z.array(sqlRow),
    saved_files: z.array(sqlRow),
  })
  .strict()

export type ModelCatalog = { defaultModel: string; models: Array<{ id: string; name: string }> }

export function createApp(input: {
  store: Store
  runner: Runner
  apiToken: string
  /** Models a caller may pick per turn; without it only the default is listed. */
  models?: () => Promise<ModelCatalog>
  /** Live session events; without it the events route is not served. */
  events?: SessionEvents
  /** Saved files; without them the file routes answer `files_not_configured`. */
  files?: SavedFiles
  /** The per-conversation computers, deleted with their conversation. */
  computer?: SessionComputer
  /** Reports request failures (route and error type only, never the request or its body). */
  errors?: ErrorReporter
}) {
  const { store, runner } = input
  const expected = Buffer.from(input.apiToken)
  /** Constant-time compare; only the length of the (random, 32+ char) token can leak. */
  const tokenMatches = (candidate: string) => {
    const actual = Buffer.from(candidate)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const app = new Hono()

  app.get("/health", (c) => c.json({ ok: true }))

  app.use("/v1/*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")
    if (!match || !tokenMatches(match[1])) return c.json({ error: "unauthorized" }, 401)
    await next()
  })

  app.onError((error, c) => {
    console.error("[headless-runner] request failed", { path: c.req.path, error: error.message })
    if (input.errors?.enabled) void input.errors.report({ code: "request_failed", tags: { route: routePath(c), method: c.req.method }, error })
    return c.json({ error: "internal_error" }, 500)
  })

  app.get("/v1/models", async (c) => c.json(input.models ? await input.models() : { defaultModel: "", models: [] }))

  app.post("/v1/sessions", async (c) => {
    const body = createSessionBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    if (body.data.memoryOf && !store.getSession(body.data.memoryOf)) return c.json({ error: "unknown_memory_session" }, 400)
    return c.json(store.createSession(body.data), 201)
  })

  // One owner's conversations that have messages, most recently used first.
  app.get("/v1/sessions", (c) => {
    const query = listQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request", issues: query.error.issues }, 400)
    return c.json({ sessions: store.listSessions(query.data.owner, query.data.limit) })
  })

  app.put("/v1/sessions/:id", async (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "invalid_session_id" }, 400)
    const body = createSessionBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    if (body.data.memoryOf && (body.data.memoryOf === id.data || !store.getSession(body.data.memoryOf))) return c.json({ error: "unknown_memory_session" }, 400)
    const { session, created } = store.putSession(id.data, body.data)
    return c.json(session, created ? 201 : 200)
  })

  app.get("/v1/sessions/:id", (c) => {
    const session = store.getSession(c.req.param("id"))
    if (!session) return c.json({ error: "unknown_session" }, 404)
    const query = readQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request", issues: query.error.issues }, 400)
    const { messageId, limit } = query.data
    // Every read is bounded, however long the conversation: one turn (messageId), or a window of the newest turns
    // that `before` pages back through. Nothing here reads the whole transcript.
    const read = messageId ? readTurn(session.id, messageId, limit) : readWindow(session.id, query.data.turns, limit, query.data.before)
    const { turns } = read
    // Busy means the conversation itself is answering; background tasks running alongside don't count. Asked of the
    // whole session, so a turn outside the window still counts.
    const busy = store.activeTurn(session.id, { conversation: true }) !== null
    // A message waiting its turn (or stopped before it started) has no transcript yet: its text comes with the turn.
    const waiting = store.waitingPrompts(session.id, turns.filter((turn) => turn.kind === undefined && (turn.status === "queued" || turn.status === "aborted")).map((turn) => turn.messageId))
    return c.json({
      session,
      status: busy ? "busy" : "idle",
      turns: turns.map((turn) => {
        const prompt = waiting.get(turn.messageId)
        return prompt === undefined ? turn : { ...turn, prompt }
      }),
      // Older turns exist: read them with `before` set to the first turn's messageId.
      ...(read.hasEarlier === undefined ? {} : { hasEarlier: read.hasEarlier }),
      // Image and PDF data stay in the store; callers poll this, so they get counts instead.
      messages: read.messages.map((entry) => {
        const { seq, messageId, message, createdAt } = entry
        if (message.role !== "tool") return { seq, messageId, ...(createdAt === undefined ? {} : { createdAt }), ...message }
        const { images, documents, output, ...rest } = message
        return {
          seq,
          messageId,
          ...(createdAt === undefined ? {} : { createdAt }),
          ...rest,
          ...(query.data.outputs === "full" ? { output } : { outputLength: output.length }),
          ...(images ? { imageCount: images.length } : {}),
          ...(documents ? { documentCount: documents.length } : {}),
        }
      }),
      finalAssistantText: read.finalAssistantText,
    })
  })

  /** One turn's transcript (its newest `limit` messages) and its family; the answer is the whole turn's. */
  function readTurn(sessionId: string, messageId: string, limit: number) {
    const transcript = store.turnMessages(sessionId, messageId)
    return {
      turns: store.turnFamily(sessionId, messageId),
      messages: transcript.slice(-limit),
      finalAssistantText: assistantText(transcript, messageId),
      hasEarlier: undefined,
    }
  }

  /** The newest `count` turns before `before` with their newest `limit` messages; the answer is the newest turn's. */
  function readWindow(sessionId: string, count: number, limit: number, before?: string) {
    const window = store.recentTurns(sessionId, count, before)
    const first = window.turns.at(0)?.messageId
    const last = window.turns.at(-1)?.messageId
    const messages = first && last ? store.windowMessages(sessionId, first, last, limit) : []
    // Fewer than `limit` messages means the window's whole transcript came back; otherwise the newest turn may
    // start before the cut, so its answer is read on its own (one turn).
    const finalAssistantText = !last ? "" : assistantText(messages.length < limit ? messages : store.turnMessages(sessionId, last), last)
    return { turns: window.turns, messages, finalAssistantText, hasEarlier: window.hasEarlier }
  }

  // Live events for one session as server-sent events: `changed` (re-read the session) and `text` (model text
  // as it is written). A comment every 15 seconds keeps idle proxies from closing the stream.
  app.get("/v1/sessions/:id/events", (c) => {
    const events = input.events
    if (!events) return c.json({ error: "not_supported" }, 404)
    const sessionId = c.req.param("id")
    return streamSSE(c, async (stream) => {
      const queue: string[] = []
      let wake: (() => void) | null = null
      const unsubscribe = events.subscribe(sessionId, (event) => {
        queue.push(JSON.stringify(event))
        wake?.()
      })
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })
      try {
        await stream.writeSSE({ event: "ready", data: "{}" })
        while (!stream.aborted) {
          while (queue.length) await stream.writeSSE({ data: queue.shift() ?? "" })
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15_000)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          wake = null
          if (!queue.length && !stream.aborted) await stream.write(": keep-alive\n\n")
        }
      } finally {
        unsubscribe()
      }
    })
  })

  // Moving a conversation to a Node runner with nothing lost: its export, then its import there with the same id.
  // Only while nothing runs in it; callers pause their traffic first.
  app.get("/v1/sessions/:id/export", (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    const conversation = id.success ? store.exportConversation(id.data) : null
    if (!id.success || !conversation) return c.json({ error: "unknown_session" }, 404)
    if (store.activeTurn(id.data)) return c.json({ error: "session_busy" }, 409)
    return c.json({ format: EXPORT_FORMAT, version: 1, ...conversation })
  })

  app.post("/v1/sessions/:id/import", async (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "invalid_session_id" }, 400)
    if (store.getSession(id.data)) return c.json({ error: "session_exists" }, 409)
    const parsed = exportedConversation.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid_import", issues: parsed.error.issues }, 400)
    const { session, turns, messages, files, saved_files } = parsed.data
    const conversation = { session, turns, messages, files, saved_files }
    if (session.id !== id.data || CONVERSATION_TABLES.some((table) => conversation[table].some((row) => row.session_id !== id.data))) {
      return c.json({ error: "id_mismatch" }, 400)
    }
    const unknown = (["sessions", ...CONVERSATION_TABLES] as const).flatMap((table) => {
      const known = store.columns(table)
      const rows = table === "sessions" ? [session] : conversation[table]
      return [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((name) => !known.has(name)).map((name) => `${table}.${name}`)
    })
    if (unknown.length) return c.json({ error: "unsupported_export", message: `This runner has no ${unknown.join(", ")}; update it first.` }, 400)
    const running = turns.some((turn) => {
      const status = turnStatusSchema.safeParse(turn.status)
      return status.success && ACTIVE.has(status.data)
    })
    if (running) return c.json({ error: "invalid_import", message: "A turn was still running when this was exported." }, 400)
    try {
      store.importConversation(conversation)
    } catch (error) {
      return c.json({ error: "invalid_import", message: error instanceof Error ? error.message : "unknown error" }, 400)
    }
    return c.json({ id: id.data, rows: Object.fromEntries(CONVERSATION_TABLES.map((table) => [table, conversation[table].length])) }, 201)
  })

  app.delete("/v1/sessions/:id", async (c) => {
    const id = c.req.param("id")
    if (store.activeTurn(id)) return c.json({ error: "session_busy" }, 409)
    await input.files?.deleteSession(id)
    await input.computer?.delete(id).catch((error: unknown) => {
      // Freestyle deletes an unused VM on its own after a while, so a failure here only delays the cleanup.
      console.error("[headless-runner] computer delete failed", { sessionId: id, error: error instanceof Error ? error.message : "unknown" })
    })
    return store.deleteSession(id) ? c.body(null, 204) : c.json({ error: "unknown_session" }, 404)
  })

  // Saved files: uploads a person sends with messages, and files the agent hands back. Bytes live in the
  // configured blob store (disk, or any S3-compatible bucket), only for conversations created with
  // `files: true`, within a per-file and a per-conversation limit.
  app.get("/v1/files/status", (c) =>
    c.json({
      enabled: Boolean(input.files),
      kind: input.files?.blobs.kind ?? null,
      ...(input.files ? { maxFileBytes: input.files.limits.maxFileBytes, maxSessionBytes: input.files.limits.maxSessionBytes } : {}),
    }),
  )

  /** Refuses an upload before its body is read: no file store, unknown session, or a session without files. */
  const uploadAllowed: MiddlewareHandler = async (c, next) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    const session = store.getSession(c.req.param("id") ?? "")
    if (!session) return c.json({ error: "unknown_session" }, 404)
    if (!session.files) return c.json({ error: "files_not_enabled", message: "This conversation was not created with files: true." }, 403)
    if (!c.req.query("name")?.trim()) return c.json({ error: "invalid_request", message: "name is required" }, 400)
    await next()
  }
  /** Stops reading a body past the per-file limit, whether or not it declares its length. */
  const uploadSizeLimit: MiddlewareHandler = (c, next) => {
    const maxSize = input.files?.limits.maxFileBytes ?? 0
    return bodyLimit({
      maxSize,
      onError: (limited) => limited.json({ error: "file_too_large", message: `The most a kept file can be is ${formatBytes(maxSize)}.` }, 413),
    })(c, next)
  }

  app.post("/v1/sessions/:id/saved-files", uploadAllowed, uploadSizeLimit, async (c) => {
    const files = input.files
    if (!files) return c.json({ error: "files_not_configured" }, 501)
    const sessionId = c.req.param("id")
    const name = c.req.query("name")?.trim() ?? "file"
    const source = c.req.query("source") === "agent" ? "agent" : "user"
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    try {
      const file = await files.add(sessionId, { name, mediaType: c.req.header("content-type"), bytes, source })
      return c.json(file, 201)
    } catch (error) {
      if (error instanceof SavedFileLimitError) return c.json({ error: error.code, message: error.message }, 413)
      throw error
    }
  })

  app.get("/v1/sessions/:id/saved-files", (c) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    if (!store.getSession(c.req.param("id"))) return c.json({ error: "unknown_session" }, 404)
    return c.json({ files: input.files.list(c.req.param("id")) })
  })

  app.get("/v1/sessions/:id/saved-files/:fileId", async (c) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    const found = await input.files.read(c.req.param("id"), c.req.param("fileId"))
    if (!found) return c.json({ error: "unknown_file" }, 404)
    return c.body(found.bytes, 200, {
      "content-type": found.file.mediaType,
      "content-length": String(found.bytes.byteLength),
      "x-file-name": encodeURIComponent(found.file.name),
    })
  })

  app.get("/v1/sessions/:id/saved-files/:fileId/preview", async (c) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    const sessionId = c.req.param("id")
    const fileId = c.req.param("fileId")
    let manifest = await input.files.readPreview(sessionId, fileId)
    // No preview yet (an older file, or one the person sent): render it now on the conversation's computer,
    // when it has one. A conversation without a computer never starts one here.
    if (!manifest && input.computer && store.getSession(sessionId)?.computer) {
      await input.computer.previewSavedFile(sessionId, fileId).catch(() => undefined)
      manifest = await input.files.readPreview(sessionId, fileId)
    }
    return manifest ? c.json(manifest) : c.json({ error: "no_preview" }, 404)
  })

  app.get("/v1/sessions/:id/saved-files/:fileId/preview/:page", async (c) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    const page = Number(c.req.param("page"))
    if (!Number.isInteger(page) || page < 1 || page > 1_000) return c.json({ error: "unknown_page" }, 404)
    const png = await input.files.readPreviewPage(c.req.param("id"), c.req.param("fileId"), page)
    if (!png) return c.json({ error: "unknown_page" }, 404)
    return c.body(png, 200, { "content-type": "image/png", "content-length": String(png.byteLength) })
  })

  app.delete("/v1/sessions/:id/saved-files/:fileId", async (c) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    return (await input.files.delete(c.req.param("id"), c.req.param("fileId"))) ? c.body(null, 204) : c.json({ error: "unknown_file" }, 404)
  })

  app.post("/v1/sessions/:id/turns", async (c) => {
    const body = sendBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    const result = runner.send({ sessionId: c.req.param("id"), ...body.data })
    if (!result.ok) return c.json({ error: result.error }, result.error === "unknown_session" ? 404 : result.error === "unknown_file" ? 400 : 429)
    return c.json({ state: result.state, turn: result.turn }, 202)
  })

  // Removes a message and what it led to (its answer, tasks and reports); `after=1` removes every later message too,
  // for editing a message. Refused while any of them is still queued or running.
  app.delete("/v1/sessions/:id/turns/:messageId", (c) => {
    const sessionId = c.req.param("id")
    if (!store.getSession(sessionId)) return c.json({ error: "unknown_session" }, 404)
    const messageId = messageIdSchema.safeParse(c.req.param("messageId"))
    if (!messageId.success) return c.json({ error: "invalid_request" }, 400)
    const removed = store.deleteTurns(sessionId, messageId.data, { andAfter: c.req.query("after") === "1" })
    if (removed === null) return c.json({ error: "turn_busy" }, 409)
    return c.json({ removed })
  })

  app.post("/v1/sessions/:id/abort", async (c) => {
    if (!store.getSession(c.req.param("id"))) return c.json({ error: "unknown_session" }, 404)
    const body = abortBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    return c.json({ accepted: runner.abort(c.req.param("id"), body.data.messageId) })
  })

  app.get("/v1/sessions/:id/files", (c) => {
    if (!store.getSession(c.req.param("id"))) return c.json({ error: "unknown_session" }, 404)
    return c.json({ files: store.listFiles(c.req.param("id")) })
  })

  app.get("/v1/sessions/:id/files/content", (c) => {
    const path = normalizePath(c.req.query("path") ?? "")
    if (!path) return c.json({ error: "invalid_path" }, 400)
    const content = store.readFile(c.req.param("id"), path)
    if (content === null) return c.json({ error: "unknown_file" }, 404)
    return c.text(content)
  })

  return app
}
