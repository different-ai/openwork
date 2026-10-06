import { createHmac, timingSafeEqual } from "node:crypto"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConnectorAccountTable } from "@openwork-ee/den-db/schema"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { signedWebhookRoute } from "../../middleware/index.js"
import { emptyResponse, jsonResponse } from "../../openapi.js"
import { enqueueGithubWebhookSync } from "../org/plugin-system/store.js"
import {
  githubWebhookAcceptedResponseSchema,
  githubWebhookIgnoredResponseSchema,
  githubWebhookUnauthorizedResponseSchema,
} from "../org/plugin-system/schemas.js"
import { pluginArchRoutePaths } from "../org/plugin-system/contracts.js"

export function signGithubBody(rawBody: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`
}

export function safeCompareGithubSignature(received: string, expected: string) {
  const encoder = new TextEncoder()
  const receivedBuffer = encoder.encode(received)
  const expectedBuffer = encoder.encode(expected)
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer)
}

export function registerGithubWebhookRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    pluginArchRoutePaths.githubWebhookIngress,
    describeRoute({
      tags: ["Webhooks"],
      security: [],
      summary: "GitHub webhook ingress",
      description: "Verifies a GitHub App webhook signature against the raw request body, then records any relevant sync work.",
      responses: {
        200: jsonResponse("Ignored but valid GitHub webhook delivery.", githubWebhookIgnoredResponseSchema),
        202: jsonResponse("Accepted GitHub webhook delivery.", githubWebhookAcceptedResponseSchema),
        401: jsonResponse("Invalid GitHub webhook signature.", githubWebhookUnauthorizedResponseSchema),
        503: emptyResponse("GitHub webhook secret is not configured."),
      },
    }),
    signedWebhookRoute,
    async (c) => {
      const secret = env.githubConnectorApp.webhookSecret
      if (!secret) {
        return c.body(null, 503)
      }

      const rawBody = await c.req.raw.text()
      const signature = c.req.raw.headers.get("x-hub-signature-256")?.trim() ?? ""
      if (!signature) {
        return c.json({ ok: false, error: "invalid signature" }, 401)
      }

      const expected = signGithubBody(rawBody, secret)
      if (!safeCompareGithubSignature(signature, expected)) {
        return c.json({ ok: false, error: "invalid signature" }, 401)
      }

      const event = c.req.raw.headers.get("x-github-event")?.trim() ?? ""
      const deliveryId = c.req.raw.headers.get("x-github-delivery")?.trim() ?? ""
      if (!event || !deliveryId) {
        return c.json({ ok: true, accepted: false, reason: "event ignored" }, 200)
      }

      const normalizedEvent = event === "push" || event === "installation" || event === "installation_repositories" || event === "repository"
        ? event
        : null
      if (!normalizedEvent) {
        return c.json({ ok: true, accepted: false, reason: "event ignored" }, 200)
      }

      const payload = JSON.parse(rawBody) as Record<string, unknown>
      const installationId = payload.installation && typeof payload.installation === "object" && typeof (payload.installation as Record<string, unknown>).id === "number"
        ? (payload.installation as Record<string, unknown>).id as number
        : undefined
      const repository = payload.repository && typeof payload.repository === "object" ? payload.repository as Record<string, unknown> : null
      const repositoryFullName = typeof repository?.full_name === "string" ? repository.full_name : undefined
      const repositoryId = typeof repository?.id === "number" ? repository.id : undefined
      const ref = typeof payload.ref === "string" ? payload.ref : undefined
      const headSha = typeof payload.after === "string" ? payload.after : undefined

      // Signature verified: our stored connector accounts for this installation
      // name the organization. One installation linked to several organizations
      // has no single tenant, so such deliveries stay in the platform store.
      if (installationId !== undefined) {
        const accounts = await db
          .select({ organizationId: ConnectorAccountTable.organizationId })
          .from(ConnectorAccountTable)
          .where(and(eq(ConnectorAccountTable.connectorType, "github"), eq(ConnectorAccountTable.remoteId, String(installationId))))
        const organizationIds = [...new Set(accounts.map((account) => account.organizationId))]
        if (organizationIds.length === 1 && organizationIds[0]) {
          const audited = await attributeAuditRequest(c, { organizationId: organizationIds[0], ...auditServiceAttribution("github", null), origin: "webhook" })
          if (!audited.ok) return audited.response
        }
      }

      const accepted = await enqueueGithubWebhookSync({
        deliveryId,
        event: normalizedEvent,
        headSha,
        installationId,
        payload,
        ref,
        repositoryFullName,
        repositoryId,
      })

      if (!accepted.accepted) {
        return c.json({ ok: true, accepted: false, reason: accepted.reason }, 200)
      }

      return c.json({ ok: true, accepted: true, deliveryId, event: normalizedEvent, queued: accepted.queued }, 202)
    },
  )
}
