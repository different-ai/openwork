import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { env } from "../env.js"
import { publicRequestUrl } from "../request-url.js"
import { clientSelectedFeatures, resolveProviderScopes, type NativeOAuthProviderConfig } from "./provider-registry.js"
import { readProviderTenantId, resolveTenantEndpointTemplate } from "./oauth-tenant.js"
import {
  getConnectedAccount,
  getOrgOAuthClient,
  refreshConnectedAccountForActiveMember,
  type ConnectedAccountRow,
  type OrgOAuthClientRow,
} from "./oauth-credentials.js"

/**
 * A single, provider-agnostic classic-OAuth2 (authorization code + PKCE)
 * driver. Every native provider (google-workspace today, anything else we
 * implement natively later) goes through this exact same code — only the
 * registry entry (authorizeUrl/tokenUrl/scopes) differs per provider.
 */

const TOKEN_EXPIRY_SAFETY_WINDOW_MS = 60_000
const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024

function base64UrlEncode(input: Buffer | string) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64url")
}

/**
 * The public API base URL an external OAuth server should redirect back to.
 * A configured pathname is preserved for self-hosted deployments that expose
 * Den behind a prefix such as `/api/den`. Behind a
 * reverse proxy (e.g. Daytona's port-forwarding proxy), `request.url`
 * reflects the *internal* bind address (http://127.0.0.1:8788) rather than
 * the public URL the browser actually called, since the proxy doesn't
 * rewrite the request's own URL — `x-forwarded-proto` can correct the
 * scheme, while `DEN_API_PUBLIC_URL`, when set, is still needed when the
 * proxy does not preserve the public host.
 */
export function resolvePublicApiBaseUrl(request: Request, apiPublicUrl: string | undefined): string {
  if (apiPublicUrl) {
    const url = new URL(apiPublicUrl)
    const pathname = url.pathname.replace(/\/+$/, "")
    return `${url.origin}${pathname === "/" ? "" : pathname}`
  }
  return publicRequestUrl(request, { trustedOrigins: env.publicUrlTrustedOrigins }).origin
}

/** Compatibility name retained for existing callback and webhook builders. */
export const resolvePublicOrigin = resolvePublicApiBaseUrl

export function createPkcePair() {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export type OAuthStatePayload = {
  version?: 1 | 2
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerId: string
  binding?: string
  callbackMode?: "shared-v1" | "legacy-v1"
  authorizationServerIssuer?: string
  nonce: string
  iat?: number
  exp: number
}

export function createOAuthStateToken(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerId: string
  binding?: string
  version?: 1 | 2
  callbackMode?: "shared-v1" | "legacy-v1"
  authorizationServerIssuer?: string
  secret: string
  ttlSeconds?: number
  now?: number
}) {
  const nowMs = input.now ?? Date.now()
  const payload: OAuthStatePayload = {
    ...(input.version ? { version: input.version } : {}),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.providerId,
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.callbackMode ? { callbackMode: input.callbackMode } : {}),
    ...(input.authorizationServerIssuer ? { authorizationServerIssuer: input.authorizationServerIssuer } : {}),
    nonce: randomUUID(),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + (input.ttlSeconds ?? 10 * 60),
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = base64UrlEncode(createHmac("sha256", input.secret).update(encodedPayload).digest())
  return `${encodedPayload}.${signature}`
}

