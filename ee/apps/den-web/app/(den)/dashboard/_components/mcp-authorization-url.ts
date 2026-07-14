function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true
  const octets = normalized.split(".")
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

export type McpAuthorizationWindow = {
  readonly closed: boolean
  close: () => void
  location: {
    replace: (url: string) => void
  }
  opener: unknown
}

type OpenMcpAuthorizationWindow = (
  url: string,
  target: string,
  features: string,
) => McpAuthorizationWindow | null

export function mcpAuthorizationWindowName(connectionKey: string): string {
  const suffix = connectionKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "connection"
  return `openwork-mcp-oauth-${suffix}`
}

/**
 * Open a same-origin blank window while the click still has browser user
 * activation. The provider URL is validated and applied only after the API
 * handshake returns it.
 */
export function openMcpAuthorizationWindow(
  connectionKey: string,
  openWindow: OpenMcpAuthorizationWindow = (url, target, features) => window.open(url, target, features),
): McpAuthorizationWindow | null {
  try {
    const authorizationWindow = openWindow(
      "about:blank",
      mcpAuthorizationWindowName(connectionKey),
      "popup=yes,width=640,height=760",
    )
    if (!authorizationWindow) return null
    // We retain the WindowProxy needed to navigate and close the popup, while
    // preventing the eventual provider page from controlling the Den tab.
    authorizationWindow.opener = null
    return authorizationWindow
  } catch {
    return null
  }
}

export function navigateMcpAuthorizationWindow(
  authorizationWindow: McpAuthorizationWindow | null,
  rawUrl: string,
): { authorizeUrl: string; navigated: boolean } {
  const authorizeUrl = safeMcpAuthorizationUrl(rawUrl)
  if (!authorizationWindow || authorizationWindow.closed) {
    return { authorizeUrl, navigated: false }
  }
  try {
    authorizationWindow.location.replace(authorizeUrl)
    return { authorizeUrl, navigated: true }
  } catch {
    return { authorizeUrl, navigated: false }
  }
}

export function closeMcpAuthorizationWindow(authorizationWindow: McpAuthorizationWindow | null | undefined): void {
  try {
    if (authorizationWindow && !authorizationWindow.closed) authorizationWindow.close()
  } catch {
    // A provider-controlled cross-origin window may deny access while closing.
  }
}

export function safeMcpAuthorizationUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("The MCP provider returned an invalid authorization URL.")
  }
  const allowedProtocol = url.protocol === "https:"
    || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  if (!allowedProtocol || url.username || url.password) {
    throw new Error("The MCP provider returned an unsafe authorization URL.")
  }
  return url.toString()
}
