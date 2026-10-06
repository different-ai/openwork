import { eq } from "@openwork-ee/den-db/drizzle"
import { expireUsageRequestsForMembers } from "@openwork-ee/den-db/gateway-usage-limits"
import { GatewayProviderAccessTable } from "@openwork-ee/den-db/schema"
import { ensureMemberGatewayKey } from "../../../gateway-keys.js"
import {
  invalidateTeamInferenceOAuth,
  revokeGoogleCredentials,
  revokeInferenceCredentialsForMembers,
} from "../../../llm/inference-provider-lifecycle.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: aiGateway (credentials and keys are shared with openworkModels
// until W0-P07 splits inference.ts; usage requests belong to aiGateway.usageLimits).

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/ai-gateway/revoke-member-inference-credentials",
  registrant: "legacy",
  security: true,
  // Credentials lock first: revokeInferenceCredentialsForMembers expects to
  // run before any grant cleanup under the caller's member fences.
  order: CORE_HOOK_ORDER.security,
  handler: async ({ tx, memberIds, afterCommit }) => {
    const credentials = await revokeInferenceCredentialsForMembers(tx, memberIds)
    afterCommit(() => revokeGoogleCredentials(credentials))
  },
})

coreHooks.registerPostCommit({
  point: "member.added",
  id: "legacy/ai-gateway/mint-member-key-for-adapter-insert",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  errorPolicy: "propagate",
  handler: async (input) => {
    // Den invitation/acceptance mint through openworkModels' member sync.
    if (input.source !== "betterAuthAdapter") return
    if (!input.userId || input.removedAt) return
    await ensureMemberGatewayKey({ organizationId: input.organizationId, memberId: input.memberId })
  },
})

coreHooks.registerPostCommit({
  point: "org.created",
  id: "legacy/ai-gateway/mint-owner-key",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  errorPolicy: "propagate",
  handler: async (input) => {
    // Better Auth-created orgs mint through the member.create.after adapter hook.
    if (input.source !== "den" || !input.ownerMemberId) return
    await ensureMemberGatewayKey({ organizationId: input.organizationId, memberId: input.ownerMemberId })
  },
})

coreHooks.registerTx({
  point: "team.membershipChanged",
  id: "legacy/ai-gateway/invalidate-team-inference-oauth",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  handler: ({ tx, teamId }) => invalidateTeamInferenceOAuth(tx, teamId),
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/ai-gateway/invalidate-deleted-team-inference-oauth",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  handler: ({ tx, teamId }) => invalidateTeamInferenceOAuth(tx, teamId),
})

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/ai-gateway/delete-team-provider-access",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.security + 1,
  handler: async ({ tx, teamId }) => {
    await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.team_id, teamId))
  },
})

coreHooks.registerTx({
  point: "user.deleting",
  id: "legacy/ai-gateway/expire-member-usage-requests",
  registrant: "legacy",
  alwaysRun: "consistency",
  order: CORE_HOOK_ORDER.security,
  handler: async ({ tx, memberIds }) => {
    await expireUsageRequestsForMembers(tx, memberIds)
  },
})

coreHooks.registerTx({
  point: "user.deleting",
  id: "legacy/ai-gateway/revoke-deleted-user-inference-credentials",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 1,
  handler: async ({ tx, memberIds, afterCommit }) => {
    const credentials = await revokeInferenceCredentialsForMembers(tx, memberIds)
    afterCommit(() => revokeGoogleCredentials(credentials))
  },
})
