import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  getExternalMcpConnection,
  listUsableExternalMcpConnections,
  memberCanUseExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import { callExternalMcpTool, listExternalMcpTools } from "../capability-sources/external-mcp-client.js"
import { getConnectedAccount } from "../capability-sources/oauth-credentials.js"
import { db } from "../db.js"
import { listTeamsForMember } from "../orgs.js"
import { tokenize } from "./search.js"
import type { CapabilityMatch } from "./search.js"

/**
 * Merges org-level External MCP Connections (capability-sources/) into the
 * same search_capabilities/execute_capability surface as the REST-derived
 * catalog (catalog.ts), without touching that catalog or the rich `/mcp`
 * endpoint at all. A connected external tool is namespaced
 * `mcp:<connectionId>:<toolName>` so execute_capability can tell it apart
 * from a REST operation name and dispatch to the real MCP client
 * (external-mcp-client.ts) instead of invokeMcpOperation.
 *
 * Everything here is scoped to the CALLING MEMBER, not just the org:
 * - Only connections the member has been granted (org-wide, direct, or via
 *   a team) are searchable/executable. Access is never implicit.
 * - For credentialMode "per_member" connections, calls run with the
 *   member's own connected account; if they haven't connected one yet,
 *   search surfaces the connection as needs_connection (so the agent can
 *   tell the human what to do) instead of silently hiding it.
 */

const EXTERNAL_CAPABILITY_PREFIX = "mcp:"

export function buildExternalCapabilityName(connectionId: string, toolName: string): string {
  return `${EXTERNAL_CAPABILITY_PREFIX}${connectionId}:${toolName}`
}

export function parseExternalCapabilityName(name: string): { connectionId: string; toolName: string } | null {
  if (!name.startsWith(EXTERNAL_CAPABILITY_PREFIX)) return null
  const rest = name.slice(EXTERNAL_CAPABILITY_PREFIX.length)
  const separatorIndex = rest.indexOf(":")
  if (separatorIndex <= 0) return null
  return {
    connectionId: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 1),
  }
}

export type McpMemberIdentity = {
  orgMembershipId: DenTypeId<"member">
  teamIds: DenTypeId<"team">[]
}

/**
 * Resolves the MCP principal (userId + organizationId from the bearer
 * token) to the member identity the grant checks need. Returns null when
 * the user has no active membership — callers should treat that as
 * zero external-capability access, not an error.
 */
export async function resolveMcpMemberIdentity(input: {
  userId: string
  organizationId: string
}): Promise<McpMemberIdentity | null> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.userId, normalizeDenTypeId("user", input.userId)),
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const member = rows[0]
  if (!member) return null
  const teams = await listTeamsForMember({ organizationId, memberId: member.id })
  return { orgMembershipId: member.id, teamIds: teams.map((team) => team.id) }
}

function hasSharedCredential(connection: ExternalMcpConnectionRow): boolean {
  if (connection.authType === "oauth") return Boolean(connection.accessToken)
  if (connection.authType === "apikey") return Boolean(connection.apiKey)
  return true
}

