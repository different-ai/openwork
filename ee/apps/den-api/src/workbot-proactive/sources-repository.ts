import type { AgentSourceConnection } from "@openwork/types/den/workbot-proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { listExternalMcpConnections, listUsableExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { NATIVE_OAUTH_PROVIDERS } from "../capability-sources/provider-registry.js"
import { probeExternalConnectionStatus } from "../mcp/external-capabilities.js"
import { listTeamsForMember } from "../member-teams.js"
import type { MemberConnection } from "./sources.js"

/**
 * Database reads behind a member's agent's sources: the connections the member can use and whether their own account
 * on each is ready, and the organization's connections for the admin. No provider is called.
 */

/** The member's usable connections (Den's own and MCP), each with whether their account is ready to read. */
export async function listMemberConnections(input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }): Promise<MemberConnection[]> {
  const teamIds = (await listTeamsForMember({ organizationId: input.organizationId, memberId: input.memberId })).map((team) => team.id)
  const member = { orgMembershipId: input.memberId, teamIds }
  const [natives, externals] = await Promise.all([
    listNativeProviderUsableEntries({ organizationId: input.organizationId, orgMembershipId: input.memberId, teamIds }),
    listUsableExternalMcpConnections({ organizationId: input.organizationId, orgMembershipId: input.memberId, teamIds }),
  ])
  const connections: MemberConnection[] = natives.map((entry) => ({
    id: entry.id,
    name: entry.name,
    url: entry.url,
    native: entry.nativeProviderKey,
    state: entry.connectedForMe ? (entry.needsReconnect ? "reconnect" : "connected") : "needs_connection",
  }))
  for (const connection of externals) {
    const probe = await probeExternalConnectionStatus({ organizationId: input.organizationId, member, connectionId: connection.id }).catch(() => null)
    if (!probe?.ok) continue
    const state: MemberConnection["state"] = probe.connected ? "connected" : probe.status.state === "reauth_required" ? "reconnect" : "needs_connection"
    connections.push({ id: connection.id, name: connection.name, url: connection.url, native: null, state })
  }
  return connections
}

type OrganizationSourceConnection = AgentSourceConnection & { native: string | null }

/**
 * Every connection in the organization, for "What agents read": Den's own providers and MCP connections. That includes
 * a provider set up before connections had rows (its OAuth client saved under the provider's own key), which members'
 * agents read too (listNativeProviderUsableEntries), so an admin can pick or leave it out like any other.
 */
export async function listOrganizationSourceConnections(
  organizationId: DenTypeId<"organization">,
  deps: {
    rows: (organizationId: DenTypeId<"organization">) => Promise<readonly { id: string; name: string; url: string; kind: string; nativeProviderKey: string | null }[]>
    hasLegacyClient: (organizationId: DenTypeId<"organization">, providerId: string) => Promise<boolean>
  } = { rows: listExternalMcpConnections, hasLegacyClient: async (org, providerId) => (await getOrgOAuthClient(org, providerId)) !== null },
): Promise<OrganizationSourceConnection[]> {
  const rows = await deps.rows(organizationId)
  const connections: OrganizationSourceConnection[] = rows.map((row) => ({ id: row.id, name: row.name, url: row.url, native: row.kind === "native_provider" ? row.nativeProviderKey : null }))
  const legacy: OrganizationSourceConnection[] = []
  for (const provider of Object.values(NATIVE_OAUTH_PROVIDERS)) {
    if (connections.some((connection) => connection.id === provider.providerId)) continue
    if (await deps.hasLegacyClient(organizationId, provider.providerId)) {
      legacy.push({ id: provider.providerId, name: provider.displayName, url: provider.websiteUrl, native: provider.providerId })
    }
  }
  return [...legacy, ...connections]
}
