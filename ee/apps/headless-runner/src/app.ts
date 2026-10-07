import { timingSafeEqual } from "node:crypto"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { streamSSE } from "hono/streaming"
import type { SessionEvents } from "./events.js"
import { SavedFileLimitError, type SavedFiles } from "./saved-files.js"
import { formatBytes } from "./tool-files.js"
import { z } from "zod"
import { normalizePath } from "./files.js"
import type { Runner } from "./runner.js"
import type { Store } from "./store.js"
import { ACTIVE, repeatLimitsSchema, turnCredentialsSchema, type SessionComputer } from "./types.js"

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
  })
  .strict()
const messageIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
/** Caller-chosen session ids share the runner's `hs_` prefix so they can never collide with other ids. */
const sessionIdSchema = z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/)
const sendBody = z
  .object({
    messageId: messageIdSchema,
    prompt: z.string().max(100_000),
    model: z.string().min(1).max(256).optional(),
    credentials: turnCredentialsSchema.default({}),
    /** Ids of saved files (POST /v1/sessions/:id/saved-files) sent with this message. */
    attachments: z.array(z.string().regex(/^fl_[a-f0-9]{32}$/)).optional(),
  })
  .strict()
  .refine((body) => body.prompt.trim().length > 0 || (body.attachments?.length ?? 0) > 0, "prompt or attachments is required")
const abortBody = z.object({ messageId: messageIdSchema.optional() }).strict()
const readQuery = z.object({
  messageId: messageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(100),
  /** `none` leaves tool outputs out, for callers that poll a long turn and only need its steps. */
  outputs: z.enum(["full", "none"]).default("full"),
  /**
   * Only the newest `turns` turns (before `before`, a messageId) and their messages, so reading a long
   * conversation costs the same as reading a short one. `limit` still caps the messages returned.
   */
  turns: z.coerce.number().int().min(1).max(200).optional(),
  before: messageIdSchema.optional(),
})

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
    return c.json({ error: "internal_error" }, 500)
  })

  app.get("/v1/models", async (c) => c.json(input.models ? await input.models() : { defaultModel: "", models: [] }))

  app.post("/v1/sessions", async (c) => {
    const body = createSessionBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    return c.json(store.createSession(body.data), 201)
  })

  app.put("/v1/sessions/:id", async (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "invalid_session_id" }, 400)
    const body = createSessionBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    const { session, created } = store.putSession(id.data, body.data)
    return c.json(session, created ? 201 : 200)
  })

  app.get("/v1/sessions/:id", (c) => {
    const session = store.getSession(c.req.param("id"))
    if (!session) return c.json({ error: "unknown_session" }, 404)
    const query = readQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request", issues: query.error.issues }, 400)
    const windowed = query.data.turns ? store.recentTurns(session.id, query.data.turns, query.data.before) : null
    const turns = windowed ? windowed.turns : store.listTurns(session.id)
    const target = query.data.messageId ?? turns.at(-1)?.messageId
    const all = query.data.messageId
      ? store.turnMessages(session.id, query.data.messageId)
      : windowed
        ? store.messagesForTurns(session.id, turns.map((turn) => turn.messageId))
        : store.messages(session.id)
    const scoped = all
    const finalAssistantText = all
      .filter((entry) => entry.messageId === target && entry.message.role === "assistant")
      .flatMap((entry) => (entry.message.role === "assistant" && entry.message.text ? [entry.message.text] : []))
      .join("\n\n")
    // Busy means the conversation itself is answering; background tasks running alongside don't count.
    const busy = windowed
      ? store.activeTurn(session.id, { conversation: true }) !== null
      : turns.some((turn) => ACTIVE.has(turn.status) && turn.kind !== "task")
    return c.json({
      session,
      status: busy ? "busy" : "idle",
      turns,
      ...(windowed ? { hasEarlier: windowed.hasEarlier } : {}),
      // Image and PDF data stay in the store; callers poll this, so they get counts instead.
      messages: scoped.slice(-query.data.limit).map((entry) => {
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
      finalAssistantText,
    })
  })

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
  // configured blob store (disk, any S3-compatible bucket, or Vercel Blob), only for conversations created with
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
