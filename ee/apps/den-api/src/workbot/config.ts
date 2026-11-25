export const WORKBOT_OAUTH_CLIENT_ID = "openwork-workbot"
export const WORKBOT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", "mcp:read", "mcp:write"] as const

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export function workbotOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.DEN_WORKBOT_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url.origin
  } catch {
  }
  return null
}

export function workbotRedirectUri(origin: string) {
  return `${origin}/auth/callback`
}
