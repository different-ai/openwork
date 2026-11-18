import { timingSafeEqual } from "node:crypto"
import { refreshAuditUsageCounts } from "@openwork-ee/den-db/audit-log"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { tokenRoute } from "../../middleware/index.js"
import { appLogger } from "../../observability/logger.js"
import { captureException } from "../../observability/runtime.js"
import { jsonResponse } from "../../openapi.js"
import { reconcileGithubConnectorTargets } from "../../workers/github-sync.js"

// Scheduled maintenance endpoints, called by a cron (Helm CronJob
// `den-audit-usage`; Render cron jobs `den-audit-usage` and
// `den-github-reconcile`) with
// `Authorization: Bearer $DEN_MAINTENANCE_TOKEN`. Same shape as the Gateway's
// POST /internal/rollups/run: 404 when the token is not configured, 401 on a
// wrong token. Tagged Internal, so the published API document excludes them.

const logger = appLogger.child({ component: "internal_maintenance" })
const errorSchema = z.object({ error: z.enum(["not_found", "unauthorized", "refresh_failed", "reconcile_failed"]) })
const githubReconcileSchema = z.object({
  seeded: z.number().int().nonnegative(),
  resumed: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  probed: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
  skippedSyncing: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  durationMs: z.number().int().nonnegative(),
})
const usageRefreshSchema = z.object({ organizations: z.number().int().nonnegative(), refreshedAt: z.string().datetime() })

function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function isAuthorized(header: string | undefined, token: string) {
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
  return bearer !== null && constantTimeEquals(bearer, token)
}

export function registerInternalRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/internal/audit/usage/refresh",
    describeRoute({
      tags: ["Internal"],
      security: [{ maintenanceToken: [] }],
      summary: "Recompute audit usage totals",
      description: "Recomputes every organization's audit usage totals (retained operations, events, logical bytes) from the stored rows and saves them with the time they were measured. The audit write path never updates these totals, so a scheduled caller runs this (daily by default). Answers 404 when DEN_MAINTENANCE_TOKEN is not configured.",
      responses: {
        200: jsonResponse("Totals recomputed.", usageRefreshSchema),
        401: jsonResponse("Missing or wrong maintenance token.", errorSchema),
        404: jsonResponse("Maintenance endpoints are not configured on this deployment.", errorSchema),
        500: jsonResponse("The refresh failed; totals keep their previous values.", errorSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const token = env.maintenanceToken
      if (!token) return c.json({ error: "not_found" }, 404)
      if (!isAuthorized(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401)
      const startedAt = Date.now()
      try {
        const summary = await refreshAuditUsageCounts(db)
        logger.info("audit usage totals refreshed", { organizations: summary.organizations, duration_ms: Date.now() - startedAt })
        return c.json(summary)
      } catch (error) {
        logger.error("audit usage refresh failed", { duration_ms: Date.now() - startedAt, error_name: error instanceof Error ? error.name : typeof error })
        return c.json({ error: "refresh_failed" }, 500)
      }
    },
  )

  app.post(
    "/internal/github/reconcile/run",
    describeRoute({
      tags: ["Internal"],
      security: [{ maintenanceToken: [] }],
      summary: "Check GitHub connectors for new commits",
      description: "Checks due GitHub connector targets against their branch heads and queues a resync for each one that moved. Reads due targets in pages and stops when none are due or the run's page or time budget is used; hasMore says due targets are left for the next run. Safe to call while another run is going: each target is claimed by one run. A scheduled caller runs this every few minutes. Answers 404 when DEN_MAINTENANCE_TOKEN is not configured.",
      responses: {
        200: jsonResponse("Run finished.", githubReconcileSchema),
        401: jsonResponse("Missing or wrong maintenance token.", errorSchema),
        404: jsonResponse("Maintenance endpoints are not configured on this deployment.", errorSchema),
        500: jsonResponse("The run failed; targets it claimed are retried once their claim passes.", errorSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const token = env.maintenanceToken
      if (!token) return c.json({ error: "not_found" }, 404)
      if (!isAuthorized(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401)
      const startedAt = Date.now()
      try {
        const summary = await reconcileGithubConnectorTargets()
        return c.json({ ...summary, durationMs: Date.now() - startedAt })
      } catch (error) {
        logger.error("github reconcile run failed", { duration_ms: Date.now() - startedAt, error_name: error instanceof Error ? error.name : typeof error })
        captureException(error, { component: "github_reconcile_run" })
        return c.json({ error: "reconcile_failed" }, 500)
      }
    },
  )
}