export function verifyOAuthStateToken(input: { token: string; secret: string; now?: number }): OAuthStatePayload | null {
  const [encodedPayload, encodedSignature] = input.token.split(".")
  if (!encodedPayload || !encodedSignature) return null

  const expectedSignature = createHmac("sha256", input.secret).update(encodedPayload).digest()
  const providedSignature = Buffer.from(encodedSignature, "base64url")
  const expectedBytes = new Uint8Array(expectedSignature)
  const providedBytes = new Uint8Array(providedSignature)
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<OAuthStatePayload>
    const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000)
    if (
      typeof payload.organizationId !== "string"
      || typeof payload.orgMembershipId !== "string"
      || typeof payload.providerId !== "string"
      || (payload.binding !== undefined && typeof payload.binding !== "string")
      || (payload.version !== undefined && payload.version !== 1 && payload.version !== 2)
      || (payload.callbackMode !== undefined && payload.callbackMode !== "shared-v1" && payload.callbackMode !== "legacy-v1")
      || (payload.authorizationServerIssuer !== undefined && typeof payload.authorizationServerIssuer !== "string")
      || typeof payload.nonce !== "string"
      || (payload.iat !== undefined && typeof payload.iat !== "number")
      || typeof payload.exp !== "number"
      || payload.exp < nowSeconds
      || (payload.version === 2 && (
        typeof payload.binding !== "string"
        || (payload.callbackMode !== "shared-v1" && payload.callbackMode !== "legacy-v1")
        || typeof payload.iat !== "number"
      ))
    ) {
      return null
    }
    return payload as OAuthStatePayload
  } catch {
    return null
  }
}

