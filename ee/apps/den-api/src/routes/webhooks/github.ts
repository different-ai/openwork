import { createHmac, timingSafeEqual } from "node:crypto"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { env } from "../../env.js"
import { signedWebhookRoute } from "../../middleware/index.js"
import { emptyResponse, invalidRequestSchema, jsonResponse } from "../../openapi.js"
import { enqueueGithubWebhookSync } from "../org/plugin-system/store.js"
import {
  githubWebhookAcceptedResponseSchema,
  githubWebhookIgnoredResponseSchema,
  githubWebhookPayloadSchema,
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
      summary: "GitHub webhook ingress",
      description: "Verifies a GitHub App webhook signature against the raw request body, then records any relevant sync work.",
      responses: {
        200: jsonResponse("Ignored but valid GitHub webhook delivery.", githubWebhookIgnoredResponseSchema),
        202: jsonResponse("Accepted GitHub webhook delivery.", githubWebhookAcceptedResponseSchema),
        400: jsonResponse("Malformed GitHub webhook payload.", invalidRequestSchema),
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

      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        return c.json({ error: "invalid_request", details: [{ message: "Webhook payload must be valid JSON.", path: [] }] }, 400)
      }
      const parsed = githubWebhookPayloadSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error.issues }, 400)
      }

      const payload = parsed.data
      const installationId = payload.installation?.id
      const repositoryFullName = payload.repository?.full_name
      const repositoryId = payload.repository?.id
      const ref = payload.ref
      const headSha = payload.after

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
