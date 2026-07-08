import type { DenTypeId } from "@openwork-ee/utils/typeid"
import {
  clientSelectedFeatures,
  NATIVE_OAUTH_PROVIDERS,
  resolveProviderScopes,
  type NativeOAuthProviderConfig,
} from "./provider-registry.js"
import { getConnectedAccount, getOrgOAuthClient } from "./oauth-credentials.js"

/**
 * Native providers (google-workspace, ...) surface in the SAME member-facing
 * list as external MCP connections, so the desktop app renders and connects
 * them with zero client changes: once an org admin saves an OAuth client for
 * a provider, every granted surface that lists usable connections shows a
 * per-member card for it. These entries are synthetic — they exist in
 * OrgOAuthClientTable + ConnectedAccountTable, never in
 * ExternalMcpConnectionTable — which also keeps them out of the agent MCP
 * client merge (external-capabilities reads the DB table directly).
 */

export type NativeProviderConnectionEntry = {
  id: string
  name: string
  url: string
  authType: "oauth"
  credentialMode: "per_member"
  connected: boolean
  connectedAt: null
  connectedForMe: boolean
  needsReconnect: boolean
  missingFeatures: string[]
  access: null
}

type NativeProviderReconnectState = {
  needsReconnect: boolean
  missingFeatures: string[]
}

function resolveReconnectState(
  provider: NativeOAuthProviderConfig,
  clientExtra: Record<string, unknown> | null,
  grantedScopes: string[] | null,
): NativeProviderReconnectState {
  if (!grantedScopes || grantedScopes.length === 0) {
    return { needsReconnect: false, missingFeatures: [] }
  }

  const selectedFeatures = clientSelectedFeatures(provider, clientExtra)
  const expectedScopes = resolveProviderScopes(provider, selectedFeatures)
  const grantedScopeSet = new Set(grantedScopes)
  const needsReconnect = expectedScopes.some((scope) => !grantedScopeSet.has(scope))
  const missingFeatures = selectedFeatures.filter((feature) => {
    const featureScopes = provider.optionalFeatures?.[feature] ?? []
    return featureScopes.some((scope) => !grantedScopeSet.has(scope))
  })

  return { needsReconnect, missingFeatures }
}

export function buildNativeProviderEntry(
  provider: NativeOAuthProviderConfig,
  state: { clientConfigured: boolean; connectedForMe: boolean; reconnect?: NativeProviderReconnectState },
): NativeProviderConnectionEntry | null {
  if (!state.clientConfigured) {
    return null
  }
  return {
    id: provider.providerId,
    name: provider.displayName,
    url: provider.websiteUrl,
    authType: "oauth",
    credentialMode: "per_member",
    connected: true,
    connectedAt: null,
    connectedForMe: state.connectedForMe,
    needsReconnect: state.reconnect?.needsReconnect ?? false,
    missingFeatures: state.reconnect?.missingFeatures ?? [],
    access: null,
  }
}

export async function listNativeProviderUsableEntries(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<NativeProviderConnectionEntry[]> {
  const entries: NativeProviderConnectionEntry[] = []
  for (const provider of Object.values(NATIVE_OAUTH_PROVIDERS)) {
    const client = await getOrgOAuthClient(input.organizationId, provider.providerId)
    if (!client) continue
    const account = await getConnectedAccount({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      providerId: provider.providerId,
    })
    const entry = buildNativeProviderEntry(provider, {
      clientConfigured: true,
      connectedForMe: Boolean(account?.accessToken),
      reconnect: account?.accessToken
        ? resolveReconnectState(provider, client.extra, account.scopes)
        : { needsReconnect: false, missingFeatures: [] },
    })
    if (entry) entries.push(entry)
  }
  return entries
}
