import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { signedWebhookRoute } from "../../middleware/index.js"
import { captureException } from "../../observability/runtime.js"
import { handleStripeWebhook, StripeWebhookAuditBlockedError } from "../../stripe-billing.js"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
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
      security: [],
      hide: true,
      summary: "Stripe webhook ingress",
      responses: {
        200: jsonResponse("Stripe webhook processed successfully.", stripeWebhookResponseSchema),
        503: jsonResponse("Managed Models policy is unavailable.", z.object({ error: z.string(), message: z.string() })),
      },
    }),
    signedWebhookRoute,
    async (c) => {
      const payload = await c.req.raw.text()
      const signature = c.req.raw.headers.get("stripe-signature")
      let auditBlocked: Response | null = null
      try {
        return c.json(await handleStripeWebhook({ payload, signature }, {
          // Signature verified and our subscription row maps the event: attribute
          // to that organization before applying it (after, for a first checkout).
          onOrganization: async (organizationId, phase) => {
            const audited = await attributeAuditRequest(c, { organizationId, ...auditServiceAttribution("stripe", null), origin: "webhook", phase })
            if (audited.ok) return true
            auditBlocked = audited.response
            return false
          },
        }))
      } catch (error) {
        if (error instanceof StripeWebhookAuditBlockedError) {
          return auditBlocked ?? c.json({ error: "audit_unavailable" }, 503)
        }
        if (error instanceof ManagedModelsPolicyError) {
          return c.json({ error: error.code, message: error.message }, error.status)
        }
        const message = error instanceof Error ? error.message : "stripe_webhook_failed"
        const status = message.includes("missing") || message.includes("signature") ? 400 : 500
        if (status === 500) {
          // This local catch converts the error into a response before the
          // observability middleware can see it, so report it explicitly:
          // a silently failing Stripe webhook desynchronizes billing state.
          captureException(error, { component: "stripe_webhook" })
        }
        return c.json({ error: message }, status)
      }
    },
  )
}
