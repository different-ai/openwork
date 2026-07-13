export const MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION =
  "MCP OAuth redirect URIs must use HTTPS callbacks or HTTP loopback callbacks and must not include fragments."

function isIpv4Loopback(hostname: string) {
  const parts = hostname.split(".")
  if (parts.length !== 4 || parts[0] !== "127") {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }

    const octet = Number(part)
    return octet >= 0 && octet <= 255
  })
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase()
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || normalized === "[::1]"
    || isIpv4Loopback(normalized)
}

export function isAllowedMcpOAuthRedirectUri(uri: string) {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }

  if (uri.includes("#")) {
    return false
  }

  if (parsed.protocol === "https:") {
    return true
  }

  if (parsed.protocol === "http:") {
    return isLoopbackHostname(parsed.hostname)
  }

  return false
}

export function getInvalidMcpOAuthRedirectUris(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => !isAllowedMcpOAuthRedirectUri(entry))
}
