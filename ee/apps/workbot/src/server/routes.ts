import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createWorkbot, toWorkbotPageEvent, WorkbotFilesUnavailableError, WorkbotUnavailableError, type WorkbotActor } from "@openwork-ee/workbot-server"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { AppEnv, Member } from "./auth.js"
import type { Config } from "./config.js"
import type { Den } from "./den.js"

/**
 * The Workbot API the page talks to (`/v1/workbot/...`). Every route needs a signed-in member, and Den's answer
 * that Workbot is on for their workspace; the conversation itself lives on the headless runner, created with
 * files and a computer.
 */

const fileIdSchema = z.string().regex(/^fl_[a-f0-9]{32}$/)
const sendSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    text: z.string().trim().max(20_000),
    timeZone: z.string().max(64).optional(),
    attachments: z.array(fileIdSchema).max(20).optional(),
  })
  .strict()
const editSchema = z
  .object({
    newId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    text: z.string().trim().max(20_000),
    timeZone: z.string().max(64).optional(),
    attachments: z.array(fileIdSchema).max(20).optional(),
  })
  .strict()
const uploadQuerySchema = z.object({ name: z.string().trim().min(1).max(255), timeZone: z.string().max(64).optional() })
const threadQuerySchema = z.object({ turns: z.coerce.number().int().min(1).max(200).optional() })
/** Raster images open inline (thumbnails); everything else always downloads, so no file renders as a page. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
/** The stream ends after this and the page reopens it, so a held-open stream notices a revoked membership. */
const EVENTS_MAX_MS = 170_000
/** Matches the runner's per-file limit; a bigger upload is refused before it is read. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Plenty for a person typing; stops a runaway script from spending the organization's model budget. */
const MESSAGES_PER_WINDOW = 30
const MESSAGE_WINDOW_MS = 10 * 60_000
const RUN_TOKEN_TTL_MS = 60 * 60_000

function actorOf(member: Member): WorkbotActor {
  const { den } = member
  const firstName = den.user.name?.trim().split(/\s+/)[0] ?? null
  return {
    organizationId: den.organization.id,
    organizationName: den.organization.name,
    organizationMetadata: den.organization.brandAppName ? { brandAppName: den.organization.brandAppName } : {},
    memberId: den.memberId,
    userId: den.user.id,
    firstName: firstName || null,
  }
}

