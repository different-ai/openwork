import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  getExternalMcpConnection,
  listUsableExternalMcpConnections,
  memberCanUseExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import { callExternalMcpTool, listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { getConnectedAccount } from "../capability-sources/oauth-credentials.js"
import { db } from "../db.js"
import { listTeamsForMember } from "../orgs.js"
import { compareCapabilityMatches, tokenize } from "./search.js"
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
  /** Distinguishes a connection-health result from a callable capability. */
  kind?: "connection_status"
  /** Set for connection-level status rows: the tool exists but needs a human/admin fix before real tools can be listed. */
  status?: "needs_connection" | "error"
  hint?: string
  connectionStatus?: ExternalConnectionStatus
}

export type ExternalConnectionStatus = {
  layer: "downstream_provider"
  connectionId: string
  connectionName: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  state: "needs_connection" | "reauth_required" | "provider_error"
  errorCode: "not_connected" | "invalid_refresh_token" | "invalid_grant" | "unauthorized" | "provider_error"
  message: string
  actor: "member" | "organization_admin" | "provider_admin"
  action: {
    type: "connect" | "reconnect" | "update_credentials" | "inspect_connection" | "fix_provider"
    label: string
    surface: "openwork_your_connections" | "openwork_organization_connections" | "provider_admin_console"
    retry: "search_capabilities"
  }
}

const ERROR_MESSAGE_LIMIT = 300
const LIVE_PROBE_HINT = "This is a live probe, not a cached result — repeating the same search without changing anything will return the same error."
const INVALID_REFRESH_TOKEN_PATTERN = /\binvalid[ _-]?refresh[ _-]?token\b/i
const INVALID_GRANT_PATTERN = /\binvalid[ _-]?grant\b/i
const UNAUTHORIZED_PATTERN = /\b(?:unauthori[sz]ed|invalid[ _-]?token|token (?:is )?expired|expired (?:access )?token)\b/i
const PROVIDER_ADMIN_ACTION_PATTERN = /\b(?:app (?:is )?not installed|admin(?:istrator)? (?:consent|approval)|approval required)\b/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cappedErrorMessage(message: string): string {
  return message.length > ERROR_MESSAGE_LIMIT ? `${message.slice(0, ERROR_MESSAGE_LIMIT)}...` : message
}

function parsedErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  const nestedError = value.error
  if (isRecord(nestedError) && typeof nestedError.message === "string") {
    return typeof nestedError.code === "number"
      ? `${nestedError.message} (JSON-RPC ${nestedError.code})`
      : nestedError.message
  }
  if (typeof value.message === "string") return value.message
  if (typeof nestedError === "string") return nestedError
  return null
}

function errorCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6; depth += 1) {
    chain.push(current)
    if (!isRecord(current) || !("cause" in current) || current.cause === undefined) break
    current = current.cause
  }
  return chain
}

export function upstreamErrorMessage(error: unknown): string {
  const chain = errorCauseChain(error)
  for (const current of [...chain].reverse()) {
    const message = current instanceof Error ? current.message : String(current)
    const jsonStart = message.indexOf("{")
    if (jsonStart >= 0) {
      try {
        const parsed: unknown = JSON.parse(message.slice(jsonStart))
        const parsedMessage = parsedErrorMessage(parsed)
        if (parsedMessage) return parsedMessage
      } catch {
        // Try the next cause when the SDK wrapper contains partial or invalid JSON.
      }
    }
    if (message.trim()) return cappedErrorMessage(message)
  }
  return "Unknown MCP provider error."
}

export function externalMcpAuthErrorCode(
  error: unknown,
  message = upstreamErrorMessage(error),
): ExternalConnectionStatus["errorCode"] | null {
  if (INVALID_REFRESH_TOKEN_PATTERN.test(message)) return "invalid_refresh_token"
  if (INVALID_GRANT_PATTERN.test(message)) return "invalid_grant"
  if (
    errorCauseChain(error).some((current) => (
      current instanceof UnauthorizedError
      || (current instanceof StreamableHTTPError && (current.code === 401 || current.code === 403))
    ))
    || UNAUTHORIZED_PATTERN.test(message)
  ) return "unauthorized"
  return null
}

export function isExternalMcpAuthError(error: unknown): boolean {
  return externalMcpAuthErrorCode(error) !== null
}

export function externalConnectionErrorHint(
  connectionName: string,
  error: unknown,
  message = upstreamErrorMessage(error),
  credentialMode: ExternalMcpConnectionRow["credentialMode"] = "shared",
): string {
  if (externalMcpAuthErrorCode(error, message)) {
    const destination = credentialMode === "per_member"
      ? "OpenWork Cloud -> Your Connections"
      : "the OpenWork Cloud dashboard -> Connections"
    return `The stored credential for "${connectionName}" is invalid or expired. Reconnect "${connectionName}" from ${destination}, then search again. OpenWork Cloud itself is still connected. ${LIVE_PROBE_HINT}`
  }
  if (PROVIDER_ADMIN_ACTION_PATTERN.test(message)) {
    return `The provider's server rejected the request for "${connectionName}": ${message}. A provider admin must fix it in the provider's own admin console, then search again. OpenWork Cloud itself is still connected. ${LIVE_PROBE_HINT}`
  }
  return `The downstream provider for "${connectionName}" returned an error: ${message}. Ask an org admin to inspect "${connectionName}" in the OpenWork Cloud dashboard -> Connections, then search again. OpenWork Cloud itself is still connected. ${LIVE_PROBE_HINT}`
}

