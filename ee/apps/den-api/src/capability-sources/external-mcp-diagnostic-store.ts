import { randomUUID } from "node:crypto"
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "@openwork-ee/den-db/drizzle"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import {
  ExternalMcpConnectionTable,
  McpDiagnosticAttemptTable,
  McpDiagnosticEventTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  MCP_DIAGNOSTIC_HEALTH_LEVELS,
  type McpDiagnosticActionOwner,
  type McpDiagnosticAttempt,
  type McpDiagnosticAttemptStatus,
  type McpDiagnosticEvent,
  type McpDiagnosticEventOutcome,
  type McpDiagnosticHealthLevel,
  type McpDiagnosticPhase,
  type McpDiagnosticSafeEvidence,
  type McpDiagnosticSnapshot,
} from "@openwork/types/den/mcp-diagnostics"
import { db } from "../db.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../audit-events.js"
import { roleIncludesPrivileged } from "../organization-member-guards.js"
import { ExternalMcpDiagnosticError } from "./external-mcp-diagnostics.js"

export const MCP_DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60 * 1000
export const MCP_DIAGNOSTIC_EXECUTION_LEASE_MS = 30_000
export const MCP_DIAGNOSTIC_RATE_WINDOW_MS = 10 * 60 * 1000
export const MCP_DIAGNOSTIC_MAX_ACTIVE_PER_MEMBER = 2
export const MCP_DIAGNOSTIC_MAX_ACTIVE_PER_ORGANIZATION = 8
export const MCP_DIAGNOSTIC_MAX_STARTS_PER_MEMBER_WINDOW = 20
export const MCP_DIAGNOSTIC_MAX_STARTS_PER_ORGANIZATION_WINDOW = 80
const MCP_DIAGNOSTIC_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
export const MCP_DIAGNOSTIC_AUTHORIZATION_LEASE_MS = 90_000
const SAFE_PATH_SEGMENTS = new Set([
  ".well-known",
  "authorize",
  "mcp",
  "mcp-server",
  "oauth-authorization-server",
  "oauth-protected-resource",
  "openid-configuration",
  "register",
  "sncapps",
  "token",
])
let cleanupTimer: ReturnType<typeof setInterval> | null = null

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">
type ConnectionId = DenTypeId<"externalMcpConnection">
type AttemptId = DenTypeId<"mcpDiagnosticAttempt">
type AuditEventId = DenTypeId<"auditEvent">

const ACTIVE_ATTEMPT_STATUSES = ["running", "waiting_for_authorization"] as const

type SafeEvidenceInput = {
  url?: string | URL
  method?: string
  status?: number
  contentType?: string | null
  errorCode?: string | null
  protocolVersion?: string | null
  toolCount?: number
  pageCount?: number
}

type DiagnosticFailure = {
  category: string
  messageSafe: string
  operatorAction: string
  retryable: boolean
  actionOwner: McpDiagnosticActionOwner
  errorCode: string | null
}

export class McpDiagnosticAttemptClosedError extends Error {
  constructor() {
    super("The MCP diagnostic attempt is already complete.")
    this.name = "McpDiagnosticAttemptClosedError"
  }
}

export class McpDiagnosticStartLimitError extends Error {
  readonly kind: "concurrency" | "rate"
  readonly scope: "member" | "organization"
  readonly retryAfterSeconds: number

  constructor(input: {
    kind: "concurrency" | "rate"
    scope: "member" | "organization"
    retryAfterSeconds: number
  }) {
    const subject = input.scope === "member" ? "this administrator" : "this organization"
    super(input.kind === "concurrency"
      ? `Too many MCP diagnostics are already active for ${subject}. Wait for an active diagnostic to finish, then retry.`
      : `MCP diagnostics were started too frequently for ${subject}. Wait before starting another diagnostic.`)
    this.name = "McpDiagnosticStartLimitError"
    this.kind = input.kind
    this.scope = input.scope
    this.retryAfterSeconds = input.retryAfterSeconds
  }
}

export function isMcpDiagnosticAttemptClosedError(error: unknown, depth = 0): boolean {
  if (!isRecord(error) || depth > 6) return false
  if (error instanceof McpDiagnosticAttemptClosedError || error.name === "McpDiagnosticAttemptClosedError") return true
  return "cause" in error && isMcpDiagnosticAttemptClosedError(error.cause, depth + 1)
}

function boundedToken(value: string, maxLength: number): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || !/^[a-zA-Z0-9_./+:-]+$/.test(trimmed)) return undefined
  return trimmed
}

function pathTemplate(pathname: string): string {
  const serviceNow = pathname.match(/^\/sncapps\/mcp-server\/mcp\/[^/]+\/?$/)
  if (serviceNow) return "/sncapps/mcp-server/mcp/{server}"

  const segments = pathname.split("/").map((segment) => {
    if (!segment) return segment
    return SAFE_PATH_SEGMENTS.has(segment.toLowerCase()) ? segment : "{segment}"
  })
  return segments.join("/").slice(0, 512)
}

