import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderMemberCredentialTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: customProviders.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/custom-providers/delete-member-credentials",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 2,
  handler: async ({ tx, organizationId, memberIds }) => {
    await tx
      .delete(LlmProviderMemberCredentialTable)
      .where(and(
        eq(LlmProviderMemberCredentialTable.organizationId, organizationId),
        inArray(LlmProviderMemberCredentialTable.orgMembershipId, memberIds),
      ))
  },
})

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/custom-providers/delete-member-provider-access",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 2,
  handler: async ({ tx, memberIds }) => {
    await tx
      .delete(LlmProviderAccessTable)
      .where(inArray(LlmProviderAccessTable.orgMembershipId, memberIds))
  },
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/custom-providers/delete-team-provider-access",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 2,
  handler: async ({ tx, teamId }) => {
    await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.teamId, teamId))
  },
})
