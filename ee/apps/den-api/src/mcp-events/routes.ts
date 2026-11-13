import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { jsonResponse } from "../openapi.js"
import { signedWebhookRoute } from "../middleware/index.js"
import { attributeAuditRequest, auditServiceAttribution } from "../audit/request-capture.js"
import { eventAccess, EventAccessError } from "./context.js"
import { acceptControl, acceptEvent, findSubscription } from "./repository.js"
import { receiveMcpEvent } from "./receiver.js"

export function registerMcpEventRoutes<T extends Env>(app: Hono<T>) {
  app.post("/v1/mcp-events/webhooks/:subscriptionId", describeRoute({
    tags: ["Webhooks"], summary: "Receive a signed MCP event for a hosted chat", security: [],
    description: "Standard Webhooks signatures over the raw body authenticate a previously registered subscription. Feature-gated, bounded, and deduplicated before acknowledgement. This endpoint is not an MCP tool.",
    responses: {
      200: jsonResponse("Signed verification challenge.", z.object({ challenge: z.string() })),
      202: { description: "Durably accepted, including a duplicate event." },
      400: { description: "Invalid event or subscription identity." }, 401: { description: "Invalid signature or timestamp." },
      404: { description: "Unknown subscription." }, 410: { description: "Subscription expired, stopped or unavailable." },
      413: { description: "Body exceeds 256 KiB or the complete event prompt exceeds 100,000 characters." }, 503: { description: "Not durably accepted; retry later." },
    },
  }), signedWebhookRoute, (c) => receiveMcpEvent(c.req.raw, c.req.param("subscriptionId"), {
    find: async (id) => {
      const subscription = /^[a-f0-9]{48}$/.test(id) ? await findSubscription(id) : null
      // Internal sources enter the receipt queue directly and have no public webhook credential.
      return subscription?.source === "connection" ? subscription : null
    },
    enabled: async (subscription) => {
      try { return (await eventAccess(subscription, subscription.scopes)).connections.some((connection) => connection.id === subscription.connectionId) } catch (error) { if (error instanceof EventAccessError) return false; throw error }
    },
    acceptControl: async (subscription, control, deliveryId) => {
      const audited = await attributeAuditRequest(c, { organizationId: subscription.organizationId, ...auditServiceAttribution("mcp_event", subscription.connectionId) })
      if (!audited.ok) throw new Error("Audit unavailable")
      await acceptControl(subscription, control, deliveryId)
    },
    accept: async (subscription, event) => {
      const audited = await attributeAuditRequest(c, { organizationId: subscription.organizationId, ...auditServiceAttribution("mcp_event", subscription.connectionId) })
      if (!audited.ok) throw new Error("Audit unavailable")
      await acceptEvent(subscription, event)
    },
  }))
}