export function safeMcpDiagnosticEvidence(input: SafeEvidenceInput = {}): McpDiagnosticSafeEvidence {
  let origin: string | undefined
  let path: string | undefined
  if (input.url) {
    try {
      const url = input.url instanceof URL ? input.url : new URL(input.url)
      origin = url.origin
      path = pathTemplate(url.pathname)
    } catch {
      // Invalid URLs are classified separately. Never retain the raw value.
    }
  }

  const method = input.method ? boundedToken(input.method.toUpperCase(), 16) : undefined
  const contentType = input.contentType
    ? boundedToken(input.contentType.split(";", 1)[0] ?? "", 128)
    : undefined
  const errorCode = input.errorCode ? boundedToken(input.errorCode, 64) : undefined
  const protocolVersion = input.protocolVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(input.protocolVersion)
    ? input.protocolVersion
    : undefined

  return {
    ...(method ? { method } : {}),
    ...(origin ? { origin } : {}),
    ...(path ? { path } : {}),
    ...(typeof input.status === "number" && Number.isInteger(input.status) ? { status: input.status } : {}),
    ...(contentType ? { contentType } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(typeof input.toolCount === "number" && Number.isInteger(input.toolCount) ? { toolCount: input.toolCount } : {}),
    ...(typeof input.pageCount === "number" && Number.isInteger(input.pageCount) ? { pageCount: input.pageCount } : {}),
    detailsRedacted: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function errorCauseCode(error: unknown, depth = 0): string | null {
  if (!isRecord(error) || depth > 6) return null
  if (typeof error.code === "string") return boundedToken(error.code, 64) ?? null
  return errorCauseCode(error.cause, depth + 1)
}

function errorName(error: unknown, depth = 0): string | null {
  if (!isRecord(error) || depth > 6) return null
  return errorName(error.cause, depth + 1)
    ?? (typeof error.name === "string" ? error.name : null)
}

function errorText(error: unknown, depth = 0): string {
  if (!isRecord(error) || depth > 6) return ""
  const own = error instanceof Error ? error.message.toLowerCase() : ""
  return `${own} ${errorText(error.cause, depth + 1)}`.trim()
}

type SafeHttpFailure = {
  phase: McpDiagnosticPhase
  status: number
  hadAuthorization: boolean
  bearerChallenge: boolean
  invalidToken: boolean
  insufficientScope: boolean
}

function errorHttpFailure(error: unknown, depth = 0): SafeHttpFailure | null {
  if (!isRecord(error) || depth > 6) return null
  const http = isRecord(error.http) ? error.http : null
  if (
    http
    && typeof http.phase === "string"
    && typeof http.status === "number"
    && typeof http.hadAuthorization === "boolean"
    && typeof http.bearerChallenge === "boolean"
    && typeof http.invalidToken === "boolean"
    && typeof http.insufficientScope === "boolean"
  ) return http as SafeHttpFailure
  return errorHttpFailure(error.cause, depth + 1)
}

export function classifyMcpDiagnosticFailure(error: unknown, phase: McpDiagnosticPhase): DiagnosticFailure {
  if (error instanceof ExternalMcpDiagnosticError) {
    return {
      category: error.diagnostic.category,
      messageSafe: error.diagnostic.message,
      operatorAction: error.diagnostic.operatorAction,
      retryable: error.diagnostic.retryable,
      actionOwner: error.diagnostic.actionOwner,
      errorCode: error.diagnostic.code,
    }
  }
  const code = errorCauseCode(error)
  const name = errorName(error)
  const text = errorText(error)
  const http = errorHttpFailure(error)

  if (name === "PrivateUrlError") {
    return {
      category: "security_blocked",
      messageSafe: "Den blocked this destination under its outbound URL safety policy.",
      operatorAction: "review_endpoint_and_ssrf_policy",
      retryable: false,
      actionOwner: "organization_admin",
      errorCode: null,
    }
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      category: "dns_failure",
      messageSafe: "The MCP host could not be resolved from the Den server.",
      operatorAction: "check_dns_and_den_egress",
      retryable: code === "EAI_AGAIN",
      actionOwner: "network_admin",
      errorCode: code,
    }
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET") {
    return {
      category: "network_connection_failed",
      messageSafe: "Den reached the destination network, but the connection was refused or reset.",
      operatorAction: "check_provider_allowlist_and_listener",
      retryable: code === "ECONNRESET",
      actionOwner: "network_admin",
      errorCode: code,
    }
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || name === "TimeoutError" || name === "AbortError") {
    return {
      category: "network_timeout",
      messageSafe: "The MCP request exceeded its Den-side network deadline.",
      operatorAction: "check_den_egress_proxy_and_provider_availability",
      retryable: true,
      actionOwner: "network_admin",
      errorCode: code,
    }
  }
  if (code && [
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ].includes(code)) {
    return {
      category: "tls_failure",
      messageSafe: "The provider TLS certificate could not be validated from the Den server.",
      operatorAction: "fix_provider_certificate_or_den_ca_bundle",
      retryable: false,
      actionOwner: "network_admin",
      errorCode: code,
    }
  }
  if (code === "MCP_LIFECYCLE_DEADLINE") {
    return {
      category: "lifecycle_deadline",
      messageSafe: "The MCP lifecycle exceeded its bounded Den-side deadline.",
      operatorAction: "reduce_provider_latency_or_catalog_pagination",
      retryable: true,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  if (code === "MCP_CLOSE_TIMEOUT") {
    return {
      category: "shutdown_timeout",
      messageSafe: "The MCP client did not close within its bounded shutdown deadline.",
      operatorAction: "inspect_provider_stream_shutdown",
      retryable: true,
      actionOwner: "openwork",
      errorCode: code,
    }
  }
  if (code === "MCP_RESPONSE_BODY_LIMIT") {
    return {
      category: "response_too_large",
      messageSafe: "The MCP server returned a response larger than Den can safely process.",
      operatorAction: "reduce_provider_response_or_catalog_size",
      retryable: false,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  if (code?.startsWith("MCP_CATALOG_")) {
    return {
      category: "mcp_catalog_bound",
      messageSafe: "The MCP tool catalog exceeded a bounded safety or validity limit.",
      operatorAction: "reduce_and_validate_provider_tool_catalog",
      retryable: false,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  if (name === "InvalidTokenError") {
    return {
      category: "oauth_invalid_token",
      messageSafe: "The MCP resource rejected the configured OAuth token.",
      operatorAction: "reconnect_provider_account_and_verify_resource_audience",
      retryable: true,
      actionOwner: "member",
      errorCode: code,
    }
  }
  if (name === "InsufficientScopeError") {
    return {
      category: "oauth_insufficient_scope",
      messageSafe: "The OAuth token does not include the scopes required by this MCP resource.",
      operatorAction: "grant_required_provider_scopes_and_reconnect",
      retryable: false,
      actionOwner: "organization_admin",
      errorCode: code,
    }
  }
  if (name === "TooManyRequestsError") {
    return {
      category: "provider_throttled",
      messageSafe: "The provider rate-limited this MCP handshake request.",
      operatorAction: "wait_for_provider_rate_limit_and_retry",
      retryable: true,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  if (name === "MethodNotAllowedError") {
    return {
      category: "method_not_allowed",
      messageSafe: "The provider does not allow the HTTP method required by this MCP phase.",
      operatorAction: "verify_provider_endpoint_and_transport_method",
      retryable: false,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  if (name === "ExternalMcpOAuthClientRevisionError") {
    return {
      category: "oauth_client_revision_changed",
      messageSafe: "The MCP OAuth client registration changed after this authorization started.",
      operatorAction: "restart_provider_authorization",
      retryable: true,
      actionOwner: "organization_admin",
      errorCode: code,
    }
  }
  if (name === "ExternalMcpPendingGrantError") {
    return {
      category: "oauth_pending_grant_invalid",
      messageSafe: "The MCP OAuth authorization is missing, expired, or already consumed.",
      operatorAction: "restart_provider_authorization",
      retryable: true,
      actionOwner: "member",
      errorCode: code,
    }
  }
  if (name === "McpDiagnosticCredentialFenceError") {
    return {
      category: "oauth_callback_lease_stale",
      messageSafe: "This OAuth callback no longer holds the active diagnostic authorization lease.",
      operatorAction: "restart_provider_authorization",
      retryable: true,
      actionOwner: "member",
      errorCode: code,
    }
  }
  if (http) {
    if (
      (http.phase === "AUTH_TOKEN_ACQUISITION" || http.phase === "CONTINUITY_REFRESH")
      && (http.status === 404 || http.status === 405 || http.status >= 500)
    ) {
      const refreshing = http.phase === "CONTINUITY_REFRESH"
      const unavailable = http.status >= 500
      return {
        category: refreshing ? "oauth_refresh_failure" : "oauth_token_failure",
        messageSafe: unavailable
          ? "The authorization server token endpoint was unavailable during the OAuth exchange."
          : `The authorization server token endpoint rejected the required HTTP ${http.status === 404 ? "path" : "method"}.`,
        operatorAction: unavailable
          ? "inspect_authorization_server_token_endpoint_availability"
          : "verify_authorization_server_token_endpoint",
        retryable: unavailable,
        actionOwner: unavailable ? "provider_admin" : "organization_admin",
        errorCode: `MCP_OAUTH_TOKEN_HTTP_${http.status}`,
      }
    }
    if (
      http.phase === "AUTH_CLIENT_REGISTRATION"
      && (http.status === 404 || http.status === 405 || http.status >= 500)
    ) {
      return {
        category: "oauth_client_registration",
        messageSafe: http.status >= 500
          ? "The authorization server dynamic client registration endpoint was unavailable."
          : "The authorization server did not expose a compatible dynamic client registration endpoint.",
        operatorAction: http.status >= 500
          ? "inspect_authorization_server_registration_availability"
          : "configure_a_preregistered_oauth_client",
        retryable: http.status >= 500,
        actionOwner: "organization_admin",
        errorCode: `MCP_OAUTH_DCR_HTTP_${http.status}`,
      }
    }
    if (
      (http.phase === "AUTH_RESOURCE_DISCOVERY" || http.phase === "AUTH_ISSUER_DISCOVERY")
      && (http.status === 404 || http.status === 405 || http.status >= 500)
    ) {
      return {
        category: "oauth_handshake_failure",
        messageSafe: "The provider's OAuth discovery metadata could not be resolved from its standards-based candidates.",
        operatorAction: "verify_authorization_server_metadata",
        retryable: http.status >= 500,
        actionOwner: "organization_admin",
        errorCode: `MCP_OAUTH_DISCOVERY_HTTP_${http.status}`,
      }
    }
    if (http.status === 429) {
      return {
        category: "provider_throttled",
        messageSafe: "The provider rate-limited this MCP request.",
        operatorAction: "wait_for_provider_rate_limit_and_retry",
        retryable: true,
        actionOwner: "provider_admin",
        errorCode: "MCP_HTTP_429",
      }
    }
    if (http.status === 404) {
      return {
        category: "endpoint_not_found",
        messageSafe: "Den reached the host, but the configured MCP endpoint path was not found.",
        operatorAction: "verify_complete_provider_mcp_endpoint_path",
        retryable: false,
        actionOwner: "organization_admin",
        errorCode: "MCP_HTTP_404",
      }
    }
    if (http.status === 405) {
      return {
        category: "method_not_allowed",
        messageSafe: "The endpoint does not accept the HTTP method required by Streamable HTTP MCP.",
        operatorAction: "verify_streamable_http_endpoint_and_method",
        retryable: false,
        actionOwner: "provider_admin",
        errorCode: "MCP_HTTP_405",
      }
    }
    if (http.status >= 500) {
      return {
        category: "provider_unavailable",
        messageSafe: "The provider returned a server error during this MCP phase.",
        operatorAction: "inspect_provider_and_reverse_proxy_availability",
        retryable: true,
        actionOwner: "provider_admin",
        errorCode: `MCP_HTTP_${http.status}`,
      }
    }
    if (http.status === 401 && http.bearerChallenge && !http.hadAuthorization) {
      return {
        category: "oauth_authorization_required",
        messageSafe: "The MCP resource requires provider authorization before it can be diagnosed.",
        operatorAction: "complete_provider_authorization",
        retryable: true,
        actionOwner: "member",
        errorCode: "MCP_OAUTH_AUTHORIZATION_REQUIRED",
      }
    }
    if ((http.status === 401 || http.status === 403) && (http.invalidToken || http.insufficientScope)) {
      return {
        category: http.insufficientScope ? "oauth_insufficient_scope" : "oauth_invalid_token",
        messageSafe: http.insufficientScope
          ? "The OAuth token does not include the scopes required by this MCP resource."
          : "The MCP resource rejected the configured OAuth token.",
        operatorAction: http.insufficientScope
          ? "grant_required_provider_scopes_and_reconnect"
          : "reconnect_provider_account_and_verify_resource_audience",
        retryable: !http.insufficientScope,
        actionOwner: http.insufficientScope ? "organization_admin" : "member",
        errorCode: http.insufficientScope ? "MCP_OAUTH_INSUFFICIENT_SCOPE" : "MCP_OAUTH_INVALID_TOKEN",
      }
    }
    if (http.status === 403 && http.hadAuthorization) {
      return {
        category: "provider_policy_denied",
        messageSafe: "The provider accepted the identity but denied the required role or ACL.",
        operatorAction: "grant_required_provider_role_acl_or_application_permission",
        retryable: false,
        actionOwner: "provider_admin",
        errorCode: "MCP_PROVIDER_HTTP_403",
      }
    }
    if (http.status === 401) {
      return {
        category: "oauth_authentication_failed",
        messageSafe: "The MCP resource rejected the configured authentication.",
        operatorAction: "verify_provider_credential_and_reconnect",
        retryable: true,
        actionOwner: "organization_admin",
        errorCode: "MCP_HTTP_401",
      }
    }
    if (http.status === 403) {
      return {
        category: "provider_policy_denied",
        messageSafe: "The provider denied the required role, ACL, or application permission.",
        operatorAction: "grant_required_provider_role_acl_or_application_permission",
        retryable: false,
        actionOwner: "provider_admin",
        errorCode: "MCP_PROVIDER_HTTP_403",
      }
    }
  }
  if (phase === "MCP_VERSION" || text.includes("protocol version") || text.includes("unsupported version")) {
    return {
      category: "mcp_version",
      messageSafe: "The client and server did not agree on a supported stable MCP revision.",
      operatorAction: "align_provider_and_client_mcp_versions",
      retryable: false,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  if (phase === "AUTH_CLIENT_REGISTRATION") {
    return {
      category: "oauth_client_registration",
      messageSafe: "The authorization server did not accept the MCP OAuth client registration.",
      operatorAction: "configure_a_preregistered_oauth_client",
      retryable: false,
      actionOwner: "organization_admin",
      errorCode: code,
    }
  }
  if (phase === "AUTH_TOKEN_ACQUISITION") {
    return {
      category: "oauth_token_failure",
      messageSafe: "The authorization server did not complete the token exchange.",
      operatorAction: "review_redirect_client_and_consent",
      retryable: false,
      actionOwner: "organization_admin",
      errorCode: code,
    }
  }
  if (phase === "CONTINUITY_REFRESH") {
    return {
      category: "oauth_refresh_failure",
      messageSafe: "The authorization server did not refresh the MCP access token.",
      operatorAction: "reconnect_provider_account_and_review_refresh_policy",
      retryable: true,
      actionOwner: "member",
      errorCode: code,
    }
  }
  if (phase === "MCP_TOOL_DISCOVERY") {
    return {
      category: "mcp_catalog",
      messageSafe: "The MCP tool catalog was incomplete or invalid.",
      operatorAction: "inspect_provider_tool_catalog",
      retryable: false,
      actionOwner: "provider_admin",
      errorCode: code,
    }
  }
  return {
    category: phase.startsWith("AUTH_") ? "oauth_handshake_failure" : "mcp_connection_failure",
    messageSafe: phase.startsWith("AUTH_")
      ? "The OAuth handshake failed at this phase."
      : "The MCP connection failed at this phase.",
    operatorAction: phase.startsWith("AUTH_") ? "review_oauth_configuration" : "inspect_provider_and_den_logs",
    retryable: false,
    actionOwner: phase.startsWith("AUTH_") ? "organization_admin" : "provider_admin",
    errorCode: code,
  }
}

function toAttempt(row: typeof McpDiagnosticAttemptTable.$inferSelect): McpDiagnosticAttempt {
  return {
    id: row.id,
    connectionId: row.externalMcpConnectionId,
    status: row.status,
    highestHealthLevel: row.highestHealthLevel,
    firstFailedPhase: row.firstFailedPhase,
    firstFailureCategory: row.firstFailureCategory,
    firstFailureMessage: row.firstFailureMessage,
    actionOwner: row.actionOwner,
    operatorAction: row.operatorAction,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  }
}

function toEvent(row: typeof McpDiagnosticEventTable.$inferSelect): McpDiagnosticEvent {
  return {
    id: row.id,
    attemptId: row.attemptId,
    sequence: row.sequence,
    occurredAt: row.occurredAt.toISOString(),
    phase: row.phase,
    outcome: row.outcome,
    elapsedMs: row.elapsedMs,
    phaseDurationMs: row.phaseDurationMs,
    healthLevel: row.healthLevel,
    messageSafe: row.messageSafe,
    category: row.category,
    retryable: row.retryable,
    actionOwner: row.actionOwner,
    operatorAction: row.operatorAction,
    evidence: row.evidence,
  }
}

export async function cleanupExpiredMcpDiagnostics(now = new Date()): Promise<number> {
  let deleted = 0
  while (true) {
    const expired = await db
      .select({ id: McpDiagnosticAttemptTable.id })
      .from(McpDiagnosticAttemptTable)
      .where(lt(McpDiagnosticAttemptTable.expiresAt, now))
      .limit(200)
    if (expired.length === 0) return deleted
    const attemptIds = expired.map((row) => row.id)
    await db.transaction(async (tx) => {
      await tx.delete(McpDiagnosticEventTable).where(inArray(McpDiagnosticEventTable.attemptId, attemptIds))
      await tx.delete(McpDiagnosticAttemptTable).where(inArray(McpDiagnosticAttemptTable.id, attemptIds))
    })
    deleted += attemptIds.length
    if (attemptIds.length < 200) return deleted
  }
}

export function startMcpDiagnosticCleanupLoop(): void {
  if (cleanupTimer) return
  const run = () => {
    void cleanupExpiredMcpDiagnostics().catch((error) => {
      console.error("mcp_diagnostic_cleanup_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    })
  }
  run()
  cleanupTimer = setInterval(run, MCP_DIAGNOSTIC_CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()
}

function isTerminalAttemptStatus(status: McpDiagnosticAttemptStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "expired"
}

function executionLeaseIsAbandoned(
  attempt: Pick<typeof McpDiagnosticAttemptTable.$inferSelect, "startedAt" | "executionLeaseExpiresAt">,
  now: Date,
): boolean {
  if (attempt.executionLeaseExpiresAt) return attempt.executionLeaseExpiresAt.getTime() <= now.getTime()
  return attempt.startedAt.getTime() + MCP_DIAGNOSTIC_EXECUTION_LEASE_MS <= now.getTime()
}

/**
 * Converts an attempt whose owning Den process stopped heartbeating into a
 * retryable, redacted terminal result. The row lock makes restart recovery
 * race safely with a late OAuth callback or a still-live runner heartbeat.
 */
export async function recoverAbandonedMcpDiagnosticAttempt(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  now?: Date
}): Promise<McpDiagnosticEvent | null> {
  const now = input.now ?? new Date()
  const eventId = createDenTypeId("mcpDiagnosticEvent")
  const recovered = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
      .limit(1)
      .for("update")
    const attempt = rows[0]
    if (!attempt || isTerminalAttemptStatus(attempt.status) || !executionLeaseIsAbandoned(attempt, now)) return null

    const sequence = attempt.lastSequence + 1
    const messageSafe = "The Den diagnostic worker stopped before this attempt completed. Run the diagnostic again."
    await tx.insert(McpDiagnosticEventTable).values({
      id: eventId,
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      sequence,
      phase: "CONTINUITY_SESSION",
      outcome: "failed",
      elapsedMs: Math.max(0, now.getTime() - attempt.startedAt.getTime()),
      phaseDurationMs: null,
      healthLevel: attempt.highestHealthLevel,
      messageSafe,
      category: "diagnostic_execution_interrupted",
      retryable: true,
      actionOwner: "openwork",
      operatorAction: "run_diagnostic_again",
      evidence: safeMcpDiagnosticEvidence({ errorCode: "MCP_DIAGNOSTIC_EXECUTION_LOST" }),
      occurredAt: now,
    })
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({
        status: "failed",
        lastSequence: sequence,
        firstFailedPhase: attempt.firstFailedPhase ?? "CONTINUITY_SESSION",
        firstFailureCategory: attempt.firstFailureCategory ?? "diagnostic_execution_interrupted",
        firstFailureMessage: attempt.firstFailureMessage ?? messageSafe,
        actionOwner: attempt.actionOwner ?? "openwork",
        operatorAction: attempt.operatorAction ?? "run_diagnostic_again",
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        authorizationClaimId: null,
        authorizationLeaseExpiresAt: null,
        completedAt: now,
      })
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
    const events = await tx
      .select()
      .from(McpDiagnosticEventTable)
      .where(eq(McpDiagnosticEventTable.id, eventId))
      .limit(1)
    return events[0] ? toEvent(events[0]) : null
  })
  if (!recovered) return null

  const [attempt, snapshot] = await Promise.all([
    getMcpDiagnosticAttemptRow({ organizationId: input.organizationId, attemptId: input.attemptId }),
    getMcpDiagnosticSnapshot({ organizationId: input.organizationId, attemptId: input.attemptId }),
  ])
  if (attempt && snapshot) {
    try {
      const actorUserId = await getMcpDiagnosticAdminActorUserId({
        organizationId: input.organizationId,
        memberId: attempt.createdByOrgMembershipId,
      })
      if (actorUserId) {
        await recordMcpDiagnosticCompletionAuditOnce({
          organizationId: input.organizationId,
          actorUserId,
          attemptId: input.attemptId,
          connectionId: attempt.externalMcpConnectionId,
          status: snapshot.attempt.status,
          highestHealthLevel: snapshot.attempt.highestHealthLevel,
          firstFailedPhase: snapshot.attempt.firstFailedPhase,
        })
      }
    } catch (error) {
      console.error("mcp_diagnostic_recovery_audit_write_failed", {
        organizationId: input.organizationId,
        attemptId: input.attemptId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    }
  }
  return recovered
}

async function recoverAbandonedMcpDiagnosticAttemptsForOrganization(input: {
  organizationId: OrganizationId
  now: Date
}): Promise<void> {
  const active = await db
    .select({ id: McpDiagnosticAttemptTable.id, startedAt: McpDiagnosticAttemptTable.startedAt, executionLeaseExpiresAt: McpDiagnosticAttemptTable.executionLeaseExpiresAt })
    .from(McpDiagnosticAttemptTable)
    .where(and(
      eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
      inArray(McpDiagnosticAttemptTable.status, ACTIVE_ATTEMPT_STATUSES),
    ))
    .limit(100)
  for (const attempt of active) {
    if (!executionLeaseIsAbandoned(attempt, input.now)) continue
    await recoverAbandonedMcpDiagnosticAttempt({
      organizationId: input.organizationId,
      attemptId: attempt.id,
      now: input.now,
    })
  }
}

export async function createMcpDiagnosticAttempt(input: {
  organizationId: OrganizationId
  connectionId: ConnectionId
  createdByOrgMembershipId: MemberId
  now?: Date
}): Promise<McpDiagnosticAttempt> {
  const now = input.now ?? new Date()
  const id = createDenTypeId("mcpDiagnosticAttempt")
  const completionAuditEventId = createDenTypeId("auditEvent")
  await cleanupExpiredMcpDiagnostics(now)
  await recoverAbandonedMcpDiagnosticAttemptsForOrganization({ organizationId: input.organizationId, now })
  await db.transaction(async (tx) => {
    const organizations = await tx
      .select({ id: OrganizationTable.id })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId))
      .limit(1)
      .for("update")
    if (!organizations[0]) throw new Error("Unknown organization for MCP diagnostic attempt.")

    // Serialize start with connection deletion. If deletion wins, this row is
    // absent and no orphan diagnostic can be created. If start wins, deletion
    // waits and then removes the newly-created attempt in the same transaction.
    const connections = await tx
      .select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    if (!connections[0]) throw new Error("Unknown MCP connection for diagnostic attempt.")

    const activeOrganizationRows = await tx
      .select({ count: sql<number>`count(*)` })
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        inArray(McpDiagnosticAttemptTable.status, ACTIVE_ATTEMPT_STATUSES),
      ))
    const activeMemberRows = await tx
      .select({ count: sql<number>`count(*)` })
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.createdByOrgMembershipId, input.createdByOrgMembershipId),
        inArray(McpDiagnosticAttemptTable.status, ACTIVE_ATTEMPT_STATUSES),
      ))
    const rateWindowStart = new Date(now.getTime() - MCP_DIAGNOSTIC_RATE_WINDOW_MS)
    const organizationRateRows = await tx
      .select({ count: sql<number>`count(*)` })
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        gte(McpDiagnosticAttemptTable.startedAt, rateWindowStart),
      ))
    const memberRateRows = await tx
      .select({ count: sql<number>`count(*)` })
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.createdByOrgMembershipId, input.createdByOrgMembershipId),
        gte(McpDiagnosticAttemptTable.startedAt, rateWindowStart),
      ))

    if (Number(activeMemberRows[0]?.count ?? 0) >= MCP_DIAGNOSTIC_MAX_ACTIVE_PER_MEMBER) {
      throw new McpDiagnosticStartLimitError({ kind: "concurrency", scope: "member", retryAfterSeconds: 5 })
    }
    if (Number(activeOrganizationRows[0]?.count ?? 0) >= MCP_DIAGNOSTIC_MAX_ACTIVE_PER_ORGANIZATION) {
      throw new McpDiagnosticStartLimitError({ kind: "concurrency", scope: "organization", retryAfterSeconds: 5 })
    }
    const rateRetryAfterSeconds = Math.ceil(MCP_DIAGNOSTIC_RATE_WINDOW_MS / 1000)
    if (Number(memberRateRows[0]?.count ?? 0) >= MCP_DIAGNOSTIC_MAX_STARTS_PER_MEMBER_WINDOW) {
      throw new McpDiagnosticStartLimitError({ kind: "rate", scope: "member", retryAfterSeconds: rateRetryAfterSeconds })
    }
    if (Number(organizationRateRows[0]?.count ?? 0) >= MCP_DIAGNOSTIC_MAX_STARTS_PER_ORGANIZATION_WINDOW) {
      throw new McpDiagnosticStartLimitError({ kind: "rate", scope: "organization", retryAfterSeconds: rateRetryAfterSeconds })
    }

    await tx.insert(McpDiagnosticAttemptTable).values({
      id,
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
      completionAuditEventId,
      startedAt: now,
      expiresAt: new Date(now.getTime() + MCP_DIAGNOSTIC_RETENTION_MS),
    })
  })
  const row = await getMcpDiagnosticAttemptRow({ organizationId: input.organizationId, attemptId: id })
  if (!row) throw new Error("Failed to create MCP diagnostic attempt.")
  return toAttempt(row)
}

async function getMcpDiagnosticAttemptRow(input: { organizationId: OrganizationId; attemptId: AttemptId }) {
  const rows = await db
    .select()
    .from(McpDiagnosticAttemptTable)
    .where(and(
      eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
      eq(McpDiagnosticAttemptTable.id, input.attemptId),
    ))
    .limit(1)
  return rows[0] ?? null
}

export async function getMcpDiagnosticAttempt(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
}): Promise<McpDiagnosticAttempt | null> {
  const row = await getMcpDiagnosticAttemptRow(input)
  return row ? toAttempt(row) : null
}

export async function getMcpDiagnosticAttemptForCallback(attemptId: AttemptId) {
  const rows = await db
    .select()
    .from(McpDiagnosticAttemptTable)
    .where(eq(McpDiagnosticAttemptTable.id, attemptId))
    .limit(1)
  return rows[0] ?? null
}

export async function claimMcpDiagnosticExecutionLease(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  now?: Date
  leaseMs?: number
}): Promise<{ leaseId: string; leaseExpiresAt: Date } | null> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
      .limit(1)
      .for("update")
    const attempt = rows[0]
    if (
      !attempt
      || isTerminalAttemptStatus(attempt.status)
      || (attempt.executionLeaseId
        && attempt.executionLeaseExpiresAt
        && attempt.executionLeaseExpiresAt.getTime() > now.getTime())
    ) return null

    const leaseId = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? MCP_DIAGNOSTIC_EXECUTION_LEASE_MS))
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({ executionLeaseId: leaseId, executionLeaseExpiresAt: leaseExpiresAt })
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
    return { leaseId, leaseExpiresAt }
  })
}

