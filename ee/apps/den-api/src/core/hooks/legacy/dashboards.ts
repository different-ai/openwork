import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { DashboardAccessGrantTable } from "@openwork-ee/den-db/schema"
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
