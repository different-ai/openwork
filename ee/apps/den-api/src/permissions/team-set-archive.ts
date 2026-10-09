import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PermissionSetTable, PermissionSetTeamTable, TeamTable } from "@openwork-ee/den-db/schema"
import type { TeamMutationTransaction } from "../organization-team-roles.js"

type OrganizationId = typeof TeamTable.$inferSelect.organizationId
type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

/**
 * Stops the teams' permission sets applying (overview section 10): soft-removes
 * their active permission set links and archives each linked team set that no
 * other team still uses. Default sets are never archived. Nothing is deleted.
 * Used when a team is deleted, and when a SCIM provider is deleted or changes
 * how it maps groups, alongside clearing those teams' Admin designation: the
 * retained teams keep their members but grant nothing until the owner sets
 * their permissions again. `actorMemberId` is null for SCIM-driven changes.
 *
 * The permission_set rows are locked FOR UPDATE before their links, the same
 * order permission set edits and archives use, so these never deadlock.
 */
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

  const setIds = [...new Set(links.map((link) => link.permissionSetId))]
  const stillLinked = new Set((await tx
    .select({ permissionSetId: PermissionSetTeamTable.permissionSetId })
    .from(PermissionSetTeamTable)
    .where(and(
      eq(PermissionSetTeamTable.organizationId, input.organizationId),
      inArray(PermissionSetTeamTable.permissionSetId, setIds),
      isNull(PermissionSetTeamTable.removedAt),
    )))
    .map((row) => row.permissionSetId))
  const archiveIds = setIds.filter((setId) => !stillLinked.has(setId))
  if (archiveIds.length === 0) return

  await tx
    .update(PermissionSetTable)
    .set({ archivedAt: input.at, archivedByOrgMembershipId: input.actorMemberId })
    .where(and(
      eq(PermissionSetTable.organizationId, input.organizationId),
      inArray(PermissionSetTable.id, archiveIds),
      isNull(PermissionSetTable.defaultKey),
      isNull(PermissionSetTable.archivedAt),
    ))
}
