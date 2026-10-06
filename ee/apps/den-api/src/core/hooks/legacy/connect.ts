import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionAccessGrantTable, ExternalMcpConnectionTable, OrgOAuthClientTable, PluginMcpRequirementBindingTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"
import { memberFacingMcpConnectionsEnabled } from "../../../capability-sources/external-mcp-rollout.js"

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

// The effective value: Connect is member-facing default-on unless an
// explicit org kill switch says no.
coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/connect/org-context-capability",
  registrant: "legacy",
  // Today a failure here is a 500; keep it.
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 5,
  contribute: async ({ metadata }) => ({ capabilities: { mcpConnections: memberFacingMcpConnectionsEnabled(metadata) } }),
})

coreHooks.registerContributor({
  point: "me.desktopConfig",
  id: "legacy/connect/desktop-config-connect",
  registrant: "legacy",
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 3,
  contribute: async ({ metadata }) => ({ connectEnabled: memberFacingMcpConnectionsEnabled(metadata) }),
})

coreHooks.registerContributor({
  point: "auth.handoffPayload",
  id: "legacy/connect/handoff-connect-enabled",
  registrant: "legacy",
  contribute: async ({ organizationId, metadata }) => {
    if (!organizationId) return { connectEnabled: null }
    try {
      return { connectEnabled: memberFacingMcpConnectionsEnabled(metadata) }
    } catch {
      return { connectEnabled: null }
    }
  },
})
