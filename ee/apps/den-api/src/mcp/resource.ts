/**
 * Derivation of the Den MCP resource URL from the auth origin.
 *
 * Hosted web-app origins (app.openworklabs.com, app.openwork.software,
 * app.*, *.run.app, configured DEN_WEB_APP_HOSTS) serve the den-web
 * frontend at their root and expose den-api only behind the `/api/den`
 * proxy path. Nothing serves MCP at `<origin>/mcp` on those hosts, so
 * desktop clients connecting to a minted bare resource fail with
 * "SSE error: Non-200 status code (404)".
 *
 * Kept dependency-free so it stays unit-testable without booting env/db.
 */

export function isHostedWebAppHost(hostname: string, webAppHosts: readonly string[]): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) return false
  if (webAppHosts.some((host) => (host.startsWith(".") ? normalized.endsWith(host) : normalized === host))) {
    return true
  }
  // Cloud Run hostnames serve den-web, which only exposes den-api behind
  // its /api/den proxy path (see #1807).
  return normalized.startsWith("app.") || normalized.endsWith(".run.app")
}

/**
 * Default MCP resource for a deployment. Web-app origins route through the
 * `/api/den` proxy; direct API origins (api.openworklabs.com, loopback dev
 * den-api) keep the bare `<origin>/mcp` form.
 */
export function deriveDenMcpResource(betterAuthUrl: string, webAppHosts: readonly string[]): string {
  const origin = betterAuthUrl.replace(/\/+$/, "")
  try {
    const url = new URL(origin)
    if (isHostedWebAppHost(url.hostname, webAppHosts)) {
      return `${origin}/api/den/mcp`
    }
  } catch {
    // Unparseable values keep the legacy bare form.
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
  // Prefer the shape the client actually requested, then the configured
  // same-origin fallback, so the legacy bare compat resource does not shadow
  // the proxied public route on web-app origins.
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
