import { and, eq, isNotNull, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, OrganizationTable, ScimGroupMemberTable, ScimGroupTable, ScimProviderTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { organizationRoleValueSatisfies } from "./organization-role-hierarchy.js"

export type OrganizationAdminTeam = { id: string; name: string }

export type TeamMutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Share this lock with invitations and SCIM teardown so a concurrent grant cannot
// turn an already-authorized routine membership edit into a role assignment.
export function withOrganizationTeamMutation<T>(
  organizationId: typeof TeamTable.$inferSelect.organizationId,
  mutation: (tx: TeamMutationTransaction) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId)).for("update")
    return mutation(tx)
  })
}

export function effectiveOrganizationRole(directRole: string, adminTeams: readonly OrganizationAdminTeam[]) {
  return adminTeams.length > 0 && !organizationRoleValueSatisfies({ roleValue: directRole, requiredRole: "admin" })
    ? `${directRole},admin`
    : directRole
}

export async function invitationHasAdminTeam(tx: TeamMutationTransaction, invitation: Pick<typeof InvitationTable.$inferSelect, "id" | "organizationId" | "teamId">) {
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

// Never cache authority: IdP removals and designation changes apply on the next check.
export async function listOrganizationAdminTeamGrants(organizationId: typeof TeamTable.$inferSelect.organizationId) {
  return db.select({ memberId: MemberTable.id, id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .innerJoin(MemberTable, and(
      eq(MemberTable.id, TeamMemberTable.orgMembershipId),
      eq(MemberTable.organizationId, TeamTable.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .leftJoin(ScimGroupTable, and(eq(ScimGroupTable.teamId, TeamTable.id), eq(ScimGroupTable.organizationId, organizationId)))
    .leftJoin(ScimProviderTable, and(
      eq(ScimProviderTable.providerId, ScimGroupTable.providerId),
      eq(ScimProviderTable.organizationId, organizationId),
    ))
    .leftJoin(ScimGroupMemberTable, and(
      eq(ScimGroupMemberTable.groupId, ScimGroupTable.id),
      eq(ScimGroupMemberTable.providerId, ScimProviderTable.providerId),
      eq(ScimGroupMemberTable.organizationId, organizationId),
      eq(ScimGroupMemberTable.teamMemberId, TeamMemberTable.id),
      eq(ScimGroupMemberTable.orgMembershipId, MemberTable.id),
      eq(ScimGroupMemberTable.remoteUserId, MemberTable.userId),
    ))
    .where(and(
      eq(TeamTable.organizationId, organizationId),
      eq(TeamTable.grantsOrganizationAdmin, true),
      // A mapped team projection is not itself authority. Orphaned projections
      // fail closed; disconnected teams require their own manual reapproval.
      or(
        isNull(ScimGroupTable.id),
        eq(ScimProviderTable.groupMappingMode, "metadata_only"),
        and(eq(ScimProviderTable.groupMappingMode, "create_teams"), isNotNull(ScimGroupMemberTable.id)),
      ),
    ))
}

export async function resolveOrganizationMemberAuthority(input: {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}) {
  const [members, grants] = await Promise.all([
    db.select().from(MemberTable).where(and(
      eq(MemberTable.id, input.memberId),
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
    )).limit(1),
    listOrganizationAdminTeamGrants(input.organizationId),
  ])
  const member = members[0]
  if (!member?.userId) return null
  const adminTeams = grants.filter((grant) => grant.memberId === member.id).map(({ id, name }) => ({ id, name }))
  return { ...member, directRole: member.role, role: effectiveOrganizationRole(member.role, adminTeams), adminTeams }
}
