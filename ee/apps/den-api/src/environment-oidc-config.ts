import { z } from "zod"

// Operator configuration only: product availability is resolved separately through
// environmentOidc, including on callbacks and account-linking endpoints.
export function readEnvironmentOidcConfig(values: Record<string, string | undefined>, devMode = false) {
  const text = (key: string) => values[key]?.trim() || undefined
  const clientId = text("OIDC_CLIENT_ID")
  const clientSecret = text("OIDC_CLIENT_SECRET")
  const issuerInput = text("OIDC_ISSUER_URL")
  if (!clientId && !clientSecret && !issuerInput) return null
  if (!clientId || !clientSecret || !issuerInput) {
    throw new Error("OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_ISSUER_URL must be configured together")
  }
  const providerId = text("OIDC_PROVIDER_ID") ?? "oidc"
  // Namespace avoids collisions with built-in providers, credential accounts and
  // dynamically registered organization SSO identities. It is part of account IDs.
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(providerId)) throw new Error("OIDC_PROVIDER_ID must be a lowercase identifier of at most 48 characters")
  const name = text("OIDC_PROVIDER_NAME") ?? "SSO"
  if (name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("OIDC_PROVIDER_NAME must be plain text of at most 80 characters")
  const issuer = oidcEndpoint(issuerInput, "OIDC_ISSUER_URL", devMode)
  const scopes = [...new Set((text("OIDC_SCOPES") ?? "openid,email,profile").split(/[ ,]+/).filter(Boolean))]
  if (!scopes.includes("openid") || !scopes.includes("email")) throw new Error("OIDC_SCOPES must include openid and email")
  const pkce = text("OIDC_PKCE") ?? "true"
  if (pkce !== "true" && pkce !== "false") throw new Error("OIDC_PKCE must be true or false")
  const authentication = text("OIDC_TOKEN_AUTH_METHOD") ?? "client_secret_basic"
  if (authentication !== "client_secret_basic" && authentication !== "client_secret_post") throw new Error("OIDC_TOKEN_AUTH_METHOD must be client_secret_basic or client_secret_post")
  const authorizationUrl = text("OIDC_AUTHORIZATION_ENDPOINT")
  const tokenUrl = text("OIDC_TOKEN_ENDPOINT")
  const jwksUrl = text("OIDC_JWKS_ENDPOINT")
  if ([authorizationUrl, tokenUrl, jwksUrl].some(Boolean) && ![authorizationUrl, tokenUrl, jwksUrl].every(Boolean)) {
    throw new Error("Explicit OIDC endpoints require OIDC_AUTHORIZATION_ENDPOINT, OIDC_TOKEN_ENDPOINT and OIDC_JWKS_ENDPOINT together")
  }
  return {
    providerId: `env-oidc-${providerId}`,
    name,
    clientId,
    clientSecret,
    issuer,
    discoveryUrl: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    scopes,
    pkce: pkce === "true",
    authentication,
    devMode,
    endpoints: authorizationUrl && tokenUrl && jwksUrl ? {
      authorizationUrl: oidcEndpoint(authorizationUrl, "OIDC_AUTHORIZATION_ENDPOINT", devMode),
      tokenUrl: oidcEndpoint(tokenUrl, "OIDC_TOKEN_ENDPOINT", devMode),
      jwksUrl: oidcEndpoint(jwksUrl, "OIDC_JWKS_ENDPOINT", devMode),
    } : null,
  }
}

export type EnvironmentOidcConfig = NonNullable<ReturnType<typeof readEnvironmentOidcConfig>>

export function oidcEndpoint(value: string, label: string, devMode: boolean) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} must be an absolute HTTPS URL`) }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(devMode && loopback && url.protocol === "http:")) throw new Error(`${label} must use HTTPS (HTTP is allowed only on loopback in development)`)
  if (url.username || url.password || url.search || url.hash) throw new Error(`${label} cannot contain credentials, query parameters or a fragment`)
  return value
}

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  id_token_signing_alg_values_supported: z.array(z.string()).min(1),
})

export async function discoverEnvironmentOidc(config: EnvironmentOidcConfig) {
  if (config.endpoints) return { ...config.endpoints, algorithms: ["RS256", "PS256", "ES256", "EdDSA"] }
  const response = await fetch(config.discoveryUrl, { signal: AbortSignal.timeout(10_000), redirect: "error" })
  if (!response.ok) throw new Error("OIDC discovery failed")
  const discovered = discoverySchema.parse(await response.json())
  // Exact issuer matching is required by OIDC, including path and trailing slash.
  if (discovered.issuer !== config.issuer) throw new Error("OIDC discovery issuer does not match OIDC_ISSUER_URL")
  const algorithms = discovered.id_token_signing_alg_values_supported.filter((alg) => ["RS256", "PS256", "ES256", "EdDSA"].includes(alg))
  if (!algorithms.length) throw new Error("OIDC discovery must advertise a supported asymmetric signing algorithm")
  return {
    authorizationUrl: oidcEndpoint(discovered.authorization_endpoint, "OIDC discovery authorization endpoint", config.devMode),
    tokenUrl: oidcEndpoint(discovered.token_endpoint, "OIDC discovery token endpoint", config.devMode),
    jwksUrl: oidcEndpoint(discovered.jwks_uri, "OIDC discovery JWKS endpoint", config.devMode),
    algorithms,
  }
}
