import { z } from "zod"
import { HEADLESS_MAX_PROMPT_CHARS } from "@openwork-ee/headless-protocol"
import { controlSchema, eventPrompt, eventSchema, MAX_EVENT_BYTES, verifyWebhook, type McpEvent, type McpEventControl } from "./protocol.js"

export type WebhookSubscription = { id: string; name: string; connectionId: string | null; instruction: string; remoteId: string | null; secret: string; status: string; expiresAt: Date }
export type WebhookDeps<S extends WebhookSubscription> = {
  find: (id: string) => Promise<S | null>
  enabled: (subscription: S) => Promise<boolean>
  /** Commit the receipt before resolving. A unique subscription/event key makes retries harmless. */
  accept: (subscription: S, event: McpEvent) => Promise<void>
  acceptControl: (subscription: S, control: McpEventControl, deliveryId: string) => Promise<void>
  now?: () => number
}
const verificationSchema = z.object({ type: z.literal("verification"), challenge: z.string().min(1).max(8192) })

export async function receiveMcpEvent<S extends WebhookSubscription>(request: Request, id: string, deps: WebhookDeps<S>): Promise<Response> {
  const reply = (status: number) => new Response(null, { status })
  try {
    const subscription = await deps.find(id)
    if (!subscription) return reply(404)
    const now = deps.now?.() ?? Date.now()
    if (!["pending", "active", "terminated"].includes(subscription.status) || subscription.expiresAt.getTime() <= now || !await deps.enabled(subscription)) return reply(410)
    const reader = request.body?.getReader()
    if (!reader) return reply(400)
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_EVENT_BYTES) { await reader.cancel(); return reply(413) }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(Buffer.concat(chunks, length))
    if (!verifyWebhook(subscription.secret, request.headers, bytes, now)) return reply(401)
    let body: unknown
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { return reply(400) }
    const verification = verificationSchema.safeParse(body)
    if (verification.success) return Response.json({ challenge: verification.data.challenge })
    // The server can race its subscribe response. Ask it to retry after the remote identity is committed.
    if (subscription.status === "pending") return reply(503)
    if (request.headers.get("x-mcp-subscription-id") !== subscription.remoteId) return reply(400)
    if (typeof body === "object" && body !== null && "type" in body) {
      const control = controlSchema.safeParse(body)
      if (!control.success) return reply(400)
      if (subscription.status === "terminated" && control.data.type !== "terminated") return reply(410)
      if (eventPrompt(subscription.instruction, subscription, control.data).length > HEADLESS_MAX_PROMPT_CHARS) return reply(413)
      await deps.acceptControl(subscription, control.data, request.headers.get("webhook-id")!)
      return reply(202)
    }
    if (subscription.status === "terminated") return reply(410)
    const event = eventSchema.safeParse(body)
    if (!event.success || event.data.name !== subscription.name || request.headers.get("x-mcp-subscription-id") !== subscription.remoteId) return reply(400)
    // Do not acknowledge an event the thread harness can never admit. Include the saved instruction and envelope.
    if (eventPrompt(subscription.instruction, subscription, event.data).length > HEADLESS_MAX_PROMPT_CHARS) return reply(413)
    await deps.accept(subscription, event.data)
    return reply(202)
  } catch {
    // No body, secret or provider exception goes into a response/log. A failed durable write must be retried.
    return reply(503)
  }
}
