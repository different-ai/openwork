import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: marketplace. Grants are soft-removed to keep audit history.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/marketplace/remove-member-marketplace-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 5,
  handler: async ({ tx, organizationId, memberIds, removedAt }) => {
    await tx
      .update(MarketplaceAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(MarketplaceAccessGrantTable.organizationId, organizationId),
        inArray(MarketplaceAccessGrantTable.orgMembershipId, memberIds),
        isNull(MarketplaceAccessGrantTable.removedAt),
      ))
  },
})

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/marketplace/remove-member-config-object-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 6,
  handler: async ({ tx, organizationId, memberIds, removedAt }) => {
    await tx
      .update(ConfigObjectAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
        inArray(ConfigObjectAccessGrantTable.orgMembershipId, memberIds),
        isNull(ConfigObjectAccessGrantTable.removedAt),
      ))
  },
})

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/marketplace/remove-member-plugin-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 7,
  handler: async ({ tx, organizationId, memberIds, removedAt }) => {
    await tx
      .update(PluginAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(PluginAccessGrantTable.organizationId, organizationId),
        inArray(PluginAccessGrantTable.orgMembershipId, memberIds),
        isNull(PluginAccessGrantTable.removedAt),
      ))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/marketplace/remove-team-marketplace-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 3,
  handler: async ({ tx, teamId, removedAt }) => {
    await tx
      .update(MarketplaceAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(MarketplaceAccessGrantTable.teamId, teamId), isNull(MarketplaceAccessGrantTable.removedAt)))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/marketplace/remove-team-config-object-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 4,
  handler: async ({ tx, teamId, removedAt }) => {
    await tx
      .update(ConfigObjectAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(ConfigObjectAccessGrantTable.teamId, teamId), isNull(ConfigObjectAccessGrantTable.removedAt)))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/marketplace/remove-team-plugin-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 5,
  handler: async ({ tx, teamId, removedAt }) => {
    await tx
      .update(PluginAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(PluginAccessGrantTable.teamId, teamId), isNull(PluginAccessGrantTable.removedAt)))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/marketplace/purge-organization-marketplace",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 20,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.organizationId, organizationId))
    await tx.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
    await tx.delete(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.organizationId, organizationId))
    await tx.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
    await tx.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
    await tx.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
    await tx.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
    await tx.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
    await tx.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
  },
})
