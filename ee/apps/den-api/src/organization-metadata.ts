import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { assertManagedModelsAllowed, ManagedModelsPolicyError, readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import { db } from "./db.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id

export async function updateOrganizationMetadata(
  organizationId: OrganizationId,
  transform: (metadata: Record<string, unknown>) => Record<string, unknown>,
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
    return metadata
  })
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
