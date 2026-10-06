import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSourceBindingTable,
  ConnectorSourceTombstoneTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
} from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: marketplace.githubSync.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/marketplace-github-sync/remove-member-connector-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 8,
  handler: async ({ tx, organizationId, memberIds, removedAt }) => {
    await tx
      .update(ConnectorInstanceAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(ConnectorInstanceAccessGrantTable.organizationId, organizationId),
        inArray(ConnectorInstanceAccessGrantTable.orgMembershipId, memberIds),
        isNull(ConnectorInstanceAccessGrantTable.removedAt),
      ))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/marketplace-github-sync/remove-team-connector-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 6,
  handler: async ({ tx, teamId, removedAt }) => {
    await tx
      .update(ConnectorInstanceAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(ConnectorInstanceAccessGrantTable.teamId, teamId), isNull(ConnectorInstanceAccessGrantTable.removedAt)))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/marketplace-github-sync/purge-organization-connectors",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 19,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(ConnectorSourceTombstoneTable).where(eq(ConnectorSourceTombstoneTable.organizationId, organizationId))
    await tx.delete(ConnectorSourceBindingTable).where(eq(ConnectorSourceBindingTable.organizationId, organizationId))
    await tx.delete(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.organizationId, organizationId))
    await tx.delete(ConnectorMappingTable).where(eq(ConnectorMappingTable.organizationId, organizationId))
    await tx.delete(ConnectorTargetTable).where(eq(ConnectorTargetTable.organizationId, organizationId))
    await tx.delete(ConnectorInstanceAccessGrantTable).where(eq(ConnectorInstanceAccessGrantTable.organizationId, organizationId))
    await tx.delete(ConnectorInstanceTable).where(eq(ConnectorInstanceTable.organizationId, organizationId))
    await tx.delete(ConnectorAccountTable).where(eq(ConnectorAccountTable.organizationId, organizationId))
  },
})
