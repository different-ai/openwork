import { eq } from "@openwork-ee/den-db/drizzle"
import { OrgSubscriptionTable } from "@openwork-ee/den-db/schema"
import {
  cancelOrganizationSubscriptions,
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

coreHooks.registerGuard({
  point: "org.deletion.pre",
  id: "legacy/billing/cancel-organization-subscriptions",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  handler: async ({ organizationId }) => {
    // A failure aborts deletion, as today: nothing is deleted while Stripe still bills.
    await cancelOrganizationSubscriptions({ organizationId })
    return null
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/billing/purge-organization-subscriptions",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 12,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(OrgSubscriptionTable).where(eq(OrgSubscriptionTable.organization_id, organizationId))
  },
})
