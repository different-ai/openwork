// FUTURE(modules/teams): Admin-team authority. Teams contribute candidate
// elevations to `member.effectiveAuthority`; Core merges them after the
// authority exclusions (SCIM projections) have run. When teams is off (D29) the
// contributor is skipped and nobody is elevated.
import { and, eq, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import type { AuthorityCandidate, AuthorityContributor, AuthorityQuery } from "./core/hook-seams.js"
import type { CoreTx } from "./core/types.js"

export const ADMIN_TEAM_ELEVATION_KIND = "team"

// Every team_member of a grants_organization_admin team, joined to an active
// member. Knows nothing about SCIM: projections are filtered by exclusions.
export async function listAdminTeamCandidates(query: AuthorityQuery): Promise<AuthorityCandidate[]> {
  const rows = query.database.select({
    memberId: MemberTable.id,
    userId: MemberTable.userId,
    teamMemberId: TeamMemberTable.id,
    id: TeamTable.id,
    name: TeamTable.name,
  })
    .from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .innerJoin(MemberTable, and(
      eq(MemberTable.id, TeamMemberTable.orgMembershipId),
      eq(MemberTable.organizationId, TeamTable.organizationId),
      isNull(MemberTable.removedAt),
      query.memberId ? eq(MemberTable.id, query.memberId) : undefined,
    ))
    .where(and(
      eq(TeamTable.organizationId, query.organizationId),
      eq(TeamTable.grantsOrganizationAdmin, true),
    ))
  const grants = await (query.lock === "share" ? rows.for("share") : rows)
  return grants.map((grant) => ({
    memberId: grant.memberId,
    userId: grant.userId,
    elevation: {
      role: "admin",
      source: { kind: ADMIN_TEAM_ELEVATION_KIND, id: grant.id, name: grant.name, teamMemberId: grant.teamMemberId },
    },
  }))
}

export const adminTeamElevationContributor: AuthorityContributor = {
  id: "teams/admin-team-elevation",
  registrant: "legacy",
  // moduleId stays undefined until M-teams: the legacy registration always runs.
  collect: listAdminTeamCandidates,
}

export async function invitationHasAdminTeam(tx: CoreTx, invitation: Pick<typeof InvitationTable.$inferSelect, "id" | "organizationId" | "teamId">) {
  const teams = await tx.select({ id: TeamTable.id }).from(TeamTable)
    .leftJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .leftJoin(MemberTable, and(eq(MemberTable.id, TeamMemberTable.orgMembershipId), isNull(MemberTable.removedAt)))
    .where(and(
      eq(TeamTable.organizationId, invitation.organizationId),
      eq(TeamTable.grantsOrganizationAdmin, true),
      or(eq(MemberTable.inviteId, invitation.id), invitation.teamId ? eq(TeamTable.id, invitation.teamId) : undefined),
    )).limit(1)
  return teams.length > 0
}
