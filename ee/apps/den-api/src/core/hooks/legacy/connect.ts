import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionAccessGrantTable, ExternalMcpConnectionTable, OrgOAuthClientTable, PluginMcpRequirementBindingTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: connect.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/connect/delete-member-connection-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 4,
  handler: async ({ tx, organizationId, memberIds }) => {
    await tx
      .delete(ExternalMcpConnectionAccessGrantTable)
      .where(and(
        eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId),
        inArray(ExternalMcpConnectionAccessGrantTable.orgMembershipId, memberIds),
      ))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/connect/delete-team-connection-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 1,
  handler: async ({ tx, teamId }) => {
    await tx.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.teamId, teamId))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/connect/purge-organization-connections",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 18,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.organizationId, organizationId))
    await tx.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
    await tx.delete(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.organizationId, organizationId))
    await tx.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.organizationId, organizationId))
  },
})
