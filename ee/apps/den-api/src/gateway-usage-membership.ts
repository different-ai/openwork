// FUTURE(modules/ai-gateway/usage-limits): how usage limits plug into Core
// membership and authority.
import { withGatewayUsageEntitlementMutation } from "@openwork-ee/den-db/gateway-usage-limits"
import { CORE_HOOK_ORDER, type MembershipMutationParticipant } from "./core/hook-seams.js"

// The usage-entitlement lock as a `membership.mutation.participant`. Accounting
// consistency: it locks usage org/member rows right after the org row,
// snapshots effective policies, and expires stale reset requests / extensions
// after the mutation. It must run even when usage limits are off, so stale
// extensions never survive.
export const gatewayUsageEntitlementParticipant: MembershipMutationParticipant = {
  id: "ai-gateway-usage-limits/entitlement-participant",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.lock,
  alwaysRun: "consistency",
  run: (context, next) => withGatewayUsageEntitlementMutation(context.tx, context.organizationId, next, context.memberIds),
}

