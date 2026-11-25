import { createHash } from "node:crypto"
import type { ClientIpSource } from "./client-ip.js"

const KNOWN_GRANT_TYPES = new Set([
  "authorization_code",
  "client_credentials",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:device_code",
  "urn:ietf:params:oauth:grant-type:jwt-bearer",
])

const KNOWN_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
])

export const MCP_SESSION_REVOKED_GRANT_DESCRIPTION = "The authorization backing this grant has been revoked. Re-authorize the connection."

const KNOWN_ERROR_REASONS = new Map([
  [MCP_SESSION_REVOKED_GRANT_DESCRIPTION, "mcp_session_revoked"],
  ["session not found", "refresh_token_unknown"],
  ["invalid refresh token", "refresh_token_rejected"],
])

const SAFE_BUCKET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

export type OAuthTokenLimitLayer = "den_admission" | "auth_handler"

export type OAuthTokenLimitBlock = { bucket: string; retryAfterSeconds: number }

export type OAuthTokenLimitAttribution = {
  layer: OAuthTokenLimitLayer
  blocked?: readonly OAuthTokenLimitBlock[]
  clientIpSource: ClientIpSource
}

type OAuthTokenRequestLogFields = {
  grant_type: string
  client_id_fingerprint: string | undefined
  user_agent_category: string
}

export type OAuthTokenRateLimitLogFields = OAuthTokenRequestLogFields & {
  retry_after: string | undefined
  limit_layer: OAuthTokenLimitLayer
  client_ip_source: ClientIpSource
  bucket?: string
  blocked_buckets?: { bucket: string; retry_after_seconds: number }[]
}

export type OAuthTokenErrorLogFields = {
  oauth_error: string
  oauth_error_reason?: string
}

export type OAuthTokenFailureLogFields = OAuthTokenRequestLogFields & OAuthTokenErrorLogFields & {
  limit_layer: "den_admission"
  bucket: string
  retry_after_seconds: number | undefined
  http_status: number
  client_ip_source: ClientIpSource
}

export function readBasicAuthClientId(headers: Headers) {
  const authorization = headers.get("authorization")?.trim() ?? ""
  const match = authorization.match(/^Basic\s+(.+)$/i)
  if (!match?.[1]) return null

  try {
    const decoded = atob(match[1])
    const separator = decoded.indexOf(":")
    return separator > 0 ? decoded.slice(0, separator) : null
  } catch {
    return null
  }
}

function fingerprintClientId(clientId: string | null) {
  if (!clientId) return undefined
  return `sha256:${createHash("sha256").update(clientId).digest("hex").slice(0, 16)}`
}

function userAgentCategory(userAgent: string | null) {
  if (!userAgent) return "missing"
  if (/cursor/i.test(userAgent)) return "cursor"
  if (/claude-code/i.test(userAgent)) return "claude_code"
  if (/codex-mcp-client/i.test(userAgent)) return "codex"
  if (/opencode/i.test(userAgent)) return "opencode"
  if (/openwork/i.test(userAgent)) return "openwork"
  if (/mozilla\//i.test(userAgent)) return "browser"
  if (/curl|wget|httpie/i.test(userAgent)) return "cli"
  return "other"
}

function isOAuthTokenPost(request: Request) {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "")
  return request.method.toUpperCase() === "POST" && pathname.endsWith("/oauth2/token")
}

async function oauthTokenRequestLogFields(request: Request): Promise<OAuthTokenRequestLogFields> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  const body = contentType.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(await request.clone().text().catch(() => ""))
    : new URLSearchParams()
  const grantType = body.get("grant_type")
  const clientId = readBasicAuthClientId(request.headers) ?? body.get("client_id")

  return {
    grant_type: grantType && KNOWN_GRANT_TYPES.has(grantType) ? grantType : grantType ? "other" : "missing",
    client_id_fingerprint: fingerprintClientId(clientId),
    user_agent_category: userAgentCategory(request.headers.get("user-agent")),
  }
}

function safeBucket(bucket: string) {
  return SAFE_BUCKET_PATTERN.test(bucket) ? bucket : "other"
}

function safeRetryAfterSeconds(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function blockedBucketFields(blocked: readonly OAuthTokenLimitBlock[] | undefined) {
  const entries = (blocked ?? []).flatMap((block) => {
    const retryAfterSeconds = safeRetryAfterSeconds(block.retryAfterSeconds)
    return retryAfterSeconds === undefined ? [] : [{ bucket: safeBucket(block.bucket), retry_after_seconds: retryAfterSeconds }]
  })
  if (entries.length === 0) return {}

  const longest = entries.reduce((current, entry) => entry.retry_after_seconds > current.retry_after_seconds ? entry : current)
  return { bucket: longest.bucket, blocked_buckets: entries }
}

export async function getOAuthTokenRateLimitLogFields(
  request: Request,
  response: Response,
  attribution: OAuthTokenLimitAttribution,
): Promise<OAuthTokenRateLimitLogFields | null> {
  if (!isOAuthTokenPost(request) || response.status !== 429) {
    return null
  }

  const retryAfter = (response.headers.get("retry-after") ?? response.headers.get("x-retry-after"))?.trim().slice(0, 128)

  return {
    ...await oauthTokenRequestLogFields(request),
    retry_after: retryAfter || undefined,
    limit_layer: attribution.layer,
    client_ip_source: attribution.clientIpSource,
    ...blockedBucketFields(attribution.blocked),
  }
}

export async function readOAuthTokenErrorLogFields(response: Response): Promise<OAuthTokenErrorLogFields> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  const body: unknown = contentType.includes("json")
    ? await response.clone().json().catch(() => null)
    : null
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : undefined
  const description = typeof body === "object" && body !== null && "error_description" in body ? body.error_description : undefined
  const reason = typeof description === "string" ? KNOWN_ERROR_REASONS.get(description) : undefined

  return {
    oauth_error: typeof error === "string" && error ? KNOWN_OAUTH_ERRORS.has(error) ? error : "other" : "missing",
    ...(reason ? { oauth_error_reason: reason } : {}),
  }
}

export async function getOAuthTokenFailureLogFields(
  request: Request,
  response: Response,
  exhausted: OAuthTokenLimitBlock,
  clientIpSource: ClientIpSource,
): Promise<OAuthTokenFailureLogFields | null> {
  if (!isOAuthTokenPost(request) || (response.status !== 400 && response.status !== 401 && response.status !== 403)) {
    return null
  }

  return {
    ...await oauthTokenRequestLogFields(request),
    ...await readOAuthTokenErrorLogFields(response),
    limit_layer: "den_admission",
    bucket: safeBucket(exhausted.bucket),
    retry_after_seconds: safeRetryAfterSeconds(exhausted.retryAfterSeconds),
    http_status: response.status,
    client_ip_source: clientIpSource,
  }
}