function redirectUriFor(redirectUriBase: string, connectionId: string): string {
  return `${redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
}

function scoreText(nameTokens: string[], summaryTokens: string[], queryTokens: string[]): number {
  let score = 0
  for (const queryToken of queryTokens) {
    if (nameTokens.includes(queryToken)) {
      score += 5
    } else if (nameTokens.some((token) => token.startsWith(queryToken) || queryToken.startsWith(token))) {
      score += 3
    }
    if (summaryTokens.includes(queryToken)) {
      score += 2
    }
  }
  return score
}

export type ExternalCapabilityMatch = CapabilityMatch & {
  /** Set when the connection is per-member and the calling member hasn't connected their account yet: the tool exists but needs the human to connect first. */
  status?: "needs_connection"
  hint?: string
}

/**
 * Live-lists tools for every external MCP connection the calling member has
 * been granted, and returns the ones matching `query`, in the same
 * CapabilityMatch shape the REST catalog uses. Each connection is
 * best-effort: one unreachable external server doesn't fail the whole search.
 */
export async function searchExternalCapabilities(input: {
  organizationId: string
  member: McpMemberIdentity | null
  query: string
  redirectUriBase: string
  limit?: number
}): Promise<ExternalCapabilityMatch[]> {
  if (!input.member) return []
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []

  const connections = await listUsableExternalMcpConnections({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const matches: ExternalCapabilityMatch[] = []

  for (const connection of connections) {
    if (connection.credentialMode === "per_member") {
      const account = await getConnectedAccount({
        organizationId: connection.organizationId,
        orgMembershipId: input.member.orgMembershipId,
        providerId: connection.id,
      })
      if (!account?.accessToken) {
        // Granted but not yet connected: surface the connection itself (not
        // its tools — we can't list them without the member's credential) so
        // the agent can tell the human exactly what to do.
        const nameTokens = tokenize(connection.name)
        const score = scoreText(nameTokens, nameTokens, queryTokens)
        if (score > 0) {
          matches.push({
            name: buildExternalCapabilityName(connection.id, "*"),
            method: "MCP",
            path: connection.url,
            score,
            summary: `[${connection.name}] Available to you, but you haven't connected your ${connection.name} account yet.`,
            pathParams: [],
            queryParams: [],
            hasBody: false,
            status: "needs_connection",
            hint: `Ask the user to open OpenWork Cloud -> Your Connections and click Connect on "${connection.name}", then search again.`,
          })
        }
        continue
      }
    } else if (!hasSharedCredential(connection)) {
      continue
    }

    const member = connection.credentialMode === "per_member"
      ? { orgMembershipId: input.member.orgMembershipId }
      : undefined
    let tools: Awaited<ReturnType<typeof listExternalMcpTools>>
    try {
      tools = await listExternalMcpTools(connection, redirectUriFor(input.redirectUriBase, connection.id), member)
    } catch {
      continue
    }

    for (const tool of tools) {
      const summary = tool.description ?? tool.title ?? tool.name
      const nameTokens = tokenize(`${connection.name} ${tool.name}`)
      const summaryTokens = tokenize(summary)
      const score = scoreText(nameTokens, summaryTokens, queryTokens)
      if (score <= 0) continue
      matches.push({
        name: buildExternalCapabilityName(connection.id, tool.name),
        method: "MCP",
        path: connection.url,
        score,
        summary: `[${connection.name}] ${summary}`,
        pathParams: [],
        queryParams: [],
        hasBody: true,
      })
    }
  }

  matches.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
  return matches.slice(0, input.limit ?? 5)
}

export type ExternalCapabilityExecuteResult =
  | { ok: true; result: Awaited<ReturnType<typeof callExternalMcpTool>> }
  | { ok: false; error: "unknown_capability" | "forbidden" | "connection_not_connected" | "needs_connection"; message: string }

/**
 * Executes a namespaced external capability, scoped to the calling
 * principal's org AND member: the member must hold a grant (org-wide,
 * direct, or team), and for per-member connections must have connected
 * their own account — the call then runs as them.
 */
export async function executeExternalCapability(input: {
  organizationId: string
  member: McpMemberIdentity | null
  connectionId: string
  toolName: string
  args: Record<string, unknown>
  redirectUriBase: string
}): Promise<ExternalCapabilityExecuteResult> {
  if (!input.member) {
    return { ok: false, error: "forbidden", message: "No active org membership for this token." }
  }

  let connection: Awaited<ReturnType<typeof getExternalMcpConnection>>
  let connectionId: DenTypeId<"externalMcpConnection">
  try {
    connectionId = normalizeDenTypeId("externalMcpConnection", input.connectionId)
    connection = await getExternalMcpConnection({
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      connectionId,
    })
  } catch {
    // A malformed connectionId (e.g. hand-typed by an agent) isn't a server
    // error — it's the same "no such capability" outcome as a valid-shaped
    // but nonexistent id, so surface the same clean error either way.
    connection = null
    connectionId = input.connectionId as DenTypeId<"externalMcpConnection">
  }
  if (!connection) {
    return { ok: false, error: "unknown_capability", message: `No external MCP connection "${input.connectionId}" in this organization.` }
  }

  const canUse = await memberCanUseExternalMcpConnection({
    connectionId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  if (!canUse) {
    return { ok: false, error: "forbidden", message: `You have not been granted access to "${connection.name}".` }
  }

  let member: { orgMembershipId: DenTypeId<"member"> } | undefined
  if (connection.credentialMode === "per_member") {
    const account = await getConnectedAccount({
      organizationId: connection.organizationId,
      orgMembershipId: input.member.orgMembershipId,
      providerId: connection.id,
    })
    if (!account?.accessToken) {
      return {
        ok: false,
        error: "needs_connection",
        message: `You haven't connected your ${connection.name} account yet. Open OpenWork Cloud -> Your Connections and click Connect on "${connection.name}".`,
      }
    }
    member = { orgMembershipId: input.member.orgMembershipId }
  } else if (!hasSharedCredential(connection)) {
    return { ok: false, error: "connection_not_connected", message: `"${connection.name}" is not connected yet.` }
  }

  const result = await callExternalMcpTool({
    connection,
    redirectUri: redirectUriFor(input.redirectUriBase, connection.id),
    toolName: input.toolName,
    args: input.args,
    member,
  })
  return { ok: true, result }
}
