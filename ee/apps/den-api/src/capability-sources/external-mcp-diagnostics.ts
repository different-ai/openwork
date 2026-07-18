import { createHash } from "node:crypto"
import { PrivateUrlError } from "./url-guard.js"

export const EXTERNAL_MCP_DIAGNOSTIC_PHASES = [
  "CONFIGURATION",
  "NETWORK_DNS",
  "NETWORK_TCP",
  "NETWORK_TLS",
  "HTTP_ROUTING",
  "AUTH_RESOURCE_DISCOVERY",
  "AUTH_ISSUER_DISCOVERY",
  "AUTH_CLIENT_REGISTRATION",
  "AUTH_USER_OR_WORKLOAD",
  "AUTH_TOKEN_ACQUISITION",
  "AUTH_RESOURCE_VALIDATION",
  "MCP_TRANSPORT",
  "MCP_VERSION",
  "MCP_INITIALIZE",
  "MCP_INITIALIZED",
  "MCP_TOOL_DISCOVERY",
  "MCP_TOOL_EXECUTION",
  "PROVIDER_AUTHORIZATION",
  "PROVIDER_EXECUTION",
  "CONTINUITY_REFRESH",
  "CONTINUITY_SESSION",
  "SHUTDOWN",
] as const

export type ExternalMcpDiagnosticPhase = (typeof EXTERNAL_MCP_DIAGNOSTIC_PHASES)[number]

export type ExternalMcpHealthLevel =
  | "configured"
  | "reachable"
  | "authorized"
  | "protocol_ready"
  | "catalog_ready"
  | "operation_ready"

export type ExternalMcpDiagnostic = {
  referenceId: string
  phase: ExternalMcpDiagnosticPhase
  category: string
  code: string
  highestPassed: ExternalMcpHealthLevel
  retryable: boolean
  actionOwner: "openwork" | "network_admin" | "provider_admin" | "organization_admin" | "member"
  operatorAction: string
  message: string
  httpStatus?: number
  operationPhase?: ExternalMcpDiagnosticPhase
  outbound?: ExternalMcpSafeOutbound
  providerRequestId?: string
  providerStatus?: number
  providerCode?: string
  payloadBytes?: number
  jsonRpcCode?: number
}

export type ExternalMcpSafeOutbound = {
  origin: string
  pathHash: string
}

export type ExternalMcpSafeCause = {
  name: string
  code?: string
  errno?: string | number
  syscall?: string
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

// JSON MCP responses are expected to be compact. Event streams need more
// headroom because a single request can carry multiple protocol messages, but
// still need an absolute byte ceiling so a provider cannot grow Den memory
// without bound.
export const EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024
export const EXTERNAL_MCP_SSE_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024

export class ExternalMcpLifecycleDeadlineError extends Error {
  constructor() {
    super("External MCP lifecycle deadline exceeded.")
    this.name = "ExternalMcpLifecycleDeadlineError"
  }
}

class ExternalMcpResponseBodyLimitError extends Error {
  constructor() {
    super("External MCP response body exceeded its byte limit.")
    this.name = "ExternalMcpResponseBodyLimitError"
  }
}

const HEALTH_RANK: Record<ExternalMcpHealthLevel, number> = {
  configured: 0,
  reachable: 1,
  authorized: 2,
  protocol_ready: 3,
  catalog_ready: 4,
  operation_ready: 5,
}

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])

const TCP_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
])

const SAFE_NATIVE_ERROR_CODES = new Set([
  ...TLS_ERROR_CODES,
  ...TCP_ERROR_CODES,
  "ENOTFOUND",
  "EAI_AGAIN",
  "ConnectionRefused",
  "ConnectionReset",
  "ConnectionTimedOut",
  "Timeout",
])

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "AggregateError",
  "AbortError",
  "FetchError",
  "McpError",
  "UnauthorizedError",
  "InvalidClientError",
  "UnauthorizedClientError",
  "InvalidClientMetadataError",
  "InvalidGrantError",
  "InvalidRequestError",
  "InvalidScopeError",
  "InvalidTargetError",
  "InvalidTokenError",
  "InsufficientScopeError",
  "MethodNotAllowedError",
  "TooManyRequestsError",
  "UnsupportedTokenTypeError",
  "AccessDeniedError",
  "UnsupportedGrantTypeError",
  "UnsupportedResponseTypeError",
  "TemporarilyUnavailableError",
  "ServerError",
])

const SAFE_PROVIDER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
const SAFE_PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/
const PROVIDER_STATUS_FIELDS = ["status", "statusCode", "httpStatus"]
const PROVIDER_CODE_FIELDS = ["code", "error"]
const PROVIDER_REQUEST_ID_FIELDS = ["requestId", "request_id", "transactionId", "transaction_id"]

const TYPED_OAUTH_ERROR_NAMES = new Set([
  "InvalidClientError",
  "UnauthorizedClientError",
  "InvalidClientMetadataError",
  "InvalidGrantError",
  "InvalidRequestError",
  "InvalidScopeError",
  "InvalidTargetError",
  "InvalidTokenError",
  "InsufficientScopeError",
  "MethodNotAllowedError",
  "TooManyRequestsError",
  "UnsupportedTokenTypeError",
  "AccessDeniedError",
  "UnsupportedGrantTypeError",
  "UnsupportedResponseTypeError",
  "TemporarilyUnavailableError",
  "ServerError",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const property = value[key]
  return typeof property === "string" ? property : undefined
}

function stringOrNumberProperty(value: unknown, key: string): string | number | undefined {
  if (!isRecord(value)) return undefined
  const property = value[key]
  return typeof property === "string" || typeof property === "number" ? property : undefined
}

function errorCause(value: unknown): unknown {
  return isRecord(value) ? value.cause : undefined
}

function errorCode(value: unknown): string | undefined {
  let current: unknown = value
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = stringProperty(current, "code")
    if (code) return code
    current = errorCause(current)
  }
  return undefined
}

function numericErrorCode(value: unknown): number | undefined {
  let current: unknown = value
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = isRecord(current) ? current.code : undefined
    // MCP/JSON-RPC protocol errors use negative integer codes. Positive
    // values on SDK errors are commonly HTTP statuses and are already
    // represented by httpStatus, so do not mislabel them as JSON-RPC.
    if (typeof code === "number" && Number.isSafeInteger(code) && code < 0) return code
    current = errorCause(current)
  }
  return undefined
}

function safeNativeToken(value: string | undefined, pattern: RegExp, maxLength = 64): string | undefined {
  if (!value || value.length > maxLength || !pattern.test(value)) return undefined
  return value
}

function safeProviderToken(value: unknown, maxLength = 64): string | undefined {
  return typeof value === "string" ? safeNativeToken(value, SAFE_PROVIDER_TOKEN_PATTERN, maxLength) : undefined
}

