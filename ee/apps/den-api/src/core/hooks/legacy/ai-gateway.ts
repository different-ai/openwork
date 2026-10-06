import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { deleteGatewayUsageForOrganization, expireUsageRequestsForMembers } from "@openwork-ee/den-db/gateway-usage-limits"
import {
  GatewayCredentialSetTable,
  GatewayKeyTable,
  GatewayModelGroupModelTable,
  GatewayModelGroupTable,
  GatewayProviderAccessTable,
  GatewayProviderCredentialTable,
  GatewayProviderModelTable,
  GatewayProviderOauthStateTable,
  GatewayProviderTable,
  GatewayRequestLogTable,
  GatewayUsageAssignmentTable,
  GatewayUsageRollupTable,
} from "@openwork-ee/den-db/schema"
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

coreHooks.registerTx({
  point: "team.deleting",
  id: "legacy/ai-gateway/delete-team-usage-assignments",
  registrant: "legacy",
  alwaysRun: "cleanup",
  // Runs inside deleteTeam's usage mutation, so affected members' effective
  // policies are recomputed when the assignment disappears. No soft-delete
  // column exists; policy history stays in gateway_usage_audit.
  order: CORE_HOOK_ORDER.security + 2,
  handler: async ({ tx, organizationId, teamId }) => {
    await tx.delete(GatewayUsageAssignmentTable).where(and(
      eq(GatewayUsageAssignmentTable.organizationId, organizationId),
      eq(GatewayUsageAssignmentTable.teamId, teamId),
    ))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/ai-gateway/erase-organization-usage",
  registrant: "legacy",
  alwaysRun: "cleanup",
  // First: erasure fences usage writers for the organization.
  order: CORE_HOOK_ORDER.lock,
  handler: ({ tx, organizationId }) => deleteGatewayUsageForOrganization(tx, organizationId),
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/ai-gateway/purge-organization-providers",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 4,
  handler: async ({ tx, organizationId }) => {
    const gatewayProviderIds = (await tx
      .select({ id: GatewayProviderTable.id })
      .from(GatewayProviderTable)
      .where(eq(GatewayProviderTable.organization_id, organizationId)).for("update"))
      .map((row) => row.id)
    if (gatewayProviderIds.length > 0) {
      await tx.delete(GatewayProviderOauthStateTable).where(inArray(GatewayProviderOauthStateTable.gateway_provider_id, gatewayProviderIds))
      const groups = await tx.select({ id: GatewayModelGroupTable.id }).from(GatewayModelGroupTable).where(inArray(GatewayModelGroupTable.gateway_provider_id, gatewayProviderIds))
      if (groups.length) await tx.delete(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id)))
      await tx.delete(GatewayProviderAccessTable).where(inArray(GatewayProviderAccessTable.gateway_provider_id, gatewayProviderIds))
      await tx.delete(GatewayProviderCredentialTable).where(inArray(GatewayProviderCredentialTable.gateway_provider_id, gatewayProviderIds))
      await tx.delete(GatewayCredentialSetTable).where(inArray(GatewayCredentialSetTable.gateway_provider_id, gatewayProviderIds))
      await tx.delete(GatewayModelGroupTable).where(inArray(GatewayModelGroupTable.gateway_provider_id, gatewayProviderIds))
      await tx.delete(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.gateway_provider_id, gatewayProviderIds))
    }
    await tx.delete(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.organization_id, organizationId))
    // Account erasure remains distinct from provider deletion, which retains its history.
    await tx.delete(GatewayRequestLogTable).where(eq(GatewayRequestLogTable.organization_id, organizationId))
    await tx.delete(GatewayUsageRollupTable).where(eq(GatewayUsageRollupTable.organization_id, organizationId))
    await tx.delete(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, organizationId))
    await tx.delete(GatewayKeyTable).where(eq(GatewayKeyTable.organization_id, organizationId))
  },
})