export function registerWorkbotRoutes(app: Hono<AppEnv>, input: { config: Config; den: Den; member: MiddlewareHandler<AppEnv>; sameOrigin: MiddlewareHandler }) {
  const { config, den } = input
  const sent = new Map<string, number[]>()

  /** Workbot bound to this person: their runner conversation, and turn tokens Den mints for them. */
  const workbotFor = (member: Member) =>
    createWorkbot({
      client: createHeadlessRunnerClient({
        config: config.runner,
        fetch,
        mintToken: async () => ({ token: await den.runToken(member.accessToken) }),
        maxTokenTtlMs: RUN_TOKEN_TTL_MS,
      }),
      canSchedule: async () => member.den.canSchedule,
    })

  const enabled = (c: Context<AppEnv>) => c.get("member").den.enabled
  const rateLimited = (memberId: string) => {
    const now = Date.now()
    const recent = (sent.get(memberId) ?? []).filter((at) => now - at < MESSAGE_WINDOW_MS)
    if (recent.length >= MESSAGES_PER_WINDOW) {
      sent.set(memberId, recent)
      return Math.ceil(((recent[0] ?? now) + MESSAGE_WINDOW_MS - now) / 1000)
    }
    sent.set(memberId, [...recent, now])
    return null
  }

  app.use("/v1/workbot/*", input.sameOrigin, input.member)
  app.use("/v1/workbot", input.sameOrigin, input.member)

  app.get("/v1/workbot/me", async (c) => {
    const { den: who } = c.get("member")
    return c.json({
      name: who.user.name,
      email: who.user.email,
      organizationName: who.organization.name,
      enabled: who.enabled,
      denUrl: config.denWebUrl ?? (await den.webUrl().catch(() => null)),
    })
  })

  /** Leaving the welcome screen: Workbot starts the conversation with its own hello. */
  app.post("/v1/workbot/hello", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const body = z.object({ timeZone: z.string().min(1).max(100).optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request" }, 400)
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).hello(actorOf(member), body.data))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  /** The everyday apps to connect on the welcome screen; connecting happens in Den, in a new tab. */
  app.get("/v1/workbot/connections", async (c) => {
    const member = c.get("member")
    const connections = await den.connections(member.accessToken).catch(() => null)
    if (!connections) return c.json({ connections: [] })
    const denWeb = config.denWebUrl ?? (await den.webUrl().catch(() => null))
    return c.json({
      connections: connections.map((connection) => ({
        ...connection,
        // Den's own link, at the Den web origin this Workbot is configured with.
        connectUrl: connection.ready || !denWeb ? connection.connectUrl : `${denWeb}/dashboard/your-connections?connectionId=${encodeURIComponent(connection.id)}`,
      })),
    })
  })

  app.get("/v1/workbot", async (c) => {
    if (!enabled(c)) return c.json({ available: false as const, reason: "workbot_not_enabled" as const })
    const query = threadQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request" }, 400)
    const member = c.get("member")
    try {
      return c.json({ available: true as const, ...(await workbotFor(member).readThread(actorOf(member), { turns: query.data.turns })) })
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ available: false as const, reason: error.code })
      throw error
    }
  })

  app.post("/v1/workbot/messages", async (c) => {
    const body = sendSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid_request" }, 400)
    if (!body.data.text && !body.data.attachments?.length) return c.json({ error: "invalid_request", message: "Send text or a file." }, 400)
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    const retryAfter = rateLimited(member.den.memberId)
    if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
    try {
      const result = await workbotFor(member).send(actorOf(member), body.data)
      if (!result.ok) return c.json({ error: result.code }, result.code === "unknown_file" ? 400 : 429)
      return c.json({ ok: true as const }, 202)
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/stop", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).stop(actorOf(member)))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  /** Deletes one of the person's messages and Workbot's answer to it. */
  app.delete("/v1/workbot/messages/:id", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    try {
      const result = await workbotFor(member).deleteMessage(actorOf(member), c.req.param("id"))
      if (!result.ok) return c.json({ error: result.code }, result.code === "busy" ? 409 : 404)
      return c.json({ ok: true as const })
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  /** Edits one of the person's messages: what came after it is replaced by Workbot's answer to the edit. */
  app.post("/v1/workbot/messages/:id/edit", async (c) => {
    const body = editSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid_request" }, 400)
    if (!body.data.text && !body.data.attachments?.length) return c.json({ error: "invalid_request", message: "Send text or a file." }, 400)
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    const retryAfter = rateLimited(member.den.memberId)
    if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
    try {
      const result = await workbotFor(member).editMessage(actorOf(member), { id: c.req.param("id"), ...body.data })
      if (!result.ok) {
        const status = result.code === "busy" ? 409 : result.code === "unknown_message" ? 404 : result.code === "unknown_file" ? 400 : 429
        return c.json({ error: result.code }, status)
      }
      return c.json({ ok: true as const }, 202)
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/tasks/:taskId/stop", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).stopTask(actorOf(member), c.req.param("taskId")))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.get("/v1/workbot/events", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    const upstream = new AbortController()
    const opened = await workbotFor(member).openEvents(actorOf(member), upstream.signal).catch(() => null)
    if (!opened?.body) return c.json({ error: "workbot_runner_unavailable" }, 409)
    const body = opened.body
    c.header("Cache-Control", "no-cache, no-transform")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => upstream.abort())
      const deadline = setTimeout(() => upstream.abort(), EVENTS_MAX_MS)
      const reader = body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      try {
        await stream.writeSSE({ event: "ready", data: "{}" })
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stream.aborted) break
          buffer += value
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf("\n\n")
            if (block.startsWith(":")) {
              await stream.write(": keep-alive\n\n")
              continue
            }
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            let parsed: unknown = null
            try {
              parsed = JSON.parse(data)
            } catch {
              continue
            }
            // Only this person's Workbot turns, under the page's own ids.
            const event = toWorkbotPageEvent(parsed)
            if (event) await stream.writeSSE({ data: JSON.stringify(event) })
          }
        }
      } catch {
        // The page reconnects; nothing to report.
      } finally {
        clearTimeout(deadline)
        upstream.abort()
        reader.releaseLock()
      }
    })
  })

  app.post(
    "/v1/workbot/files",
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: "file_too_large", message: "The most a file can be is 100 MB." }, 413) }),
    async (c) => {
      const query = uploadQuerySchema.safeParse(c.req.query())
      if (!query.success) return c.json({ error: "invalid_request" }, 400)
      if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
      const member = c.get("member")
      try {
        const file = await workbotFor(member).uploadFile(actorOf(member), {
          name: query.data.name,
          mediaType: c.req.header("content-type") ?? "application/octet-stream",
          bytes: await c.req.arrayBuffer(),
          timeZone: query.data.timeZone,
        })
        return c.json(file, 201)
      } catch (error) {
        if (error instanceof WorkbotFilesUnavailableError) return c.json({ error: "workbot_files_not_configured" }, 409)
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.get("/v1/workbot/files", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).listFiles(actorOf(member)))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.get("/v1/workbot/files/:fileId/preview", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    if (!fileId.success || !enabled(c)) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const manifest = await workbotFor(member).readPreview(actorOf(member), fileId.data).catch(() => null)
    return manifest ? c.json(manifest, 200) : c.json({ error: "not_found" }, 404)
  })

  app.get("/v1/workbot/files/:fileId/preview/:page", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    const page = z.coerce.number().int().min(1).max(1_000).safeParse(c.req.param("page"))
    if (!fileId.success || !page.success || !enabled(c)) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const upstream = await workbotFor(member).downloadPreviewPage(actorOf(member), fileId.data, page.data).catch(() => null)
    if (!upstream?.body) return c.json({ error: "not_found" }, 404)
    const length = upstream.headers.get("content-length")
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "image/png",
        ...(length ? { "content-length": length } : {}),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    })
  })

  app.get("/v1/workbot/files/:fileId", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    if (!fileId.success || !enabled(c)) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const upstream = await workbotFor(member).downloadFile(actorOf(member), fileId.data).catch(() => null)
    if (!upstream?.body) return c.json({ error: "not_found" }, 404)
    const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream"
    const encodedName = upstream.headers.get("x-file-name") ?? "file"
    let name = "file"
    try {
      name = decodeURIComponent(encodedName)
    } catch {
      // keep the fallback
    }
    const inline = c.req.query("inline") === "1" && INLINE_TYPES.has(type)
    const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
    const length = upstream.headers.get("content-length")
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": inline ? type : type.startsWith("text/") || type === "image/svg+xml" ? "application/octet-stream" : type,
        ...(length ? { "content-length": length } : {}),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    })
  })

  app.delete("/v1/workbot/files/:fileId", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    if (!fileId.success || !enabled(c)) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const deleted = await workbotFor(member).deleteFile(actorOf(member), fileId.data).catch(() => false)
    return deleted ? c.body(null, 204) : c.json({ error: "not_found" }, 404)
  })
}
