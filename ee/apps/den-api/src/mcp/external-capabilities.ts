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
import {
  createExternalMcpLifecycleDeadline,
  type ExternalMcpLifecycleDeadline,
} from "../capability-sources/external-mcp-client.js"
import {
  ExternalMcpDiagnosticError,
  externalMcpDiagnosticForLog,
  safeExternalMcpEndpointForLog,
  type ExternalMcpDiagnostic,
} from "../capability-sources/external-mcp-diagnostics.js"
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
export const EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT = 16
export const EXTERNAL_MCP_SEARCH_CONCURRENCY = 4
export const EXTERNAL_MCP_SEARCH_MATCH_LIMIT = 20

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

/**
 * A capability search must never turn an unbounded org connection list into
 * unbounded remote handshakes. Prefer connections whose names match the
 * query, keep source order as the deterministic tiebreaker, and enforce one
 * hard fanout ceiling before any provider network request is started.
 */
export function selectExternalMcpSearchConnections<T extends { name: string }>(
  connections: readonly T[],
  queryTokens: string[],
  limit = EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT,
): T[] {
  return connections
    .map((connection, index) => ({
      connection,
      index,
      score: scoreText(tokenize(connection.name), tokenize(connection.name), queryTokens),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT)))
    .map(({ connection }) => connection)
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
  layer: "mcp_connection" | "downstream_provider"
  connectionId: string
  connectionName: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  state: "needs_connection" | "reauth_required" | "provider_error"
  errorCode: "not_connected" | "invalid_refresh_token" | "invalid_grant" | "unauthorized" | "provider_error"
  message: string
  actor: ExternalMcpDiagnostic["actionOwner"]
  action: {
    type: "connect" | "reconnect" | "update_credentials" | "inspect_connection" | "fix_provider" | "fix_network" | "contact_openwork"
    label: string
    surface: "openwork_your_connections" | "openwork_organization_connections" | "provider_admin_console" | "network_infrastructure" | "openwork_support"
    retry: "search_capabilities"
  }
  diagnostic?: ExternalMcpDiagnostic
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
  const diagnosticError = chain.find((current) => current instanceof ExternalMcpDiagnosticError)
  if (diagnosticError instanceof ExternalMcpDiagnosticError) return diagnosticError.diagnostic.message
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
  const diagnosticError = errorCauseChain(error)
    .find((current) => current instanceof ExternalMcpDiagnosticError)
  if (diagnosticError instanceof ExternalMcpDiagnosticError) {
    if (diagnosticError.diagnostic.code === "MCP_OAUTH_INVALID_GRANT") return "invalid_grant"
    if (
      diagnosticError.diagnostic.phase === "AUTH_TOKEN_ACQUISITION"
      || diagnosticError.diagnostic.phase === "AUTH_RESOURCE_VALIDATION"
      || diagnosticError.diagnostic.phase === "CONTINUITY_REFRESH"
    ) return "unauthorized"
  }
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
  if (error instanceof ExternalMcpDiagnosticError) {
    return `${error.diagnostic.message} Ask the named action owner to inspect this layer. ${error.diagnostic.operatorAction} Diagnostic reference: ${error.diagnostic.referenceId}. ${LIVE_PROBE_HINT}`
  }
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

function diagnosticConnectionAction(input: {
  connection: Pick<ExternalMcpConnectionRow, "authType">
  state: ExternalConnectionStatus["state"]
  diagnostic: ExternalMcpDiagnostic
}): Pick<ExternalConnectionStatus, "actor" | "action"> {
  const actor = input.diagnostic.actionOwner
  let type: ExternalConnectionStatus["action"]["type"]
  let surface: ExternalConnectionStatus["action"]["surface"]
  if (actor === "openwork") {
    type = "contact_openwork"
    surface = "openwork_support"
  } else if (actor === "network_admin") {
    type = "fix_network"
    surface = "network_infrastructure"
  } else if (actor === "provider_admin") {
    type = "fix_provider"
    surface = "provider_admin_console"
  } else if (actor === "member") {
    type = input.state === "needs_connection" ? "connect" : "reconnect"
    surface = "openwork_your_connections"
  } else {
    type = input.state === "reauth_required"
      ? input.connection.authType === "apikey" ? "update_credentials" : "reconnect"
      : "inspect_connection"
    surface = "openwork_organization_connections"
  }
  return {
    actor,
    action: {
      type,
      surface,
      label: input.diagnostic.operatorAction,
      retry: "search_capabilities",
    },
  }
}

export function buildExternalConnectionStatus(input: {
  connection: Pick<ExternalMcpConnectionRow, "id" | "name" | "authType" | "credentialMode">
  state: ExternalConnectionStatus["state"]
  errorCode: ExternalConnectionStatus["errorCode"]
  message: string
  diagnostic?: ExternalMcpDiagnostic
}): ExternalConnectionStatus {
  const connectionName = input.connection.name
  const diagnosticAction = input.diagnostic
    ? diagnosticConnectionAction({ connection: input.connection, state: input.state, diagnostic: input.diagnostic })
    : null
  if (input.state === "provider_error") {
    const providerAdminAction = PROVIDER_ADMIN_ACTION_PATTERN.test(input.message)
    return {
      layer: input.diagnostic ? "mcp_connection" : "downstream_provider",
      connectionId: input.connection.id,
      connectionName,
      authType: input.connection.authType,
      credentialMode: input.connection.credentialMode,
      state: input.state,
      errorCode: input.errorCode,
      message: input.message,
      actor: diagnosticAction?.actor ?? (providerAdminAction ? "provider_admin" : "organization_admin"),
      action: diagnosticAction?.action ?? {
        type: providerAdminAction ? "fix_provider" : "inspect_connection",
        label: providerAdminAction
          ? `Fix ${connectionName} in the provider admin console`
          : `Inspect the ${connectionName} connection`,
        surface: providerAdminAction ? "provider_admin_console" : "openwork_organization_connections",
        retry: "search_capabilities",
      },
      ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
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
    layer: input.diagnostic ? "mcp_connection" : "downstream_provider",
    connectionId: input.connection.id,
    connectionName,
    authType: input.connection.authType,
    credentialMode: input.connection.credentialMode,
    state: input.state,
    errorCode: input.errorCode,
    message: input.message,
    actor: diagnosticAction?.actor ?? actor,
    action: diagnosticAction?.action ?? {
      type: actionType,
      label: `${actionVerb} ${connectionName}`,
      surface,
      retry: "search_capabilities",
    },
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
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

export function mergeBoundedExternalCapabilityMatches(
  retained: ExternalCapabilityMatch[],
  candidates: readonly ExternalCapabilityMatch[],
  limit: number,
): ExternalCapabilityMatch[] {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(Math.floor(limit), EXTERNAL_MCP_SEARCH_MATCH_LIMIT))
    : 0
  if (boundedLimit === 0) {
    retained.splice(0)
    return retained
  }
  for (const candidate of candidates) {
    retained.push(candidate)
    retained.sort(compareCapabilityMatches)
    if (retained.length > boundedLimit) retained.splice(boundedLimit)
  }
  return retained
}

export async function collectBoundedExternalMcpSearchMatches<T>(input: {
  connections: readonly T[]
  deadline: ExternalMcpLifecycleDeadline
  limit: number
  concurrency?: number
  probe: (connection: T, deadline: ExternalMcpLifecycleDeadline) => Promise<ExternalCapabilityMatch[]>
}): Promise<ExternalCapabilityMatch[]> {
  const retained: ExternalCapabilityMatch[] = []
  const boundedLimit = Number.isFinite(input.limit)
    ? Math.max(0, Math.min(Math.floor(input.limit), EXTERNAL_MCP_SEARCH_MATCH_LIMIT))
    : 0
  if (boundedLimit === 0 || input.connections.length === 0) return retained

  const concurrency = Math.max(1, Math.min(
    Math.floor(input.concurrency ?? EXTERNAL_MCP_SEARCH_CONCURRENCY),
    EXTERNAL_MCP_SEARCH_CONCURRENCY,
    input.connections.length,
  ))
  let nextIndex = 0
  let acceptingResults = true
  const worker = async () => {
    while (Date.now() < input.deadline.expiresAt) {
      const index = nextIndex
      nextIndex += 1
      if (index >= input.connections.length) return
      const candidates = await input.probe(input.connections[index]!, input.deadline)
      if (acceptingResults) mergeBoundedExternalCapabilityMatches(retained, candidates, boundedLimit)
    }
  }
  const workers = Promise.all(Array.from({ length: concurrency }, () => worker()))
  const remaining = Math.max(0, input.deadline.expiresAt - Date.now())
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadlineReached = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, remaining)
  })
  try {
    await Promise.race([workers, deadlineReached])
  } finally {
    acceptingResults = false
    if (deadlineTimer) clearTimeout(deadlineTimer)
    // Active MCP requests receive the same absolute deadline and abort their
    // fetch at this point. Keep a rejection observer on the worker pool for
    // the smaller class of non-fetch operations that cannot be cancelled.
    void workers.catch(() => undefined)
  }
  return retained
}

