import { and, count, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, MemberTable } from "@openwork-ee/den-db/schema"
import type { AgentSourceConnection } from "@openwork/types/den/workbot-proactive"
import { isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentReadToolInput } from "@openwork/automations/agent-read-tools"
import { db } from "../db.js"
import { env } from "../env.js"
import { createExternalMcpLifecycleDeadline } from "../capability-sources/external-mcp-client.js"
import { getExternalMcpConnection, listExternalMcpConnections, listUsableExternalMcpConnections, type ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
import { getConnectedAccountsForListing, getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { NATIVE_OAUTH_PROVIDERS } from "../capability-sources/provider-registry.js"
import { cachedSearchTools, listedExternalConnectionStatus, listExternalMcpToolsThroughSearchCache, type McpMemberIdentity } from "../mcp/external-capabilities.js"
import { listTeamsForMember } from "../member-teams.js"
import type { MemberConnection } from "./sources.js"

type SourceMember = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }

export async function listMemberConnections(input: SourceMember, ids?: ReadonlySet<string>): Promise<MemberConnection[]> {
  return (await loadMemberConnectorInventory(input, ids)).connections
}

export async function loadMemberConnectorInventory(input: SourceMember, ids?: ReadonlySet<string>) {
  const teamIds = (await listTeamsForMember({ organizationId: input.organizationId, memberId: input.memberId })).map((team) => team.id)
  const member = { orgMembershipId: input.memberId, teamIds }
  const externalRows = listUsableExternalMcpConnections({
    organizationId: input.organizationId, ...member,
    connectionIds: ids && [...ids].filter((id) => isDenTypeId("externalMcpConnection", id)),
  })
  const nativeRows = ids && (await externalRows).length === ids.size
    ? []
    : listNativeProviderUsableEntries({ organizationId: input.organizationId, ...member })
  const [natives, externals] = await Promise.all([nativeRows, externalRows])
  const connections: MemberConnection[] = natives.filter((entry) => !ids || ids.has(entry.id)).map((entry) => ({
    id: entry.id,
    name: entry.name,
    url: entry.url,
    native: entry.nativeProviderKey,
    state: entry.connectedForMe ? (entry.needsReconnect ? "reconnect" : "connected") : "needs_connection",
  }))
  const accounts = await getConnectedAccountsForListing({
    organizationId: input.organizationId,
    orgMembershipId: input.memberId,
    providerIds: externals.filter((row) => row.credentialMode === "per_member" && !row.oauthIssuerReviewRequiredAt).map((row) => row.id),
  })
  const byId = new Map<string, ExternalMcpConnectionRow>()
  for (const connection of externals) {
    byId.set(connection.id, connection)
    const probe = listedExternalConnectionStatus(connection, accounts.get(connection.id) ?? null)
    const state: MemberConnection["state"] = probe.connected ? "connected" : probe.status.state === "reauth_required" ? "reconnect" : "needs_connection"
    connections.push({ id: connection.id, name: connection.name, url: connection.url, native: null, state })
  }
  return {
    connections,
    listTools: (id: string, deadlineMs: number, cacheOnly: boolean) => {
      const connection = byId.get(id)
      return connection ? memberConnectionTools(connection, member, deadlineMs, cacheOnly) : Promise.resolve(null)
    },
  }
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
  return memberConnectionTools(connection, { orgMembershipId: input.memberId, teamIds: [...teamIds] }, input.deadlineMs ?? CONNECTION_TOOLS_DEADLINE_MS, false)
}

async function memberConnectionTools(connection: ExternalMcpConnectionRow, member: McpMemberIdentity, deadlineMs: number, cacheOnly: boolean): Promise<AgentReadToolInput[] | null> {
  if (connection.toolPolicy?.allDisabled) return null
  try {
    const tools = cacheOnly ? cachedSearchTools(connection, member) : await listExternalMcpToolsThroughSearchCache({
      connection,
      member,
      redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
      deadline: createExternalMcpLifecycleDeadline(deadlineMs),
    })
    if (!tools) return null
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
