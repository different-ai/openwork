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
import { getConnectedAccount, getConnectedAccounts, type ConnectedAccountRow } from "../capability-sources/oauth-credentials.js"
import {
  classifyManifest,
  getManifests,
  manifestMapKey,
  manifestPrincipalFor,
  markManifestsStale,
  saveManifestFailure,
  saveManifestListing,
  scheduleManifestRevalidation,
  type ExternalMcpToolManifestRow,
  type ManifestPrincipal,
} from "../capability-sources/external-mcp-manifests.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { listTeamsForMember } from "../orgs.js"
import { mapWithConcurrency } from "../utils/concurrency.js"
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

export function redirectUriFor(redirectUriBase: string, connectionId: string): string {
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
  /** Set for connection-level status rows: the tool exists but needs a human/admin fix before real tools can be listed. */
  status?: "needs_connection" | "error"
  hint?: string
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 120 ? `${message.slice(0, 117)}...` : message
}

type ToolForSearch = {
  name: string
  title?: string
  description?: string
}

type ExternalSearchCounters = {
  cacheHits: number
  staleServed: number
  misses: number
  errors: number
  timeouts: number
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === -32001) return true
  const message = error instanceof Error ? error.message : String(error)
  return /timeout|timed out/i.test(message)
}

function isUnknownToolError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code
    if (code === -32601) return true
    if (code === -32602) {
      const message = error instanceof Error ? error.message : String(error)
      return /unknown tool|not found/i.test(message)
    }
  }
  return false
}

function scoreTools(
  connection: ExternalMcpConnectionRow,
  tools: readonly ToolForSearch[],
  queryTokens: string[],
): ExternalCapabilityMatch[] {
  const matches: ExternalCapabilityMatch[] = []
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
  return matches
}

function statusMatch(input: {
  connection: ExternalMcpConnectionRow
  queryTokens: string[]
  status: "needs_connection" | "error"
  summary: string
  hint: string
}): ExternalCapabilityMatch[] {
  const nameTokens = tokenize(input.connection.name)
  const score = scoreText(nameTokens, nameTokens, input.queryTokens)
  if (score <= 0) return []
  return [{
    name: buildExternalCapabilityName(input.connection.id, "*"),
    method: "MCP",
    path: input.connection.url,
    score,
    summary: input.summary,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    status: input.status,
    hint: input.hint,
  }]
}

async function listAndMaybeCache(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  member?: { orgMembershipId: DenTypeId<"member"> }
  principal: ManifestPrincipal
  cacheEnabled: boolean
  counters: ExternalSearchCounters
}) {
  const startedAt = Date.now()
  try {
    const tools = await listExternalMcpTools(input.connection, input.redirectUri, input.member, {
      timeoutMs: env.mcpListToolsTimeoutMs,
    })
    if (input.cacheEnabled) {
      await saveManifestListing({
        connection: input.connection,
        principal: input.principal,
        tools,
        durationMs: Date.now() - startedAt,
      })
    }
    return tools
  } catch (error) {
    input.counters.errors += 1
    if (isTimeoutError(error)) input.counters.timeouts += 1
    if (input.cacheEnabled) {
      await saveManifestFailure({
        connection: input.connection,
        principal: input.principal,
        error,
        durationMs: Date.now() - startedAt,
      })
    }
    throw error
  }
}

