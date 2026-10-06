import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  InferenceKeyTable,
  InferenceOrgLimitPolicyTable,
  InferenceOrgUpstreamProviderKeyTable,
  InferenceOrgUsageBucketTable,
  InferenceUsageLedgerBucketChargeTable,
  InferenceUsageLedgerEntryTable,
} from "@openwork-ee/den-db/schema"
import { syncInferenceAfterMemberChange } from "../../../inference.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: openworkModels. `syncInferenceAfterMemberChange` also mints and
// revokes gateway keys (aiGateway); W0-P07 splits it.

coreHooks.registerPostCommit({
  point: "member.added",
  id: "legacy/openwork-models/sync-inference-after-member-added",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  errorPolicy: "propagate",
  handler: async (input) => {
    // Today only Den invitation create and acceptance run member-change hooks.
    if (input.source !== "invitation" && input.source !== "acceptance") return
    await syncInferenceAfterMemberChange({
      organizationId: input.organizationId,
      memberId: input.memberId,
      memberCount: input.memberCount,
      change: "added",
    })
  },
})

coreHooks.registerPostCommit({
  point: "member.removed",
  id: "legacy/openwork-models/sync-inference-after-member-removed",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  errorPolicy: "propagate",
  handler: (input) => syncInferenceAfterMemberChange({
    organizationId: input.organizationId,
    memberId: input.memberId,
    memberCount: input.memberCount,
    change: "removed",
  }),
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/openwork-models/purge-organization-inference",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 5,
  handler: async ({ tx, organizationId }) => {
    const ledgerEntryIds = (await tx
      .select({ id: InferenceUsageLedgerEntryTable.id })
      .from(InferenceUsageLedgerEntryTable)
      .where(eq(InferenceUsageLedgerEntryTable.organization_id, organizationId)))
      .map((row) => row.id)
    if (ledgerEntryIds.length > 0) {
      await tx.delete(InferenceUsageLedgerBucketChargeTable).where(inArray(InferenceUsageLedgerBucketChargeTable.ledger_entry_id, ledgerEntryIds))
    }
    await tx.delete(InferenceUsageLedgerEntryTable).where(eq(InferenceUsageLedgerEntryTable.organization_id, organizationId))
    await tx.delete(InferenceKeyTable).where(eq(InferenceKeyTable.organization_id, organizationId))
    await tx.delete(InferenceOrgLimitPolicyTable).where(eq(InferenceOrgLimitPolicyTable.organization_id, organizationId))
    await tx.delete(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.organization_id, organizationId))
    await tx.delete(InferenceOrgUpstreamProviderKeyTable).where(eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId))
  },
})
