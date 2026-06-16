import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { signedWebhookRoute } from "../../middleware/index.js"
import { handleStripeWebhook } from "../../stripe-billing.js"
import { jsonResponse } from "../../openapi.js"

const stripeWebhookResponseSchema = z.object({
  received: z.literal(true),
  type: z.string(),
}).meta({ ref: "StripeWebhookResponse" })

export function registerStripeWebhookRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/v1/webhooks/stripe",
    describeRoute({
      tags: ["Webhooks"],
      hide: true,
      summary: "Stripe webhook ingress",
      responses: {
        200: jsonResponse("Stripe webhook processed successfully.", stripeWebhookResponseSchema),
      },
    }),
    signedWebhookRoute,
    async (c) => {
      const payload = await c.req.raw.text()
      const signature = c.req.raw.headers.get("stripe-signature")
      try {
        return c.json(await handleStripeWebhook({ payload, signature }))
      } catch (error) {
        const message = error instanceof Error ? error.message : "stripe_webhook_failed"
        const status = message.includes("missing") || message.includes("signature") ? 400 : 500
        return c.json({ error: message }, status)
      }
    },
  )
}
