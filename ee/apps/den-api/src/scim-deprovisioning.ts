import { and, eq, isNotNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, ExternalIdentityTable, MemberTable, ScimUserTombstoneTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id

export function shouldDeleteGlobalUser(activeMembershipCount: number) {
  return activeMembershipCount === 0
}

export async function isScimDeprovisionedIdentity(input: {
  organizationId: OrganizationId
  userId: UserId
  email: string | null
}) {
  const email = input.email?.trim().toLowerCase() ?? null
  const tombstoneRows = await db
    .select({ id: ScimUserTombstoneTable.id })
    .from(ScimUserTombstoneTable)
    .where(and(
      eq(ScimUserTombstoneTable.organizationId, input.organizationId),
      or(
        eq(ScimUserTombstoneTable.deprovisionedUserId, input.userId),
        email ? eq(ScimUserTombstoneTable.email, email) : eq(ScimUserTombstoneTable.deprovisionedUserId, input.userId),
      ),
    ))
    .limit(1)
  if (tombstoneRows[0]) {
    return true
  }

  const inactiveRows = await db
    .select({ id: ExternalIdentityTable.id })
    .from(ExternalIdentityTable)
    .where(and(
      eq(ExternalIdentityTable.organizationId, input.organizationId),
      eq(ExternalIdentityTable.userId, input.userId),
      eq(ExternalIdentityTable.active, false),
      isNotNull(ExternalIdentityTable.scimProviderId),
    ))
    .limit(1)
  return Boolean(inactiveRows[0])
}
