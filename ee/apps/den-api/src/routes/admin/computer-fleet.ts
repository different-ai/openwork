import { adminComputerFleetHistorySchema, adminComputerFleetSchema, computerFleetHistoryRangeSchema } from "@openwork/types/den/admin-computer-fleet"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { currentComputerFleet, readComputerFleetHistory } from "../../computer-fleet/service.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const historyQuerySchema = z.object({ range: computerFleetHistoryRangeSchema.default("24h") })
const accessResponses = {
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("Platform admin access required.", forbiddenSchema),
}

export function registerAdminComputerFleetRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/computer-fleet", describeRoute({
    tags: ["Admin"], summary: "Read the cloud computer fleet", ...{ "x-mcp": false },
    description: "Every sandbox cloud conversations use as a computer, as its provider reports it now: what it is doing, where it runs (the sandbox gateway's pool, or the direct provider), its size and times, which need a look, and whose it is. Read through the headless runner, which asks the providers with its own keys; readers within 15 seconds share one read. `status` is `not_configured` when there is no runner or it has no computers.",
    responses: { 200: jsonResponse("The fleet now.", adminComputerFleetSchema), ...accessResponses },
  }), adminRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await currentComputerFleet())
  })

  app.get("/v1/admin/computer-fleet/history", describeRoute({
    tags: ["Admin"], summary: "Read the cloud computer fleet's history", ...{ "x-mcp": false },
    description: "The fleet's highest counts in each 10 minutes of the last 24 hours, or in each hour of the last 7 or 30 days, as a background job recorded them every five minutes. A bucket with no reading is left out.",
    responses: { 200: jsonResponse("Recorded history.", adminComputerFleetHistorySchema), 400: jsonResponse("Invalid range.", invalidRequestSchema), ...accessResponses },
  }), adminRoute(), queryValidator(historyQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await readComputerFleetHistory(c.req.valid("query").range))
  })
}
