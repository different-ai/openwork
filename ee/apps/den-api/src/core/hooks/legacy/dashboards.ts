import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { DashboardAccessGrantTable, DashboardTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: dashboards.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/dashboards/remove-member-dashboard-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 9,
  handler: async ({ tx, organizationId, memberIds, removedAt }) => {
    await tx
      .update(DashboardAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(DashboardAccessGrantTable.organizationId, organizationId),
        inArray(DashboardAccessGrantTable.orgMembershipId, memberIds),
        isNull(DashboardAccessGrantTable.removedAt),
      ))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/dashboards/remove-team-dashboard-grants",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 7,
  handler: async ({ tx, organizationId, teamId, removedAt }) => {
    // Previously left active (W0-05); soft-removed like member removal does.
    await tx
      .update(DashboardAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(DashboardAccessGrantTable.organizationId, organizationId),
        eq(DashboardAccessGrantTable.teamId, teamId),
        isNull(DashboardAccessGrantTable.removedAt),
      ))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/dashboards/purge-organization-dashboards",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 24,
  handler: async ({ tx, organizationId }) => {
    // Previously orphaned (W0-05).
    await tx.delete(DashboardAccessGrantTable).where(eq(DashboardAccessGrantTable.organizationId, organizationId))
    await tx.delete(DashboardTable).where(eq(DashboardTable.organizationId, organizationId))
  },
})
