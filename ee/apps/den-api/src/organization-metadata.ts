import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { assertManagedModelsAllowed, ManagedModelsPolicyError, readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import { db } from "./db.js"
import { requestRead } from "./request-reads.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id

/** Holds an unfinished organization deletion's progress (routes/org/delete-organization.ts). Never shown to members. */
export const ORGANIZATION_DELETION_METADATA_KEY = "deletionInProgress"

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

/**
 * The organization's metadata column, read fresh once per request and shared by
 * the request's later readers (a write in the request reads it again). Never
 * cached across requests, so an admin change applies to the next request.
 */
export function readOrganizationMetadataColumn(organizationId: OrganizationId): Promise<{ metadata: typeof OrganizationTable.$inferSelect.metadata } | null> {
  return requestRead(`organization-metadata:${organizationId}`, async () => {
    const [organization] = await db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
    return organization ?? null
  })
}

export async function assertOrganizationManagedModelsAllowed(organizationId: OrganizationId): Promise<void> {
  let metadata: unknown
  try {
    const organization = await readOrganizationMetadataColumn(organizationId)
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
    metadata = organization.metadata
  } catch {
    throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
  }
  assertManagedModelsAllowed(metadata)
}