export async function renewMcpDiagnosticExecutionLease(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  leaseId: string
  now?: Date
  leaseMs?: number
}): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(McpDiagnosticAttemptTable)
    .set({ executionLeaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? MCP_DIAGNOSTIC_EXECUTION_LEASE_MS)) })
    .where(and(
      eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
      eq(McpDiagnosticAttemptTable.id, input.attemptId),
      eq(McpDiagnosticAttemptTable.executionLeaseId, input.leaseId),
      inArray(McpDiagnosticAttemptTable.status, ACTIVE_ATTEMPT_STATUSES),
    ))
}

export async function releaseMcpDiagnosticExecutionLease(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  leaseId: string
}): Promise<void> {
  await db
    .update(McpDiagnosticAttemptTable)
    .set({ executionLeaseId: null, executionLeaseExpiresAt: null })
    .where(and(
      eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
      eq(McpDiagnosticAttemptTable.id, input.attemptId),
      eq(McpDiagnosticAttemptTable.executionLeaseId, input.leaseId),
    ))
}

/**
 * A completion audit id is allocated with the attempt. Both the background
 * runner and OAuth callback can therefore retry this write using the same
 * primary key, yielding one durable audit row across processes.
 */
export async function recordMcpDiagnosticCompletionAuditOnce(input: {
  organizationId: OrganizationId
  actorUserId: DenTypeId<"user">
  attemptId: AttemptId
  connectionId: ConnectionId
  status: McpDiagnosticAttemptStatus
  highestHealthLevel: McpDiagnosticHealthLevel
  firstFailedPhase: McpDiagnosticPhase | null
}): Promise<void> {
  let completionAuditEventId: AuditEventId | null = null
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
        eq(McpDiagnosticAttemptTable.externalMcpConnectionId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const attempt = rows[0]
    if (!attempt || !isTerminalAttemptStatus(attempt.status)) return
    completionAuditEventId = attempt.completionAuditEventId ?? createDenTypeId("auditEvent")
    if (!attempt.completionAuditEventId) {
      await tx
        .update(McpDiagnosticAttemptTable)
        .set({ completionAuditEventId })
        .where(and(
          eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
          eq(McpDiagnosticAttemptTable.id, input.attemptId),
          isNull(McpDiagnosticAttemptTable.completionAuditEventId),
        ))
    }
  })
  if (!completionAuditEventId) return
  await recordOrganizationAuditEvent({
    eventId: completionAuditEventId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: ORGANIZATION_AUDIT_ACTIONS.mcpDiagnosticCompleted,
    payload: {
      attemptId: input.attemptId,
      connectionId: input.connectionId,
      status: input.status,
      highestHealthLevel: input.highestHealthLevel,
      firstFailedPhase: input.firstFailedPhase,
    },
  })
}

