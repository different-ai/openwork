import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, ExternalIdentityTable, MemberTable, ScimProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { ORGANIZATION_MEMBER_ROLE } from "./organization-role-hierarchy.js"

/**
 * An identity provider re-creating someone a Den admin removed from the
 * organization (while they stayed assigned in the IdP) is the IdP-authoritative
 * path back in. Den keeps the removed member row and the global user, so
 * without these steps Better Auth answers the IdP's POST /Users with
 * 409 "User already exists" and nothing short of a database edit restores
 * the person.
 */

type OrgId = typeof MemberTable.$inferSelect.organizationId
type UserId = NonNullable<typeof MemberTable.$inferSelect.userId>

function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The SCIM account id Better Auth derives for a POST /Users body (externalId, else userName). */
export function scimCreateAccountId(body: unknown) {
  const record = asRecord(body)
  if (!record) return null
  return maybeString(record.externalId) ?? maybeString(record.userName)
}

async function hasActiveMembership(organizationId: OrgId, userId: UserId) {
  const rows = await db.$primary
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
    .limit(1)
  return Boolean(rows[0])
}

/**
 * Before the IdP's POST /Users: a SCIM account left behind by a membership Den
 * already removed (an admin removed the person in Den, not in the IdP) would
 * make Better Auth refuse the create as a duplicate. The account only serves an
 * active membership, so release it and let the create link the user again.
 */
export async function releaseStaleScimAccountForCreate(input: { organizationId: OrgId; body: unknown }) {
  const accountId = scimCreateAccountId(input.body)
  if (!accountId) return false

  const [provider] = await db.$primary
    .select({ providerId: ScimProviderTable.providerId })
    .from(ScimProviderTable)
    .where(eq(ScimProviderTable.organizationId, input.organizationId))
    .limit(1)
  if (!provider) return false

  const [account] = await db.$primary
    .select({ id: AuthAccountTable.id, userId: AuthAccountTable.userId })
    .from(AuthAccountTable)
    .where(and(eq(AuthAccountTable.providerId, provider.providerId), eq(AuthAccountTable.accountId, accountId)))
    .limit(1)
  if (!account) return false
  if (await hasActiveMembership(input.organizationId, account.userId)) return false

  await db.delete(AuthAccountTable).where(eq(AuthAccountTable.id, account.id))
  return true
}

/**
 * Whether the organization's SCIM connection may take over an existing user
 * matched by email: they are a member now, were one before (a removed member
 * row), or the organization's identity provider already asserted them
 * (an external identity in this organization, kept after removal).
 */
export async function isUserKnownToScimOrganization(input: { organizationId: OrgId; userId: UserId }) {
  const [member] = await db.$primary
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId)))
    .limit(1)
  if (member) return true

  const [identity] = await db.$primary
    .select({ id: ExternalIdentityTable.id })
    .from(ExternalIdentityTable)
    .where(and(eq(ExternalIdentityTable.organizationId, input.organizationId), eq(ExternalIdentityTable.userId, input.userId)))
    .limit(1)
  return Boolean(identity)
}

/**
 * After the IdP's POST /Users: Better Auth adds a member only when the user has
 * no member row at all, so a removed member stays removed. Start a fresh
 * membership, as accepting a new invitation does: the removed row is kept for
 * audit history (detached from the user), and the person comes back as a plain
 * member without the roles, teams or grants they had before. SCIM group
 * mappings re-add their teams on the sync that follows.
 *
 * Returns the active member id, or null when there is no member row to restore.
 */
export async function restoreScimProvisionedMembership(input: { organizationId: OrgId; userId: UserId }) {
  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: MemberTable.id, removedAt: MemberTable.removedAt })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId)))
      .limit(1)
      .for("update")
    const row = rows[0] ?? null
    if (!row) return null
    if (!row.removedAt) return { memberId: row.id, restored: false }

    await tx
      .update(MemberTable)
      .set({ userId: null })
      .where(and(eq(MemberTable.id, row.id), isNotNull(MemberTable.removedAt)))
    const memberId = createDenTypeId("member")
    await tx.insert(MemberTable).values({
      id: memberId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: ORGANIZATION_MEMBER_ROLE,
      joinedAt: new Date(),
    })
    return { memberId, restored: true }
  })

  if (!outcome) return null
  if (outcome.restored) {
    await cache.org.deleteMemberList(input.organizationId)
    await cache.org.deleteMembership({ organizationId: input.organizationId, userId: input.userId })
  }
  // A returning member changes billing like any other join and gets a gateway key.
  await runPostOrganizationMemberChangeHooks({ organizationId: input.organizationId, memberId: outcome.memberId, change: "added" })
  return outcome.memberId
}
