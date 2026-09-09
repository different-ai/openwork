import { discoverConnectionRequirements } from "@openwork/enterprise-mcp-client"
import { connectionSetupSchema, type ConnectionSetupInput } from "@openwork/types/connection-setup"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import { listExternalMcpConnections, listDirectExternalMcpConnectionAccess, listVisibleExternalMcpConnections, listUsableNativeProviderConnections, memberCanUseExternalMcpConnection, normalizeExternalMcpIdentityUrl, listRetiredPluginOwnedExternalMcpConnectionIds } from "./external-mcp-connections.js"
import { EXTERNAL_MCP_PRESETS } from "./external-mcp-presets.js"
import { getConnectedAccount } from "./oauth-credentials.js"
import { getNativeOAuthProvider } from "./provider-registry.js"
import { externalMcpSharedCallbackUrl } from "./external-mcp-oauth-contract.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import { matchPresetForQuery, suggestConnectionName } from "./external-mcp-resolve.js"
import { pluginMcpRequiresPreRegisteredOAuthClient } from "./external-mcp-auth-policy.js"

/** Shared setup facts for first-party human clients. Discovery never registers a client or writes credentials. */
export async function readConnectionSetup(input: ConnectionSetupInput & {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  teamIds: DenTypeId<"team">[]
  canManage: boolean
}) {
  const native = getNativeOAuthProvider(input.query)
  const preset = matchPresetForQuery(input.query, EXTERNAL_MCP_PRESETS)
  let url = native?.websiteUrl ?? preset?.url ?? input.query
  const candidates = input.canManage
    ? await listExternalMcpConnections(input.organizationId)
    : [...await listVisibleExternalMcpConnections({ organizationId: input.organizationId, orgMembershipId: input.memberId, teamIds: input.teamIds }), ...await listUsableNativeProviderConnections({ organizationId: input.organizationId, orgMembershipId: input.memberId, teamIds: input.teamIds })]
  const retired = await listRetiredPluginOwnedExternalMcpConnectionIds({ organizationId: input.organizationId, connectionIds: candidates.map(row => row.id) })
  const rows = candidates.filter(row => !retired.has(row.id))
  const requested = rows.find(row => input.connectionId ? row.id === input.connectionId : input.externalKey && row.externalKey === input.externalKey)
  if (input.connectionId && !requested) return connectionSetupSchema.parse({
    version: 1, organizationId: input.organizationId, memberId: input.memberId, canManage: false,
    target: null, connections: [], requirements: null, message: "This connection is no longer available to you. Check its access with a connection manager.",
  })
  if (requested) url = requested.url
  let targetUrl: URL
  try {
    targetUrl = new URL(url)
    if (!["https:", "http:"].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password || targetUrl.hash) throw new Error("Invalid endpoint")
  } catch {
    return connectionSetupSchema.parse({
      version: 1, organizationId: input.organizationId, memberId: input.memberId, canManage: input.canManage,
      target: null, connections: [], requirements: null, message: "Enter the service's MCP server URL to continue.",
    })
  }
  const provider = native ?? (requested?.nativeProviderKey ? getNativeOAuthProvider(requested.nativeProviderKey) : null)
  const matching = input.connectionId || input.resumeOnly
    ? rows.filter(row => row.id === requested?.id)
    : rows.filter(row => row.id === requested?.id || normalizeExternalMcpIdentityUrl(row.url) === normalizeExternalMcpIdentityUrl(url))
  const connections = await Promise.all(matching.map(async row => {
    const account = row.credentialMode === "per_member"
      ? await getConnectedAccount({ organizationId: input.organizationId, orgMembershipId: input.memberId, providerId: row.id })
      : null
    const canUse = await memberCanUseExternalMcpConnection({ connectionId: row.id, orgMembershipId: input.memberId, teamIds: input.teamIds })
    const grants = input.canManage ? await listDirectExternalMcpConnectionAccess({ organizationId: input.organizationId, connectionId: row.id }) : []
    return {
      updatedAt: row.updatedAt.toISOString(),
      access: input.canManage ? { orgWide: grants.some(grant => grant.orgWide), memberIds: grants.flatMap(grant => grant.orgMembershipId ? [grant.orgMembershipId] : []), teamIds: grants.flatMap(grant => grant.teamId ? [grant.teamId] : []) } : null,
      id: row.id, name: row.name, url: row.url, authType: row.authType, credentialMode: row.credentialMode, canUse,
      connectedForMe: row.credentialMode === "per_member" ? Boolean(account?.accessToken) : Boolean(row.accessToken || row.apiKey || (row.authType === "none" && row.connectedAt)),
      needsReconnect: Boolean(row.oauthIssuerReviewRequiredAt), externalAccountId: account?.externalAccountId ?? null,
    }
  }))
  const requirements = input.canManage && !provider && !preset && connections.length === 0
    ? await discoverConnectionRequirements({ serverUrl: url, fetch: env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch() })
    : null
  const authType = requested?.authType ?? preset?.authType ?? (requirements?.authentication.kind === "none" ? "none" : requirements?.authentication.kind === "manual_bearer" ? "apikey" : "oauth")
  return connectionSetupSchema.parse({
    version: 1, organizationId: input.organizationId, memberId: input.memberId, canManage: input.canManage,
    target: {
      name: requested?.name ?? provider?.displayName ?? preset?.displayName ?? suggestConnectionName(url),
      url, kind: provider ? "native_provider" : "external_mcp", nativeProviderKey: provider?.providerId,
      authType, requiresOAuthClient: Boolean(provider || preset?.requiresOAuthClient || pluginMcpRequiresPreRegisteredOAuthClient(url) || requirements?.authentication.recommendedRegistrationMethod === "pre_registered" && requirements.authentication.kind === "oauth"),
      callbackUrl: provider ? new URL(`/v1/oauth-providers/${encodeURIComponent(provider.providerId)}/connect/callback`, externalMcpSharedCallbackUrl()).toString() : externalMcpSharedCallbackUrl(), requiresTenant: Boolean(provider?.tenantIdExtraKey),
      features: Object.keys(provider?.optionalFeatures ?? {}).map(id => ({ id, label: id.replace(/([A-Z])/g, " $1").toLowerCase(), selected: provider?.defaultFeatures?.includes(id) ?? false })),
    },
    connections, requirements,
    message: !input.canManage && connections.length === 0 ? "An organization admin or connection manager needs to set up this service and grant you access." : null,
  })
}