function safeProviderRequestId(value: unknown): string | undefined {
  return typeof value === "string" ? safeNativeToken(value, SAFE_PROVIDER_REQUEST_ID_PATTERN, 128) : undefined
}

function validProviderStatus(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 400 || value > 599) return undefined
  return value
}

function providerStatusFromRecord(value: Record<string, unknown>): number | undefined {
  for (const field of PROVIDER_STATUS_FIELDS) {
    const status = validProviderStatus(value[field])
    if (status !== undefined) return status
  }
  return undefined
}

function providerCodeFromRecord(value: Record<string, unknown>): string | undefined {
  for (const field of PROVIDER_CODE_FIELDS) {
    const code = safeProviderToken(value[field])
    if (code) return code
  }
  return undefined
}

function providerRequestIdFromRecord(value: Record<string, unknown>): string | undefined {
  for (const field of PROVIDER_REQUEST_ID_FIELDS) {
    const requestId = safeProviderRequestId(value[field])
    if (requestId) return requestId
  }
  return undefined
}

function providerStatusFromLeadingText(value: string): number | undefined {
  const text = value.trimStart()
  const statusMatch = /^(?:HTTP[ /])?([45]\d\d)\b/.exec(text) ?? /^([45]\d\d)\s+[A-Za-z]/.exec(text)
  const statusText = statusMatch?.[1]
  if (!statusText) return undefined
  return validProviderStatus(Number(statusText))
}

function parsedTextRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function providerToolContentArray(result: unknown): unknown[] | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null
  return result.content
}

function isProviderToolTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string"
}

function serializedContentPayloadBytes(content: unknown[] | null): number {
  if (!content || content.length === 0) return 0
  try {
    const serialized = JSON.stringify(content)
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : 0
  } catch {
    return 0
  }
}

function sanitizedProviderToolExcerpt(texts: string[]): string | undefined {
  const sanitized = texts
    .join("\n")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!sanitized) return undefined
  return sanitized.length > 512 ? sanitized.slice(0, 512) : sanitized
}

type ProviderToolContentEvidence = {
  providerStatus?: number
  providerCode?: string
  providerRequestId?: string
  payloadBytes: number
  excerpt?: string
}

function providerToolContentEvidence(result: unknown): ProviderToolContentEvidence {
  const content = providerToolContentArray(result)
  const payloadBytes = serializedContentPayloadBytes(content)
  if (!content) return { payloadBytes }

  let providerStatus: number | undefined
  let providerCode: string | undefined
  let providerRequestId: string | undefined
  const texts: string[] = []

  for (const item of content) {
    if (!isProviderToolTextContent(item)) continue
    texts.push(item.text)
    const parsed = parsedTextRecord(item.text)
    if (parsed) {
      providerStatus ??= providerStatusFromRecord(parsed)
      providerCode ??= providerCodeFromRecord(parsed)
      providerRequestId ??= providerRequestIdFromRecord(parsed)
    }
    providerStatus ??= providerStatusFromLeadingText(item.text)
  }

  const excerpt = sanitizedProviderToolExcerpt(texts)
  return {
    payloadBytes,
    ...(providerStatus === undefined ? {} : { providerStatus }),
    ...(providerCode ? { providerCode } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(excerpt ? { excerpt } : {}),
  }
}

function isProviderInputValidationExcerpt(value: string | undefined): boolean {
  if (!value) return false
  return /^Input validation error:\s*Invalid arguments for tool\b/i.test(value)
    || /^Invalid (?:tool )?(?:arguments|params)\b/i.test(value)
}

function errorName(value: unknown): string {
  const name = value instanceof Error ? value.name : stringProperty(value, "name")
  return name && SAFE_ERROR_NAMES.has(name) ? name : "Error"
}

function hasUnsupportedVersionMessage(value: unknown): boolean {
  let current: unknown = value
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    const message = current instanceof Error ? current.message : stringProperty(current, "message")
    if (message && message.length <= 1_000) {
      const normalized = message.toLowerCase()
      if (
        (normalized.includes("protocol version") || normalized.includes("mcp version"))
        && (normalized.includes("unsupported") || normalized.includes("not supported") || normalized.includes("incompatible"))
      ) return true
    }
    current = errorCause(current)
  }
  return false
}

function hasForbiddenPortMessage(value: unknown): boolean {
  const outerMessage = value instanceof Error ? value.message : stringProperty(value, "message")
  const outerName = value instanceof Error ? value.name : stringProperty(value, "name")
  if (outerName !== "TypeError" || outerMessage?.toLowerCase() !== "fetch failed") return false

  let current: unknown = errorCause(value)
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    const message = current instanceof Error ? current.message : stringProperty(current, "message")
    if (message && ["bad port", "forbidden port"].includes(message.trim().toLowerCase())) return true
    current = errorCause(current)
  }
  return false
}

export function safeExternalMcpCauseChain(error: unknown): ExternalMcpSafeCause[] {
  const causes: ExternalMcpSafeCause[] = []
  let current: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    const rawCode = stringProperty(current, "code")
    const code = rawCode && SAFE_NATIVE_ERROR_CODES.has(rawCode) ? rawCode : undefined
    const errno = stringOrNumberProperty(current, "errno")
    const safeErrno = typeof errno === "number" && Number.isSafeInteger(errno)
      ? errno
      : typeof errno === "string"
        ? safeNativeToken(errno, /^-?\d+$/, 16)
        : undefined
    const syscall = safeNativeToken(stringProperty(current, "syscall"), /^(connect|read|write|getaddrinfo|lookup|request)$/)
    causes.push({
      name: errorName(current),
      ...(code ? { code } : {}),
      ...(safeErrno !== undefined ? { errno: safeErrno } : {}),
      ...(syscall ? { syscall } : {}),
    })
    current = errorCause(current)
  }
  return causes
}

function safeMessageFor(input: {
  phase: ExternalMcpDiagnosticPhase
  category: string
  code: string
  providerStatus?: number
  providerCode?: string
}): string {
  const message = safeBaseMessageFor(input)
  const details = [
    ...(input.providerStatus === undefined ? [] : [`provider status ${input.providerStatus}`]),
    ...(input.providerCode ? [`code ${input.providerCode}`] : []),
  ]
  return details.length === 0 ? message : `${message} Provider evidence: ${details.join(", ")}.`
}

