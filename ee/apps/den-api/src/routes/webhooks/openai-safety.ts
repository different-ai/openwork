import type { Env, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { verifyWebhook } from "../../mcp-events/protocol.js"
import { signedWebhookRoute } from "../../middleware/index.js"
import { providerCaseId, importCase } from "../../openai-safety/cases.js"

const eventSchema = z.object({ type: z.string(), id: z.string().min(1), object: z.literal("event"), data: z.unknown() })
const dataSchema = z.object({ id: providerCaseId })
export function registerOpenAiSafetyWebhook<T extends Env>(app: Hono<T>) {
  app.post("/v1/webhooks/openai/safety", describeRoute({ tags: ["Webhooks"], security: [], summary: "Receive an OpenAI safety notice",
    description: "Verifies the signed event and retrieves the case using the configured organization's Safety Read key. Duplicate notices preserve local decisions.",
    responses: { 204: { description: "Case recorded or unrelated event ignored." }, 400: { description: "Invalid safety event." },
      401: { description: "Signature verification failed." }, 413: { description: "Event too large." },
      503: { description: "Configuration, case lookup or storage unavailable. Retry delivery." } } }),
    signedWebhookRoute, bodyLimit({ maxSize: 16_384 }), async c => {
      const secret = env.openaiSafety.webhookSecret
      if (!secret || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6), "base64").length < 16) return c.body(null, 503)
      const raw = new Uint8Array(await c.req.raw.arrayBuffer())
      if (!verifyWebhook(secret, c.req.raw.headers, raw)) return c.body(null, 401)
      let payload: unknown
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) } catch { return c.body(null, 400) }
      const event = eventSchema.safeParse(payload)
      if (!event.success) return c.body(null, 400)
      const type = event.data.type
      if (type !== "safety.warning_issued" && type !== "safety.deactivation_issued") return c.body(null, 204)
      const data = dataSchema.safeParse(event.data.data)
      if (!data.success) return c.body(null, 400)
      try { await importCase(data.data.id, type === "safety.warning_issued" ? "warning" : "deactivation") }
      catch { return c.body(null, 503) }
      return c.body(null, 204)
    })
}
