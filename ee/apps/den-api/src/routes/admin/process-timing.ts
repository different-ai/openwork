import { processTimingEnvironmentSchema, processTimingProcessSchema, processTimingSummarySchema } from "@openwork/types/den/diagnostics"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { readProcessTimings } from "../../diagnostics/process-timing.js"
import { env } from "../../env.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const querySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(14),
  process: processTimingProcessSchema.optional(),
  environment: processTimingEnvironmentSchema.optional(),
})

export function registerAdminProcessTimingRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/process-timing", describeRoute({
    tags: ["Admin"],
    summary: "Development process timing",
    description: "Staff-only timing statistics and the latest 50 runs in a selected window (default 14 days). Step durations exclude skipped steps; repeated step names are combined within each run. Median uses the midpoint and p90 uses nearest rank. Failure rates exclude skipped measurements. Processes are split by local and CI.",
    ...{ "x-mcp": false },
    responses: {
      200: jsonResponse("Timing statistics.", processTimingSummarySchema),
      400: jsonResponse("Invalid filters.", invalidRequestSchema),
      401: jsonResponse("Sign in required.", unauthorizedSchema),
      403: jsonResponse("Staff access required.", forbiddenSchema),
    },
  }), adminRoute(), queryValidator(querySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await readProcessTimings({ ...c.req.valid("query"), reportingEnabled: Boolean(env.processTimingIngestKey) }))
  })
}