export function buildAuthorizeUrl(input: {
  provider: NativeOAuthProviderConfig
  client: OrgOAuthClientRow
  state: string
  redirectUri: string
  codeChallenge?: string
}) {
  const url = new URL(resolveOAuthEndpointUrl({ provider: input.provider, client: input.client, endpoint: "authorize" }))
  url.searchParams.set("client_id", input.client.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", resolveProviderScopes(input.provider, clientSelectedFeatures(input.provider, input.client.extra)).join(" "))
  url.searchParams.set("state", input.state)
  if (input.provider.usesPkce && input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")
  }
  for (const [key, value] of Object.entries(input.provider.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().nonnegative().optional(),
  token_type: z.string().min(1).optional(),
  scope: z.string().optional(),
})

const oauthErrorResponseSchema = z.object({
  error: z.string().trim().min(1).max(128),
  error_description: z.string().max(4_096).optional(),
  error_codes: z.array(z.number().int()).max(16).optional(),
  trace_id: z.string().uuid().optional(),
  correlation_id: z.string().uuid().optional(),
  timestamp: z.string().max(64).optional(),
})

export type OAuthTokenExchangeFailureCode =
  | "oauth_invalid_client_secret"
  | "oauth_invalid_client"
  | "oauth_invalid_grant"
  | "oauth_invalid_scope"
  | "oauth_access_denied"
  | "oauth_provider_unavailable"
  | "oauth_token_response_invalid"
  | "oauth_token_response_oversized"
  | "oauth_token_endpoint_unreachable"
  | "oauth_token_exchange_failed"

export class OAuthTokenExchangeError extends Error {
  readonly phase = "AUTH_TOKEN_ACQUISITION"

  constructor(
    message: string,
    readonly code: OAuthTokenExchangeFailureCode = "oauth_token_exchange_failed",
    readonly details: {
      httpStatus?: number
      providerOAuthError?: string
      providerErrorCode?: number
      providerTraceId?: string
      providerCorrelationId?: string
      providerTimestamp?: string
    } = {},
  ) {
    super(message)
    this.name = "OAuthTokenExchangeError"
  }
}
export class OAuthClientConfigurationError extends Error {}

export function oauthTokenExchangeErrorFromResponse(input: {
  provider: NativeOAuthProviderConfig
  status: number
  body: unknown
}): OAuthTokenExchangeError {
  const parsed = oauthErrorResponseSchema.safeParse(input.body)
  if (!parsed.success) {
    return new OAuthTokenExchangeError(
      `${input.provider.displayName} rejected the OAuth token exchange. Try Connect again; if it still fails, contact support with the diagnostic reference.`,
      "oauth_token_exchange_failed",
      { httpStatus: input.status },
    )
  }

  const providerErrorCode = parsed.data.error_codes?.[0]
  const details = {
    httpStatus: input.status,
    providerOAuthError: parsed.data.error,
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(parsed.data.trace_id ? { providerTraceId: parsed.data.trace_id } : {}),
    ...(parsed.data.correlation_id ? { providerCorrelationId: parsed.data.correlation_id } : {}),
    ...(parsed.data.timestamp ? { providerTimestamp: parsed.data.timestamp } : {}),
  }

  if (parsed.data.error === "invalid_client") {
    if (input.provider.providerId === "microsoft-365" && providerErrorCode === 7_000_215) {
      return new OAuthTokenExchangeError(
        "Microsoft rejected the client secret during OAuth token exchange (AADSTS7000215). An organization administrator should replace the client secret value and try Connect again.",
        "oauth_invalid_client_secret",
        details,
      )
    }
    return new OAuthTokenExchangeError(
      `${input.provider.displayName} rejected the OAuth client credentials during token exchange. An organization administrator should verify the client ID and client secret value, then try Connect again.`,
      "oauth_invalid_client",
      details,
    )
  }

  if (parsed.data.error === "invalid_grant") {
    return new OAuthTokenExchangeError(
      `${input.provider.displayName} rejected the authorization grant during token exchange. Restart Connect and complete a new authorization attempt.`,
      "oauth_invalid_grant",
      details,
    )
  }

  if (parsed.data.error === "invalid_scope") {
    return new OAuthTokenExchangeError(
      `${input.provider.displayName} rejected the requested OAuth permissions. An organization administrator should review the configured permissions and consent, then try Connect again.`,
      "oauth_invalid_scope",
      details,
    )
  }

  if (parsed.data.error === "access_denied") {
    return new OAuthTokenExchangeError(
      `${input.provider.displayName} denied the OAuth authorization request. Review consent and tenant policy, then try Connect again.`,
      "oauth_access_denied",
      details,
    )
  }

  if (parsed.data.error === "server_error" || parsed.data.error === "temporarily_unavailable") {
    return new OAuthTokenExchangeError(
      `${input.provider.displayName} could not complete the OAuth token exchange because the provider was unavailable. Try Connect again later.`,
      "oauth_provider_unavailable",
      details,
    )
  }

  return new OAuthTokenExchangeError(
    `${input.provider.displayName} rejected the OAuth token exchange. Try Connect again; if it still fails, contact support with the diagnostic reference.`,
    "oauth_token_exchange_failed",
    details,
  )
}

export function parseOAuthTokenResponse(value: unknown): TokenResponse {
  const parsed = tokenResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new OAuthTokenExchangeError(
      "The token endpoint returned an invalid OAuth response.",
      "oauth_token_response_invalid",
    )
  }
  return parsed.data
}

async function readBoundedTokenResponse(response: Response): Promise<string> {
  const declaredBytes = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredBytes) && declaredBytes > TOKEN_RESPONSE_MAX_BYTES) {
    throw new OAuthTokenExchangeError(
      "The token endpoint response exceeded the allowed size.",
      "oauth_token_response_oversized",
    )
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    totalBytes += result.value.byteLength
    if (totalBytes > TOKEN_RESPONSE_MAX_BYTES) {
      await reader.cancel()
      throw new OAuthTokenExchangeError(
        "The token endpoint response exceeded the allowed size.",
        "oauth_token_response_oversized",
      )
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export function resolveOAuthEndpointUrl(input: {
  provider: NativeOAuthProviderConfig
  client: OrgOAuthClientRow
  endpoint: "authorize" | "token"
}): string {
  const template = input.endpoint === "authorize" ? input.provider.authorizeUrl : input.provider.tokenUrl
  const tenantIdExtraKey = input.provider.tenantIdExtraKey
  if (!tenantIdExtraKey) return template

  const tenantId = readProviderTenantId(input.client.extra, tenantIdExtraKey)
  if (!tenantId) {
    throw new OAuthClientConfigurationError(`${input.provider.displayName} requires a valid tenant ID or verified tenant domain.`)
  }
  try {
    return resolveTenantEndpointTemplate(template, tenantId)
  } catch (error) {
    throw new OAuthClientConfigurationError(error instanceof Error ? error.message : "Tenant-scoped OAuth endpoint is invalid.")
  }
}

async function postTokenRequest(input: {
  provider: NativeOAuthProviderConfig
  tokenUrl: string
  params: URLSearchParams
}): Promise<TokenResponse> {
  let response: Response
  try {
    response = await fetch(input.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: input.params,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new OAuthTokenExchangeError(
      `${input.provider.displayName} token endpoint could not be reached before the request deadline.`,
      "oauth_token_endpoint_unreachable",
    )
  }

  const text = await readBoundedTokenResponse(response)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!response.ok) {
    throw oauthTokenExchangeErrorFromResponse({
      provider: input.provider,
      status: response.status,
      body,
    })
  }
  return parseOAuthTokenResponse(body)
}

export async function exchangeCodeForTokens(input: {
  provider: NativeOAuthProviderConfig
  client: OrgOAuthClientRow
  code: string
  redirectUri: string
  codeVerifier?: string
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.clientId,
  })
  if (input.client.clientSecret) params.set("client_secret", input.client.clientSecret)
  if (input.provider.usesPkce && input.codeVerifier) params.set("code_verifier", input.codeVerifier)
  return postTokenRequest({
    provider: input.provider,
    tokenUrl: resolveOAuthEndpointUrl({ provider: input.provider, client: input.client, endpoint: "token" }),
    params,
  })
}

async function refreshTokens(input: {
  provider: NativeOAuthProviderConfig
  client: OrgOAuthClientRow
  refreshToken: string
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
  })
  if (input.client.clientSecret) params.set("client_secret", input.client.clientSecret)
  return postTokenRequest({
    provider: input.provider,
    tokenUrl: resolveOAuthEndpointUrl({ provider: input.provider, client: input.client, endpoint: "token" }),
    params,
  })
}

