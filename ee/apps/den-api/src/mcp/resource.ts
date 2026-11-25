import { firstForwardedValue, trustedForwardedOrigin } from "../request-url.js"

const DEN_WEB_PROXY_PREFIX = "/api/den"

export function isHostedWebAppHost(hostname: string, webAppHosts: readonly string[]): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) return false
  if (webAppHosts.some((host) => (host.startsWith(".") ? normalized.endsWith(host) : normalized === host))) {
    return true
  }
  return normalized.startsWith("app.") || normalized.endsWith(".run.app")
}

export function deriveDenMcpResource(betterAuthUrl: string, webAppHosts: readonly string[]): string {
  const origin = betterAuthUrl.replace(/\/+$/, "")
  try {
    const url = new URL(origin)
    if (isHostedWebAppHost(url.hostname, webAppHosts)) {
      return `${origin}/api/den/mcp`
    }
  } catch {
  }
  return `${origin}/mcp`
}

export type McpResourceRoute = "mcp" | "agent" | "admin"

export function mcpEndpointResource(resource: string, endpoint: "agent" | "admin"): string {
  return `${resource.replace(/\/+$/, "")}/${endpoint}`
}

export function deriveDenMcpAgentResource(input: { apiPublicUrl: string | undefined; mcpResource: string }): string {
  const base = input.apiPublicUrl ? `${input.apiPublicUrl.replace(/\/+$/, "")}/mcp` : input.mcpResource
  return mcpEndpointResource(base, "agent")
}

export function mcpProtectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource)
  const pathname = url.pathname.replace(/\/+$/, "")
  return `${url.origin}/.well-known/oauth-protected-resource${pathname === "" ? "" : pathname}`
}

export function mcpRouteResource(input: {
  route: McpResourceRoute
  parentResource: string
  agentResource: string
}): string {
  return input.route === "agent" ? input.agentResource : input.parentResource
}

export function resolveMcpResourceFromRequest(
  requestUrl: string,
  resources: readonly string[],
  fallback: string,
): string {
  const url = new URL(requestUrl)
  const bareResource = `${url.origin}/mcp`
  const proxiedResource = `${url.origin}/api/den/mcp`
  if (url.pathname.startsWith("/api/den") && resources.includes(proxiedResource)) {
    return proxiedResource
  }

  if ((fallback === bareResource || fallback === proxiedResource) && resources.includes(fallback)) {
    return fallback
  }

  const candidates = [bareResource, proxiedResource]
  const match = candidates.find((candidate) => resources.includes(candidate))
  return match ?? fallback
}

function normalizedForwardedPrefix(value: string | null): string | null {
  const prefix = firstForwardedValue(value)
  if (!prefix) return null
  return prefix.replace(/\/+$/, "") || "/"
}

export function deriveFirstPartyMcpTokenResourceFromRequest(
  request: Request,
  options: { fallback: string; trustedOrigins: readonly string[] },
): string {
  if (normalizedForwardedPrefix(request.headers.get("x-forwarded-prefix")) !== DEN_WEB_PROXY_PREFIX) {
    return options.fallback
  }

  const forwarded = trustedForwardedOrigin(request, { trustedOrigins: options.trustedOrigins })
  return forwarded ? `${forwarded.origin}${DEN_WEB_PROXY_PREFIX}/mcp` : options.fallback
}
