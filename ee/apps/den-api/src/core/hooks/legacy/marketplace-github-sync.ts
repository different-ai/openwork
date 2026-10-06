import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ConnectorInstanceAccessGrantTable } from "@openwork-ee/den-db/schema"
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
