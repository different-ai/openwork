import { adminComputerDetailSchema, adminComputerFleetHistorySchema, adminComputerFleetSchema, computerFleetHistoryRangeSchema, computerFleetSourceKindSchema } from "@openwork/types/den/admin-computer-fleet"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { currentComputer, currentComputerFleet, readComputerFleetHistory } from "../../computer-fleet/service.js"
import { adminRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const historyQuerySchema = z.object({ range: computerFleetHistoryRangeSchema.default("24h") })
/** An organization's id, or `unknown` for computers whose organization Den cannot name. */
const fleetQuerySchema = z.object({ organization: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional() })
const computerParamsSchema = z.object({ source: computerFleetSourceKindSchema, id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/) })
const unavailableSchema = z.object({ error: z.literal("computer_unavailable"), code: z.string(), message: z.string() })
/** A read code as words: `provider_http_503` reads "provider http 503". */
const unavailableMessage = (code: string) => /^http_4\d\d$/.test(code) ? `The headless runner in use did not take this request (${code.replaceAll("_", " ")}). A runner from before it could read one computer answers this way: the page works once a current runner is deployed.`
  : code === "not_configured" ? "This deployment has no headless runner."
  : `The computer could not be read (${code.replaceAll("_", " ")}).`
const accessResponses = {
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("Platform admin access required.", forbiddenSchema),
}

export function registerAdminComputerFleetRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/computer-fleet", describeRoute({
    tags: ["Admin"], summary: "Read the cloud computer fleet", ...{ "x-mcp": false },
    description: "Pass `organization` (an organization id, or `unknown`) to list only that organization's computers; totals, sources and the status stay the whole fleet's. Every sandbox cloud conversations use as a computer, as its provider reports it now: what it is doing, where it runs (the sandbox gateway's pool, or the direct provider), its size and times, which need a look, and whose it is. Read through the headless runner, which asks the providers with its own keys; readers within 15 seconds share one read. `status` is `not_configured` when there is no runner or it has no computers.",
    responses: { 200: jsonResponse("The fleet now.", adminComputerFleetSchema), 400: jsonResponse("Invalid organization.", invalidRequestSchema), ...accessResponses },
  }), adminRoute(), queryValidator(fleetQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await currentComputerFleet(c.req.valid("query").organization ?? null))
  })

  app.get("/v1/admin/computer-fleet/computers/:source/:id", describeRoute({
    tags: ["Admin"], summary: "Read one cloud computer", ...{ "x-mcp": false },
    description: "One computer in full, read now from its provider through the headless runner: its state and why, its size and image, the rules that pause and delete it, where the sandbox gateway placed it and why, the conversation it belongs to (organization, member and activity, never its name or content) and what happened to it. Nothing is run on the computer, so reading never wakes or keeps it awake. `source` is `gateway` or `direct`; `id` is the provider's id from the fleet list.",
    responses: {
      200: jsonResponse("The computer.", adminComputerDetailSchema),
      400: jsonResponse("Invalid source or id.", invalidRequestSchema),
      404: jsonResponse("The provider has no such computer, or it is not one of this deployment's.", notFoundSchema),
      502: jsonResponse("The runner or the provider could not be read.", unavailableSchema),
      ...accessResponses,
    },
  }), adminRoute(), paramValidator(computerParamsSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const { source, id } = c.req.valid("param")
    const read = await currentComputer(source, id)
    if (read.status === "unknown") return c.json({ error: "not_found", message: "Computer not found." }, 404)
    if (read.status === "unavailable") return c.json({ error: "computer_unavailable" as const, code: read.code, message: unavailableMessage(read.code) }, 502)
    return c.json(read.detail)
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