export function buildExternalConnectionStatus(input: {
  connection: Pick<ExternalMcpConnectionRow, "id" | "name" | "authType" | "credentialMode">
  state: ExternalConnectionStatus["state"]
  errorCode: ExternalConnectionStatus["errorCode"]
  message: string
}): ExternalConnectionStatus {
  const connectionName = input.connection.name
  if (input.state === "provider_error") {
    const providerAdminAction = PROVIDER_ADMIN_ACTION_PATTERN.test(input.message)
    return {
      layer: "downstream_provider",
      connectionId: input.connection.id,
      connectionName,
      authType: input.connection.authType,
      credentialMode: input.connection.credentialMode,
      state: input.state,
      errorCode: input.errorCode,
      message: input.message,
      actor: providerAdminAction ? "provider_admin" : "organization_admin",
      action: {
        type: providerAdminAction ? "fix_provider" : "inspect_connection",
        label: providerAdminAction
          ? `Fix ${connectionName} in the provider admin console`
          : `Inspect the ${connectionName} connection`,
        surface: providerAdminAction ? "provider_admin_console" : "openwork_organization_connections",
        retry: "search_capabilities",
      },
    }
  }

  const actor = input.connection.credentialMode === "per_member" ? "member" : "organization_admin"
  const surface = input.connection.credentialMode === "per_member"
    ? "openwork_your_connections"
    : "openwork_organization_connections"
  const actionType = input.state === "needs_connection"
    ? "connect"
    : input.connection.authType === "oauth"
      ? "reconnect"
      : input.connection.authType === "apikey"
        ? "update_credentials"
        : "inspect_connection"
  const actionVerb = actionType === "connect"
    ? "Connect"
    : actionType === "reconnect"
      ? "Reconnect"
      : actionType === "update_credentials"
        ? "Update credentials for"
        : "Inspect"
  return {
    layer: "downstream_provider",
    connectionId: input.connection.id,
    connectionName,
    authType: input.connection.authType,
    credentialMode: input.connection.credentialMode,
    state: input.state,
    errorCode: input.errorCode,
    message: input.message,
    actor,
    action: {
      type: actionType,
      label: `${actionVerb} ${connectionName}`,
      surface,
      retry: "search_capabilities",
    },
  }
}

function statusMatch(input: {
  connection: ExternalMcpConnectionRow
  score: number
  summary: string
  status: ExternalCapabilityMatch["status"]
  hint: string
  connectionStatus: ExternalConnectionStatus
}): ExternalCapabilityMatch {
  return {
    name: buildExternalCapabilityName(input.connection.id, "*"),
    method: "MCP",
    path: input.connection.url,
    score: input.score,
    summary: input.summary,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    kind: "connection_status",
    status: input.status,
    hint: input.hint,
    connectionStatus: input.connectionStatus,
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
          const message = `You haven't connected your ${connection.name} account yet.`
          matches.push(statusMatch({
            connection,
            score,
            summary: `[${connection.name}] Available to you, but you haven't connected your ${connection.name} account yet.`,
            status: "needs_connection",
            hint: `Ask the user to open OpenWork Cloud -> Your Connections and click Connect on "${connection.name}", then search again.`,
            connectionStatus: buildExternalConnectionStatus({ connection, state: "needs_connection", errorCode: "not_connected", message }),
          }))
        }
        continue
      }
    } else if (!hasSharedCredential(connection)) {
      const nameTokens = tokenize(connection.name)
      const score = scoreText(nameTokens, nameTokens, queryTokens)
      if (score > 0) {
        const message = `${connection.name} is not connected yet.`
        matches.push(statusMatch({
          connection,
          score,
          summary: `[${connection.name}] Available to your organization, but an admin hasn't connected it yet.`,
          status: "needs_connection",
          hint: `Ask an org admin to open the OpenWork Cloud dashboard -> Connections and connect "${connection.name}", then search again.`,
          connectionStatus: buildExternalConnectionStatus({ connection, state: "needs_connection", errorCode: "not_connected", message }),
        }))
      }
      continue
    }

    const member = connection.credentialMode === "per_member"
      ? { orgMembershipId: input.member.orgMembershipId }
      : undefined
    let tools: Awaited<ReturnType<typeof listExternalMcpTools>>
    try {
      tools = await listExternalMcpTools(connection, redirectUriFor(input.redirectUriBase, connection.id), member)
    } catch (error) {
      const message = upstreamErrorMessage(error)
      const nameTokens = tokenize(connection.name)
      const score = scoreText(nameTokens, nameTokens, queryTokens)
      if (score > 0) {
        const authErrorCode = externalMcpAuthErrorCode(error, message)
        const state = authErrorCode ? "reauth_required" : "provider_error"
        matches.push(statusMatch({
          connection,
          score,
          summary: `[${connection.name}] This connection is set up but returned an error (${message}).`,
          status: "error",
          hint: externalConnectionErrorHint(connection.name, error, message, connection.credentialMode),
          connectionStatus: buildExternalConnectionStatus({
            connection,
            state,
            errorCode: authErrorCode ?? "provider_error",
            message,
          }),
        }))
      }
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

  matches.sort(compareCapabilityMatches)
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

  const result = await callExternalMcpTool({
    connection,
    redirectUri: redirectUriFor(input.redirectUriBase, connection.id),
    toolName: input.toolName,
    args: input.args,
    member,
  })
  return { ok: true, result }
}
