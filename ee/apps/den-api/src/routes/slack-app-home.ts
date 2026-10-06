import { createHmac, timingSafeEqual } from "node:crypto"
import type { Env, Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../env.js"

const verificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(256),
  team_id: z.string().optional(),
})

const homeEventSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().regex(/^T[A-Z0-9]{1,63}$/),
  event_id: z.string().min(1).max(128),
  event: z.object({
    type: z.literal("app_home_opened"),
    user: z.string().regex(/^[UW][A-Z0-9]{1,63}$/),
    tab: z.literal("home"),
  }),
})
const authSchema = z.object({ ok: z.literal(true), team_id: z.string(), bot_id: z.string().min(1) })
const publishedSchema = z.object({ ok: z.literal(true) })

function homeView() {
  // Existing member connection-management route; no account/token identifiers in the link.
  const connectionsUrl = new URL("/dashboard/your-connections", env.betterAuthUrl).toString()
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "OpenWork Connect" } },
      { type: "section", fields: [
        { type: "mrkdwn", text: "*Read access*\nOnly conversations you authorize" },
        { type: "mrkdwn", text: "*Posting and replies*\nNot supported" },
      ] },
      { type: "context", elements: [{ type: "plain_text", text: "Account connection not verified here." }] },
      // A plain link needs no interactive callbacks or message permissions.
      { type: "section", text: { type: "mrkdwn", text: `<${connectionsUrl}|Manage connections>` } },
    ],
  }
}

class BodyTooLarge extends Error {}

async function boundedBody(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!stream) return Buffer.alloc(0)
  const reader = stream.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) return Buffer.concat(chunks, size)
      size += chunk.value.byteLength
      if (size > maxBytes) throw new BodyTooLarge()
      chunks.push(chunk.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

async function slackRequest(method: "auth.test" | "views.publish", token: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(`${env.slackApiBaseUrl.replace(/\/$/, "")}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error("Slack Home unavailable")
  }
  const data: unknown = JSON.parse((await boundedBody(response.body, 64 * 1024, signal)).toString("utf8"))
  return data
}

/**
 * Slack-signed public webhook, deliberately absent from the agent capability catalog.
 * The app passes its existing signedWebhookRoute policy marker so this standalone
 * signature boundary does not import the member-auth/database dependency graph.
 */
export function registerSlackAppHomeRoutes<E extends Env>(
  app: Hono<E>,
  signedWebhookRoute: MiddlewareHandler<E>,
  homeToken: (workspaceId: string, signal: AbortSignal) => Promise<string | null>,
  homePolicy: () => Promise<{ kind: "policy_blocked" } | null>,
) {
  const deliveries = new Map<string, number>()
  let publicationsInFlight = 0
  app.post("/v1/slack/events", describeRoute({ hide: true, security: [] }), signedWebhookRoute, async (c) => {
    c.header("Cache-Control", "no-store")
    c.header("X-Slack-No-Retry", "1")
    const deadline = AbortSignal.timeout(2000)
    const clientId = env.slackClientId
    const clientSecret = env.slackClientSecret
    const timestamp = c.req.header("x-slack-request-timestamp") ?? ""
    const signature = c.req.header("x-slack-signature") ?? ""
    const secret = env.slackSigningSecret
    if (!secret || !/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signature)) {
      return c.json({ error: "invalid_signature" }, 401)
    }
    let body: Buffer
    try {
      body = await boundedBody(c.req.raw.body, 32 * 1024, deadline)
    } catch (error) {
      return c.json({ error: "invalid_body" }, error instanceof BodyTooLarge ? 413 : deadline.aborted ? 408 : 400)
    }
    const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(new Uint8Array(body)).digest()
    if (!timingSafeEqual(new Uint8Array(expected), new Uint8Array(Buffer.from(signature.slice(3), "hex")))) return c.json({ error: "invalid_signature" }, 401)
    let payload: unknown
    try {
      payload = JSON.parse(body.toString("utf8"))
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    if (secret !== env.slackSigningSecret) return c.json({ error: "policy_blocked" }, 403)
    const verification = verificationSchema.safeParse(payload)
    if (verification.success) {
      // App-level endpoint verification grants no organization/member access.
      // It can run before any org opts in; no feature-table read precedes HMAC.
      return c.json({ challenge: verification.data.challenge })
    }
    const event = homeEventSchema.safeParse(payload)
    if (!event.success) return c.json({ error: "unsupported_event" }, 400)
    for (const [id, expiresAt] of deliveries) if (expiresAt < Date.now()) deliveries.delete(id)
    const deliveryId = `${event.data.team_id}:${event.data.event_id}`
    if (deliveries.has(deliveryId)) return c.json({ ok: true })
    if (deliveries.size >= 256 || publicationsInFlight >= 4) return c.json({ error: "delivery_limit" }, 429)
    deliveries.set(deliveryId, Number(timestamp) * 1000 + 300_000)
    publicationsInFlight++
    let cancelTokenWait: (() => void) | undefined
    // Keep storage work counted until it actually settles: SQL acquisition and
    // row-lock waits cannot be cancelled by racing the HTTP response deadline.
    const publication = (async () => {
      // Feature DB work belongs inside the existing deadline/concurrency bound,
      // after signature verification, never on unauthenticated requests.
      if (await homePolicy()) return c.json({ error: "policy_blocked" }, 403)
      deadline.throwIfAborted()
      const botToken = await homeToken(event.data.team_id, deadline)
      deadline.throwIfAborted()
      if (!botToken) return c.json({ error: "home_unavailable" }, 503)
      const identity = authSchema.parse(await slackRequest("auth.test", botToken, {}, deadline))
      if (await homePolicy() || identity.team_id !== event.data.team_id || secret !== env.slackSigningSecret
        || clientId !== env.slackClientId || clientSecret !== env.slackClientSecret) return c.json({ error: "policy_blocked" }, 403)
      publishedSchema.parse(await slackRequest("views.publish", botToken, { user_id: event.data.event.user, view: homeView() }, deadline))
      return c.json({ ok: true })
    })().finally(() => { publicationsInFlight-- })
    try {
      // Storage/refresh is inside the same response deadline as Slack HTTP.
      return await Promise.race([publication, new Promise<never>((_resolve, reject) => {
        cancelTokenWait = () => reject(new Error("Slack Home timed out"))
        deadline.addEventListener("abort", cancelTokenWait, { once: true })
      })])
    } catch {
      return c.json({ error: "home_unavailable" }, deadline.aborted ? 504 : 502)
    } finally {
      if (cancelTokenWait) deadline.removeEventListener("abort", cancelTokenWait)
    }
  })
}
