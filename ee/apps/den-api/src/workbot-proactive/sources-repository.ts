import type { AgentSourceConnection } from "@openwork/types/den/workbot-proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { listExternalMcpConnections, listUsableExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
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

/** Every connection in the organization, for "What agents read": Den's own providers and MCP connections. */
export async function listOrganizationSourceConnections(organizationId: DenTypeId<"organization">): Promise<(AgentSourceConnection & { native: string | null })[]> {
  const rows = await listExternalMcpConnections(organizationId)
  return rows.map((row) => ({ id: row.id, name: row.name, url: row.url, native: row.kind === "native_provider" ? row.nativeProviderKey : null }))
}
