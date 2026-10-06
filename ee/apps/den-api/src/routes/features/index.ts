import { readFeatureRollouts } from "@openwork-ee/den-db/organization-features"
import { FEATURE_KEYS, featureAvailableOn, featureDefinition, featureRollout } from "@openwork/features"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { publicRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"

const publicRolloutsResponseSchema = z.object({
  version: z.literal(1),
  deployment: z.enum(["cloud", "self_hosted"]),
  features: z.record(z.string(), z.object({
    percent: z.number().int().min(0).max(100),
    killed: z.boolean(),
    lock: z.boolean().nullable(),
  })),
}).meta({ ref: "PublicFeatureRollouts" })

/**
 * Rollout state of features rolled out to people (`subject: "person"`), for
 * clients that resolve them locally, including desktops that are not signed in
 * and have no organization. Organization features are resolved by den-api and
 * never listed here.
 */
export function registerFeatureRoutes<T extends Env>(app: Hono<T>) {
  app.get(
    "/v1/features/rollouts",
    describeRoute({
      tags: ["System"],
      security: [],
      summary: "Get rollout state for features rolled out to people",
      description: "Percentage, kill switch and operator lock for every person feature that is part of this deployment. Clients bucket by user id when signed in and by install id when signed out, with the same rules as packages/features (resolveFeature). A feature missing here is off.",
      responses: {
        200: jsonResponse("Rollout state returned.", publicRolloutsResponseSchema),
      },
    }),
    publicRoute,
    async (c) => {
      c.header("Cache-Control", "public, max-age=60, stale-if-error=86400")
      const rollouts = await readFeatureRollouts(db)
      const features: Record<string, { percent: number; killed: boolean; lock: boolean | null }> = {}
      for (const key of FEATURE_KEYS) {
        if (featureDefinition(key).subject !== "person" || !featureAvailableOn(key, env.features.deployment)) continue
        const { percent, killed } = featureRollout(key, rollouts)
        features[key] = { percent, killed, lock: env.features.locks[key] ?? null }
      }
      return c.json({ version: 1 as const, deployment: env.features.deployment, features })
    },
  )
}