/**
 * Returns a valid, unexpired access token for the calling member's
 * connected account, refreshing it (and persisting the refresh) if needed.
 * This is the one function every native capability route calls — none of
 * them touch tokens, expiry, or the client credential directly.
 */
export async function getValidAccessToken(input: {
  provider: NativeOAuthProviderConfig
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<{ accessToken: string; account: ConnectedAccountRow } | { error: "not_connected" | "client_not_configured" }> {
  const account = await getConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.provider.providerId,
  })
  if (!account || !account.accessToken) {
    return { error: "not_connected" }
  }

  const stillValid = !account.expiresAt || account.expiresAt.getTime() - TOKEN_EXPIRY_SAFETY_WINDOW_MS > Date.now()
  if (stillValid) {
    return { accessToken: account.accessToken, account }
  }

  if (!account.refreshToken) {
    return { error: "not_connected" }
  }

  const client = await getOrgOAuthClient(input.organizationId, input.provider.providerId)
  if (!client) {
    return { error: "client_not_configured" }
  }

  const refreshed = await refreshTokens({ provider: input.provider, client, refreshToken: account.refreshToken })
  const expiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null
  const updated = await refreshConnectedAccountForActiveMember({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.provider.providerId,
    expectedAccountId: account.id,
    expectedAccessToken: account.accessToken,
    expectedRefreshToken: account.refreshToken,
    accessToken: refreshed.access_token,
    // Most providers (Google included) omit refresh_token on refresh responses; keep the existing one.
    refreshToken: refreshed.refresh_token ?? account.refreshToken,
    tokenType: refreshed.token_type ?? account.tokenType,
    expiresAt,
  })
  if (updated?.accessToken) {
    return { accessToken: updated.accessToken, account: updated }
  }

  // Another in-flight refresh may have won the compare-and-set. Reuse its
  // fresh token, but never recreate a row deleted by disconnect/removal/rotation.
  const current = await getConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.provider.providerId,
  })
  if (
    current?.accessToken
    && (!current.expiresAt || current.expiresAt.getTime() - TOKEN_EXPIRY_SAFETY_WINDOW_MS > Date.now())
  ) {
    return { accessToken: current.accessToken, account: current }
  }
  return { error: "not_connected" }
}
