// FUTURE(modules/ai-gateway/usage-limits): how usage limits plug into Core
// membership and authority.
import { withGatewayUsageEntitlementMutation, type GatewayUsageAdminAuthority } from "@openwork-ee/den-db/gateway-usage-limits"
import { CORE_HOOK_ORDER, type MembershipMutationParticipant } from "./core/hook-seams.js"
import { listAuthorityElevations } from "./core/member-authority.js"

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

// Usage-limit administration follows the same authority rules as every other
// admin check (Admin teams, minus unconfirmed or orphaned SCIM projections).
// den-db calls this only after the direct-role check fails, inside its
// transaction; with lock it rechecks under FOR SHARE.
export const gatewayUsageAdminAuthority: GatewayUsageAdminAuthority = async (reader, input) => {
  const elevations = await listAuthorityElevations({
    organizationId: input.organizationId,
    memberId: input.memberId,
    database: reader,
    lock: input.lock ? "share" : undefined,
  })
  return elevations.some((elevation) => elevation.role === "admin")
}