function safeBaseMessageFor(input: {
  phase: ExternalMcpDiagnosticPhase
  category: string
  code: string
}): string {
  if (input.code === "MCP_LIFECYCLE_DEADLINE") {
    return "The MCP lifecycle exceeded OpenWork's bounded diagnostic deadline."
  }
  if (input.code === "MCP_REQUEST_TIMEOUT") {
    return "The MCP server did not answer the current protocol request within its bounded timeout."
  }
  if (input.code === "MCP_RESPONSE_BODY_LIMIT") {
    return "The MCP server returned a response body larger than OpenWork can safely process."
  }
  if (input.category === "security_blocked") {
    return "Den blocked the MCP URL because it violates the outbound network safety policy."
  }
  if (input.code === "MCP_FETCH_FORBIDDEN_PORT") {
    return "The MCP URL uses a port that server-side HTTP clients are not permitted to access."
  }
  if (input.phase === "NETWORK_DNS") {
    return "Den could not resolve the MCP host from its server network."
  }
  if (input.phase === "NETWORK_TCP") {
    return "Den resolved the MCP host but could not establish a network connection."
  }
  if (input.phase === "NETWORK_TLS") {
    return "Den reached the MCP host but could not verify or complete TLS."
  }
  if (input.phase === "AUTH_RESOURCE_DISCOVERY") {
    return "The MCP endpoint did not provide usable protected-resource metadata."
  }
  if (input.phase === "AUTH_ISSUER_DISCOVERY") {
    return "The authorization server did not provide usable OAuth metadata."
  }
  if (input.phase === "AUTH_CLIENT_REGISTRATION") {
    return "OpenWork could not register or identify its OAuth client with the authorization server."
  }
  if (input.phase === "AUTH_TOKEN_ACQUISITION" || input.phase === "CONTINUITY_REFRESH") {
    return "The authorization server rejected the code or token refresh exchange."
  }
  if (input.phase === "AUTH_USER_OR_WORKLOAD") {
    return input.code === "MCP_OAUTH_ACCESS_DENIED"
      ? "The provider did not grant authorization for this MCP connection."
      : "The provider rejected the authorization request before issuing a code."
  }
  if (input.phase === "AUTH_RESOURCE_VALIDATION") {
    return "The MCP resource rejected the supplied authorization."
  }
  if (input.phase === "MCP_VERSION") {
    return "The MCP client and server could not agree on a supported protocol version."
  }
  if (input.phase === "MCP_INITIALIZE" || input.phase === "MCP_INITIALIZED") {
    return "The MCP lifecycle failed during initialization."
  }
  if (input.phase === "MCP_TOOL_DISCOVERY") {
    return input.code === "MCP_CATALOG_CURSOR_LOOP"
      ? "The MCP server repeated a tool-catalog cursor, so OpenWork stopped safely."
      : "OpenWork could not retrieve a complete, valid MCP tool catalog."
  }
  if (input.phase === "MCP_TOOL_EXECUTION" || input.phase === "PROVIDER_EXECUTION") {
    return "The MCP connection is established, but the requested provider operation failed."
  }
  if (input.phase === "PROVIDER_AUTHORIZATION") {
    return "The MCP connection is established, but provider policy denied the requested operation."
  }
  if (input.phase === "CONTINUITY_SESSION") {
    return "The MCP session expired or was rejected and must be initialized again."
  }
  if (input.phase === "HTTP_ROUTING") {
    return "Den reached the host, but the configured path did not behave like the intended MCP endpoint."
  }
  return "The MCP connection failed before OpenWork could complete the protocol lifecycle."
}

type Classification = Omit<ExternalMcpDiagnostic, "referenceId" | "highestPassed" | "message">

