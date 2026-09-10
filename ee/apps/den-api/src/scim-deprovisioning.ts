import { and, eq, isNotNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, ExternalIdentityTable, MemberTable, ScimUserTombstoneTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id

export const SCIM_DEPROVISIONED_SIGN_IN_MESSAGE = "This user was deprovisioned by SCIM. Reactivate them in the identity provider before signing in."

export function shouldDeleteGlobalUser(activeMembershipCount: number) {
  return activeMembershipCount === 0
}

// SSO JIT creates the user before Den's provisionUser hook can refuse it, so a
// deprovisioned email must be recognised from the SSO provider alone.
export async function isScimDeprovisionedEmailForSsoProvider(input: {
  ssoProviderId: string
  email: string
}) {
  const rows = await db
    .select({ id: ScimUserTombstoneTable.id })
    .from(ScimUserTombstoneTable)
    .innerJoin(SsoProviderTable, eq(SsoProviderTable.organizationId, ScimUserTombstoneTable.organizationId))
    .where(and(
      eq(SsoProviderTable.providerId, input.ssoProviderId),
      eq(ScimUserTombstoneTable.email, input.email.trim().toLowerCase()),
    ))
    .limit(1)
  return Boolean(rows[0])
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
