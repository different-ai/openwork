import { isFeatureKey, type FeatureKey } from "@openwork/features"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { markFeaturesUsed } from "../../feature-usage.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const featureUsageInputSchema = z.object({
  // Strings, not the key enum: a client built before a feature was removed keeps working.
  features: z.array(z.string().max(64)).max(100),
}).strict()

const featureUsageResponseSchema = z.object({ ok: z.literal(true) }).meta({ ref: "FeatureUsageRecorded" })

export function registerOrgFeatureUsageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/org/feature-usage",
    describeRoute({
      tags: ["Organizations"],
      summary: "Report features the caller used",
      description: "Clients report features a member just used, from the place the feature is exercised, so platform admins can see who uses which feature. Only features that are on for the caller are recorded; unknown keys are ignored. Stores the member, feature and day only. Best effort: always answers ok.",
      responses: {
        200: jsonResponse("Usage accepted.", featureUsageResponseSchema),
        400: jsonResponse("The body was invalid.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(featureUsageInputSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const keys = c.req.valid("json").features.filter((key): key is FeatureKey => isFeatureKey(key) && payload.features[key])
      markFeaturesUsed({ organizationId: payload.organization.id, memberId: payload.currentMember.id, keys })
      return c.json({ ok: true as const })
    },
  )
}