export async function reserveMcpDiagnosticAuthorizationGeneration(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
}): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
      .limit(1)
      .for("update")
    const attempt = rows[0]
    if (!attempt || attempt.status !== "running") throw new McpDiagnosticAttemptClosedError()
    const generation = attempt.authorizationGeneration + 1
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({
        authorizationGeneration: generation,
        authorizationClaimId: null,
        authorizationLeaseExpiresAt: null,
      })
      .where(eq(McpDiagnosticAttemptTable.id, input.attemptId))
    return generation
  })
}

export async function claimMcpDiagnosticAuthorizationCallback(input: {
  organizationId: OrganizationId
  connectionId: ConnectionId
  attemptId: AttemptId
  createdByOrgMembershipId: MemberId
  generation: number
  now?: Date
  leaseMs?: number
}): Promise<{ leaseId: string; leaseExpiresAt: Date } | null> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
        eq(McpDiagnosticAttemptTable.externalMcpConnectionId, input.connectionId),
        eq(McpDiagnosticAttemptTable.createdByOrgMembershipId, input.createdByOrgMembershipId),
      ))
      .limit(1)
      .for("update")
    const attempt = rows[0]
    if (
      !attempt
      || attempt.status !== "waiting_for_authorization"
      || attempt.authorizationGeneration !== input.generation
      || attempt.expiresAt.getTime() <= now.getTime()
      || (attempt.authorizationClaimId
        && attempt.authorizationLeaseExpiresAt
        && attempt.authorizationLeaseExpiresAt.getTime() > now.getTime())
    ) return null

    const leaseId = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? MCP_DIAGNOSTIC_AUTHORIZATION_LEASE_MS))
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({ authorizationClaimId: leaseId, authorizationLeaseExpiresAt: leaseExpiresAt })
      .where(eq(McpDiagnosticAttemptTable.id, input.attemptId))
    return { leaseId, leaseExpiresAt }
  })
}

