import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { DesktopPolicyMemberTable } from "@openwork-ee/den-db/schema"
import { ensureDefaultDesktopPolicyForOrganization } from "../../../desktop-policies.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: desktopPolicies.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/desktop-policies/delete-member-assignments",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 3,
  handler: async ({ tx, organizationId, memberIds }) => {
    await tx
      .delete(DesktopPolicyMemberTable)
      .where(and(
        eq(DesktopPolicyMemberTable.organizationId, organizationId),
        inArray(DesktopPolicyMemberTable.orgMemberId, memberIds),
      ))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/desktop-policies/delete-team-assignments",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup,
  handler: async ({ tx, teamId }) => {
    await tx.delete(DesktopPolicyMemberTable).where(eq(DesktopPolicyMemberTable.teamId, teamId))
  },
})

coreHooks.registerPostCommit({
  point: "org.created",
  id: "legacy/desktop-policies/ensure-default-policy",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default + 1,
  errorPolicy: "propagate",
  handler: async (input) => {
    // Den path only, as today: Better Auth-created orgs get no default policy
    // (W0-05 open question 2).
    if (input.source !== "den" || !input.ownerMemberId) return
    await ensureDefaultDesktopPolicyForOrganization({
      organizationId: input.organizationId,
      createdByOrgMemberId: input.ownerMemberId,
    })
  },
})
