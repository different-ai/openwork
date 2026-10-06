import { and, eq, isNotNull, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, type OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { peopleMemberCondition } from "./setup-agent-members.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

/** Joined, non-removed people in the organization (the OpenWork Web quantity). */
export async function countJoinedPeopleMembers(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, organizationId),
      isNotNull(MemberTable.joinedAt),
      peopleMemberCondition(),
    ))
  const count = Number(row?.count ?? 0)
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}
