import { createHash } from "node:crypto"

const KNOWN_GRANT_TYPES = new Set([
  "authorization_code",
  "client_credentials",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:device_code",
])

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

export async function getOAuthTokenRateLimitLogFields(request: Request, response: Response) {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "")
  if (request.method.toUpperCase() !== "POST" || !pathname.endsWith("/oauth2/token") || response.status !== 429) {
    return null
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  const body = contentType.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(await request.clone().text().catch(() => ""))
    : new URLSearchParams()
  const grantType = body.get("grant_type")
  const clientId = readBasicAuthClientId(request.headers) ?? body.get("client_id")
  const retryAfter = response.headers.get("retry-after")?.trim().slice(0, 128)

  return {
    grant_type: grantType && KNOWN_GRANT_TYPES.has(grantType) ? grantType : grantType ? "other" : "missing",
    client_id_fingerprint: fingerprintClientId(clientId),
    retry_after: retryAfter || undefined,
    user_agent_category: userAgentCategory(request.headers.get("user-agent")),
  }
}
