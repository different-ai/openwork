import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { NativeOAuthProviderConfig } from "./provider-registry.js"
import {
  getConnectedAccount,
  getOrgOAuthClient,
  upsertConnectedAccount,
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

function base64UrlEncode(input: Buffer | string) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64url")
}

/**
 * The origin an external OAuth server should redirect back to. Behind a
 * reverse proxy (e.g. Daytona's port-forwarding proxy), `request.url`
 * reflects the *internal* bind address (http://127.0.0.1:8788) rather than
 * the public URL the browser actually called, since the proxy doesn't
 * rewrite the request's own URL — only `DEN_API_PUBLIC_URL`, when set,
 * reliably gives the real public origin in that case.
 */
export function resolvePublicOrigin(request: Request, apiPublicUrl: string | undefined): string {
  if (apiPublicUrl) {
    return new URL(apiPublicUrl).origin
  }
  return new URL(request.url).origin
}

export function createPkcePair() {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

type OAuthStatePayload = {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerId: string
  nonce: string
  exp: number
}

export function createOAuthStateToken(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerId: string
  secret: string
  ttlSeconds?: number
  now?: number
}) {
  const nowMs = input.now ?? Date.now()
  const payload: OAuthStatePayload = {
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.providerId,
    nonce: randomUUID(),
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
      || typeof payload.nonce !== "string"
      || typeof payload.exp !== "number"
      || payload.exp < nowSeconds
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
  const url = new URL(input.provider.authorizeUrl)
  url.searchParams.set("client_id", input.client.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", input.provider.defaultScopes.join(" "))
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

export class OAuthTokenExchangeError extends Error {}

async function postTokenRequest(tokenUrl: string, params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!response.ok) {
    throw new OAuthTokenExchangeError(`Token request failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`)
  }
  return body as TokenResponse
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
  return postTokenRequest(input.provider.tokenUrl, params)
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
  return postTokenRequest(input.provider.tokenUrl, params)
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
  const updated = await upsertConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.provider.providerId,
    accessToken: refreshed.access_token,
    // Most providers (Google included) omit refresh_token on refresh responses; keep the existing one.
    refreshToken: refreshed.refresh_token ?? account.refreshToken,
    tokenType: refreshed.token_type ?? account.tokenType,
    expiresAt,
  })
  return { accessToken: updated.accessToken!, account: updated }
}