export type McpDiagnosticAuthorizationExpiryResult =
  | { status: "expired"; event: McpDiagnosticEvent }
  | { status: "claimed"; retryAt: Date }
  | { status: "terminal" }
  | { status: "not_eligible" }

export async function expireMcpDiagnosticAuthorizationIfEligible(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  generation: number
  now?: Date
}): Promise<McpDiagnosticAuthorizationExpiryResult> {
  const now = input.now ?? new Date()
  const eventId = createDenTypeId("mcpDiagnosticEvent")
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
      .limit(1)
      .for("update")
    const attempt = rows[0]
    if (!attempt) return { status: "not_eligible" as const }
    if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "expired") {
      return { status: "terminal" as const }
    }
    if (attempt.status !== "waiting_for_authorization" || attempt.authorizationGeneration !== input.generation) {
      return { status: "not_eligible" as const }
    }
    if (
      attempt.authorizationClaimId
      && attempt.authorizationLeaseExpiresAt
      && attempt.authorizationLeaseExpiresAt.getTime() > now.getTime()
    ) return { status: "claimed" as const, retryAt: attempt.authorizationLeaseExpiresAt }

    const sequence = attempt.lastSequence + 1
    await tx.insert(McpDiagnosticEventTable).values({
      id: eventId,
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      sequence,
      phase: "AUTH_USER_OR_WORKLOAD",
      outcome: "failed",
      elapsedMs: Math.max(0, now.getTime() - attempt.startedAt.getTime()),
      phaseDurationMs: null,
      healthLevel: "reachable",
      messageSafe: "The provider authorization window expired before a callback completed under an active lease.",
      category: "oauth_user_interaction",
      retryable: false,
      actionOwner: "member",
      operatorAction: "restart_provider_authorization",
      evidence: safeMcpDiagnosticEvidence(),
      occurredAt: now,
    })
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({
        status: "expired",
        lastSequence: sequence,
        highestHealthLevel: "reachable",
        firstFailedPhase: "AUTH_USER_OR_WORKLOAD",
        firstFailureCategory: "oauth_user_interaction",
        firstFailureMessage: "The provider authorization window expired before a callback completed under an active lease.",
        actionOwner: "member",
        operatorAction: "restart_provider_authorization",
        authorizationClaimId: null,
        authorizationLeaseExpiresAt: null,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        completedAt: now,
      })
      .where(eq(McpDiagnosticAttemptTable.id, input.attemptId))
    const events = await tx
      .select()
      .from(McpDiagnosticEventTable)
      .where(eq(McpDiagnosticEventTable.id, eventId))
      .limit(1)
    if (!events[0]) throw new Error("Failed to persist the expired MCP diagnostic event.")
    return { status: "expired" as const, event: toEvent(events[0]) }
  })
}

