import { timingSafeEqual } from "node:crypto"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { routePath } from "hono/route"
import { streamSSE } from "hono/streaming"
import type { ErrorReporter } from "./error-reporting.js"
import type { SessionEvents } from "./events.js"
import { serviceHealthResponse, type ServiceHealthConfig } from "./service-health.js"
import { computerDetailResponse, computerFleetResponse, type ComputerFleetConfig } from "./computer-fleet.js"
import { SavedFileLimitError, type SavedFiles } from "./saved-files.js"
import { formatBytes } from "./tool-files.js"
import { z } from "zod"
import { demonstrationCommandSchema } from "@openwork/types/browser-demonstration"
import { FILE_LIMITS, isMemoryPath, normalizePath } from "./files.js"
import { localMemory, MemoryUnavailableError, type MemoryResolver } from "./memory.js"
import type { Runner } from "./runner.js"
import { scopedCatalogResponse } from "./model-catalog.js"
import { HEADLESS_MAX_PROMPT_CHARS, type HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import { modelProbeResponse, type ModelProbe } from "./model-probe.js"
import { CONVERSATION_TABLES, sqlRow, type SessionInput, type StoredMessage, type Store, type Turn } from "./store.js"
import { LargeBodyUnavailableError, SegmentError, SessionStorage } from "./storage/index.js"
import { CellsStore } from "./cells-store.js"
import { ACTIVE, DESKTOP_VIEWS, desktopViewSchema, executionSchema, repeatLimitsSchema, turnCredentialsSchema, turnStatusSchema, type DesktopView, type SessionComputer } from "./types.js"

const createSessionBody = z
  .object({
    title: z.string().max(200).optional(),
    instructions: z.string().max(20_000).optional(),
    repeats: repeatLimitsSchema.optional(),
    files: z.boolean().optional(),
    computer: z.boolean().optional(),
    desktop: z.boolean().optional(),
    desktopViews: z.array(desktopViewSchema).min(1).max(DESKTOP_VIEWS.length).optional(),
    reactions: z.boolean().optional(),
    tasks: z.boolean().optional(),
    documentNavigation: z.boolean().optional(),
    teachingNavigation: z.boolean().optional(),
    sandboxGateway: z.boolean().optional(),
    browserRecovery: z.boolean().optional(),
    owner: z.string().min(1).max(200).optional(),
    ref: z.string().min(1).max(200).optional(),
    timeZone: z.string().min(1).max(64).refine(isTimeZone, "unknown time zone").optional(),
    autoTitle: z.boolean().optional(),
    memoryOf: z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/).optional(),
    memoryScope: z.enum(["owner"]).optional(),
  })
  .strict()
const messageIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
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
    prompt: z.string().max(HEADLESS_MAX_PROMPT_CHARS),
    model: z.string().min(1).max(256).optional(),
    credentials: turnCredentialsSchema.default({}),
    attachments: z.array(z.string().regex(/^fl_[a-f0-9]{32}$/)).optional(),
    interrupt: z.boolean().optional(),
    execution: executionSchema.optional(),
  })
  .strict()
  .refine((body) => body.prompt.trim().length > 0 || (body.attachments?.length ?? 0) > 0, "prompt or attachments is required")
const abortBody = z.object({ messageId: messageIdSchema.optional() }).strict()
export const DEFAULT_READ_TURNS = 30
export const MAX_READ_TURNS = 200
const readQuery = z.object({
  expectedOwner: z.string().min(1).max(200).optional(),
  messageId: messageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(100),
  outputs: z.enum(["full", "none"]).default("full"),
  turns: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .transform((turns) => Math.min(turns ?? DEFAULT_READ_TURNS, MAX_READ_TURNS)),
  before: messageIdSchema.optional(),
})

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
    owner_memory: z.array(z.object({ path: z.string().min(1).max(200), content: z.string(), updated_at: z.number() }).strict()).max(FILE_LIMITS.maxFiles).optional(),
  })
  .strict()

export type ModelCatalog = { defaultModel: string; models: Array<{ id: string; name: string }>; verified?: boolean }

