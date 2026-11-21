import { and, count, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, MemberTable } from "@openwork-ee/den-db/schema"
import type { AgentSourceConnection } from "@openwork/types/den/workbot-proactive"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentReadToolInput } from "@openwork/automations/agent-read-tools"
import { db } from "../db.js"
import { env } from "../env.js"
import { createExternalMcpLifecycleDeadline } from "../capability-sources/external-mcp-client.js"
import { getExternalMcpConnection, listExternalMcpConnections, listUsableExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { NATIVE_OAUTH_PROVIDERS } from "../capability-sources/provider-registry.js"
import { listExternalMcpToolsThroughSearchCache, probeExternalConnectionStatus } from "../mcp/external-capabilities.js"
import { listTeamsForMember } from "../member-teams.js"
import type { MemberConnection } from "./sources.js"

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

type CountedConnection = { id: string; kind: string; authType: string; credentialMode: string }

export async function countConnectedMembers(
  organizationId: DenTypeId<"organization">,
  deps: {
    rows: (organizationId: DenTypeId<"organization">) => Promise<readonly CountedConnection[]>
    accounts: (organizationId: DenTypeId<"organization">) => Promise<readonly { providerId: string; members: number }[]>
  } = { rows: listExternalMcpConnections, accounts: countConnectedAccounts },
): Promise<Map<string, number>> {
  const [rows, accounts] = await Promise.all([deps.rows(organizationId), deps.accounts(organizationId)])
  const byProvider = new Map(accounts.map((entry) => [entry.providerId, entry.members]))
  const counts = new Map<string, number>()
  for (const provider of Object.values(NATIVE_OAUTH_PROVIDERS)) counts.set(provider.providerId, byProvider.get(provider.providerId) ?? 0)
  for (const row of rows) {
    const perMember = row.kind === "native_provider" || (row.credentialMode === "per_member" && (row.authType === "oauth" || row.authType === "apikey"))
    if (perMember) counts.set(row.id, byProvider.get(row.id) ?? 0)
  }
  return counts
}

async function countConnectedAccounts(organizationId: DenTypeId<"organization">): Promise<{ providerId: string; members: number }[]> {
  return db
    .select({ providerId: ConnectedAccountTable.providerId, members: count() })
    .from(ConnectedAccountTable)
    .innerJoin(MemberTable, eq(MemberTable.id, ConnectedAccountTable.orgMembershipId))
    .where(and(
      eq(ConnectedAccountTable.organizationId, organizationId),
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
      isNotNull(ConnectedAccountTable.accessToken),
    ))
    .groupBy(ConnectedAccountTable.providerId)
}

export const CONNECTION_TOOLS_DEADLINE_MS = 8_000

export async function listConnectionToolsForMember(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  connectionId: string
  teamIds?: readonly DenTypeId<"team">[]
  deadlineMs?: number
}): Promise<AgentReadToolInput[] | null> {
  let connectionId: DenTypeId<"externalMcpConnection">
  try {
    connectionId = normalizeDenTypeId("externalMcpConnection", input.connectionId)
  } catch {
    return null
  }
  const connection = await getExternalMcpConnection({ organizationId: input.organizationId, connectionId })
  if (!connection || connection.kind !== "external_mcp" || connection.toolPolicy?.allDisabled) return null
  const teamIds = input.teamIds ?? (await listTeamsForMember({ organizationId: input.organizationId, memberId: input.memberId })).map((team) => team.id)
  try {
    const tools = await listExternalMcpToolsThroughSearchCache({
      connection,
      member: { orgMembershipId: input.memberId, teamIds: [...teamIds] },
      redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
      deadline: createExternalMcpLifecycleDeadline(input.deadlineMs ?? CONNECTION_TOOLS_DEADLINE_MS),
    })
    return tools
      .filter((tool) => !isToolDisabled(connection.toolPolicy, tool.name))
      .map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: tool.description ?? null,
        annotations: tool.annotations ? { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint } : null,
      }))
  } catch {
    return null
  }
}
