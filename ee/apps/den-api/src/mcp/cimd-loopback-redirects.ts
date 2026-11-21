import type { ClientDiscovery } from "@better-auth/oauth-provider"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

function isHttpLoopback(url: URL) {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
}

export function relaxLoopbackRedirectUris(registered: readonly string[] | undefined, requested: string | undefined): string[] {
  const list = [...(registered ?? [])]
  if (!requested || list.includes(requested)) return list
  let candidate: URL
  try {
    candidate = new URL(requested)
  } catch {
    return list
  }
  if (!isHttpLoopback(candidate) || candidate.hash) return list
  const matches = list.some((entry) => {
    try {
      const known = new URL(entry)
      return isHttpLoopback(known)
        && known.hostname.toLowerCase() === candidate.hostname.toLowerCase()
        && known.pathname === candidate.pathname
        && known.search === candidate.search
    } catch {
      return false
    }
  })
  return matches ? [...list, requested] : list
}

function readRequestedRedirectUri(ctx: { query?: unknown; body?: unknown }): string | undefined {
  for (const source of [ctx.query, ctx.body]) {
    if (typeof source !== "object" || source === null) continue
    const value = (source as Record<string, unknown>).redirect_uri
    if (typeof value === "string" && value) return value
  }
  return undefined
}

export function withLoopbackRedirectRelaxation(discovery: ClientDiscovery): ClientDiscovery {
  return {
    ...discovery,
    resolve: async (ctx, clientId, existing) => {
      const client = await discovery.resolve(ctx, clientId, existing)
      if (!client) return client
      const requested = readRequestedRedirectUri(ctx)
      if (!requested) return client
      const redirectUris = relaxLoopbackRedirectUris(client.redirectUris, requested)
      if (redirectUris.length === (client.redirectUris?.length ?? 0)) return client
      return { ...client, redirectUris }
    },
  }
}