function logProviderToolEvidence(input: {
  referenceId: string
  evidence: ProviderToolContentEvidence
  diagnosticCode: string
  providerStatus?: number
  providerCode?: string
  providerRequestId?: string
}): void {
  if (!input.evidence.excerpt) return
  console.error("external_mcp_provider_tool_evidence", {
    referenceId: input.referenceId,
    diagnosticCode: input.diagnosticCode,
    excerpt: input.evidence.excerpt,
    payloadBytes: input.evidence.payloadBytes,
    ...(input.providerStatus === undefined ? {} : { providerStatus: input.providerStatus }),
    ...(input.providerCode ? { providerCode: input.providerCode } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
  })
}

function httpClassification(input: {
  phase: ExternalMcpDiagnosticPhase
  status: number
  hasAuthorization: boolean
  bearerChallenge: boolean
  insufficientScope: boolean
  hasSession: boolean
  contentType: string
}): Classification | null {
  const { phase, status } = input
  if (status === 404 && input.hasSession) {
    return {
      phase: "CONTINUITY_SESSION",
      category: "mcp_session_expired",
      code: "MCP_SESSION_NOT_FOUND",
      retryable: true,
      actionOwner: "openwork",
      operatorAction: "Reinitialize the MCP session, then retry the operation once.",
    }
  }
  if (status === 404 && phase.startsWith("MCP_")) {
    return {
      phase: "HTTP_ROUTING",
      category: "endpoint_not_found",
      code: "MCP_HTTP_404",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Verify the complete MCP endpoint path, including any provider tenant or instance prefix.",
    }
  }
  if ((status === 406 || status === 415) && phase.startsWith("MCP_")) {
    return {
      phase: "MCP_TRANSPORT",
      category: "mcp_transport_negotiation",
      code: `MCP_HTTP_${status}`,
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Verify Streamable HTTP content negotiation and the provider's supported MCP transport.",
    }
  }
  if (status === 429) {
    return {
      phase,
      category: "provider_throttled",
      code: "MCP_HTTP_429",
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Wait for the provider rate limit to reset, then retry with bounded backoff.",
    }
  }
  if (status >= 500) {
    return {
      phase,
      category: "provider_unavailable",
      code: `MCP_HTTP_${status}`,
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Check provider availability and reverse-proxy logs using the diagnostic reference, then retry.",
    }
  }
  if ((status === 401 || status === 403) && phase.startsWith("MCP_") && input.hasAuthorization) {
    // A 401 is itself an authentication challenge. A 403 is ambiguous for
    // enterprise providers: only a Bearer/insufficient_scope challenge means
    // token validation; an ordinary tools/* 403 is usually an ACL/role denial.
    if (status === 401 || input.bearerChallenge || input.insufficientScope) {
      return {
        phase: "AUTH_RESOURCE_VALIDATION",
        category: input.insufficientScope ? "oauth_insufficient_scope" : "oauth_resource_rejected",
        code: input.insufficientScope ? "MCP_OAUTH_INSUFFICIENT_SCOPE" : `MCP_OAUTH_HTTP_${status}`,
        retryable: status === 401,
        actionOwner: input.insufficientScope ? "organization_admin" : "member",
        operatorAction: input.insufficientScope
          ? "Grant the provider scopes required by this MCP resource and reconnect."
          : "Reconnect the provider account and verify token audience, tenant, and resource binding.",
      }
    }
    if (status === 403 && (phase === "MCP_TOOL_DISCOVERY" || phase === "MCP_TOOL_EXECUTION")) {
      return {
        phase: "PROVIDER_AUTHORIZATION",
        category: "provider_policy_denied",
        code: "MCP_PROVIDER_HTTP_403",
        retryable: false,
        actionOwner: "provider_admin",
        operatorAction: "Grant the provider role, ACL, or application permission required for this operation.",
      }
    }
  }
  if (status >= 400) {
    return {
      phase,
      category: "http_failure",
      code: `MCP_HTTP_${status}`,
      retryable: status === 408,
      actionOwner: "provider_admin",
      operatorAction: "Inspect provider and proxy logs for the failing HTTP request using the diagnostic reference.",
    }
  }
  if (phase.startsWith("MCP_") && input.contentType === "text/html") {
    return {
      phase: "HTTP_ROUTING",
      category: "unexpected_html",
      code: "MCP_HTTP_HTML_RESPONSE",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Verify the MCP path is not a sign-in page, portal route, or proxy-generated HTML response.",
    }
  }
  if (phase === "MCP_INITIALIZED" && (status === 202 || status === 204)) return null
  if (phase.startsWith("MCP_") && input.contentType !== "application/json" && input.contentType !== "text/event-stream") {
    return {
      phase: "MCP_TRANSPORT",
      category: "unexpected_content_type",
      code: "MCP_HTTP_CONTENT_TYPE",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Return an MCP JSON or event-stream response with a standards-compliant Content-Type header.",
    }
  }
  return null
}

function classifyByCode(code: string): Classification | null {
  if (code === "MCP_OAUTH_AUTHORIZATION_ID_REQUIRED") {
    return {
      phase: "CONFIGURATION",
      category: "oauth_authorization_transaction_invalid",
      code,
      retryable: false,
      actionOwner: "openwork",
      operatorAction: "Start OAuth through Den so the callback is bound to a signed, expiring authorization transaction.",
    }
  }
  if (code === "MCP_OAUTH_AUTHORIZATION_MISSING" || code === "MCP_OAUTH_AUTHORIZATION_EXPIRED") {
    return {
      phase: "AUTH_TOKEN_ACQUISITION",
      category: "oauth_authorization_transaction_expired",
      code,
      retryable: true,
      actionOwner: "member",
      operatorAction: "Start Connect again and complete provider authorization before the signed transaction expires.",
    }
  }
  if (code === "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED") {
    return {
      phase: "AUTH_CLIENT_REGISTRATION",
      category: "oauth_client_registration_changed",
      code,
      retryable: true,
      actionOwner: "organization_admin",
      operatorAction: "Retry Connect using the OAuth client registration that won the concurrent update.",
    }
  }
  if (code === "MCP_OAUTH_CLIENT_EXPIRED") {
    return {
      phase: "AUTH_CLIENT_REGISTRATION",
      category: "oauth_client_registration_expired",
      code,
      retryable: true,
      actionOwner: "organization_admin",
      operatorAction: "Renew the provider client secret or client registration, then start Connect again.",
    }
  }
  if (code === "MCP_OAUTH_CREDENTIAL_EXPIRED") {
    return {
      phase: "CONTINUITY_REFRESH",
      category: "oauth_credential_expired",
      code,
      retryable: true,
      actionOwner: "member",
      operatorAction: "Reconnect the provider account because the access token expired without a usable refresh token.",
    }
  }
  if (code === "MCP_OAUTH_CREDENTIAL_CHANGED") {
    return {
      phase: "CONTINUITY_REFRESH",
      category: "oauth_credential_changed",
      code,
      retryable: true,
      actionOwner: "openwork",
      operatorAction: "Retry with the newer OAuth credential after the concurrent refresh completes.",
    }
  }
  if (code === "MCP_OAUTH_CONFIGURATION_REQUIRED") {
    return {
      phase: "AUTH_CLIENT_REGISTRATION",
      category: "oauth_configuration_required",
      code,
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Create a provider OAuth application, allowlist the shared callback, and save its client ID and optional secret before reconnecting.",
    }
  }
  if (code === "MCP_OAUTH_ISSUER_MISMATCH") {
    return {
      phase: "AUTH_ISSUER_DISCOVERY",
      category: "oauth_issuer_mismatch",
      code,
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Repeat requirements discovery and select an authorization server advertised by the protected resource.",
    }
  }
  if (code === "MCP_OAUTH_PERSISTENCE_INVALID") {
    return {
      phase: "CONFIGURATION",
      category: "oauth_persistence_invalid",
      code,
      retryable: false,
      actionOwner: "openwork",
      operatorAction: "Inspect the encrypted OAuth record and adapter validation using the diagnostic reference.",
    }
  }
  if (code === "MCP_LIFECYCLE_DEADLINE") {
    return {
      phase: "CONTINUITY_REFRESH",
      category: "lifecycle_deadline",
      code,
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Retry after provider latency allows the credential transaction to commit within its lifecycle deadline.",
    }
  }
  if (
    code === "MCP_TOOL_ARGUMENT_SIZE_LIMIT"
    || code === "MCP_TOOL_ARGUMENT_DEPTH_LIMIT"
    || code === "MCP_TOOL_ARGUMENT_CYCLE"
    || code === "MCP_TOOL_ARGUMENT_INVALID_JSON"
  ) {
    return {
      phase: "CONFIGURATION",
      category: "mcp_tool_input_invalid",
      code,
      retryable: false,
      actionOwner: "openwork",
      operatorAction: "Correct and bound the tool arguments before attempting the provider operation again.",
    }
  }
  const normalizedCode = code === "ConnectionRefused"
    ? "ECONNREFUSED"
    : code === "ConnectionReset"
      ? "ECONNRESET"
      : code === "ConnectionTimedOut" || code === "Timeout"
        ? "ETIMEDOUT"
        : code
  if (normalizedCode === "ENOTFOUND" || normalizedCode === "EAI_AGAIN") {
    return {
      phase: "NETWORK_DNS",
      category: "dns_failure",
      code: `MCP_${normalizedCode}`,
      retryable: normalizedCode === "EAI_AGAIN",
      actionOwner: "network_admin",
      operatorAction: "Verify DNS resolution and Den egress for the MCP host.",
    }
  }
  if (TLS_ERROR_CODES.has(normalizedCode)) {
    return {
      phase: "NETWORK_TLS",
      category: "tls_failure",
      code: `MCP_${normalizedCode}`,
      retryable: false,
      actionOwner: "network_admin",
      operatorAction: "Verify the provider certificate chain, hostname, and Den trust store.",
    }
  }
  if (TCP_ERROR_CODES.has(normalizedCode)) {
    return {
      phase: "NETWORK_TCP",
      category: "network_failure",
      code: `MCP_${normalizedCode}`,
      retryable: normalizedCode === "ECONNRESET" || normalizedCode === "ETIMEDOUT" || normalizedCode.startsWith("UND_ERR_"),
      actionOwner: "network_admin",
      operatorAction: "Verify provider allowlists, firewall rules, proxy requirements, and service availability from Den.",
    }
  }
  return null
}

function classifyError(error: unknown, fallbackPhase: ExternalMcpDiagnosticPhase): Classification {
  if (error instanceof ExternalMcpLifecycleDeadlineError) {
    return {
      phase: fallbackPhase,
      category: "lifecycle_deadline",
      code: "MCP_LIFECYCLE_DEADLINE",
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Reduce provider latency or catalog pagination so the complete MCP lifecycle finishes within the bounded deadline, then retry.",
    }
  }
  if (error instanceof ExternalMcpResponseBodyLimitError) {
    return {
      phase: fallbackPhase,
      category: "response_too_large",
      code: "MCP_RESPONSE_BODY_LIMIT",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Reduce the provider response size, tool catalog, or event-stream payload before retrying.",
    }
  }
  if (error instanceof PrivateUrlError) {
    return {
      phase: "CONFIGURATION",
      category: "security_blocked",
      code: "MCP_URL_BLOCKED",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Use a public HTTPS MCP URL or change the deployment's private-network policy through security review.",
    }
  }
  if (hasForbiddenPortMessage(error)) {
    return {
      phase: "CONFIGURATION",
      category: "unsupported_endpoint_port",
      code: "MCP_FETCH_FORBIDDEN_PORT",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Use the provider's supported HTTPS MCP port or place the endpoint behind a standard HTTPS listener.",
    }
  }

  const code = errorCode(error)
  if (code) {
    const classified = classifyByCode(code)
    if (classified) return classified
  }

  if (numericErrorCode(error) === -32001) {
    return {
      phase: fallbackPhase,
      category: "request_timeout",
      code: "MCP_REQUEST_TIMEOUT",
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Check provider latency and retry after the current MCP request can complete within its bounded timeout.",
    }
  }
  if (numericErrorCode(error) === -32602 && fallbackPhase === "MCP_TOOL_EXECUTION") {
    return {
      phase: "MCP_TOOL_EXECUTION",
      category: "mcp_tool_input_invalid",
      code: "MCP_INVALID_PARAMS",
      retryable: false,
      actionOwner: "openwork",
      operatorAction: "Correct the tool arguments using the latest advertised input schema; do not retry the same arguments unchanged.",
    }
  }

  const name = errorName(error)
  if (name === "InvalidClientError" || name === "UnauthorizedClientError" || name === "InvalidClientMetadataError") {
    return {
      phase: "AUTH_CLIENT_REGISTRATION",
      category: "oauth_client_registration",
      code: "MCP_OAUTH_CLIENT_REJECTED",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Verify the client registration, redirect URI, client type, and token endpoint authentication method.",
    }
  }
  if (name === "InvalidGrantError") {
    return {
      phase: fallbackPhase === "CONTINUITY_REFRESH" ? fallbackPhase : "AUTH_TOKEN_ACQUISITION",
      category: "oauth_token_failure",
      code: "MCP_OAUTH_INVALID_GRANT",
      retryable: false,
      actionOwner: "member",
      operatorAction: "Restart authorization; if it repeats, verify redirect URI and PKCE state.",
    }
  }
  if (name === "InvalidScopeError") {
    return {
      phase: "AUTH_USER_OR_WORKLOAD",
      category: "oauth_invalid_scope",
      code: "MCP_OAUTH_INVALID_SCOPE",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Correct the configured provider scopes and restart authorization.",
    }
  }
  if (name === "InvalidTargetError") {
    return {
      phase: "AUTH_RESOURCE_VALIDATION",
      category: "oauth_invalid_target",
      code: "MCP_OAUTH_INVALID_TARGET",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Correct the configured MCP resource or token audience and restart authorization.",
    }
  }
  if (name === "InsufficientScopeError") {
    return {
      phase: "AUTH_RESOURCE_VALIDATION",
      category: "oauth_insufficient_scope",
      code: "MCP_OAUTH_INSUFFICIENT_SCOPE",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Grant the MCP resource scopes required by the provider and restart authorization.",
    }
  }
  if (name === "InvalidTokenError") {
    return {
      phase: "AUTH_RESOURCE_VALIDATION",
      category: "oauth_invalid_token",
      code: "MCP_OAUTH_INVALID_TOKEN",
      retryable: false,
      actionOwner: "member",
      operatorAction: "Reconnect the MCP account to obtain a token for the configured resource.",
    }
  }
  if (name === "UnsupportedTokenTypeError") {
    return {
      phase: fallbackPhase,
      category: "oauth_unsupported_token_type",
      code: "MCP_OAUTH_UNSUPPORTED_TOKEN_TYPE",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Configure the authorization server to issue a token type supported by the MCP client and resource.",
    }
  }
  if (name === "MethodNotAllowedError") {
    return {
      phase: fallbackPhase,
      category: "oauth_method_not_allowed",
      code: "MCP_OAUTH_METHOD_NOT_ALLOWED",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Verify the provider OAuth endpoint path and its supported HTTP method.",
    }
  }
  if (name === "TooManyRequestsError") {
    return {
      phase: fallbackPhase,
      category: "oauth_provider_throttled",
      code: "MCP_OAUTH_TOO_MANY_REQUESTS",
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Wait for the provider rate limit to reset, then retry with bounded backoff.",
    }
  }
  if (name === "AccessDeniedError") {
    return {
      phase: "AUTH_USER_OR_WORKLOAD",
      category: "oauth_access_denied",
      code: "MCP_OAUTH_ACCESS_DENIED",
      retryable: false,
      actionOwner: "member",
      operatorAction: "Restart authorization and grant consent; if policy blocks consent, contact the provider administrator.",
    }
  }
  if (name === "InvalidRequestError" || name === "UnsupportedGrantTypeError" || name === "UnsupportedResponseTypeError") {
    return {
      phase: fallbackPhase,
      category: "oauth_request_rejected",
      code: name === "UnsupportedGrantTypeError"
        ? "MCP_OAUTH_UNSUPPORTED_GRANT_TYPE"
        : name === "UnsupportedResponseTypeError"
          ? "MCP_OAUTH_UNSUPPORTED_RESPONSE_TYPE"
          : "MCP_OAUTH_INVALID_REQUEST",
      retryable: false,
      actionOwner: "organization_admin",
      operatorAction: "Verify the provider OAuth flow, redirect URI, PKCE, and registered grant/response types.",
    }
  }
  if (name === "TemporarilyUnavailableError" || name === "ServerError") {
    return {
      phase: fallbackPhase,
      category: "oauth_provider_unavailable",
      code: name === "TemporarilyUnavailableError" ? "MCP_OAUTH_TEMPORARILY_UNAVAILABLE" : "MCP_OAUTH_SERVER_ERROR",
      retryable: true,
      actionOwner: "provider_admin",
      operatorAction: "Check authorization-server availability and retry with bounded backoff.",
    }
  }
  if (hasUnsupportedVersionMessage(error)) {
    return {
      phase: "MCP_VERSION",
      category: "mcp_version_mismatch",
      code: "MCP_UNSUPPORTED_VERSION",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Configure the provider to support an MCP protocol version compatible with OpenWork.",
    }
  }

  const phase = fallbackPhase
  const category = phase.startsWith("AUTH_")
    ? "oauth_failure"
    : phase.startsWith("MCP_") || phase.startsWith("CONTINUITY_")
      ? "mcp_protocol_failure"
      : "connection_failure"
  return {
    phase,
    category,
    code: `MCP_${phase}`,
    retryable: phase === "NETWORK_TCP" || phase === "MCP_TRANSPORT",
    actionOwner: phase.startsWith("AUTH_") ? "organization_admin" : "provider_admin",
    operatorAction: phase.startsWith("AUTH_")
      ? "Verify the endpoint's OAuth metadata and provider application configuration."
      : "Inspect the provider's MCP logs using the diagnostic reference and retry after correcting the named layer.",
  }
}

export class ExternalMcpDiagnosticError extends Error {
  readonly diagnostic: ExternalMcpDiagnostic
  readonly safeCauseChain: ExternalMcpSafeCause[]

  constructor(diagnostic: ExternalMcpDiagnostic, cause?: unknown) {
    super(diagnostic.message, cause === undefined ? undefined : { cause })
    this.name = "ExternalMcpDiagnosticError"
    this.diagnostic = diagnostic
    this.safeCauseChain = cause === undefined ? [] : safeExternalMcpCauseChain(cause)
  }
}

export class ExternalMcpDiagnosticTracker {
  readonly referenceId: string
  private readonly credentialContext?: {
    authType: "oauth" | "apikey" | "none"
    credentialMode: "shared" | "per_member"
  }
  private phase: ExternalMcpDiagnosticPhase = "CONFIGURATION"
  private highestPassed: ExternalMcpHealthLevel = "configured"
  private lastFailedPhase: ExternalMcpDiagnosticPhase | null = null
  private capturedFailure: { phase: ExternalMcpDiagnosticPhase; error: unknown } | null = null
  private lastHttpStatus: number | null = null
  private forcedClassification: Classification | null = null
  private outbound: ExternalMcpSafeOutbound | null = null
  private providerRequestId: string | null = null

  constructor(referenceId: string, credentialContext?: {
    authType: "oauth" | "apikey" | "none"
    credentialMode: "shared" | "per_member"
  }) {
    this.referenceId = referenceId
    this.credentialContext = credentialContext
  }

  get activePhase(): ExternalMcpDiagnosticPhase {
    return this.phase
  }

  begin(phase: ExternalMcpDiagnosticPhase): void {
    this.phase = phase
    this.lastFailedPhase = null
    this.capturedFailure = null
    this.lastHttpStatus = null
    this.forcedClassification = null
    this.providerRequestId = null
  }

  passed(phase: ExternalMcpDiagnosticPhase, health?: ExternalMcpHealthLevel): void {
    this.phase = phase
    this.lastFailedPhase = null
    this.capturedFailure = null
    this.forcedClassification = null
    if (health && HEALTH_RANK[health] > HEALTH_RANK[this.highestPassed]) {
      this.highestPassed = health
    }
  }

  failed(phase: ExternalMcpDiagnosticPhase, classification?: Classification): void {
    this.phase = phase
    this.lastFailedPhase = phase
    this.forcedClassification = classification ?? null
  }

  captureFailure(phase: ExternalMcpDiagnosticPhase, error: unknown): void {
    this.failed(phase)
    this.capturedFailure = { phase, error }
  }

  captureResponseBodyLimit(phase: ExternalMcpDiagnosticPhase, error: unknown): void {
    const classification = classifyError(error, phase)
    this.failed(phase, classification)
    this.capturedFailure = { phase, error }
  }

  recordHttpStatus(status: number): void {
    this.lastHttpStatus = status
  }

  recordOutbound(rawUrl: string | URL): void {
    this.outbound = safeExternalMcpOutbound(rawUrl)
  }

  recordProviderRequestId(headers: Headers): void {
    for (const name of [
      "x-ms-request-id",
      "x-ms-correlation-request-id",
      "x-servicenow-request-id",
      "x-correlation-id",
      "x-transaction-id",
      "request-id",
      "x-request-id",
    ]) {
      const value = safeProviderRequestId(headers.get(name))
      if (value) {
        this.providerRequestId = value
        return
      }
    }
  }

  providerToolError(result?: unknown): ExternalMcpDiagnosticError {
    const structuredContent = isRecord(result) && isRecord(result.structuredContent)
      ? result.structuredContent
      : null
    const structuredProviderStatus = validProviderStatus(structuredContent?.providerStatus)
    const providerCategory = typeof structuredContent?.category === "string" ? structuredContent.category : undefined
    const evidence = providerToolContentEvidence(result)
    const providerStatus = structuredProviderStatus ?? evidence.providerStatus
    const providerCode = evidence.providerCode
    const requestId = safeProviderRequestId(structuredContent?.requestId) ?? evidence.providerRequestId
    if (requestId) this.providerRequestId = requestId

    const providerInvalidArguments = [
      "invalid_arguments",
      "invalid_params",
      "validation_error",
    ].includes(providerCategory ?? "") || isProviderInputValidationExcerpt(evidence.excerpt)
    const providerPolicyDenied = structuredProviderStatus === 403
      ? providerCategory === "provider_policy"
      : evidence.providerStatus === 403
    const classificationBase: Classification = providerInvalidArguments
      ? {
          phase: "MCP_TOOL_EXECUTION",
          category: "mcp_tool_input_invalid",
          code: "MCP_PROVIDER_INVALID_PARAMS",
          retryable: false,
          actionOwner: "openwork",
          operatorAction: "Correct the tool arguments using the latest advertised input schema; do not retry the same arguments unchanged.",
        }
      : providerPolicyDenied
      ? {
          phase: "PROVIDER_AUTHORIZATION",
          category: "provider_policy_denied",
          code: "MCP_PROVIDER_HTTP_403",
          retryable: false,
          actionOwner: "provider_admin",
          operatorAction: "Grant the provider role, ACL, or application permission required for this operation.",
        }
      : providerStatus === 429
        ? {
            phase: "PROVIDER_EXECUTION",
            category: "provider_throttled",
            code: "MCP_PROVIDER_HTTP_429",
            retryable: true,
            actionOwner: "provider_admin",
            operatorAction: "Wait for the provider rate limit to reset, then retry with bounded backoff.",
          }
        : {
            phase: "PROVIDER_EXECUTION",
            category: "provider_tool_error",
            code: "MCP_PROVIDER_TOOL_ERROR",
            retryable: false,
            actionOwner: "provider_admin",
            operatorAction: "Inspect the provider operation result and provider logs using the diagnostic reference.",
          }
    const classification: Classification = {
      ...classificationBase,
      ...(providerStatus === undefined ? {} : { providerStatus }),
      ...(providerCode ? { providerCode } : {}),
      payloadBytes: evidence.payloadBytes,
    }
    logProviderToolEvidence({
      referenceId: this.referenceId,
      evidence,
      diagnosticCode: classification.code,
      ...(providerStatus === undefined ? {} : { providerStatus }),
      ...(providerCode ? { providerCode } : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
    })
    this.failed(classification.phase, classification)
    return this.error(new Error("Provider returned an MCP tool error result."), classification.phase)
  }

  error(error: unknown, fallbackPhase = this.lastFailedPhase ?? this.phase): ExternalMcpDiagnosticError {
    if (error instanceof ExternalMcpDiagnosticError) return error
    const source = errorCode(error) || !this.capturedFailure ? { phase: fallbackPhase, error } : this.capturedFailure
    const inferredClassification = classifyError(source.error, source.phase)
    const classified = this.forcedClassification
      && !TYPED_OAUTH_ERROR_NAMES.has(errorName(source.error))
      && inferredClassification.phase !== "MCP_VERSION"
      ? this.forcedClassification
      : inferredClassification
    const classification: Classification = classified.actionOwner === "member"
      && this.credentialContext
      && (classified.phase.startsWith("AUTH_") || classified.phase === "CONTINUITY_REFRESH")
      && this.credentialContext.credentialMode === "shared"
      ? {
          ...classified,
          actionOwner: "organization_admin",
          operatorAction: this.credentialContext.authType === "apikey"
            ? "Update the organization-managed API key for this MCP connection, then retry."
            : "Reconnect the organization-managed provider account, then retry.",
        }
      : classified
    const diagnosticWithoutMessage = {
      referenceId: this.referenceId,
      highestPassed: this.highestPassed,
      ...classification,
    }
    const diagnostic: ExternalMcpDiagnostic = {
      ...diagnosticWithoutMessage,
      message: safeMessageFor(diagnosticWithoutMessage),
      ...(this.lastHttpStatus === null ? {} : { httpStatus: this.lastHttpStatus }),
      ...(classification.phase === source.phase ? {} : { operationPhase: source.phase }),
      ...(this.outbound ? { outbound: this.outbound } : {}),
      ...(this.providerRequestId ? { providerRequestId: this.providerRequestId } : {}),
      ...(numericErrorCode(source.error) === undefined ? {} : { jsonRpcCode: numericErrorCode(source.error) }),
    }
    return new ExternalMcpDiagnosticError(diagnostic, error)
  }
}

function requestBodyText(init?: RequestInit): string | null {
  if (typeof init?.body === "string") return init.body
  if (init?.body instanceof URLSearchParams) return init.body.toString()
  return null
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) return null
  return new Headers(init.headers).get(name)
}

function jsonRpcMethod(body: string | null): string | null {
  if (!body || body.length > 64_000) return null
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) && typeof parsed.method === "string" ? parsed.method : null
  } catch {
    return null
  }
}

