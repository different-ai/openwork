import { and, eq, isNull, or } from "@openwork-ee/den-db/drizzle"
import { listAuthoritativeTeamMemberships } from "@openwork-ee/den-db/permissions"
import { InvitationTable, MemberTable, OrganizationTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { randomUUID } from "node:crypto"
import { withGatewayUsageEntitlementMutation } from "@openwork-ee/den-db/gateway-usage-limits"
import { organizationRoleValueSatisfies } from "./organization-role-hierarchy.js"
import { pruneUnreachableMemberApiKeys } from "./capability-sources/external-mcp-connections.js"

export type OrganizationAdminTeam = { id: string; name: string }

export type TeamMutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function withOrganizationTeamMutation<T>(
  organizationId: typeof TeamTable.$inferSelect.organizationId,
  mutation: (tx: TeamMutationTransaction) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId)).for("update")
    const result = await mutation(tx)
    await tx.update(OrganizationTable).set({ teamMembershipRevision: randomUUID() })
      .where(eq(OrganizationTable.id, organizationId))
    return result
  })
}

export function withOrganizationMembershipUsageMutation<T>(
  organizationId: typeof TeamTable.$inferSelect.organizationId,
  mutation: (tx: TeamMutationTransaction) => Promise<T>,
  memberIds: typeof MemberTable.$inferSelect.id[] | ((tx: TeamMutationTransaction) => Promise<typeof MemberTable.$inferSelect.id[]>),
) {
  return withOrganizationTeamMutation(organizationId, async (tx) => {
    const affected = [...new Set(typeof memberIds === "function" ? await memberIds(tx) : memberIds)]
    const result = await withGatewayUsageEntitlementMutation(tx, organizationId, () => mutation(tx), affected)
    await pruneUnreachableMemberApiKeys(tx, { organizationId, orgMembershipIds: affected })
    return result
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

export async function listOrganizationAdminTeamGrants(organizationId: typeof TeamTable.$inferSelect.organizationId, database: typeof db | TeamMutationTransaction = db) {
  const grants = await listAuthoritativeTeamMemberships(database, { organizationId, adminTeamsOnly: true })
  return grants.map((grant) => ({ memberId: grant.memberId, id: grant.teamId, name: grant.teamName }))
}

export async function listMemberAdminTeams(input: {
  organizationId: typeof TeamTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}): Promise<OrganizationAdminTeam[]> {
  const grants = await listAuthoritativeTeamMemberships(db, { ...input, adminTeamsOnly: true })
  return grants.map((grant) => ({ id: grant.teamId, name: grant.teamName }))
}

export async function resolveOrganizationMemberAuthority(input: {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}) {
  const [members, adminTeams] = await Promise.all([
    db.select().from(MemberTable).where(and(
      eq(MemberTable.id, input.memberId),
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
    )).limit(1),
    listMemberAdminTeams(input),
  ])
  const member = members[0]
  if (!member?.userId) return null
  return { ...member, directRole: member.role, role: effectiveOrganizationRole(member.role, adminTeams), adminTeams }
}
