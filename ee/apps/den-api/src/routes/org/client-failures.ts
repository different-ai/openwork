import { clientFailureBatchSchema } from "@openwork/types/den/diagnostics"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { recordClientFailures } from "../../diagnostics/client-failures.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"

export function registerClientFailureRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post("/v1/diagnostics/client-failures", describeRoute({
    tags: ["Diagnostics"],
    summary: "Receive content-free desktop failure reports",
    description: "Accepts up to 50 fixed-schema reports for the caller's organization and membership. Idempotent on reportId. Reports older than 14 days or over five minutes in the future are ignored. Requires clientFailureReports.",
    ...{ "x-mcp": false },
    responses: {
      204: { description: "Recorded or already received." },
      400: jsonResponse("Invalid report.", invalidRequestSchema),
      401: jsonResponse("Sign in required.", unauthorizedSchema),
      404: jsonResponse("Organization or feature unavailable.", notFoundSchema),
      413: jsonResponse("Batch too large.", z.object({ error: z.literal("body_too_large") })),
      429: jsonResponse("Retry later.", z.object({ error: z.literal("rate_limited") })),
    },
  }), orgMemberRoute(), requireFeature("clientFailureReports"),
  bodyLimit({ maxSize: 32_768, onError: (c) => c.json({ error: "body_too_large" }, 413) }),
  jsonValidator(clientFailureBatchSchema), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const retryAfter = await checkRateLimit(`diagnostics:client-failures:${context.currentMember.id}`, 30, 3_600_000, Date.now())
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter))
      return c.json({ error: "rate_limited" }, 429)
    }
    await recordClientFailures({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, reports: c.req.valid("json").reports })
    return c.body(null, 204)
  })
}
