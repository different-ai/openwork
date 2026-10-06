// `membership.mutation.participant` for external MCP member API keys: team
// membership is one of the grants a personal MCP key relies on, so prune keys
// that became unreachable. Security revocation, so it always runs (R1).
import { CORE_HOOK_ORDER, type MembershipMutationParticipant } from "../core/hook-seams.js"
import { pruneUnreachableMemberApiKeys } from "./external-mcp-connections.js"

export const memberApiKeyPruningParticipant: MembershipMutationParticipant = {
  id: "connect/member-api-key-pruning",
  registrant: "legacy",
  // Outermost wrapper: it has no pre-step, so the usage locks are still taken
  // right after the org row, and its prune runs last, after the usage
  // participant's post-step, exactly as before the split.
  order: CORE_HOOK_ORDER.lock - 10,
  security: true,
  run: async (context, next) => {
    const result = await next()
    await pruneUnreachableMemberApiKeys(context.tx, { organizationId: context.organizationId, orgMembershipIds: context.memberIds })
    return result
  },
}
