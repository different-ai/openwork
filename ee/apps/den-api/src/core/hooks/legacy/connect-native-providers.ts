import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, ExternalMcpConnectionTable } from "@openwork-ee/den-db/schema"
import { revokeGoogleTokens } from "../../../llm/inference-provider-lifecycle.js"
import { appLogger } from "../../../observability/logger.js"
import { GOOGLE_WORKSPACE_PROVIDER_ID, googleWorkspaceRevocationTokens } from "../../../organization-deletion-google-tokens.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"
import { collectGrantsForRevocation, revokeAfterOrganizationDeletion } from "./google-revocation.js"

const logger = appLogger.child({ component: "core_hooks_connect_native_providers" })

// Future owner: connect.nativeProviders.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/connect-native-providers/delete-member-connected-accounts",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 1,
  handler: async ({ tx, organizationId, memberIds }) => {
    await tx
      .delete(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, organizationId),
        inArray(ConnectedAccountTable.orgMembershipId, memberIds),
      ))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/connect-native-providers/revoke-organization-google-workspace-accounts",
  registrant: "legacy",
  security: true,
  // Reads Google Workspace grants before the connected accounts are purged,
  // then revokes them at Google once the deletion has committed.
  order: CORE_HOOK_ORDER.security + 1,
  handler: async ({ tx, organizationId, afterCommit }) => {
    const tokens = await collectGrantsForRevocation(logger, "connected_account", organizationId, async () => {
      const googleWorkspaceConnectionIds = (await tx
        .select({ id: ExternalMcpConnectionTable.id })
        .from(ExternalMcpConnectionTable)
        .where(and(eq(ExternalMcpConnectionTable.organizationId, organizationId), eq(ExternalMcpConnectionTable.nativeProviderKey, GOOGLE_WORKSPACE_PROVIDER_ID))))
        .map((row) => row.id)
      const accounts = await tx
        .select({
          providerId: ConnectedAccountTable.providerId,
          tokenType: ConnectedAccountTable.tokenType,
          accessToken: ConnectedAccountTable.accessToken,
          refreshToken: ConnectedAccountTable.refreshToken,
        })
        .from(ConnectedAccountTable)
        .where(eq(ConnectedAccountTable.organizationId, organizationId))
        .for("update")
      return googleWorkspaceRevocationTokens(accounts, googleWorkspaceConnectionIds)
    })
    if (tokens.length === 0) return
    afterCommit(() => revokeAfterOrganizationDeletion(logger, {
      organizationId,
      source: "connected_account",
      count: tokens.length,
      revoke: () => revokeGoogleTokens(tokens),
    }))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/connect-native-providers/purge-organization-connected-accounts",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 17,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(ConnectedAccountTable).where(eq(ConnectedAccountTable.organizationId, organizationId))
  },
})
