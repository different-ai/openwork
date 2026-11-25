import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, ExternalIdentityTable, MemberTable, ScimProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { ORGANIZATION_MEMBER_ROLE } from "./organization-role-hierarchy.js"

type OrgId = typeof MemberTable.$inferSelect.organizationId
type UserId = NonNullable<typeof MemberTable.$inferSelect.userId>

function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

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
  await runPostOrganizationMemberChangeHooks({ organizationId: input.organizationId, memberId: outcome.memberId, change: "added" })
  return outcome.memberId
}
