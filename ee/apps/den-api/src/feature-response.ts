import { z } from "zod"

/** Published desktop clients interpret a missing rollout key as a rollback. */
export const clientFeaturesSchema = z.object({
  engineV2ForceUpgrade: z.literal(true).meta({
    deprecated: true,
    description: "Fixed compatibility value for published desktop clients. Automatic OpenCode v2 migration is always on; this is not a configurable feature.",
  }),
}).catchall(z.boolean())

/** Response-only compatibility: never add this key to registry/admin feature state. */
export function clientFeatures(features: Record<string, boolean>): Record<string, boolean> & { engineV2ForceUpgrade: true } {
  return { ...features, engineV2ForceUpgrade: true }
}
