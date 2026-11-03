import { assertPublicUrl, PrivateUrlError } from "../capability-sources/url-guard.js"
import { env } from "../env.js"

/**
 * Hosts that must never be fetched as a Client ID Metadata Document: Den's own
 * public origins. A client_id pointing back at this deployment would turn the
 * authorization server into a proxy for its own routes.
 */
function ownOrigins(): Set<string> {
  const origins = new Set<string>()
  for (const candidate of [env.betterAuthUrl, env.apiPublicUrl, ...env.corsOrigins]) {
    if (!candidate) continue
    try {
      origins.add(new URL(candidate).origin)
    } catch {
      // Not an absolute URL (for example a CORS wildcard); nothing to deny.
    }
  }
  return origins
}

/**
 * Pre-fetch gate for Client ID Metadata Document URLs (MCP authorization,
 * draft-ietf-oauth-client-id-metadata-document). The plugin already requires an
 * HTTPS URL with a path and rejects IP literals in private ranges; this adds the
 * deployment policy: never fetch from Den itself, and, on hosted deployments,
 * require the hostname to resolve only to public addresses before the fetch.
 *
 * The DNS check runs before the fetch, so it cannot pin the resolved address to
 * the connection; it narrows the SSRF surface rather than closing it. Private
 * and self-hosted deployments opt out with DEN_ALLOW_PRIVATE_MCP_URLS, the same
 * switch used for external MCP egress.
 */
export async function isCimdClientIdUrlAllowed(clientIdUrl: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(clientIdUrl)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (ownOrigins().has(url.origin)) return false
  if (env.allowPrivateMcpUrls) return true
  try {
    await assertPublicUrl(clientIdUrl)
    return true
  } catch (error) {
    if (error instanceof PrivateUrlError) return false
    throw error
  }
}

/**
 * Fetch transport for Client ID Metadata Documents and the `jwks_uri` they
 * name. Applies the same URL policy to every request and never follows a
 * redirect, so a public document cannot bounce the fetch to a private host.
 */
export async function fetchCimdMetadataResource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!(await isCimdClientIdUrlAllowed(url))) {
    throw new Error("Client metadata URL is not permitted by the server's fetch policy")
  }
  return fetch(url, { ...init, redirect: "error" })
}