function requestPhase(input: string | URL, init: RequestInit | undefined, endpoint: URL): ExternalMcpDiagnosticPhase {
  const url = new URL(String(input))
  const path = url.pathname
  if (path.includes("/.well-known/oauth-protected-resource")) return "AUTH_RESOURCE_DISCOVERY"
  if (path.includes("/.well-known/oauth-authorization-server") || path.includes("/.well-known/openid-configuration")) {
    return "AUTH_ISSUER_DISCOVERY"
  }

  const body = requestBodyText(init)
  const contentType = requestHeader(init, "content-type") ?? ""
  if (contentType.includes("application/x-www-form-urlencoded") && body) {
    const form = new URLSearchParams(body)
    return form.get("grant_type") === "refresh_token" ? "CONTINUITY_REFRESH" : "AUTH_TOKEN_ACQUISITION"
  }
  if (contentType.includes("application/json") && body?.includes("\"redirect_uris\"")) {
    return "AUTH_CLIENT_REGISTRATION"
  }

  if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) {
    const method = jsonRpcMethod(body)
    if (method === "initialize") return "MCP_INITIALIZE"
    if (method === "notifications/initialized") return "MCP_INITIALIZED"
    if (method === "tools/list") return "MCP_TOOL_DISCOVERY"
    if (method === "tools/call") return "MCP_TOOL_EXECUTION"
    return "MCP_TRANSPORT"
  }
  return "HTTP_ROUTING"
}

