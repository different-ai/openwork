import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { calculateOrganizationBillingQuantities, normalizeUserCount, type OrganizationBillingQuantities } from "./billing-quantities.js"
import { db } from "./db.js"
import { peopleMemberCondition } from "./setup-agent-members.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

/**
 * Member rows that are billable users: joined members, plus the placeholder
 * row of each pending invitation that has not expired. Removed members, the
 * setup agent and expired invitations never count.
 */
export function billingUserCondition(now = new Date()) {
  // Conditions built with column operators so `now` is bound in the column's
  // UTC format; a raw Date in sql`` would be sent in the server's local time.
  const pendingInvitation = sql`exists (select 1 from ${InvitationTable} where ${and(
    eq(InvitationTable.id, MemberTable.inviteId),
    eq(InvitationTable.status, "pending"),
    gt(InvitationTable.expiresAt, now),
  )})`
  return and(
    peopleMemberCondition(),
    or(isNotNull(MemberTable.joinedAt), and(isNull(MemberTable.joinedAt), pendingInvitation)),
  )
}

type BillingUserCounts = { users: number; webUsers: number }

/**
 * The one query that counts billable users, for several organizations at
 * once: every user, and the users with OpenWork Web.
 */
export async function countBillingUsersAndWebUsersForOrganizations(organizationIds: readonly OrgId[]): Promise<Map<OrgId, BillingUserCounts>> {
  const result = new Map<OrgId, BillingUserCounts>()
  if (organizationIds.length === 0) return result
  const rows = await db
    .select({
      organizationId: MemberTable.organizationId,
      users: sql<number>`count(*)`,
      webUsers: sql<number>`sum(case when ${MemberTable.openworkWeb} then 1 else 0 end)`,
    })
    .from(MemberTable)
    .where(and(inArray(MemberTable.organizationId, [...organizationIds]), billingUserCondition()))
    .groupBy(MemberTable.organizationId)
  for (const organizationId of organizationIds) {
    result.set(organizationId, { users: 0, webUsers: 0 })
  }
  for (const row of rows) {
    result.set(row.organizationId, {
      users: normalizeUserCount(Number(row.users)),
      webUsers: normalizeUserCount(Number(row.webUsers ?? 0)),
    })
  }
  return result
}

export async function countBillingUsersForOrganizations(organizationIds: readonly OrgId[]): Promise<Map<OrgId, number>> {
  const counts = await countBillingUsersAndWebUsersForOrganizations(organizationIds)
  return new Map([...counts].map(([organizationId, count]) => [organizationId, count.users]))
}

export async function countBillingUsers(organizationId: OrgId): Promise<number> {
  return (await countBillingUsersForOrganizations([organizationId])).get(organizationId) ?? 0
}

/** Billing quantities for one organization: its users, its Web users and free seats. */
export async function getOrganizationBillingQuantities(organizationId: OrgId): Promise<OrganizationBillingQuantities> {
  const [counts, rows] = await Promise.all([
    countBillingUsersAndWebUsersForOrganizations([organizationId]),
    db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1),
  ])
  return calculateOrganizationBillingQuantities({ ...(counts.get(organizationId) ?? { users: 0, webUsers: 0 }), metadata: rows[0]?.metadata })
}

/** Billing quantities for several organizations at once (admin lists). */
export async function getBillingQuantitiesForOrganizations(organizations: ReadonlyArray<{ id: OrgId; metadata: Record<string, unknown> | null | undefined }>) {
  const ids = organizations.map((organization) => organization.id)
  const countsByOrg = await countBillingUsersAndWebUsersForOrganizations(ids)
  const result = new Map<OrgId, OrganizationBillingQuantities>()
  for (const organization of organizations) {
    result.set(organization.id, calculateOrganizationBillingQuantities({
      ...(countsByOrg.get(organization.id) ?? { users: 0, webUsers: 0 }),
      metadata: organization.metadata,
    }))
  }
  return result
}

/**
 * Organizations with a pending invitation that expired in (since, until]:
 * each stopped counting as a user without any request, so its subscriptions
 * need to follow the lower count.
 */
export async function listOrganizationsWithInvitationsExpiredBetween(input: { since: Date; until: Date }): Promise<OrgId[]> {
  const rows = await db
    .selectDistinct({ organizationId: InvitationTable.organizationId })
    .from(InvitationTable)
    .where(and(
      eq(InvitationTable.status, "pending"),
      gt(InvitationTable.expiresAt, input.since),
      lte(InvitationTable.expiresAt, input.until),
    ))
  return rows.map((row) => row.organizationId)
}
