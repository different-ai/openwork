import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { APIError } from "better-auth/api"
import { invitationHasAdminTeam } from "../../../organization-team-roles.js"
import { organizationRoleValueSatisfies } from "../../../organization-role-hierarchy.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: teams.

coreHooks.registerGuard({
  point: "member.removalGuard",
  id: "legacy/teams/admin-team-member-removal",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.guard,
  handler: async ({ tx, organizationId, memberId, removedByOrgMemberId }) => {
    // Self-service paths pass no actor; Core's owner checks cover them.
    if (!removedByOrgMemberId) return null
    // Kept verbatim; W0-P11 decides whether to add the SCIM projection filter.
    const adminTeams = await tx.select({ id: TeamTable.id }).from(TeamTable)
      .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
      .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.grantsOrganizationAdmin, true), eq(TeamMemberTable.orgMembershipId, memberId)))
      .limit(1)
    const [actor] = await tx.select({ role: MemberTable.role }).from(MemberTable)
      .where(and(eq(MemberTable.id, removedByOrgMemberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), isNotNull(MemberTable.userId))).for("share")
    if (adminTeams.length > 0 && (!actor || !organizationRoleValueSatisfies({ roleValue: actor.role, requiredRole: "super-admin" }))) {
      return { code: "forbidden", status: 403, message: "Only workspace owners and super-admins can remove members with Admin team access." }
    }
    return null
  },
})

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/teams/delete-member-team-memberships",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup,
  handler: async ({ tx, memberIds }) => {
    await tx
      .delete(TeamMemberTable)
      .where(inArray(TeamMemberTable.orgMembershipId, memberIds))
  },
})

coreHooks.registerGuard({
  point: "invitation.createGuard",
  id: "legacy/teams/admin-team-invitation-refresh",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.guard,
  handler: async ({ tx, invitation, requireSuperAdmin }) => {
    if (!await invitationHasAdminTeam(tx, invitation)) return null
    return requireSuperAdmin("Only workspace owners and super-admins can manage invitations with Admin team access.")
  },
})

coreHooks.registerGuard({
  point: "invitation.cancelGuard",
  id: "legacy/teams/admin-team-invitation-cancel",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.guard,
  handler: async ({ tx, invitation, requireSuperAdmin }) => {
    if (!await invitationHasAdminTeam(tx, invitation)) return null
    return requireSuperAdmin("Only workspace owners and super-admins can cancel invitations with Admin team access.")
  },
})

coreHooks.registerTx({
  point: "invitation.accepted",
  id: "legacy/teams/assign-invitation-team",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  handler: async ({ tx, organizationId, invitation, member }) => {
    if (!invitation.teamId) return
    const teams = await tx
      .select({ id: TeamTable.id, grantsOrganizationAdmin: TeamTable.grantsOrganizationAdmin })
      .from(TeamTable)
      .where(and(
        eq(TeamTable.id, invitation.teamId),
        eq(TeamTable.organizationId, organizationId),
      ))
      .limit(1)
    const team = teams[0]
    if (!team) return

    const existingTeamMember = await tx
      .select({ id: TeamMemberTable.id })
      .from(TeamMemberTable)
      .where(and(eq(TeamMemberTable.teamId, invitation.teamId), eq(TeamMemberTable.orgMembershipId, member.id)))
      .limit(1)

    const inviters = invitation.orgMemberId ? await tx.select({ role: MemberTable.role })
      .from(MemberTable).where(and(
        eq(MemberTable.id, invitation.orgMemberId),
        eq(MemberTable.organizationId, organizationId),
        isNull(MemberTable.removedAt),
      )).limit(1) : []
    const mayAssignTeam = !team.grantsOrganizationAdmin || (inviters[0] && organizationRoleValueSatisfies({ roleValue: inviters[0].role, requiredRole: "super-admin" }))
    if (existingTeamMember[0] || !mayAssignTeam) return
    // SCIM-managed teams are assigned by the identity provider only.
    const managed = await coreHooks.runGuards("team.mutationGuard", { tx, organizationId, teamId: team.id, operation: "assignMember" })
    if (managed) return
    await tx.insert(TeamMemberTable).values({
      id: createDenTypeId("teamMember"),
      teamId: invitation.teamId,
      orgMembershipId: member.id,
    })
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/teams/purge-organization-teams",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 2,
  handler: async ({ tx, organizationId }) => {
    const teamIds = (await tx
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(eq(TeamTable.organizationId, organizationId)))
      .map((row) => row.id)
    if (teamIds.length > 0) {
      await tx.delete(TeamMemberTable).where(inArray(TeamMemberTable.teamId, teamIds))
    }
    await tx.delete(TeamTable).where(eq(TeamTable.organizationId, organizationId))
  },
})

// Always denied: turning the module off must not reopen raw team endpoints.
coreHooks.registerBootContributor({
  point: "auth.rawMutationDenials",
  id: "legacy/teams/raw-team-mutations",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  contribute: () => [
    { path: "/organization/create-team", message: "Use the Den teams API to manage teams." },
    { path: "/organization/update-team", message: "Use the Den teams API to manage teams." },
    { path: "/organization/remove-team", message: "Use the Den teams API to manage teams." },
    { path: "/organization/add-team-member", message: "Use the Den teams API to manage team membership." },
    { path: "/organization/remove-team-member", message: "Use the Den teams API to manage team membership." },
  ],
})

async function denyBetterAuthTeamMutation() {
  throw new APIError("FORBIDDEN", { message: "Use the Den teams API to manage teams and their membership." })
}

// Server-side Better Auth team calls are refused too, not only raw HTTP.
coreHooks.registerBootContributor({
  point: "betterAuth.orgHooks",
  id: "legacy/teams/deny-better-auth-team-mutations",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  contribute: () => ({
    beforeCreateTeam: denyBetterAuthTeamMutation,
    beforeUpdateTeam: denyBetterAuthTeamMutation,
    beforeDeleteTeam: denyBetterAuthTeamMutation,
    beforeAddTeamMember: denyBetterAuthTeamMutation,
    beforeRemoveTeamMember: denyBetterAuthTeamMutation,
  }),
})

// The Better Auth tables exist in every deployment, so ids are always generated.
coreHooks.registerBootContributor({
  point: "auth.modelIds",
  id: "legacy/teams/model-ids",
  registrant: "legacy",
  contribute: () => ({
    team: () => createDenTypeId("team"),
    teamMember: () => createDenTypeId("teamMember"),
  }),
})