function healthForPhase(phase: ExternalMcpDiagnosticPhase): ExternalMcpHealthLevel | undefined {
  if (phase === "HTTP_ROUTING" || phase === "AUTH_RESOURCE_DISCOVERY" || phase === "AUTH_ISSUER_DISCOVERY" || phase === "AUTH_CLIENT_REGISTRATION") {
    return "reachable"
  }
  // An HTTP response proves reachability only. Higher health levels are
  // advanced by parsed OAuth/MCP operations after schema, lifecycle, and
  // pagination checks succeed; a 200 HTML page must never become
  // protocol_ready or catalog_ready.
  if (phase.startsWith("MCP_") || phase === "AUTH_RESOURCE_VALIDATION") return "reachable"
  return undefined
}

function responseBodyLimit(contentType: string): number {
  return contentType === "text/event-stream"
    ? EXTERNAL_MCP_SSE_RESPONSE_LIMIT_BYTES
    : EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES
}

function preserveResponseMetadata(target: Response, source: Response): void {
  for (const key of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(target, key, { configurable: true, value: source[key] })
    } catch {
      // These properties are diagnostic conveniences only. The status,
      // headers, and bounded body are the protocol-relevant fields.
    }
  }
}

function boundedExternalMcpResponse(input: {
  response: Response
  contentType: string
  phase: ExternalMcpDiagnosticPhase
  tracker: ExternalMcpDiagnosticTracker
}): Response {
  if (!input.response.body) return input.response
  const limit = responseBodyLimit(input.contentType)
  const advertisedLength = input.response.headers.get("content-length")
  if (advertisedLength && /^\d+$/.test(advertisedLength)) {
    const length = Number(advertisedLength)
    if (Number.isSafeInteger(length) && length > limit) {
      const error = new ExternalMcpResponseBodyLimitError()
      input.tracker.captureResponseBodyLimit(input.phase, error)
      throw input.tracker.error(error, input.phase)
    }
  }

  const reader = input.response.body.getReader()
  let bytesRead = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          return
        }
        bytesRead += next.value.byteLength
        if (bytesRead > limit) {
          const error = new ExternalMcpResponseBodyLimitError()
          input.tracker.captureResponseBodyLimit(input.phase, error)
          await reader.cancel(error).catch(() => undefined)
          controller.error(error)
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const bounded = new Response(body, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  })
  preserveResponseMetadata(bounded, input.response)
  return bounded
}

