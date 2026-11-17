import { clientFailureSummarySchema } from "@openwork/types/den/diagnostics"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { readClientFailures } from "../../diagnostics/client-failures.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

export function registerAdminClientFailureRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/client-failures", describeRoute({
    tags: ["Admin"], summary: "Desktop client failures",
    description: "Staff-only report counts, folded failures, affected organization counts and latest occurrences by failure class and app version, plus the latest 100 reports. Missing reports mean unknown, not healthy.",
    ...{ "x-mcp": false },
    responses: {
      200: jsonResponse("Client failures.", clientFailureSummarySchema),
      400: jsonResponse("Invalid window.", invalidRequestSchema),
      401: jsonResponse("Sign in required.", unauthorizedSchema),
      403: jsonResponse("Staff access required.", forbiddenSchema),
    },
  }), adminRoute(), queryValidator(z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(14) })), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await readClientFailures(c.req.valid("query").days))
  })
}
