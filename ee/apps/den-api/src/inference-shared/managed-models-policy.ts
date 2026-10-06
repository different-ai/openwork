import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { db } from "../db.js"
import { assertOrganizationManagedModelsAllowed } from "../organization-metadata.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

// Read/repair surfaces omit only managed Models when policy cannot allow them.
export async function organizationAllowsManagedModels(organizationId: OrgId): Promise<boolean> {
  try {
    await assertOrganizationManagedModelsAllowed(organizationId)
    return true
  } catch (error) {
    if (error instanceof ManagedModelsPolicyError) return false
    throw error
  }
}

export async function withManagedModelsAdmission(
  organizationId: OrgId,
  provision: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
) {
  await db.transaction(async (tx) => {
    // Serialize admission with metadata marking; never do external I/O in this lock.
    const [organization] = await tx
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
      .for("update")
      .catch(() => { throw new ManagedModelsPolicyError("managed_models_policy_unavailable") })
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
    assertManagedModelsAllowed(organization.metadata)
    await provision(tx)
  })
}
