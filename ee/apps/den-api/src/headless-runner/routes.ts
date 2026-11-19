import * as crypto from "node:crypto"
import type { Env, Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { headlessModelAccessSchema } from "@openwork-ee/headless-protocol"
import { attributeAuditRequest, auditServiceAttribution } from "../audit/request-capture.js"
import { env } from "../env.js"
import { tokenRoute } from "../middleware/index.js"
import { appLogger } from "../observability/logger.js"
import { jsonResponse } from "../openapi.js"
import { activeHeadlessResumeGrantMember, exchangeHeadlessResumeGrant, findHeadlessResumeGrant } from "./resume-grants.js"
import { HEADLESS_INDEX_MAX_UPDATES, HEADLESS_INDEX_ROUTE, headlessIndexRequestSchema, ingestHeadlessIndexUpdates } from "./session-index.js"

/**
 * The headless runner's calls back into Den, both authenticated with DEN_HEADLESS_RUNNER_CALLBACK_TOKEN (404 when
 * unset), internal (not in the published API document) and never MCP capabilities:
 * - exchanging a turn's resume grant (saved step turns) for a fresh member-scoped MCP token, so it can
 *   continue the turn after a restart or refresh a long turn's token. Never log the grant or the token.
 * - reporting sessions' content-free totals and state to Den's session index, each update with the capability Den
 *   minted for that session (session-index.ts). Never log a capability.
 */

const logger = appLogger.child({ component: "headless_resume_token" })

type HeadlessRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeHeadlessRoute = (options: HeadlessRouteOptions) => describeRoute(options)

const exchangeBodySchema = z.object({
  grant: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  model: z.string().min(1).max(512).optional(),
  modelAccessRequired: z.boolean().optional(),
}).strict()

const exchangeResponseSchema = z.object({ mcpToken: z.string(), expiresAt: z.iso.datetime(), readOnly: z.boolean(), modelAccess: headlessModelAccessSchema.optional() })
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
    "model_unavailable",
    "feature_disabled",
    "exchange_failed",
  ]),
})
const rateLimitedSchema = z.object({ error: z.literal("rate_limited"), retryAfterMs: z.number().int().positive() })

const indexResultSchema = z.object({
  sessionId: z.string(),
  version: z.number().int(),
  status: z.enum(["ok", "stale", "rejected"]),
  error: z.enum(["invalid_update", "capability_invalid", "capability_expired", "capability_mismatch", "index_disabled", "rate_limited", "session_conflict"]).optional(),
})
const indexResponseSchema = z.object({ results: z.array(indexResultSchema) })
const indexErrorSchema = z.object({ error: z.enum(["not_found", "unauthorized", "invalid_request", "index_failed"]) })

/** Compares digests, so neither the value nor its length leaks through timing. */
function sameSecret(presented: string, expected: string) {
  const left = new Uint8Array(crypto.createHash("sha256").update(presented).digest())
  const right = new Uint8Array(crypto.createHash("sha256").update(expected).digest())
  return crypto.timingSafeEqual(left, right)
}

function bearer(header: string | undefined) {
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
}

/** The runner's callback token, checked in constant time; a response when it is missing, wrong or not configured. */
function callbackRefusal(header: string | undefined): { error: "not_found"; status: 404 } | { error: "unauthorized"; status: 401 } | null {
  const callbackToken = env.headlessRunnerCallbackToken
  if (!callbackToken) return { error: "not_found", status: 404 }
  const presented = bearer(header)
  if (presented === null || !sameSecret(presented, callbackToken)) return { error: "unauthorized", status: 401 }
  return null
}

export function registerHeadlessRunnerRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    HEADLESS_INDEX_ROUTE,
    describeHeadlessRoute({
      tags: ["Internal"],
      "x-mcp": false,
      operationId: "reportHeadlessSessionIndex",
      security: [{ headlessRunnerCallbackToken: [] }],
      summary: "Report headless sessions' content-free totals and state to Den's session index",
      description: `For the headless runner only, with \`Authorization: Bearer $DEN_HEADLESS_RUNNER_CALLBACK_TOKEN\`. Body \`{ updates: [{ capability, sessionId, version, fields }] }\`, at most ${HEADLESS_INDEX_MAX_UPDATES}. Each update carries the index capability Den minted with the session's turn; the organization, member and kind come from it alone and \`sessionId\` must be its session. Idempotent on (sessionId, version): a version at or below the stored one is \`stale\` and changes nothing. One result per update, in order: \`ok\`, \`stale\`, or \`rejected\` with a code (\`rate_limited\` per session and organization: keep and retry it; \`index_disabled\` is no longer sent but older runners keep and retry it too). Rejections are audited. Answers 404 when DEN_HEADLESS_RUNNER_CALLBACK_TOKEN is not configured.`,
      responses: {
        200: jsonResponse("One result per update.", indexResponseSchema),
        400: jsonResponse("The body is not `{ updates: [...] }` with 1 to 50 updates.", indexErrorSchema),
        401: jsonResponse("Missing or wrong callback token.", indexErrorSchema),
        404: jsonResponse("Runner callbacks are not configured on this deployment.", indexErrorSchema),
        500: jsonResponse("The index could not be written; retry with backoff.", indexErrorSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const refused = callbackRefusal(c.req.header("authorization"))
      if (refused) return c.json({ error: refused.error }, refused.status)
      const body = headlessIndexRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: "invalid_request" as const }, 400)
      try {
        const requestId: unknown = c.get("requestId")
        const results = await ingestHeadlessIndexUpdates(body.data.updates, { requestId: typeof requestId === "string" ? requestId : null })
        return c.json({ results }, 200)
      } catch (error) {
        logger.error("headless session index ingest failed", { error_name: error instanceof Error ? error.name : typeof error })
        return c.json({ error: "index_failed" as const }, 500)
      }
    },
  )


  app.post(
    "/v1/headless/resume-token",
    describeHeadlessRoute({
      tags: ["Internal"],
      "x-mcp": false,
      operationId: "exchangeHeadlessResumeGrant",
      security: [{ headlessRunnerCallbackToken: [] }],
      summary: "Exchange a headless turn's resume grant for a fresh MCP token",
      description:
        "For the headless runner only, with `Authorization: Bearer $DEN_HEADLESS_RUNNER_CALLBACK_TOKEN`. Body `{ grant, sessionId, messageId }`. Exchanges the resume grant Den minted with a turn for a fresh member-scoped MCP token (at most an hour, same read-only setting) for that turn, its background tasks and their reports, while the member is still active. 403 answers are permanent for the grant. Answers 404 when DEN_HEADLESS_RUNNER_CALLBACK_TOKEN is not configured.",
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
      const { grant, sessionId, messageId, model, modelAccessRequired } = body.data

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

        const result = await exchangeHeadlessResumeGrant(row, { sessionId, messageId, memberId, model, modelAccessRequired })
        if (result.ok) {
          return c.json({ mcpToken: result.mcpToken, expiresAt: result.expiresAt.toISOString(), readOnly: result.readOnly, ...(result.modelAccess ? { modelAccess: result.modelAccess } : {}) }, 200)
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
