import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { FeatureDatabase } from "./organization-features"
import { SandboxOrganizationTable } from "./schema/sandbox-organizations"

/**
 * Whether the organization is a sandbox that was closed or whose time ran out.
 * Such a sandbox gets no Free Auto: Den API refuses access and credentials, and
 * the Gateway refuses requests. Reopening (extending) the sandbox restores it.
 * Uses the database clock so Den API and the Gateway agree on expiry.
 */
export async function sandboxFreeAutoStopped(database: FeatureDatabase, organizationId: string): Promise<boolean> {
  const id = normalizeDenTypeId("organization", organizationId)
  const [row] = await database.select({ id: SandboxOrganizationTable.id }).from(SandboxOrganizationTable).where(and(
    eq(SandboxOrganizationTable.organizationId, id),
    or(isNotNull(SandboxOrganizationTable.closedAt), lte(SandboxOrganizationTable.expiresAt, sql`current_timestamp(3)`)),
  )).limit(1)
  return Boolean(row)
}
