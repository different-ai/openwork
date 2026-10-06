import {
  syncInferenceSubscriptionQuantityAfterMemberChange,
  syncSeatSubscriptionQuantityAfterMemberChange,
  syncWebSubscriptionQuantityAfterMemberChange,
} from "../../../stripe-billing.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: billing. Stripe quantity syncs keep today's "propagate"
// semantics and today's paths (Den invitation create, acceptance, removal);
// W0-05 PR D extends them to every add path behind a flag.

const quantitySyncs = [
  { name: "seat", sync: syncSeatSubscriptionQuantityAfterMemberChange },
  { name: "inference", sync: syncInferenceSubscriptionQuantityAfterMemberChange },
  { name: "web", sync: syncWebSubscriptionQuantityAfterMemberChange },
]

quantitySyncs.forEach(({ name, sync }, index) => {
  coreHooks.registerPostCommit({
    point: "member.added",
    id: `legacy/billing/${name}-quantity-after-member-added`,
    registrant: "legacy",
    order: CORE_HOOK_ORDER.sync + index,
    errorPolicy: "propagate",
    handler: async (input) => {
      if (input.source !== "invitation" && input.source !== "acceptance") return
      await sync({ organizationId: input.organizationId, memberCount: input.memberCount })
    },
  })

  coreHooks.registerPostCommit({
    point: "member.removed",
    id: `legacy/billing/${name}-quantity-after-member-removed`,
    registrant: "legacy",
    order: CORE_HOOK_ORDER.sync + index,
    errorPolicy: "propagate",
    handler: (input) => sync({ organizationId: input.organizationId, memberCount: input.memberCount }),
  })
})