async function collectConnectionMatches(input: {
  connection: ExternalMcpConnectionRow
  account?: ConnectedAccountRow
  manifest?: ExternalMcpToolManifestRow
  queryTokens: string[]
  redirectUriBase: string
  orgMembershipId: DenTypeId<"member">
  counters: ExternalSearchCounters
}): Promise<ExternalCapabilityMatch[]> {
  const { connection, queryTokens } = input
  if (connection.credentialMode === "per_member") {
    if (!input.account?.accessToken) {
      return statusMatch({
        connection,
        queryTokens,
        status: "needs_connection",
        summary: `[${connection.name}] Available to you, but you haven't connected your ${connection.name} account yet.`,
        hint: `Ask the user to open OpenWork Cloud -> Your Connections and click Connect on "${connection.name}", then search again.`,
      })
    }
  } else if (!hasSharedCredential(connection)) {
    return statusMatch({
      connection,
      queryTokens,
      status: "needs_connection",
      summary: `[${connection.name}] Available to your organization, but an admin hasn't connected it yet.`,
      hint: `Ask an org admin to open the OpenWork Cloud dashboard -> Connections and connect "${connection.name}", then search again.`,
    })
  }

  const member = connection.credentialMode === "per_member"
    ? { orgMembershipId: input.orgMembershipId }
    : undefined
  const principal = manifestPrincipalFor(connection, member)
  const redirectUri = redirectUriFor(input.redirectUriBase, connection.id)

  if (env.mcpManifestCacheEnabled) {
    const classification = classifyManifest(input.manifest ?? null, connection)
    if (classification.state === "fresh") {
      input.counters.cacheHits += 1
      return scoreTools(connection, classification.row.tools, queryTokens)
    }
    if (classification.state === "stale") {
      input.counters.staleServed += 1
      scheduleManifestRevalidation({ connection, principal, redirectUri, member })
      return scoreTools(connection, classification.row.tools, queryTokens)
    }
    input.counters.misses += 1
  }

  try {
    const tools = await listAndMaybeCache({
      connection,
      redirectUri,
      member,
      principal,
      cacheEnabled: env.mcpManifestCacheEnabled,
      counters: input.counters,
    })
    return scoreTools(connection, tools, queryTokens)
  } catch (error) {
    const message = shortErrorMessage(error)
    return statusMatch({
      connection,
      queryTokens,
      status: "error",
      summary: `[${connection.name}] This connection is set up but not responding right now (${message}).`,
      hint: `The stored credential may be expired or the server may be unreachable. Reconnect "${connection.name}" from the OpenWork Cloud dashboard -> Connections, then search again.`,
    })
  }
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
  const memberIdentity = input.member
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []

  const connections = await listUsableExternalMcpConnections({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    orgMembershipId: memberIdentity.orgMembershipId,
    teamIds: memberIdentity.teamIds,
  })
  const startedAt = Date.now()
  const counters: ExternalSearchCounters = {
    cacheHits: 0,
    staleServed: 0,
    misses: 0,
    errors: 0,
    timeouts: 0,
  }
  const perMemberConnections = connections.filter((connection) => connection.credentialMode === "per_member")
  const accounts = await getConnectedAccounts({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    orgMembershipId: memberIdentity.orgMembershipId,
    providerIds: perMemberConnections.map((connection) => connection.id),
  })
  const manifestPairs = env.mcpManifestCacheEnabled
    ? connections
        .filter((connection) => connection.credentialMode === "shared" ? hasSharedCredential(connection) : Boolean(accounts.get(connection.id)?.accessToken))
        .map((connection) => ({
          connection,
          principal: manifestPrincipalFor(
            connection,
            connection.credentialMode === "per_member"
              ? { orgMembershipId: memberIdentity.orgMembershipId }
              : undefined,
          ),
        }))
    : []
  const manifests = await getManifests({ pairs: manifestPairs })
  const matchesByConnection = await mapWithConcurrency(
    connections,
    env.mcpListToolsConcurrency,
    (connection) => {
      const account = accounts.get(connection.id)
      const principal = connection.credentialMode === "per_member"
        ? memberIdentity.orgMembershipId
        : "shared"
      return collectConnectionMatches({
        connection,
        account,
        manifest: manifests.get(manifestMapKey(connection.id, principal)),
        queryTokens,
        redirectUriBase: input.redirectUriBase,
        orgMembershipId: memberIdentity.orgMembershipId,
        counters,
      })
    },
  )
  const matches = matchesByConnection.flat()

  console.info(`[mcp-agent][external_mcp_search] connections=${connections.length} cache_hits=${counters.cacheHits} stale_served=${counters.staleServed} misses=${counters.misses} errors=${counters.errors} timeouts=${counters.timeouts} durationMs=${Date.now() - startedAt}`)

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

  if (input.toolName === "*") {
    return {
      ok: false,
      error: "needs_connection",
      message: `"${connection.name}" was surfaced as a connection status entry, not a callable tool. Fix the connection first (see the search hint), then search again for its real tools.`,
    }
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

  let result: Awaited<ReturnType<typeof callExternalMcpTool>>
  try {
    result = await callExternalMcpTool({
      connection,
      redirectUri: redirectUriFor(input.redirectUriBase, connection.id),
      toolName: input.toolName,
      args: input.args,
      member,
    })
  } catch (error) {
    if (isUnknownToolError(error)) {
      const principal = manifestPrincipalFor(connection, member)
      void markManifestsStale({ connectionId: connection.id, principal })
    }
    throw error
  }
  return { ok: true, result }
}
