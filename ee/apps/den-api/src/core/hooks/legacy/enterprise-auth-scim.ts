import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ScimGroupMemberTable,
  ScimGroupRoleGrantTable,
  ScimGroupRoleTable,
  ScimGroupTable,
  ScimProviderTable,
  ScimSyncEventTable,
  ScimUserTombstoneTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { isScimManagedTeam } from "../../../scim-groups.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"
import { db } from "../../../db.js"

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

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/enterprise-auth-scim/purge-organization-scim",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 3,
  handler: async ({ tx, organizationId }) => {
    const scimGroupIds = (await tx
      .select({ id: ScimGroupTable.id })
      .from(ScimGroupTable)
      .where(eq(ScimGroupTable.organizationId, organizationId)))
      .map((row) => row.id)
    if (scimGroupIds.length > 0) {
      await tx.delete(ScimGroupMemberTable).where(inArray(ScimGroupMemberTable.groupId, scimGroupIds))
      // Previously orphaned (W0-05): group role rows only carry the group id.
      await tx.delete(ScimGroupRoleTable).where(inArray(ScimGroupRoleTable.groupId, scimGroupIds))
    }
    // Previously orphaned (W0-05).
    await tx.delete(ScimGroupRoleGrantTable).where(eq(ScimGroupRoleGrantTable.organizationId, organizationId))
    await tx.delete(ScimProviderTable).where(eq(ScimProviderTable.organizationId, organizationId))
    await tx.delete(ScimSyncEventTable).where(eq(ScimSyncEventTable.organizationId, organizationId))
    await tx.delete(ScimUserTombstoneTable).where(eq(ScimUserTombstoneTable.organizationId, organizationId))
    await tx.delete(ScimGroupTable).where(eq(ScimGroupTable.organizationId, organizationId))
  },
})

// Always denied: turning the module off must not reopen raw SCIM endpoints.
coreHooks.registerBootContributor({
  point: "auth.rawMutationDenials",
  id: "legacy/enterprise-auth-scim/raw-scim-mutations",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  contribute: () => [
    { path: "/scim/generate-token", message: "Use the Den SCIM API to manage SCIM tokens." },
    { path: "/scim/delete-provider-connection", message: "Use the Den SCIM API to manage SCIM providers." },
  ],
})

coreHooks.registerBootContributor({
  point: "auth.modelIds",
  id: "legacy/enterprise-auth-scim/model-ids",
  registrant: "legacy",
  contribute: () => ({
    scimProvider: () => createDenTypeId("scimProvider"),
    scimGroup: () => createDenTypeId("scimGroup"),
    scimGroupMember: () => createDenTypeId("scimGroupMember"),
    scimGroupRole: () => createDenTypeId("scimGroupRole"),
    scimGroupRoleGrant: () => createDenTypeId("scimGroupRoleGrant"),
  }),
})

coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/enterprise-auth-scim/org-context-auth-method",
  registrant: "legacy",
  // Today a failure here is a 500; keep it.
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 13,
  contribute: async ({ organizationId }) => ({ authMethods: { scim: (await db.select({ id: ScimProviderTable.id }).from(ScimProviderTable).where(eq(ScimProviderTable.organizationId, organizationId)).limit(1)).length > 0 } }),
})
