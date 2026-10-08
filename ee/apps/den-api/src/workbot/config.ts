/**
 * Workbot is its own app (ee/apps/workbot) that signs people in with Den: an OAuth client of Den's authorization
 * server, like an MCP client, but first-party (no consent screen) and with one fixed return address. Den keeps
 * who may use it (the organization's `workbot` capability) and mints the short-lived tokens its turns use.
 */
export const WORKBOT_OAUTH_CLIENT_ID = "openwork-workbot"
export const WORKBOT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", "mcp:read", "mcp:write"] as const

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Workbot's origin (`DEN_WORKBOT_URL`), https or a loopback address; null when Workbot isn't deployed here. */
export function workbotOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.DEN_WORKBOT_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url.origin
  } catch {
    // An invalid value turns Workbot sign-in off rather than redirecting anywhere unexpected.
  }
  return null
}

/** The one address Den sends a signed-in person back to. */
export function workbotRedirectUri(origin: string) {
  return `${origin}/auth/callback`
}