export function createExternalMcpDiagnosticFetch(input: {
  fetch: FetchLike
  endpoint: string
  tracker: ExternalMcpDiagnosticTracker
}): FetchLike {
  const endpoint = new URL(input.endpoint)
  return async (url, init) => {
    let phase: ExternalMcpDiagnosticPhase
    try {
      phase = requestPhase(url, init, endpoint)
    } catch (error) {
      input.tracker.failed("CONFIGURATION")
      throw input.tracker.error(error, "CONFIGURATION")
    }
    input.tracker.begin(phase)
    input.tracker.recordOutbound(url)
    try {
      const response = await input.fetch(url, init)
      input.tracker.recordHttpStatus(response.status)
      input.tracker.recordProviderRequestId(response.headers)
      const challenge = response.headers.get("www-authenticate") ?? ""
      const hasAuthorization = Boolean(requestHeader(init, "authorization"))
      const unauthenticatedChallenge = phase === "MCP_INITIALIZE"
        && response.status === 401
        && !hasAuthorization
        && /\bbearer\b/i.test(challenge)
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
      const classification = unauthenticatedChallenge
        ? null
        : httpClassification({
            phase,
            status: response.status,
            hasAuthorization,
            bearerChallenge: /\bbearer\b/i.test(challenge),
            insufficientScope: /\binsufficient_scope\b/i.test(challenge),
            hasSession: Boolean(requestHeader(init, "mcp-session-id")),
            contentType,
          })
      input.tracker.passed(phase, "reachable")
      if (classification) {
        input.tracker.failed(classification.phase, {
          ...classification,
          ...(classification.phase === phase ? {} : { operationPhase: phase }),
        })
      } else if (response.ok || unauthenticatedChallenge) {
        input.tracker.passed(phase, healthForPhase(phase))
      } else {
        input.tracker.failed(phase)
      }
      return boundedExternalMcpResponse({ response, contentType, phase, tracker: input.tracker })
    } catch (error) {
      input.tracker.captureFailure(phase, error)
      throw error
    }
  }
}