export function createApp(input: {
  store: Store
  runner: Runner
  apiToken: string
  healthConfig?: ServiceHealthConfig
  computerFleet?: ComputerFleetConfig
  models?: (modelAccess?: HeadlessModelAccess) => Promise<ModelCatalog>
  modelProbe?: ModelProbe
  events?: SessionEvents
  files?: SavedFiles
  computer?: SessionComputer
  errors?: ErrorReporter
  cells?: CellsStore
  memory?: MemoryResolver
  storage?: SessionStorage
}) {
  const { store, runner } = input
  const storage = input.storage ?? new SessionStorage(store, input.files?.blobs ?? null)
  const cells = input.cells ?? CellsStore.of(store)
  const memoryOf = input.memory ?? localMemory(store, cells)
  const ownerMemory = (sessionId: string) => {
    const session = store.getSession(sessionId)
    return session?.memoryScope === "owner" ? memoryOf(session) : null
  }

  function withMemory(id: string | null, body: SessionInput): { ok: true; input: SessionInput } | { ok: false; error: string } {
    const existing = id ? store.getSession(id) : null
    const owner = body.owner ?? existing?.owner ?? null
    const { memoryOf, ...rest } = body
    if (body.memoryScope === "owner") {
      if (memoryOf) return { ok: false, error: "invalid_request" }
      return owner ? { ok: true, input: rest } : { ok: false, error: "owner_required" }
    }
    if (!memoryOf) return { ok: true, input: body }
    if (existing?.memoryScope === "owner") return { ok: true, input: rest }
    if (memoryOf === id) return { ok: false, error: "unknown_memory_session" }
    const target = store.getSession(memoryOf)
    if (target && target.memoryScope !== "owner") return { ok: true, input: body }
    if (!target && !cells.forwardOf(memoryOf)) return { ok: false, error: "unknown_memory_session" }
    return owner ? { ok: true, input: { ...rest, memoryScope: "owner" } } : { ok: false, error: "unknown_memory_session" }
  }
  const expected = Buffer.from(input.apiToken)
  const tokenMatches = (candidate: string) => {
    const actual = Buffer.from(candidate)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const app = new Hono()

  app.use("*", async (c, next) => {
    await next()
    if (c.res.status !== 101) c.header("X-Robots-Tag", "noindex, nofollow, noarchive")
  })

  app.get("/health", (c) => c.json({ ok: true }))

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") c.header("Cache-Control", "no-store")
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")
    if (!match || !tokenMatches(match[1])) return c.json({ error: "unauthorized" }, 401)
    await next()
  })

  app.onError((error, c) => {
    console.error("[headless-runner] request failed", { path: c.req.path, error: error.message })
    if (input.errors?.enabled) void input.errors.report({ code: "request_failed", tags: { route: routePath(c), method: c.req.method }, error })
    return c.json({ error: "internal_error" }, 500)
  })

  app.get("/v1/health", (c) => serviceHealthResponse(c.req.raw, input.healthConfig))
  app.get("/v1/computers", () => computerFleetResponse(input.computerFleet, { fetch: (url, init) => fetch(url, init) }))
  app.get("/v1/computers/:source/:id", (c) => computerDetailResponse(input.computerFleet, { fetch: (url, init) => fetch(url, init) }, c.req.param("source"), c.req.param("id")))
  app.get("/v1/models", async (c) => c.json(input.models ? await input.models() : { defaultModel: "", models: [] }))
  app.post("/v1/models", bodyLimit({ maxSize: 8192 }), (c) => scopedCatalogResponse(c.req.raw, input.models))
  app.post("/v1/model-probe", bodyLimit({ maxSize: 8192 }), (c) => modelProbeResponse(c.req.raw, input.modelProbe))

  app.post("/v1/sessions/:id/desktop/:operation", async (c) => {
    const session = store.getSession(c.req.param("id"))
    if (!session?.computer || !session.desktop) return c.json({ error: "desktop_disabled" }, 403)
    const raw: unknown = await c.req.json().catch(() => null)
    c.header("Cache-Control", "no-store")
    const allows = (view: DesktopView) => !session.desktopViews || session.desktopViews.includes(view)
    try {
      if (c.req.param("operation") === "demonstration" && input.computer?.browserDemonstration) {
        if (!allows("browser")) return c.json({ error: "desktop_view_disabled" }, 403)
        const body = demonstrationCommandSchema.safeParse(raw)
        if (!body.success) return c.json({ error: "invalid_request" }, 400)
        return c.json(await input.computer.browserDemonstration(session.id, body.data))
      }
      if (c.req.param("operation") === "viewer" && input.computer?.desktopViewer) {
        const body = z.object({ view: z.enum(["browser", "computer"]), control: z.boolean(), origin: z.string().url().max(2048) }).strict().safeParse(raw)
        if (!body.success) return c.json({ error: "invalid_request" }, 400)
        if (!allows(body.data.view)) return c.json({ error: "desktop_view_disabled" }, 403)
        return c.json(await input.computer.desktopViewer(session.id, body.data))
      }
      if (c.req.param("operation") === "action" && input.computer?.desktopAction) {
        const body = z.object({ action: z.enum(["continue", "pause", "resume", "rebuild"]) }).strict().safeParse(raw)
        if (!body.success) return c.json({ error: "invalid_request" }, 400)
        return c.json(await input.computer.desktopAction(session.id, body.data.action))
      }
      return c.json({ error: "desktop_not_configured" }, 409)
    } catch (error) {
      const code = typeof error === "object" && error !== null && "desktopCode" in error && (error.desktopCode === "desktop_outdated" || error.desktopCode === "desktop_unresponsive" || error.desktopCode === "desktop_updating" || error.desktopCode === "desktop_replacing") ? error.desktopCode : "desktop_unavailable"
      console.error("[headless-runner] desktop failed", { sessionId: session.id, operation: c.req.param("operation"), code, error: error instanceof Error ? error.message : "unknown" })
      return c.json({ error: code }, 409)
    }
  })

  app.post("/v1/sessions", async (c) => {
    const body = createSessionBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    const resolved = withMemory(null, body.data)
    if (!resolved.ok) return c.json({ error: resolved.error }, 400)
    return c.json(store.createSession(resolved.input), 201)
  })

  app.get("/v1/sessions", (c) => {
    const query = listQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request", issues: query.error.issues }, 400)
    const legacy = store.listSessions(query.data.owner, query.data.limit)
    const seen = new Set(legacy.map((session) => session.id))
    const moved = cells.directorySessions(query.data.owner, query.data.limit).filter((session) => !seen.has(session.id))
    const sessions = [...legacy, ...moved].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, query.data.limit)
    return c.json({ sessions })
  })

  app.post("/v1/owner/split", (c) => c.json({ split: "not_needed" }))

  app.put("/v1/sessions/:id", async (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "invalid_session_id" }, 400)
    const body = createSessionBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    const resolved = withMemory(id.data, body.data)
    if (!resolved.ok) return c.json({ error: resolved.error }, 400)
    const { session, created } = store.putSession(id.data, resolved.input)
    return c.json(session, created ? 201 : 200)
  })

  app.get("/v1/sessions/:id", async (c) => {
    const session = store.getSession(c.req.param("id"))
    if (!session) return c.json({ error: "unknown_session" }, 404)
    const query = readQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request", issues: query.error.issues }, 400)
    if (query.data.expectedOwner !== undefined && session.owner !== query.data.expectedOwner) return c.json({ error: "unknown_session" }, 404)
    const { messageId, limit } = query.data
    let read: { turns: Turn[]; messages: StoredMessage[]; finalAssistantText: string; hasEarlier?: boolean; sealedPrompts?: Map<string, string> }
    try {
      read = messageId ? await storage.readTurn(session.id, messageId, limit) : await storage.readWindow(session.id, query.data.turns, limit, query.data.before)
    } catch (error) {
      if (error instanceof SegmentError || error instanceof LargeBodyUnavailableError) {
        console.error("[headless-runner] history unavailable", { sessionId: session.id, error: error.message })
        if (input.errors?.enabled) void input.errors.report({ code: "history_unavailable", tags: { reason: error.code }, error })
        return c.json({ error: "history_unavailable" }, 503)
      }
      throw error
    }
    const { turns } = read
    const busy = store.activeTurn(session.id, { conversation: true }) !== null
    const waiting = new Map([
      ...store.waitingPrompts(session.id, turns.filter((turn) => turn.kind === undefined && (turn.status === "queued" || turn.status === "aborted")).map((turn) => turn.messageId)),
      ...(read.sealedPrompts ?? []),
    ])
    return c.json({
      session,
      status: busy ? "busy" : "idle",
      turns: turns.map((turn) => {
        const prompt = waiting.get(turn.messageId)
        return prompt === undefined ? turn : { ...turn, prompt }
      }),
      ...(read.hasEarlier === undefined ? {} : { hasEarlier: read.hasEarlier }),
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


  app.get("/v1/sessions/:id/events", (c) => {
    const events = input.events
    if (!events) return c.json({ error: "not_supported" }, 404)
    const sessionId = c.req.param("id")
    if (c.req.header("upgrade")?.toLowerCase() === "websocket" && sessionIdSchema.safeParse(sessionId).success) {
      const socket = events.acceptSocket(sessionId)
      if (socket) return socket
    }
    return streamSSE(c, async (stream) => {
      const queue: string[] = []
      let wake: (() => void) | null = null
      let ended = false
      const unsubscribe = events.subscribe(
        sessionId,
        (event) => {
          queue.push(JSON.stringify(event))
          wake?.()
        },
        () => {
          ended = true
          wake?.()
        },
      )
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })
      try {
        await stream.writeSSE({ event: "ready", data: "{}" })
        while (!stream.aborted && !ended) {
          while (queue.length) await stream.writeSSE({ data: queue.shift() ?? "" })
          if (ended) break
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15_000)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          wake = null
          if (!queue.length && !stream.aborted && !ended) await stream.write(": keep-alive\n\n")
        }
      } finally {
        unsubscribe()
      }
    })
  })

  app.get("/v1/sessions/:id/export", async (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    if (!id.success || !store.getSession(id.data)) return c.json({ error: "unknown_session" }, 404)
    if (store.activeTurn(id.data)) return c.json({ error: "session_busy" }, 409)
    let conversation: Awaited<ReturnType<SessionStorage["exportConversation"]>>
    try {
      conversation = await storage.exportConversation(id.data)
    } catch (error) {
      if (error instanceof SegmentError || error instanceof LargeBodyUnavailableError) return c.json({ error: "history_unavailable" }, 503)
      throw error
    }
    if (!conversation) return c.json({ error: "unknown_session" }, 404)
    const shared = ownerMemory(id.data)
    let ownerFiles: Array<{ path: string; content: string; updated_at: number }> | undefined
    try {
      ownerFiles = shared ? (await shared.list()).map((file) => ({ path: file.path, content: file.content, updated_at: file.updatedAt ?? 0 })) : undefined
    } catch (error) {
      if (error instanceof MemoryUnavailableError) return c.json({ error: "memory_unavailable" }, 503)
      throw error
    }
    return c.json({ format: EXPORT_FORMAT, version: 1, ...conversation, ...(ownerFiles ? { owner_memory: ownerFiles } : {}) })
  })

  app.post("/v1/sessions/:id/import", async (c) => {
    const id = sessionIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "invalid_session_id" }, 400)
    if (store.getSession(id.data)) return c.json({ error: "session_exists" }, 409)
    const parsed = exportedConversation.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid_import", issues: parsed.error.issues }, 400)
    const { session, turns, messages, files, saved_files, owner_memory: ownerFiles } = parsed.data
    const conversation = { session, turns, messages, files, saved_files }
    const owner = typeof session.owner === "string" && session.owner ? session.owner : null
    if (ownerFiles && (!owner || ownerFiles.some((file) => normalizePath(file.path) !== file.path || !isMemoryPath(file.path)))) {
      return c.json({ error: "invalid_import", message: "Owner memory needs an owner and memory/ paths." }, 400)
    }
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
      store.transaction(() => {
        store.importConversation(conversation)
        if (owner && ownerFiles) cells.mergeOwnerMemory(owner, ownerFiles)
      })
    } catch (error) {
      return c.json({ error: "invalid_import", message: error instanceof Error ? error.message : "unknown error" }, 400)
    }
    return c.json({ id: id.data, rows: Object.fromEntries(CONVERSATION_TABLES.map((table) => [table, conversation[table].length])) }, 201)
  })

  app.delete("/v1/sessions/:id", async (c) => {
    const id = c.req.param("id")
    if (store.activeTurn(id)) return c.json({ error: "session_busy" }, 409)
    await input.computer?.delete(id).catch((error: unknown) => {
      console.error("[headless-runner] computer delete failed", { sessionId: id, error: error instanceof Error ? error.message : "unknown" })
    })
    const savedKeys = store.savedFileKeys(id)
    if (!(await storage.deleteSession(id))) return c.json({ error: "unknown_session" }, 404)
    await input.files?.deleteSession(id, savedKeys)
    return c.body(null, 204)
  })

  app.delete("/v1/sessions/:id/computer", async (c) => {
    const id = c.req.param("id")
    if (!store.getSession(id)) return c.json({ error: "unknown_session" }, 404)
    if (store.activeTurn(id)) return c.json({ error: "session_busy" }, 409)
    await input.computer?.delete(id)
    return c.body(null, 204)
  })

  app.get("/v1/files/status", (c) =>
    c.json({
      enabled: Boolean(input.files),
      kind: input.files?.blobs.kind ?? null,
      ...(input.files ? { maxFileBytes: input.files.limits.maxFileBytes, maxSessionBytes: input.files.limits.maxSessionBytes } : {}),
    }),
  )

  const uploadAllowed: MiddlewareHandler = async (c, next) => {
    if (!input.files) return c.json({ error: "files_not_configured" }, 501)
    const session = store.getSession(c.req.param("id") ?? "")
    if (!session) return c.json({ error: "unknown_session" }, 404)
    if (!session.files) return c.json({ error: "files_not_enabled", message: "This conversation was not created with files: true." }, 403)
    if (!c.req.query("name")?.trim()) return c.json({ error: "invalid_request", message: "name is required" }, 400)
    await next()
  }
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
    if (!result.ok) return c.json({ error: result.error }, result.error === "unknown_session" ? 404 : result.error === "unknown_file" || result.error === "model_required" ? 400 : result.error === "model_mismatch" ? 409 : 429)
    return c.json({ state: result.state, turn: result.turn }, 202)
  })

  app.delete("/v1/sessions/:id/turns/:messageId", async (c) => {
    const sessionId = c.req.param("id")
    if (!store.getSession(sessionId)) return c.json({ error: "unknown_session" }, 404)
    const messageId = messageIdSchema.safeParse(c.req.param("messageId"))
    if (!messageId.success) return c.json({ error: "invalid_request" }, 400)
    const removed = await storage.deleteTurns(sessionId, messageId.data, { andAfter: c.req.query("after") === "1" })
    if (removed === null) return c.json({ error: "turn_busy" }, 409)
    return c.json({ removed })
  })

  app.post("/v1/sessions/:id/abort", async (c) => {
    if (!store.getSession(c.req.param("id"))) return c.json({ error: "unknown_session" }, 404)
    const body = abortBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    return c.json({ accepted: runner.abort(c.req.param("id"), body.data.messageId) })
  })

  app.get("/v1/sessions/:id/files", async (c) => {
    if (!store.getSession(c.req.param("id"))) return c.json({ error: "unknown_session" }, 404)
    const own = store.listFiles(c.req.param("id"))
    const shared = ownerMemory(c.req.param("id"))
    if (!shared) return c.json({ files: own })
    const memory = (await shared.list()).map((file) => ({ path: file.path, size: Buffer.byteLength(file.content), updatedAt: file.updatedAt ?? 0 }))
    return c.json({ files: [...own.filter((file) => !isMemoryPath(file.path)), ...memory].sort((left, right) => left.path.localeCompare(right.path)) })
  })

  app.get("/v1/sessions/:id/files/content", async (c) => {
    const path = normalizePath(c.req.query("path") ?? "")
    if (!path) return c.json({ error: "invalid_path" }, 400)
    const shared = isMemoryPath(path) ? ownerMemory(c.req.param("id")) : null
    const content = shared ? await shared.read(path) : store.readFile(c.req.param("id"), path)
    if (content === null) return c.json({ error: "unknown_file" }, 404)
    return c.text(content)
  })

  return app
}
