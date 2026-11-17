import { adminRunnerFleetHistorySchema, adminRunnerFleetSchema, runnerFleetHistoryRangeSchema } from "@openwork/types/den/admin-runner-fleet"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { runnerFleetEvents } from "../../runner-fleet/events.js"
import { currentRunnerFleet, readRunnerFleetHistory } from "../../runner-fleet/service.js"
import type { AuthContextVariables } from "../../session.js"

const historyQuerySchema = z.object({ range: runnerFleetHistoryRangeSchema.default("24h") })
const accessResponses = {
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("Platform admin access required.", forbiddenSchema),
}
/** Open live streams per admin on this replica: a few tabs, not a leak. */
const MAX_STREAMS = 3
const streams = new Map<string, number>()

export function registerAdminRunnerFleetRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/runner-fleet", describeRoute({
    tags: ["Admin"], summary: "Read the cloud runner fleet", ...{ "x-mcp": false },
    description: "Every runner node as it reports itself now: whether it takes new cells, its memory against the cell host's ceiling, the cells it holds in memory and owns, and cells waiting for room. Read live from each node's state endpoint; `status` is `not_configured` when the deployment does not name the nodes. Counts, sizes and opaque cell ids only.",
    responses: { 200: jsonResponse("The fleet now.", adminRunnerFleetSchema), ...accessResponses },
  }), adminRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await currentRunnerFleet())
  })

  app.get("/v1/admin/runner-fleet/history", describeRoute({
    tags: ["Admin"], summary: "Read the cloud runner fleet's history", ...{ "x-mcp": false },
    description: "Per node, the worst reading in each 10 minutes of the last 24 hours, or in each hour of the last 7 or 30 days, as a background job recorded it once a minute. A bucket with no reading is left out.",
    responses: { 200: jsonResponse("Recorded history.", adminRunnerFleetHistorySchema), 400: jsonResponse("Invalid range.", invalidRequestSchema), ...accessResponses },
  }), adminRoute(), queryValidator(historyQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await readRunnerFleetHistory(c.req.valid("query").range))
  })

  app.get("/v1/admin/runner-fleet/events", describeRoute({
    tags: ["Admin"], summary: "Watch the cloud runner fleet", ...{ "x-mcp": false },
    description: "SSE: a `fleet` event with the same body as GET /v1/admin/runner-fleet on connect and every five seconds, `unavailable` when a reading fails, and `end` after two and a half minutes, when the watcher reconnects and is authorized again. At most three streams per admin per replica.",
    responses: {
      200: { description: "Fleet event stream.", content: { "text/event-stream": { schema: { type: "string" } } } },
      429: jsonResponse("Too many streams open for this admin.", z.object({ error: z.string() })),
      ...accessResponses,
    },
  }), adminRoute(), (c) => {
    const admin = c.get("user")?.id ?? "admin"
    const open = streams.get(admin) ?? 0
    if (open >= MAX_STREAMS) return c.json({ error: "runner_fleet_stream_limit" }, 429)
    streams.set(admin, open + 1)
    return runnerFleetEvents({
      request: c.req.raw,
      read: currentRunnerFleet,
      onClose: () => {
        const remaining = (streams.get(admin) ?? 1) - 1
        if (remaining > 0) streams.set(admin, remaining)
        else streams.delete(admin)
      },
    })
  })
}