export async function getMcpDiagnosticAdminActorUserId(input: {
  organizationId: OrganizationId
  memberId: MemberId
}): Promise<DenTypeId<"user"> | null> {
  const rows = await db
    .select({ userId: MemberTable.userId, role: MemberTable.role })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      eq(MemberTable.id, input.memberId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const member = rows[0]
  if (!member?.userId || !roleIncludesPrivileged(member.role)) return null
  return member.userId
}

function healthRank(level: McpDiagnosticHealthLevel): number {
  return MCP_DIAGNOSTIC_HEALTH_LEVELS.indexOf(level) + 1
}

export async function appendMcpDiagnosticEvent(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  phase: McpDiagnosticPhase
  outcome: McpDiagnosticEventOutcome
  healthLevel: McpDiagnosticHealthLevel
  messageSafe: string
  phaseDurationMs?: number | null
  category?: string | null
  retryable?: boolean | null
  actionOwner?: McpDiagnosticActionOwner | null
  operatorAction?: string | null
  evidence?: McpDiagnosticSafeEvidence
  attemptStatus?: McpDiagnosticAttemptStatus
  now?: Date
}): Promise<McpDiagnosticEvent> {
  const occurredAt = input.now ?? new Date()
  const eventId = createDenTypeId("mcpDiagnosticEvent")

  return db.transaction(async (tx) => {
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({ lastSequence: sql`${McpDiagnosticAttemptTable.lastSequence} + 1` })
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))

    const rows = await tx
      .select()
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
      .limit(1)
    const attempt = rows[0]
    if (!attempt || attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "expired") {
      throw new McpDiagnosticAttemptClosedError()
    }

    const elapsedMs = Math.max(0, occurredAt.getTime() - attempt.startedAt.getTime())
    await tx.insert(McpDiagnosticEventTable).values({
      id: eventId,
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      sequence: attempt.lastSequence,
      phase: input.phase,
      outcome: input.outcome,
      elapsedMs,
      phaseDurationMs: input.phaseDurationMs ?? null,
      healthLevel: input.healthLevel,
      messageSafe: input.messageSafe.slice(0, 512),
      category: input.category ?? null,
      retryable: input.retryable ?? null,
      actionOwner: input.actionOwner ?? null,
      operatorAction: input.operatorAction ?? null,
      evidence: input.evidence ?? safeMcpDiagnosticEvidence(),
      occurredAt,
    })

    const terminal = input.attemptStatus === "succeeded"
      || input.attemptStatus === "failed"
      || input.attemptStatus === "expired"
    await tx
      .update(McpDiagnosticAttemptTable)
      .set({
        highestHealthLevel: sql`case when field(${McpDiagnosticAttemptTable.highestHealthLevel}, 'configured', 'reachable', 'authorized', 'protocol_ready', 'catalog_ready') < ${healthRank(input.healthLevel)} then ${input.healthLevel} else ${McpDiagnosticAttemptTable.highestHealthLevel} end`,
        ...(input.attemptStatus ? { status: input.attemptStatus } : {}),
        ...(terminal ? { completedAt: occurredAt } : {}),
        ...(terminal
          ? {
              authorizationClaimId: null,
              authorizationLeaseExpiresAt: null,
              executionLeaseId: null,
              executionLeaseExpiresAt: null,
            }
          : {}),
      })
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))

    if (input.outcome === "failed") {
      await tx
        .update(McpDiagnosticAttemptTable)
        .set({
          firstFailedPhase: input.phase,
          firstFailureCategory: input.category ?? "mcp_connection_failure",
          firstFailureMessage: input.messageSafe.slice(0, 512),
          actionOwner: input.actionOwner ?? "provider_admin",
          operatorAction: input.operatorAction ?? "inspect_provider_and_den_logs",
          status: input.attemptStatus ?? "failed",
          authorizationClaimId: null,
          authorizationLeaseExpiresAt: null,
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          completedAt: occurredAt,
        })
        .where(and(
          eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
          eq(McpDiagnosticAttemptTable.id, input.attemptId),
          isNull(McpDiagnosticAttemptTable.firstFailedPhase),
        ))
    }

    const eventRows = await tx
      .select()
      .from(McpDiagnosticEventTable)
      .where(eq(McpDiagnosticEventTable.id, eventId))
      .limit(1)
    const event = eventRows[0]
    if (!event) throw new Error("Failed to append MCP diagnostic event.")
    return toEvent(event)
  })
}

