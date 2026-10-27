import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/core"
import type { EnterpriseMcpFetch } from "./contracts.js"
import { EnterpriseMcpOAuthContractError } from "./errors.js"

/** A login page is only a hint. Prove the configured resource before starting OAuth. */
export function createOAuthLoginDiscoveryFetch(input: {
  fetch: EnterpriseMcpFetch
  serverUrl: URL
  manual?: boolean
}): EnterpriseMcpFetch {
  let firstResourcePost = true
  let verified: { url: string; body: string } | undefined
  const resource = input.serverUrl.href
  return async (rawUrl, init) => {
    const url = String(rawUrl)
    if (verified && url === verified.url && (init?.method ?? "GET") === "GET") {
      const body = verified.body
      verified = undefined
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    }
    const initial = firstResourcePost && url === resource && init?.method === "POST"
    if (!initial) return input.fetch(rawUrl, init)
    firstResourcePost = false
    // Do not follow even a same-origin redirect, or leak a body/credential to it.
    const response = await input.fetch(rawUrl, { ...init, redirect: "manual" })
    if (new Headers(init.headers).has("authorization")) return response
    const html = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/html"
    if (!(response.status >= 300 && response.status < 400) && !(response.status === 200 && html)) return response
    await response.body?.cancel()
    // An administrator already pinned the sign-in endpoints; no discovery is needed.
    if (input.manual) return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })

    const path = input.serverUrl.pathname === "/" ? "" : input.serverUrl.pathname
    const pathMetadata = new URL(`/.well-known/oauth-protected-resource${path}`, input.serverUrl.origin)
    pathMetadata.search = input.serverUrl.search
    const rootMetadata = new URL("/.well-known/oauth-protected-resource", input.serverUrl.origin)
    for (const metadataUrl of [...new Set([pathMetadata.href, rootMetadata.href])]) {
      try {
        const metadata = await input.fetch(metadataUrl, {
          method: "GET", headers: { accept: "application/json" },
          redirect: "manual", credentials: "omit", signal: init.signal,
        })
        if (metadata.status !== 200 || metadata.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          await metadata.body?.cancel()
          continue
        }
        const parsed = OAuthProtectedResourceMetadataSchema.safeParse(await metadata.json())
        // RFC 9728 §§3.3, 6: exact string equality, not an origin/prefix/host alias.
        if (!parsed.success || parsed.data.resource !== resource) continue
        verified = { url: metadataUrl, body: JSON.stringify(parsed.data) }
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` },
        })
      } catch (error) {
        if (init.signal?.aborted) throw error
        // A missing, malformed or unavailable candidate can fall back to the root.
      }
    }
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_SIGN_IN_METADATA_MISSING",
      "This server returns a redirect or login page and publishes no valid sign-in information for this MCP URL. Configure the connection manually or ask the server administrator.",
    )
  }
}
