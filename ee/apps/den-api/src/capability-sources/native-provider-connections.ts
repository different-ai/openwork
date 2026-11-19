import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import {
  clientSelectedFeatures,
  NATIVE_OAUTH_PROVIDERS,
  providerScopesSatisfy,
  resolveProviderScopes,
  type NativeOAuthProviderConfig,
} from "./provider-registry.js"
import { getConnectedAccountsForListing, getOrgOAuthClient, getOrgOAuthClients } from "./oauth-credentials.js"
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
  /** Native providers are implemented by Den itself and never have a standard MCP catalog to expose. */
  exposeDirectly: false
  /** Absent for legacy synthetic entries without a stored connector row. */
  createdAt?: string
  connected: boolean
  connectedAt: string | null
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
  /** Required scopes the stored grant does not cover; names only, safe to log. */
  missingScopes: string[]
}

export function resolveNativeProviderReconnectState(
  provider: NativeOAuthProviderConfig,
  clientExtra: Record<string, unknown> | null,
  grantedScopes: string[] | null,
): NativeProviderReconnectState {
  if (!grantedScopes || grantedScopes.length === 0) {
    return { needsReconnect: false, missingFeatures: [], missingScopes: [] }
  }

  const selectedFeatures = clientSelectedFeatures(provider, clientExtra)
  const unreported = new Set((provider.unreportedScopes ?? []).map((scope) => scope.toLowerCase()))
  const expectedScopes = resolveProviderScopes(provider, selectedFeatures).filter((scope) => !unreported.has(scope.toLowerCase()))
  const missingScopes = expectedScopes.filter((scope) => !providerScopesSatisfy(provider, grantedScopes, scope))
  const needsReconnect = missingScopes.length > 0
  const missingFeatures = selectedFeatures.filter((feature) => {
    const featureScopes = provider.optionalFeatures?.[feature] ?? []
    return featureScopes.some((scope) => !providerScopesSatisfy(provider, grantedScopes, scope))
  })

  return { needsReconnect, missingFeatures, missingScopes }
}

export function buildNativeProviderEntry(
  provider: NativeOAuthProviderConfig,
  state: {
    clientConfigured: boolean
    connectedForMe: boolean
    connectedAt?: Date
    createdAt?: Date
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
    exposeDirectly: false,
    nativeProviderKey: provider.providerId,
    ...(state.createdAt ? { createdAt: state.createdAt.toISOString() } : {}),
    connected: true,
    connectedAt: state.connectedForMe && state.connectedAt ? state.connectedAt.toISOString() : null,
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

export type NativeProviderPolicyError = { kind: "policy_blocked"; message: string }

/**
 * Connect is generally available: the per-organization `mcpConnections` opt-out
 * was retired on purpose (product decision, 2026-10), so a stored `false`
 * override no longer blocks native actions. Access is limited per connection
 * (team grants) and by each member's own credentials, both enforced where the
 * connection is resolved. Only a missing organization is refused here.
 */

export async function nativeProviderConnectionPolicyError(organizationId: DenTypeId<"organization">): Promise<NativeProviderPolicyError | null> {
  const [organization] = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  if (organization) return null
  return {
    kind: "policy_blocked",
    message: "This organization is unavailable. Ask your administrator to check your organization access.",
  }
}

export async function listNativeProviderUsableEntries(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  teamIds?: DenTypeId<"team">[]
}): Promise<NativeProviderConnectionEntry[]> {
  // Recheck at resolution so retained capability names and Code Mode calls cannot bypass an org disable.
  if (await nativeProviderConnectionPolicyError(input.organizationId)) return []
  const entries: NativeProviderConnectionEntry[] = []
  const connections = (await listUsableNativeProviderConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    teamIds: input.teamIds ?? [],
  })).flatMap((connection) => {
    const provider = connection.nativeProviderKey ? NATIVE_OAUTH_PROVIDERS[connection.nativeProviderKey] : undefined
    return provider ? [{ connection, provider }] : []
  })
  // Legacy native-provider clients never had connector rows. Keep their
  // literal registry key visible org-wide without moving either credentials
  // or connected accounts.
  const legacyProviders = Object.values(NATIVE_OAUTH_PROVIDERS)
  const clients = await getOrgOAuthClients(input.organizationId, [
    ...connections.map(({ connection }) => connection.id),
    ...legacyProviders.map((provider) => provider.providerId),
  ])
  const accounts = await getConnectedAccountsForListing({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerIds: [...clients].flatMap(([providerId, client]) => client ? [providerId] : []),
  })

  for (const { connection, provider } of connections) {
    const client = clients.get(connection.id)
    if (!client) continue
    const account = accounts.get(connection.id) ?? null
    const entry = buildNativeProviderEntry(provider, {
      clientConfigured: true,
      connectedForMe: Boolean(account?.accessToken),
      connectedAt: account?.connectedAt,
      credentialProviderId: connection.id,
      createdAt: connection.createdAt,
      name: connection.name,
      ...(account?.externalAccountId ? { externalAccountId: account.externalAccountId } : {}),
      ...(account?.scopes ? { grantedScopes: account.scopes } : {}),
      ...(provider.tenantIdExtraKey
        ? { tenantId: readProviderTenantId(client.extra, provider.tenantIdExtraKey) }
        : {}),
      reconnect: account?.accessToken
        ? resolveNativeProviderReconnectState(provider, client.extra, account.scopes)
        : { needsReconnect: false, missingFeatures: [], missingScopes: [] },
    })
    if (entry) entries.push(entry)
  }

  for (const provider of legacyProviders) {
    const client = clients.get(provider.providerId)
    if (!client) continue
    const account = accounts.get(provider.providerId) ?? null
    const entry = buildNativeProviderEntry(provider, {
      clientConfigured: true,
      connectedForMe: Boolean(account?.accessToken),
      connectedAt: account?.connectedAt,
      ...(account?.externalAccountId ? { externalAccountId: account.externalAccountId } : {}),
      ...(account?.scopes ? { grantedScopes: account.scopes } : {}),
      ...(provider.tenantIdExtraKey
        ? { tenantId: readProviderTenantId(client.extra, provider.tenantIdExtraKey) }
        : {}),
      reconnect: account?.accessToken
        ? resolveNativeProviderReconnectState(provider, client.extra, account.scopes)
        : { needsReconnect: false, missingFeatures: [], missingScopes: [] },
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
  if (await nativeProviderConnectionPolicyError(input.organizationId)) return null
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