export type ExternalMcpSearchCoverage = {
  eligibleConnections: number
  probedConnections: number
  truncated: boolean
}

export function externalMcpSearchCoverageHint(coverage: ExternalMcpSearchCoverage): string | undefined {
  if (!coverage.truncated) return undefined
  return `External MCP search inspected ${coverage.probedConnections} of ${coverage.eligibleConnections} eligible connections. Results may be incomplete; narrow the query using a connection name and search again.`
}

async function probeExternalMcpConnection(input: {
  connection: ExternalMcpConnectionRow
  member: McpMemberIdentity
  queryTokens: string[]
  redirectUriBase: string
  limit: number
  deadline: ExternalMcpLifecycleDeadline
}): Promise<ExternalCapabilityMatch[]> {
  const matches: ExternalCapabilityMatch[] = []
  const add = (match: ExternalCapabilityMatch) => {
    mergeBoundedExternalCapabilityMatches(matches, [match], input.limit)
  }
  const connection = input.connection
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
      const score = scoreText(nameTokens, nameTokens, input.queryTokens)
      if (score > 0) {
        const message = `You haven't connected your ${connection.name} account yet.`
        add(statusMatch({
          connection,
          score,
          summary: `[${connection.name}] Available to you, but you haven't connected your ${connection.name} account yet.`,
          status: "needs_connection",
          hint: `Ask the user to open OpenWork Cloud -> Your Connections and click Connect on "${connection.name}", then search again.`,
          connectionStatus: buildExternalConnectionStatus({ connection, state: "needs_connection", errorCode: "not_connected", message }),
        }))
      }
      return matches
    }
  } else if (!hasSharedCredential(connection)) {
    const nameTokens = tokenize(connection.name)
    const score = scoreText(nameTokens, nameTokens, input.queryTokens)
    if (score > 0) {
      const message = `${connection.name} is not connected yet.`
      add(statusMatch({
        connection,
        score,
        summary: `[${connection.name}] Available to your organization, but an admin hasn't connected it yet.`,
        status: "needs_connection",
        hint: `Ask an org admin to open the OpenWork Cloud dashboard -> Connections and connect "${connection.name}", then search again.`,
        connectionStatus: buildExternalConnectionStatus({ connection, state: "needs_connection", errorCode: "not_connected", message }),
      }))
    }
    return matches
  }

  const member = connection.credentialMode === "per_member"
    ? { orgMembershipId: input.member.orgMembershipId }
    : undefined
  let tools: Awaited<ReturnType<typeof listExternalMcpTools>>
  try {
    tools = await listExternalMcpTools(
      connection,
      redirectUriFor(input.redirectUriBase, connection.id),
      member,
      undefined,
      input.deadline,
    )
  } catch (error) {
    const message = upstreamErrorMessage(error)
    const diagnostic = error instanceof ExternalMcpDiagnosticError ? error.diagnostic : undefined
    const nameTokens = tokenize(connection.name)
    const score = scoreText(nameTokens, nameTokens, input.queryTokens)
    if (score > 0) {
      if (diagnostic) {
        console.error("external_mcp_capability_search_probe_failed", {
          connectionId: connection.id,
          organizationId: connection.organizationId,
          connectionEndpoint: safeExternalMcpEndpointForLog(connection.url),
          ...externalMcpDiagnosticForLog(error, diagnostic.referenceId, "MCP_TOOL_DISCOVERY"),
        })
      }
      const authErrorCode = externalMcpAuthErrorCode(error, message)
      const state = authErrorCode ? "reauth_required" : "provider_error"
      add(statusMatch({
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
          diagnostic,
        }),
      }))
    }
    return matches
  }

  for (const tool of tools) {
    const summary = tool.description ?? tool.title ?? tool.name
    const nameTokens = tokenize(`${connection.name} ${tool.name}`)
    const summaryTokens = tokenize(summary)
    const score = scoreText(nameTokens, summaryTokens, input.queryTokens)
    if (score <= 0) continue
    add({
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

/**
 * Live-lists tools for a bounded set of external MCP connections the calling
 * member has been granted. All probes share one absolute deadline and run in
 * a small worker pool; one unreachable server cannot serialize the latency of
 * every other provider or let matches grow beyond the requested top-K.
 */
export async function searchExternalCapabilities(input: {
  organizationId: string
  member: McpMemberIdentity | null
  query: string
  redirectUriBase: string
  limit?: number
  reportCoverage?: (coverage: ExternalMcpSearchCoverage) => void
}): Promise<ExternalCapabilityMatch[]> {
  if (!input.member) return []
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []
  const requestedLimit = input.limit ?? 5
  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) return []
  const limit = Math.min(Math.max(1, Math.trunc(requestedLimit)), EXTERNAL_MCP_SEARCH_MATCH_LIMIT)
  const deadline = createExternalMcpLifecycleDeadline()
  const connections = await listUsableExternalMcpConnections({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const selectedConnections = selectExternalMcpSearchConnections(connections, queryTokens)
  input.reportCoverage?.({
    eligibleConnections: connections.length,
    probedConnections: selectedConnections.length,
    truncated: selectedConnections.length < connections.length,
  })
  return await collectBoundedExternalMcpSearchMatches({
    connections: selectedConnections,
    deadline,
    limit,
    probe: (connection, sharedDeadline) => probeExternalMcpConnection({
      connection,
      member: input.member!,
      queryTokens,
      redirectUriBase: input.redirectUriBase,
      limit,
      deadline: sharedDeadline,
    }),
  })
}

export type ExternalCapabilityExecuteResult =
  | { ok: true; result: Awaited<ReturnType<typeof callExternalMcpTool>> }
  | {
      ok: false
      error: "unknown_capability" | "forbidden" | "connection_not_connected" | "needs_connection" | "connection_failed" | "provider_error"
      message: string
      diagnostic?: ExternalMcpDiagnostic
      actionOwner?: ExternalMcpDiagnostic["actionOwner"]
      operatorAction?: string
    }

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

  try {
    const result = await callExternalMcpTool({
      connection,
      redirectUri: redirectUriFor(input.redirectUriBase, connection.id),
      toolName: input.toolName,
      args: input.args,
      member,
    })
    return { ok: true, result }
  } catch (error) {
    if (error instanceof ExternalMcpDiagnosticError) {
      console.error("external_mcp_capability_execute_failed", {
        connectionId: connection.id,
        organizationId: connection.organizationId,
        connectionEndpoint: safeExternalMcpEndpointForLog(connection.url),
        ...externalMcpDiagnosticForLog(error, error.diagnostic.referenceId, "MCP_TOOL_EXECUTION"),
      })
      return {
        ok: false,
        error: error.diagnostic.phase === "PROVIDER_EXECUTION" || error.diagnostic.phase === "PROVIDER_AUTHORIZATION"
          ? "provider_error"
          : "connection_failed",
        message: `${error.diagnostic.message} ${error.diagnostic.operatorAction} Diagnostic reference: ${error.diagnostic.referenceId}.`,
        diagnostic: error.diagnostic,
        actionOwner: error.diagnostic.actionOwner,
        operatorAction: error.diagnostic.operatorAction,
      }
    }
    throw error
  }
}