export function externalMcpDiagnosticForResponse(error: unknown, referenceId: string, fallbackPhase: ExternalMcpDiagnosticPhase): ExternalMcpDiagnostic {
  if (error instanceof ExternalMcpDiagnosticError) return error.diagnostic
  return new ExternalMcpDiagnosticTracker(referenceId).error(error, fallbackPhase).diagnostic
}

const OAUTH_CALLBACK_ERROR_NAMES: Record<string, string> = {
  access_denied: "AccessDeniedError",
  invalid_client: "InvalidClientError",
  invalid_request: "InvalidRequestError",
  invalid_scope: "InvalidScopeError",
  invalid_target: "InvalidTargetError",
  invalid_token: "InvalidTokenError",
  insufficient_scope: "InsufficientScopeError",
  method_not_allowed: "MethodNotAllowedError",
  too_many_requests: "TooManyRequestsError",
  unsupported_token_type: "UnsupportedTokenTypeError",
  server_error: "ServerError",
  temporarily_unavailable: "TemporarilyUnavailableError",
  unauthorized_client: "UnauthorizedClientError",
  unsupported_response_type: "UnsupportedResponseTypeError",
}

export function externalMcpOAuthCallbackError(referenceId: string, providerErrorCode: string): ExternalMcpDiagnosticError {
  const tracker = new ExternalMcpDiagnosticTracker(referenceId)
  tracker.begin("AUTH_USER_OR_WORKLOAD")
  const error = new Error("OAuth provider returned an authorization error.")
  error.name = OAUTH_CALLBACK_ERROR_NAMES[providerErrorCode] ?? "Error"
  return tracker.error(error, "AUTH_USER_OR_WORKLOAD")
}

export function externalMcpDiagnosticForLog(error: unknown, referenceId: string, fallbackPhase: ExternalMcpDiagnosticPhase) {
  const diagnosticError = error instanceof ExternalMcpDiagnosticError
    ? error
    : new ExternalMcpDiagnosticTracker(referenceId).error(error, fallbackPhase)
  return {
    diagnostic: diagnosticError.diagnostic,
    causeChain: diagnosticError.safeCauseChain,
  }
}

export function safeExternalMcpOutbound(rawUrl: string | URL): ExternalMcpSafeOutbound {
  const url = new URL(String(rawUrl))
  return {
    origin: url.origin,
    pathHash: `sha256:${createHash("sha256").update(url.pathname).digest("hex").slice(0, 16)}`,
  }
}

export function safeExternalMcpEndpointForLog(rawUrl: string): ExternalMcpSafeOutbound | { invalid: true } {
  try {
    return safeExternalMcpOutbound(rawUrl)
  } catch {
    return { invalid: true }
  }
}

export function catalogDiagnosticError(input: {
  tracker: ExternalMcpDiagnosticTracker
  code:
    | "MCP_CATALOG_CURSOR_LOOP"
    | "MCP_CATALOG_PAGE_LIMIT"
    | "MCP_CATALOG_ITEM_LIMIT"
    | "MCP_CATALOG_DUPLICATE_TOOL"
    | "MCP_CATALOG_TOOL_NAME_LIMIT"
    | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT"
    | "MCP_CATALOG_TOOL_TITLE_LIMIT"
    | "MCP_CATALOG_SCHEMA_SIZE_LIMIT"
    | "MCP_CATALOG_SCHEMA_DEPTH_LIMIT"
    | "MCP_CATALOG_SCHEMA_CYCLE"
    | "MCP_CATALOG_CURSOR_SIZE_LIMIT"
    | "MCP_CATALOG_BYTE_LIMIT"
  operatorAction: string
}): ExternalMcpDiagnosticError {
  input.tracker.failed("MCP_TOOL_DISCOVERY")
  const diagnostic: ExternalMcpDiagnostic = {
    referenceId: input.tracker.referenceId,
    phase: "MCP_TOOL_DISCOVERY",
    category: "mcp_catalog",
    code: input.code,
    highestPassed: "protocol_ready",
    retryable: false,
    actionOwner: "provider_admin",
    operatorAction: input.operatorAction,
    message: safeMessageFor({ phase: "MCP_TOOL_DISCOVERY", category: "mcp_catalog", code: input.code }),
  }
  return new ExternalMcpDiagnosticError(diagnostic)
}

export function lifecycleDeadlineDiagnosticError(input: {
  tracker: ExternalMcpDiagnosticTracker
  phase: ExternalMcpDiagnosticPhase
}): ExternalMcpDiagnosticError {
  return input.tracker.error(new ExternalMcpLifecycleDeadlineError(), input.phase)
}

export function providerToolDiagnosticError(input: {
  tracker: ExternalMcpDiagnosticTracker
  result?: unknown
}): ExternalMcpDiagnosticError {
  return input.tracker.providerToolError(input.result)
}
