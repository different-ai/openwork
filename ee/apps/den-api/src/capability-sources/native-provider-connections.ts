import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import {
  clientSelectedFeatures,
  NATIVE_OAUTH_PROVIDERS,
  providerScopesSatisfy,
  resolveProviderScopes,
  type NativeOAuthProviderConfig,
} from "./provider-registry.js"
import { getConnectedAccount, getOrgOAuthClient } from "./oauth-credentials.js"
import { readProviderTenantId } from "./oauth-tenant.js"
import { listExternalMcpConnections, listUsableNativeProviderConnections } from "./external-mcp-connections.js"

/**
 * Native providers (google-workspace, ...) surface in the SAME member-facing
 * list as external MCP connections, so the desktop app renders and connects
 * them with zero client changes: once an org admin saves an OAuth client for
 * a provider, every granted surface that lists usable connections shows a
 * per-member card for it. Legacy entries are synthetic; multi-account
 * connectors use ExternalMcpConnectionTable rows and are explicitly fenced
 * out of the external MCP client merge.
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
  /** Which service this connector fronts ("google-workspace"), so an admin-named card ("Acme Labs") can still say what it signs in to. */
  nativeProviderKey: string
  externalAccountId?: string | null
  grantedScopes?: string[]
  tenantId?: string | null
  requiredBy: []
  access: null
}

type NativeProviderReconnectState = {
  needsReconnect: boolean
  missingFeatures: string[]
}

export function resolveNativeProviderReconnectState(
  provider: NativeOAuthProviderConfig,
  clientExtra: Record<string, unknown> | null,
  grantedScopes: string[] | null,
): NativeProviderReconnectState {
  if (!grantedScopes || grantedScopes.length === 0) {
    return { needsReconnect: false, missingFeatures: [] }
  }

  const selectedFeatures = clientSelectedFeatures(provider, clientExtra)
  const expectedScopes = resolveProviderScopes(provider, selectedFeatures)
  const needsReconnect = expectedScopes.some((scope) => !providerScopesSatisfy(provider, grantedScopes, scope))
  const missingFeatures = selectedFeatures.filter((feature) => {
    const featureScopes = provider.optionalFeatures?.[feature] ?? []
    return featureScopes.some((scope) => !providerScopesSatisfy(provider, grantedScopes, scope))
  })

  return { needsReconnect, missingFeatures }
}

export function buildNativeProviderEntry(
  provider: NativeOAuthProviderConfig,
  state: {
    clientConfigured: boolean
    connectedForMe: boolean
    externalAccountId?: string | null
    grantedScopes?: string[] | null
    reconnect?: NativeProviderReconnectState
    tenantId?: string | null
    credentialProviderId?: string
    name?: string
  },
): NativeProviderConnectionEntry | null {
  if (!state.clientConfigured) {
    return null
  }
  return {
    id: state.credentialProviderId ?? provider.providerId,
    name: state.name ?? provider.displayName,
    url: provider.websiteUrl,
    authType: "oauth",
    credentialMode: "per_member",
    nativeProviderKey: provider.providerId,
    connected: true,
    connectedAt: null,
    connectedForMe: state.connectedForMe,
    needsReconnect: state.reconnect?.needsReconnect ?? false,
    missingFeatures: state.reconnect?.missingFeatures ?? [],
    ...(state.externalAccountId !== undefined ? { externalAccountId: state.externalAccountId } : {}),
    ...(state.grantedScopes ? { grantedScopes: state.grantedScopes } : {}),
    ...(state.tenantId !== undefined ? { tenantId: state.tenantId } : {}),
    requiredBy: [],
    access: null,
  }
}

export async function listNativeProviderUsableEntries(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  teamIds?: DenTypeId<"team">[]
}): Promise<NativeProviderConnectionEntry[]> {
  const entries: NativeProviderConnectionEntry[] = []
  const connections = await listUsableNativeProviderConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    teamIds: input.teamIds ?? [],
  })
  for (const connection of connections) {
    if (!connection.nativeProviderKey) continue
    const provider = NATIVE_OAUTH_PROVIDERS[connection.nativeProviderKey]
    if (!provider) continue
    const client = await getOrgOAuthClient(input.organizationId, connection.id)
    if (!client) continue
    const account = await getConnectedAccount({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      providerId: connection.id,
    })
    const entry = buildNativeProviderEntry(provider, {
      clientConfigured: true,
      connectedForMe: Boolean(account?.accessToken),
      credentialProviderId: connection.id,
      name: connection.name,
      ...(account?.externalAccountId ? { externalAccountId: account.externalAccountId } : {}),
      ...(account?.scopes ? { grantedScopes: account.scopes } : {}),
      ...(provider.tenantIdExtraKey
        ? { tenantId: readProviderTenantId(client.extra, provider.tenantIdExtraKey) }
        : {}),
      reconnect: account?.accessToken
        ? resolveNativeProviderReconnectState(provider, client.extra, account.scopes)
        : { needsReconnect: false, missingFeatures: [] },
    })
    if (entry) entries.push(entry)
  }

  // Legacy native-provider clients never had connector rows. Keep their
  // literal registry key visible org-wide without moving either credentials
  // or connected accounts.
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
      ...(account?.externalAccountId ? { externalAccountId: account.externalAccountId } : {}),
      ...(account?.scopes ? { grantedScopes: account.scopes } : {}),
      ...(provider.tenantIdExtraKey
        ? { tenantId: readProviderTenantId(client.extra, provider.tenantIdExtraKey) }
        : {}),
      reconnect: account?.accessToken
        ? resolveNativeProviderReconnectState(provider, client.extra, account.scopes)
        : { needsReconnect: false, missingFeatures: [] },
    })
    if (entry) entries.push(entry)
  }
  return entries
}

export async function resolveDefaultNativeProviderCredentialId(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  nativeProviderKey: string
  teamIds: DenTypeId<"team">[]
}): Promise<string | null> {
  // The literal registry key is the legacy alias: it has no connector row or
  // access grants, so it intentionally remains implicitly org-wide.
  if (await getOrgOAuthClient(input.organizationId, input.nativeProviderKey)) {
    return input.nativeProviderKey
  }
  const legacyAccounts = await db
    .select({ id: ConnectedAccountTable.id })
    .from(ConnectedAccountTable)
    .where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, input.nativeProviderKey),
    ))
    .limit(1)
  if (legacyAccounts[0]) return input.nativeProviderKey
  const connectors = (await listUsableNativeProviderConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    teamIds: input.teamIds,
  })).filter((connection) => (
    connection.nativeProviderKey === input.nativeProviderKey
  ))
  return connectors.length === 1 ? connectors[0].id : null
}

/** Admin configuration lookup only; member flows must use the grant-aware default resolver above. */
export async function resolveManageableNativeProviderCredentialId(input: {
  organizationId: DenTypeId<"organization">
  nativeProviderKey: string
}): Promise<string | null> {
  if (await getOrgOAuthClient(input.organizationId, input.nativeProviderKey)) {
    return input.nativeProviderKey
  }
  const legacyAccounts = await db
    .select({ id: ConnectedAccountTable.id })
    .from(ConnectedAccountTable)
    .where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, input.nativeProviderKey),
    ))
    .limit(1)
  if (legacyAccounts[0]) return input.nativeProviderKey
  const connectors = (await listExternalMcpConnections(input.organizationId)).filter((connection) => (
    connection.kind === "native_provider" && connection.nativeProviderKey === input.nativeProviderKey
  ))
  return connectors.length === 1 ? connectors[0].id : null
}
