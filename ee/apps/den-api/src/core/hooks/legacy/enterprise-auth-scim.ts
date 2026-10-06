import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ScimGroupMemberTable, ScimSyncEventTable } from "@openwork-ee/den-db/schema"
import { isScimManagedTeam } from "../../../scim-groups.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: enterpriseAuth.scim.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/enterprise-auth-scim/unlink-member-group-projections",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 1,
  handler: async ({ tx, organizationId, memberIds }) => {
    await tx.update(ScimGroupMemberTable)
      .set({ userId: null, orgMembershipId: null, teamMemberId: null, updatedAt: new Date() })
      .where(and(eq(ScimGroupMemberTable.organizationId, organizationId), inArray(ScimGroupMemberTable.orgMembershipId, memberIds)))
  },
})

const scimManagedTeamMessages = {
  delete: "Disable SCIM team mapping before deleting this team.",
  assignMember: "Manage this team through the SCIM identity provider.",
} as const

coreHooks.registerGuard({
  point: "team.mutationGuard",
  id: "legacy/enterprise-auth-scim/refuse-scim-managed-team-mutation",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.guard,
  handler: async ({ tx, organizationId, teamId, operation }) => {
    if (!await isScimManagedTeam({ organizationId, teamId }, tx)) return null
    return { code: "scim_managed_team", status: 409, message: scimManagedTeamMessages[operation] }
  },
})

coreHooks.registerTx({
  point: "user.deleting",
  id: "legacy/enterprise-auth-scim/delete-user-sync-events",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 1,
  handler: async ({ tx, userId }) => {
    await tx.delete(ScimSyncEventTable).where(eq(ScimSyncEventTable.userId, userId))
  },
})