export async function failMcpDiagnosticAttempt(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
  phase: McpDiagnosticPhase
  healthLevel: McpDiagnosticHealthLevel
  error: unknown
  phaseDurationMs?: number | null
  url?: string | URL
  evidence?: McpDiagnosticSafeEvidence
}): Promise<McpDiagnosticEvent> {
  const failure = classifyMcpDiagnosticFailure(input.error, input.phase)
  const baseEvidence = input.evidence ?? safeMcpDiagnosticEvidence({ url: input.url })
  return appendMcpDiagnosticEvent({
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    phase: input.phase,
    outcome: "failed",
    healthLevel: input.healthLevel,
    messageSafe: failure.messageSafe,
    category: failure.category,
    retryable: failure.retryable,
    actionOwner: failure.actionOwner,
    operatorAction: failure.operatorAction,
    phaseDurationMs: input.phaseDurationMs,
    evidence: {
      ...baseEvidence,
      ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
      detailsRedacted: true,
    },
    attemptStatus: "failed",
  })
}

export async function getMcpDiagnosticSnapshot(input: {
  organizationId: OrganizationId
  attemptId: AttemptId
}): Promise<McpDiagnosticSnapshot | null> {
  const attempt = await getMcpDiagnosticAttemptRow(input)
  if (!attempt) return null
  if (attempt.expiresAt.getTime() <= Date.now()) {
    await db.transaction(async (tx) => {
      await tx.delete(McpDiagnosticEventTable).where(eq(McpDiagnosticEventTable.attemptId, input.attemptId))
      await tx.delete(McpDiagnosticAttemptTable).where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.id, input.attemptId),
      ))
    })
    return null
  }
  const events = await db
    .select()
    .from(McpDiagnosticEventTable)
    .where(and(
      eq(McpDiagnosticEventTable.organizationId, input.organizationId),
      eq(McpDiagnosticEventTable.attemptId, input.attemptId),
    ))
    .orderBy(asc(McpDiagnosticEventTable.sequence))
  return { attempt: toAttempt(attempt), events: events.map(toEvent) }
}
