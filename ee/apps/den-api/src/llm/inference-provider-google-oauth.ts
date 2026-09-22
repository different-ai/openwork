import { createHmac } from "node:crypto"
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose"
import { z } from "zod"
import { OAuthTokenExchangeError } from "../capability-sources/generic-oauth.js"

export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
export const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
export const GOOGLE_OAUTH_SCOPES = `openid email ${GOOGLE_CLOUD_PLATFORM_SCOPE}`
export const GOOGLE_OAUTH_MAX_EXPIRY_SECONDS = 86_400
export const GOOGLE_OAUTH_INFERENCE_PROVIDER_IDS = ["google-vertex", "google-vertex-anthropic"] as const

export function isGoogleOAuthInferenceProviderId(providerId: string) {
  return GOOGLE_OAUTH_INFERENCE_PROVIDER_IDS.some((entry) => entry === providerId)
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
const defaultFetch: FetchLike = (url, init) => fetch(url, init)
const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5_000 })

export function googleOAuthNonce(verifier: string, state: string) {
  return createHmac("sha256", verifier).update(`gateway-google-oidc-v1:${state}`).digest("base64url")
}

export function googleOAuthClientBinding(verifier: string, clientId: string, clientSecret: string) {
  return createHmac("sha256", verifier).update(JSON.stringify(["gateway-google-client-v1", clientId, clientSecret])).digest("base64url")
}

export const googleOAuthAttemptSchema = z.object({
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  userId: z.string().min(1),
  clientBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export function readGoogleOAuthAttempt(value: string) {
  try { return googleOAuthAttemptSchema.parse(JSON.parse(value)) } catch { return null }
}

export function buildGoogleAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  nonce: string
  hostedDomain?: string
}) {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL)
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES)
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("include_granted_scopes", "true")
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  url.searchParams.set("nonce", input.nonce)
  if (input.hostedDomain) url.searchParams.set("hd", input.hostedDomain)
  return url.toString()
}

const tokenString = z.string().min(1).max(16_384).regex(/^[\x21-\x7e]+$/)
export const googleBearerTokenSchema = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9._~+\/-]+=*$/)
const googleTokenSchema = z.object({
  access_token: googleBearerTokenSchema,
  refresh_token: tokenString.optional(),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive().max(GOOGLE_OAUTH_MAX_EXPIRY_SECONDS),
  scope: z.string().max(1024).optional(),
  id_token: tokenString,
})

export function parseGoogleAuthorizationTokens(body: unknown) {
  const result = googleTokenSchema.safeParse(body)
  if (!result.success) throw new OAuthTokenExchangeError("Google returned an invalid token response. Sign in again.", "oauth_token_response_invalid")
  const tokens = result.data
  if (tokens.scope !== undefined) {
    const scopes = new Set(tokens.scope.split(/\s+/))
    if (!scopes.has(GOOGLE_CLOUD_PLATFORM_SCOPE) || !scopes.has("openid") || !(scopes.has("email") || scopes.has("https://www.googleapis.com/auth/userinfo.email"))) {
      throw new OAuthTokenExchangeError("Allow the requested Google identity and Cloud permissions, then Connect again.", "oauth_scope_required")
    }
  }
  if (!tokens.refresh_token) throw new OAuthTokenExchangeError("Google did not grant offline access. Connect again and approve consent; if needed, remove the app's Google access first.", "oauth_refresh_token_required")
  return { ...tokens, refresh_token: tokens.refresh_token, scope: tokens.scope ?? GOOGLE_OAUTH_SCOPES }
}

export async function verifyGoogleIdentity(input: { idToken: string; clientId: string; nonce: string; keyResolver?: JWTVerifyGetKey }) {
  const resolveKey: JWTVerifyGetKey = async (...args) => {
    try { return await (input.keyResolver ?? googleKeys)(...args) } catch (error) {
      if (error instanceof errors.JWKSTimeout || error instanceof TypeError
        || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
        throw new OAuthTokenExchangeError("Google account verification is temporarily unavailable. Try Connect again later.", "oauth_identity_unavailable")
      }
      throw error
    }
  }
  try {
    const { payload } = await jwtVerify(input.idToken, resolveKey, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: input.clientId,
      requiredClaims: ["sub", "iss", "aud", "exp", "iat", "nonce", "email", "email_verified"],
      maxTokenAge: "1h",
    })
    if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 255
      || payload.nonce !== input.nonce || payload.email_verified !== true
      || typeof payload.email !== "string" || !z.email().safeParse(payload.email).success
      || (payload.azp !== undefined && payload.azp !== input.clientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== input.clientId)) throw new Error("invalid_claims")
    return { subject: payload.sub, email: payload.email, emailVerified: true as const, clientId: input.clientId }
  } catch (error) {
    if (error instanceof OAuthTokenExchangeError && error.code === "oauth_identity_unavailable") throw error
    throw new OAuthTokenExchangeError("Google account verification failed. Start Connect again.", "oauth_identity_invalid")
  }
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetchImpl?: FetchLike
}) {
  const params = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri,
    client_id: input.clientId, client_secret: input.clientSecret, code_verifier: input.codeVerifier })
  let response: Response
  try {
    response = await (input.fetchImpl ?? defaultFetch)(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS), redirect: "error",
    })
  } catch {
    throw new OAuthTokenExchangeError("Google's token endpoint could not be reached.", "oauth_token_endpoint_unreachable")
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = z.object({ error: z.string(), error_subtype: z.string().optional() }).safeParse(body)
    const code = error.success && error.data.error === "invalid_client" ? "oauth_invalid_client"
      : error.success && error.data.error === "invalid_grant" ? error.data.error_subtype === "invalid_rapt" ? "oauth_reauthentication_required" : "oauth_invalid_grant"
      : response.status === 429 || response.status >= 500 ? "oauth_token_endpoint_unavailable" : "oauth_token_exchange_failed"
    throw new OAuthTokenExchangeError(code === "oauth_invalid_client" ? "An administrator must repair this credential set's Google OAuth client." : "Google could not complete authorization. Start Connect again.", code, { httpStatus: response.status })
  }
  return parseGoogleAuthorizationTokens(body)
}

export async function revokeGoogleToken(input: { token: string; fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<boolean> {
  let outcome: "succeeded" | "rejected" | "unavailable" = "unavailable"
  try {
    const response = await (input.fetchImpl ?? defaultFetch)(GOOGLE_OAUTH_REVOKE_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: input.token }),
      signal: input.signal ?? AbortSignal.timeout(5_000), redirect: "error",
    })
    outcome = response.ok ? "succeeded" : "rejected"
    return response.ok
  } catch { return false } finally {
    console.info("gateway_google_revocation", { outcome })
  }
}
