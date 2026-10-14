import { eq, lt } from "@openwork-ee/den-db/drizzle"
import { FeatureRolloutTable, OrganizationFeatureTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { cache } from "./cache.js"
import { env } from "./env.js"
import { eligibleHistoricalBranding } from "./white-label-policy.js"

/** MySQL2 and PlanetScale expose different result envelopes. Fail closed on an unknown result. */
export function initializationAffectedRows(result: unknown): number {
  if (Array.isArray(result)) return initializationAffectedRows(result[0])
  if (typeof result !== "object" || result === null) throw new Error("white_label_unknown_insert_result")
  const count = "rowsAffected" in result ? result.rowsAffected : "affectedRows" in result ? result.affectedRows : undefined
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1) throw new Error("white_label_unknown_insert_result")
  return count
}

/**
 * One-time cutover, before serving or starting workers. INSERT IGNORE wins the
 * unique rollout row exactly once and serializes concurrent startups. The row
 * and historical overrides commit atomically; an existing row (including an
 * admin/operator's preconfiguration) is authoritative and is never modified.
 * Later startups cannot recreate an override an admin cleared, or grant a new
 * organization a feature through injected metadata. No metadata/assets change.
 */
export async function initializeWhiteLabelFeature(database = db) {
  if (env.features.deployment !== "cloud") return
  const initialized = await database.transaction(async (tx) => {
    const insertion = await tx.insert(FeatureRolloutTable).ignore()
      .values({ feature_key: "whiteLabel", enabled: false, killed: false })
    if (initializationAffectedRows(insertion) === 0) return false
    const [rollout] = await tx.select({ cutoff: FeatureRolloutTable.created_at })
      .from(FeatureRolloutTable).where(eq(FeatureRolloutTable.feature_key, "whiteLabel")).for("update")
    if (!rollout) throw new Error("white_label_rollout_initialization_failed")
    // Match admin override writes' organization lock, so explicit off always wins.
    const organizations = await tx.select({ id: OrganizationTable.id, createdAt: OrganizationTable.createdAt, logo: OrganizationTable.logo, metadata: OrganizationTable.metadata })
      .from(OrganizationTable).where(lt(OrganizationTable.createdAt, rollout.cutoff)).for("update")
    for (const organization of organizations) {
      if (!eligibleHistoricalBranding(organization, rollout.cutoff)) continue
      await tx.insert(OrganizationFeatureTable).ignore().values({
        organization_id: organization.id, feature_key: "whiteLabel", enabled: true, source: "migration",
      })
    }
    return true
  })
  // Never invalidate an uncommitted snapshot. Other replicas share this cache.
  if (initialized) await cache.features.invalidate()
}
