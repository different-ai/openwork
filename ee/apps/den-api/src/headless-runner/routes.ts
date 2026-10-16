import * as crypto from "node:crypto"
import type { Env, Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { attributeAuditRequest, auditServiceAttribution } from "../audit/request-capture.js"
import { env } from "../env.js"
import { tokenRoute } from "../middleware/index.js"
import { appLogger } from "../observability/logger.js"
import { jsonResponse } from "../openapi.js"
import { activeHeadlessResumeGrantMember, exchangeHeadlessResumeGrant, findHeadlessResumeGrant } from "./resume-grants.js"

/**
 * The headless runner's one call back into Den: exchanging a turn's resume grant (feature `headlessDurableTurns`)
 * for a fresh member-scoped MCP token, so it can continue the turn after a restart or refresh a long turn's token.
 * Authenticated with DEN_HEADLESS_RUNNER_CALLBACK_TOKEN (404 when unset). Internal: not in the published API document
 * and never an MCP capability. Never log the grant or the token.
 */

const logger = appLogger.child({ component: "headless_resume_token" })

type HeadlessRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeHeadlessRoute = (options: HeadlessRouteOptions) => describeRoute(options)

const exchangeBodySchema = z.object({
  grant: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
}).strict()

const exchangeResponseSchema = z.object({ mcpToken: z.string(), expiresAt: z.iso.datetime(), readOnly: z.boolean() })
const exchangeErrorSchema = z.object({
  error: z.enum([
    "not_found",
    "unauthorized",
    "invalid_request",
    "grant_invalid",
    "grant_expired",
    "grant_revoked",
    "grant_mismatch",
    "membership_inactive",
    "feature_disabled",
    "exchange_failed",
  ]),
})
const rateLimitedSchema = z.object({ error: z.literal("rate_limited"), retryAfterMs: z.number().int().positive() })

/** Compares digests, so neither the value nor its length leaks through timing. */
function sameSecret(presented: string, expected: string) {
  const left = new Uint8Array(crypto.createHash("sha256").update(presented).digest())
  const right = new Uint8Array(crypto.createHash("sha256").update(expected).digest())
  return crypto.timingSafeEqual(left, right)
}

function bearer(header: string | undefined) {
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
}

export function registerHeadlessRunnerRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/v1/headless/resume-token",
    describeHeadlessRoute({
      tags: ["Internal"],
      "x-mcp": false,
      operationId: "exchangeHeadlessResumeGrant",
      security: [{ headlessRunnerCallbackToken: [] }],
      summary: "Exchange a headless turn's resume grant for a fresh MCP token",
      description:
        "For the headless runner only, with `Authorization: Bearer $DEN_HEADLESS_RUNNER_CALLBACK_TOKEN`. Body `{ grant, sessionId, messageId }`. Exchanges the resume grant Den minted with a turn for a fresh member-scoped MCP token (at most an hour, same read-only setting) for that turn, its background tasks and their reports, while the member is still active and `headlessDurableTurns` is on. 403 answers are permanent for the grant. Answers 404 when DEN_HEADLESS_RUNNER_CALLBACK_TOKEN is not configured.",
      responses: {
        200: jsonResponse("A fresh MCP token for the turn.", exchangeResponseSchema),
        400: jsonResponse("The body is not `{ grant, sessionId, messageId }`.", exchangeErrorSchema),
        401: jsonResponse("Missing or wrong callback token.", exchangeErrorSchema),
        403: jsonResponse("The grant is unknown, expired, revoked, for another turn, its member left, or the feature is off.", exchangeErrorSchema),
        404: jsonResponse("Resume grants are not configured on this deployment.", exchangeErrorSchema),
        429: jsonResponse("Too many exchanges for this grant; retry after `retryAfterMs`.", rateLimitedSchema),
        500: jsonResponse("The exchange failed; retry with backoff.", exchangeErrorSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const callbackToken = env.headlessRunnerCallbackToken
      if (!callbackToken) return c.json({ error: "not_found" as const }, 404)
      const presented = bearer(c.req.header("authorization"))
      if (presented === null || !sameSecret(presented, callbackToken)) return c.json({ error: "unauthorized" as const }, 401)

      const body = exchangeBodySchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: "invalid_request" as const }, 400)
      const { grant, sessionId, messageId } = body.data

      try {
        const row = await findHeadlessResumeGrant(grant)
        if (!row) return c.json({ error: "grant_invalid" as const }, 403)
        const memberId = await activeHeadlessResumeGrantMember(row)
        // The callback token is verified and the grant names the organization and member it acts for.
        const audited = await attributeAuditRequest(c, {
          organizationId: row.organizationId,
          ...auditServiceAttribution("headless-runner", row.id, { memberId }),
        })
        if (!audited.ok) return audited.response

        const result = await exchangeHeadlessResumeGrant(row, { sessionId, messageId, memberId })
        if (result.ok) {
          return c.json({ mcpToken: result.mcpToken, expiresAt: result.expiresAt.toISOString(), readOnly: result.readOnly }, 200)
        }
        if (result.status === 429) {
          c.header("retry-after", String(Math.ceil(result.retryAfterMs / 1000)))
          return c.json({ error: result.error, retryAfterMs: result.retryAfterMs }, 429)
        }
        return c.json({ error: result.error }, 403)
      } catch (error) {
        logger.error("headless resume grant exchange failed", { error_name: error instanceof Error ? error.name : typeof error })
        return c.json({ error: "exchange_failed" as const }, 500)
      }
    },
  )
}
