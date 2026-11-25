import { organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { cachedOrganizationServiceReadiness } from "../../service-readiness-runtime.js"
import type { OrgRouteVariables } from "./shared.js"

const unavailableSchema = z.object({ error: z.literal("service_readiness_unavailable") })

export function registerOrgServiceReadinessRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/org/service-readiness", describeRoute({
    tags: ["Organizations"], summary: "Read minimal cached deployment service readiness", ...{ "x-mcp": false },
    description: "Member-safe deployment facts only. Does not inspect organization or member credentials, start a check, or alter access decisions. Missing deployment settings, notes, durations and required-service policy are withheld.",
    responses: {
      200: jsonResponse("Cached service readiness.", organizationServiceReadinessSchema),
      503: jsonResponse("The cached snapshot is unavailable; no detail is exposed.", unavailableSchema),
    },
  }), orgMemberRoute(), async (c) => {
    const result = await cachedOrganizationServiceReadiness()
    c.header("Cache-Control", "no-store")
    if (!result) return c.json({ error: "service_readiness_unavailable" }, 503)
    return c.json(result)
  })
}
