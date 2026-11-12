import { workbotUsageResponseSchema } from "@openwork/types/den/workbot-usage"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { requireFeature } from "../../features.js"
import { orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { readWorkbotUsage } from "../../workbot/usage.js"
import type { OrgRouteVariables } from "./shared.js"

/** What Workbot spent on models, for admins (Den › Analytics › Workbot). Aggregates only. */
export function registerOrgWorkbotUsageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/workbot-usage",
    describeRoute({
      tags: ["Organizations"],
      summary: "Read what Workbot spent on models over the last 30 days",
      description: [
        "Workbot's model requests, tokens and cost for the active organization over the last 30 UTC days including today: totals, one entry per day, and breakdowns by where it ran (`chat`: a person's Workbot chats; `agent`: members' background agents; `other`: Workbot in Slack and cloud Automations), by model and by member, most expensive first (at most 20 models and 50 members; totals cover everyone).",
        "Costs are the AI Gateway's: `costMicroUsd` is US dollars in millionths. A finished request the gateway could not price is counted in `unpricedRequests` and adds nothing to the cost. `since` is the first day with recorded Workbot usage, or null when there is none; counting starts when the gateway and runner that record it are deployed.",
        "Aggregates only: never a conversation or its content. Members with the View usage analytics permission only (owners and admins by default), where the Workbot cost in Analytics feature is on.",
      ].join(" "),
      responses: {
        200: jsonResponse("Workbot usage for the last 30 days.", workbotUsageResponseSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        403: jsonResponse("View usage analytics permission required.", forbiddenSchema),
        404: jsonResponse("Workbot cost in Analytics is not on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotUsageAnalytics"),
    requireOrgPermission("usage_analytics.view"),
    async (c) => c.json(await readWorkbotUsage(c.get("organizationContext").organization.id), 200),
  )
}
