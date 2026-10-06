import { readFeatureRollouts } from "@openwork-ee/den-db/organization-features"
import { FEATURE_KEYS, featureAvailableOn, resolveFeature } from "@openwork/features"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { publicRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"

const publicFeaturesResponseSchema = z.object({
  version: z.literal(1),
  deployment: z.enum(["cloud", "self_hosted"]),
  features: z.record(z.string(), z.boolean()),
}).meta({ ref: "PublicFeatures" })

/**
 * Which features are on for someone without an organization (for example a
 * desktop that is not signed in): the deployment-wide state after the kill
 * switch and operator locks. Signed-in clients read `features` from GET /v1/org,
 * which also applies their organization's overrides.
 */
export function registerFeatureRoutes<T extends Env>(app: Hono<T>) {
  app.get(
    "/v1/features",
    describeRoute({
      tags: ["System"],
      security: [],
      summary: "Get features for people without an organization",
      description: "On or off for every feature that is part of this deployment, for someone who is not signed in: the deployment-wide state after the kill switch and operator locks, with no organization overrides. A feature missing here is off.",
      responses: {
        200: jsonResponse("Features returned.", publicFeaturesResponseSchema),
      },
    }),
    publicRoute,
    async (c) => {
      c.header("Cache-Control", "public, max-age=60, stale-if-error=86400")
      const rollouts = await readFeatureRollouts(db)
      const features: Record<string, boolean> = {}
      for (const key of FEATURE_KEYS) {
        if (!featureAvailableOn(key, env.features.deployment)) continue
        features[key] = resolveFeature(key, { ...env.features, rollouts, overrides: {} }).enabled
      }
      return c.json({ version: 1 as const, deployment: env.features.deployment, features })
    },
  )
}
