import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { cache } from "./cache.js"

/**
 * Cache the team join, never the revision or member-liveness check. Each hit is
 * bound to the revision committed with team changes, so even Redis rollback
 * cannot restore revoked access. Reads inside mutation transactions stay raw.
 */
export function listTeamsForMember(member: Parameters<typeof loadMemberTeams>[0]) {
  return cache.org.memberTeams({
    ...member,
    enabled: async () => true,
    revision: async () => {
      const [row] = await db.select({ revision: OrganizationTable.teamMembershipRevision })
        .from(MemberTable)
        .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
        .where(and(eq(MemberTable.id, member.memberId), eq(MemberTable.organizationId, member.organizationId), isNull(MemberTable.removedAt)))
        .limit(1)
      return row?.revision ?? null
    },
    load: () => loadMemberTeams(member),
  })
}

async function loadMemberTeams(input: {
  organizationId: typeof TeamTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}) {
  return db
    .select({
      id: TeamTable.id,
      name: TeamTable.name,
      organizationId: TeamTable.organizationId,
      createdAt: TeamTable.createdAt,
      updatedAt: TeamTable.updatedAt,
    })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .innerJoin(MemberTable, and(eq(MemberTable.id, TeamMemberTable.orgMembershipId), eq(MemberTable.organizationId, TeamTable.organizationId), isNull(MemberTable.removedAt)))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.memberId)))
    .orderBy(asc(TeamTable.createdAt))
}
