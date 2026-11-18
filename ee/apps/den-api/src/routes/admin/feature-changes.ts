import type { FeatureChange } from "@openwork-ee/den-db/organization-features"
import { mapFeatures, type FeatureKey } from "@openwork/features"
import { z } from "zod"

/** The most recent change to a feature, shown in /admin as "On by Omar · 26 Oct 2026". */
export const adminFeatureChangeSchema = z.object({
  scope: z.enum(["everyone", "organization", "member"]).meta({ description: "What the change applied to: the whole deployment, this organization, or one member." }),
  action: z.enum(["on", "off", "reset", "killed", "restored"]).meta({ description: "on/off: set; reset: override cleared; killed/restored: kill switch turned on or cleared." }),
  at: z.string().meta({ description: "When the change was made (ISO 8601)." }),
  by: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable()
    .meta({ description: "Who made the change, or null when no signed-in person did (deploy-time scripts) or their account was deleted." }),
}).meta({ ref: "AdminFeatureChange" })

export type AdminFeatureChange = z.infer<typeof adminFeatureChangeSchema>

export function serializeFeatureChange(change: FeatureChange | undefined): AdminFeatureChange | null {
  if (!change) return null
  return { scope: change.scope, action: change.action, at: change.at.toISOString(), by: change.by }
}

export function serializeFeatureChanges(changes: Partial<Record<FeatureKey, FeatureChange>>): Record<FeatureKey, AdminFeatureChange | null> {
  return mapFeatures((key) => serializeFeatureChange(changes[key]))
}
