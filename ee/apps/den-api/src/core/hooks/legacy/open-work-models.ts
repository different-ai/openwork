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
