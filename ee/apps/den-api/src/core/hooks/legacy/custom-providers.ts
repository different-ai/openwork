import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderMemberCredentialTable, LlmProviderModelTable, LlmProviderTable } from "@openwork-ee/den-db/schema"
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
  point: "user.deleting",
  id: "legacy/custom-providers/delete-deleted-user-credentials",
  registrant: "legacy",
  security: true,
  // Every membership, including ones removed earlier, as admin user delete did.
  order: CORE_HOOK_ORDER.security + 3,
  handler: async ({ tx, memberIds }) => {
    if (memberIds.length === 0) return
    await tx.delete(LlmProviderMemberCredentialTable).where(inArray(LlmProviderMemberCredentialTable.orgMembershipId, memberIds))
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

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/custom-providers/purge-organization-providers",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 7,
  handler: async ({ tx, organizationId }) => {
    const llmProviderIds = (await tx
      .select({ id: LlmProviderTable.id })
      .from(LlmProviderTable)
      .where(eq(LlmProviderTable.organizationId, organizationId)))
      .map((row) => row.id)
    if (llmProviderIds.length > 0) {
      await tx.delete(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, llmProviderIds))
      await tx.delete(LlmProviderAccessTable).where(inArray(LlmProviderAccessTable.llmProviderId, llmProviderIds))
    }
    await tx.delete(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.organizationId, organizationId))
    await tx.delete(LlmProviderTable).where(eq(LlmProviderTable.organizationId, organizationId))
  },
})
