const BLOCKED_CUSTOM_REDIRECT_PROTOCOLS = new Set([
  "data:",
  "file:",
  "javascript:",
  "vbscript:",
])

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

function isPrivateUseCustomScheme(protocol: string) {
  const scheme = protocol.endsWith(":") ? protocol.slice(0, -1) : protocol
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && scheme.includes(".")
}

export function isAllowedMcpOAuthRedirectUri(uri: string) {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return isLoopbackHostname(parsed.hostname)
  }

  if (BLOCKED_CUSTOM_REDIRECT_PROTOCOLS.has(parsed.protocol)) {
    return false
  }

  return isPrivateUseCustomScheme(parsed.protocol)
}

export function getInvalidMcpOAuthRedirectUris(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => !isAllowedMcpOAuthRedirectUri(entry))
}
