import { z } from "zod"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client"

const CREDENTIAL_QUERY_PARTS = ["secret", "password", "passwd", "credential", "tokenhint", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "apikey", "authorization", "assertion", "signature", "privatekey", "codeverifier"]
const CREDENTIAL_QUERY_SUFFIXES = ["token", "authcode", "sig"]
const CREDENTIAL_QUERY_KEYS = new Set(["key", "auth", "state", "nonce", "code"])

function hasCredentialQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => {
    // URLSearchParams decodes ordinary encoded keys. Also handle nested encoding
    // without ever inspecting, logging or returning the credential value.
    let decoded = key
    for (let round = 0; round < 2; round += 1) {
      try { decoded = decodeURIComponent(decoded) } catch { break }
    }
    const normalized = decoded.toLowerCase().replace(/[^a-z]/g, "")
    return CREDENTIAL_QUERY_KEYS.has(normalized) || CREDENTIAL_QUERY_PARTS.some((part) => normalized.includes(part))
      || CREDENTIAL_QUERY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  })
}

/** Static administrator configuration, never populated from discovery at runtime. */
export const manualOAuthEndpointSchema = z.string().trim().url().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    return !url.username && !url.password && !url.hash && !hasCredentialQuery(url)
      && (url.protocol === "https:" || (url.protocol === "http:" && loopback))
  } catch { return false }
}, "Use HTTPS (HTTP is allowed only on localhost), without URL credentials, fragments or credential-like query parameters.").transform((value) => new URL(value).href)

export const manualOAuthEndpointsSchema = z.object({
  authorizationEndpoint: manualOAuthEndpointSchema,
  tokenEndpoint: manualOAuthEndpointSchema,
}).strict()

export type ManualOAuthEndpoints = z.infer<typeof manualOAuthEndpointsSchema>

/** SDK adapter for a static endpoint tuple. This is not discovered metadata. */
export function manualOAuthState(endpoints: ManualOAuthEndpoints, resource: string): OAuthDiscoveryState {
  const issuer = new URL(endpoints.authorizationEndpoint).origin
  return {
    authorizationServerUrl: issuer,
    resourceMetadata: { resource, authorization_servers: [issuer] },
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: endpoints.authorizationEndpoint,
      token_endpoint: endpoints.tokenEndpoint,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    },
  }
}

// These labels are display-only, never authorization-server identifiers for use.
export function safeOAuthIssuerLabel(value: string | undefined): string {
  if (!value) return "an unspecified address"
  try { const url = new URL(value); return `${url.origin}${url.pathname}` } catch { return "an invalid address" }
}

export function oauthIssuerMismatchMessage(expected: string | undefined, received: string | undefined): string {
  return `This server's sign-in information is inconsistent: it names ${safeOAuthIssuerLabel(expected)} as its sign-in service, but that service identifies itself as ${safeOAuthIssuerLabel(received)}. OpenWork stopped for security. Ask the server owner to fix it, or enter the sign-in addresses manually under Sign-in addresses in the connection settings.`
}
