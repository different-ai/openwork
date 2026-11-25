import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PermissionSetTable, PermissionSetTeamTable, TeamTable } from "@openwork-ee/den-db/schema"
import type { TeamMutationTransaction } from "../organization-team-roles.js"

type OrganizationId = typeof TeamTable.$inferSelect.organizationId
type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

export async function archiveTeamPermissionSets(tx: TeamMutationTransaction, input: {
  organizationId: OrganizationId
  teamIds: readonly TeamId[]
  actorMemberId: MemberId | null
  at: Date
}) {
  if (input.teamIds.length === 0) return
  const activeLinks = () => and(
    eq(PermissionSetTeamTable.organizationId, input.organizationId),
    inArray(PermissionSetTeamTable.teamId, [...input.teamIds]),
    isNull(PermissionSetTeamTable.removedAt),
  )
  const candidateSetIds = [...new Set((await tx
    .select({ permissionSetId: PermissionSetTeamTable.permissionSetId })
    .from(PermissionSetTeamTable)
    .where(activeLinks()))
    .map((link) => link.permissionSetId))]
  if (candidateSetIds.length === 0) return
  await tx.select({ id: PermissionSetTable.id })
    .from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.organizationId, input.organizationId), inArray(PermissionSetTable.id, candidateSetIds)))
    .for("update")

  const links = await tx
    .select({ id: PermissionSetTeamTable.id, permissionSetId: PermissionSetTeamTable.permissionSetId })
    .from(PermissionSetTeamTable)
    .where(activeLinks())
    .for("update")
  if (links.length === 0) return

  await tx
    .update(PermissionSetTeamTable)
    .set({ removedAt: input.at, removedByOrgMembershipId: input.actorMemberId })
    .where(inArray(PermissionSetTeamTable.id, links.map((link) => link.id)))

}
