import {
  adminControlCenterRefreshLimitedSchema,
  adminControlCenterRefreshSchema,
  adminControlCenterSchema,
  controlCenterRangeSchema,
} from "@openwork/types/den/admin-control-center"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { dbSnapshotStore, readControlCenter } from "../../admin-metrics/snapshots.js"
import { adminMetricIntervals, scheduleAdminMetricsRefresh } from "../../admin-metrics/worker.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const MANUAL_REFRESH_INTERVAL_MS = 60_000
const querySchema = z.object({ range: controlCenterRangeSchema.default("7d") })

export function registerAdminControlCenterRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/control-center", describeRoute({
    tags: ["Admin"], summary: "Get the platform Control Center",
    description: "Returns every Control Center section (pulse, growth and lifecycle, invitations, skill and MCP sharing, revenue, accounts to watch) from snapshots a background job precomputes. Never runs the underlying queries: each section carries when it was computed, whether it is stale and the last refresh error, if any. Range-independent sections (revenue, accounts) ignore `range`. Aggregate counts only, apart from organization names.",
    responses: {
      200: jsonResponse("Control Center snapshots returned.", adminControlCenterSchema),
      400: jsonResponse("Invalid range.", invalidRequestSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema),
      403: jsonResponse("Platform admin access required.", forbiddenSchema),
    },
  }), adminRoute(), queryValidator(querySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const { range } = c.req.valid("query")
    return c.json(await readControlCenter(range, { store: dbSnapshotStore, now: new Date(), intervals: adminMetricIntervals() }))
  })

  app.post("/v1/admin/control-center/refresh", describeRoute({
    tags: ["Admin"], summary: "Refresh the platform Control Center",
    description: "Schedules a recompute of every Control Center snapshot and returns at once; read GET /v1/admin/control-center for the results. At most one refresh a minute across all admins.",
    responses: {
      202: jsonResponse("Refresh scheduled.", adminControlCenterRefreshSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema),
      403: jsonResponse("Platform admin access required.", forbiddenSchema),
      429: jsonResponse("A refresh was requested less than a minute ago.", adminControlCenterRefreshLimitedSchema),
    },
  }), adminRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    const now = new Date()
    const request = await dbSnapshotStore.requestRefresh(now, MANUAL_REFRESH_INTERVAL_MS)
    if (!request.accepted) {
      const retryAfterSeconds = Math.ceil(request.retryAfterMs / 1_000)
      c.header("Retry-After", String(retryAfterSeconds))
      return c.json({ error: "refresh_rate_limited" as const, message: "The Control Center was refreshed less than a minute ago.", retryAfterSeconds }, 429)
    }
    scheduleAdminMetricsRefresh()
    return c.json({ scheduled: true as const, requestedAt: now.toISOString() }, 202)
  })
}
