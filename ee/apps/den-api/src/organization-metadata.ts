import { eq } from "@openwork-ee/den-db/drizzle"
import { readOrganizationModules, updateOrganizationModules, type OrganizationModulesExecutor } from "@openwork-ee/den-db/organization-modules"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { assertManagedModelsAllowed, ManagedModelsPolicyError, readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import { db } from "./db.js"
import { applyLegacyKillSwitchChanges, legacyKillSwitchChanges } from "./organization-modules-legacy.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id

export async function updateOrganizationMetadata(
  organizationId: OrganizationId,
  transform: (metadata: Record<string, unknown>) => Record<string, unknown>,
  options: { syncLegacyKillSwitches?: boolean } = {},
): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
      .for("update")
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")

    const metadata = readOrganizationMetadata(transform(readOrganizationMetadata(organization.metadata)))
    await tx.update(OrganizationTable).set({ metadata }).where(eq(OrganizationTable.id, organizationId))
    if (options.syncLegacyKillSwitches) {
      await syncLegacyKillSwitchesToModules(tx, organizationId, organization.metadata, metadata)
    }
    return metadata
  })
}

/**
 * Dual-write window (00-legacy-mapping §G.3): when a platform-admin capability
 * write flips the `installLinks` or `mcpConnections` kill switch, mirror the
 * change into `organization.modules.disabled`. A NULL column is left alone,
 * because NULL already derives those entries from metadata.
 */
async function syncLegacyKillSwitchesToModules(
  tx: OrganizationModulesExecutor,
  organizationId: OrganizationId,
  previousMetadata: unknown,
  nextMetadata: Record<string, unknown>,
) {
  const changes = legacyKillSwitchChanges(readOrganizationMetadata(previousMetadata), nextMetadata)
  if (!changes.disable.length && !changes.enable.length) return
  const current = await readOrganizationModules(tx, organizationId)
  if (!current || current.status === "absent") return
  if (current.status === "invalid") {
    console.error("organization_modules_legacy_sync_skipped", { organizationId, issues: current.issues })
    return
  }
  const result = await updateOrganizationModules(tx, {
    organizationId,
    kind: "legacy",
    actorMemberId: null,
    mutate: (doc) => applyLegacyKillSwitchChanges(doc, changes),
  })
  if (!result.ok) throw new Error(`organization.modules legacy sync failed: ${result.reason}`)
}

export async function assertOrganizationManagedModelsAllowed(organizationId: OrganizationId): Promise<void> {
  let metadata: unknown
  try {
    // Deliberately bypass caches so an admin change applies to the next request.
    const [organization] = await db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
    metadata = organization.metadata
  } catch {
    throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
  }
  assertManagedModelsAllowed(metadata)
}
