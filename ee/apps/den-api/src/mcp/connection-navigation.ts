import { env } from "../env.js"

export function openworkYourConnectionsUrl(connectionId: string) {
  const url = new URL("/dashboard/your-connections", env.betterAuthUrl)
  url.searchParams.set("connectionId", connectionId)
  return url.toString()
}

/** The connection's own settings page when its ID is known, otherwise the list. */
export function openworkOrganizationConnectionsUrl(connectionId?: string) {
  const path = connectionId ? `/dashboard/mcp-connections/${encodeURIComponent(connectionId)}` : "/dashboard/mcp-connections"
  return new URL(path, env.betterAuthUrl).toString()
}
