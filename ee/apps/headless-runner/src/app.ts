import { timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import { normalizePath } from "./files.js"
import type { Runner } from "./runner.js"
import type { Store } from "./store.js"
import { ACTIVE, turnCredentialsSchema } from "./types.js"

const createSessionBody = z
  .object({ title: z.string().max(200).optional(), instructions: z.string().max(20_000).optional() })
  .strict()
const messageIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
/** Caller-chosen session ids share the runner's `hs_` prefix so they can never collide with other ids. */
const sessionIdSchema = z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/)
const sendBody = z
  .object({
    messageId: messageIdSchema,
    prompt: z.string().min(1).max(100_000),
    model: z.string().min(1).max(256).optional(),
    credentials: turnCredentialsSchema.default({}),
  })
  .strict()
const abortBody = z.object({ messageId: messageIdSchema.optional() }).strict()
const readQuery = z.object({
  messageId: messageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export type ModelCatalog = { defaultModel: string; models: Array<{ id: string; name: string }> }

export function createApp(input: {
  store: Store
  runner: Runner
  apiToken: string
  /** Models a caller may pick per turn; without it only the default is listed. */
  models?: () => Promise<ModelCatalog>
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
    const turns = store.listTurns(session.id)
    const target = query.data.messageId ?? turns.at(-1)?.messageId
    const all = store.messages(session.id)
    const scoped = query.data.messageId ? all.filter((entry) => entry.messageId === query.data.messageId) : all
    const finalAssistantText = all
      .filter((entry) => entry.messageId === target && entry.message.role === "assistant")
      .flatMap((entry) => (entry.message.role === "assistant" && entry.message.text ? [entry.message.text] : []))
      .join("\n\n")
    return c.json({
      session,
      status: turns.some((turn) => ACTIVE.has(turn.status)) ? "busy" : "idle",
      turns,
      // Image data stays in the store; callers poll this, so they get a count instead.
      messages: scoped.slice(-query.data.limit).map((entry) => {
        const { seq, messageId, message } = entry
        if (message.role !== "tool" || !message.images) return { seq, messageId, ...message }
        const { images, ...rest } = message
        return { seq, messageId, ...rest, imageCount: images.length }
      }),
      finalAssistantText,
    })
  })

  app.delete("/v1/sessions/:id", (c) => {
    const id = c.req.param("id")
    if (store.activeTurn(id)) return c.json({ error: "session_busy" }, 409)
    return store.deleteSession(id) ? c.body(null, 204) : c.json({ error: "unknown_session" }, 404)
  })

  app.post("/v1/sessions/:id/turns", async (c) => {
    const body = sendBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400)
    const result = runner.send({ sessionId: c.req.param("id"), ...body.data })
    if (!result.ok) return c.json({ error: result.error }, result.error === "unknown_session" ? 404 : 429)
    return c.json({ state: result.state, turn: result.turn }, 202)
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
