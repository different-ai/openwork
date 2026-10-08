/**
 * Member Entra ID sign-in for Microsoft Foundry: authorization code + PKCE with
 * the organization's own confidential app registration. The Gateway renews the
 * access token with the stored refresh token (see gateway credentials/oauth-refresh).
 */
import { createHmac } from "node:crypto"
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose"
import { classifyMicrosoftTokenError, MICROSOFT_SIGN_IN_SCOPES, microsoftAuthorizeUrl, microsoftIssuer, microsoftJwksUrl, microsoftTokenUrl, readMicrosoftTokens, type MicrosoftTokens } from "@openwork-ee/utils/microsoft-entra"
import { OAuthTokenExchangeError } from "../capability-sources/generic-oauth.js"
import type { FetchLike } from "./inference-provider-google-oauth.js"

const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const defaultFetch: FetchLike = (url, init) => fetch(url, init)
const keySets = new Map<string, JWTVerifyGetKey>()

export function microsoftOAuthNonce(verifier: string, state: string) {
  return createHmac("sha256", verifier).update(`gateway-microsoft-oidc-v1:${state}`).digest("base64url")
}

export function buildMicrosoftAuthorizeUrl(input: { tenantId: string; clientId: string; redirectUri: string; state: string; codeChallenge: string; nonce: string }) {
  const url = new URL(microsoftAuthorizeUrl(input.tenantId))
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("response_mode", "query")
  url.searchParams.set("scope", MICROSOFT_SIGN_IN_SCOPES)
  // Always show the account picker so "Switch account" can choose another work account.
  url.searchParams.set("prompt", "select_account")
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  url.searchParams.set("nonce", input.nonce)
  return url.toString()
}

export type MicrosoftAuthorizationTokens = MicrosoftTokens & { refreshToken: string; idToken: string }

export async function exchangeMicrosoftAuthorizationCode(input: {
  tenantId: string
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetchImpl?: FetchLike
}): Promise<MicrosoftAuthorizationTokens> {
  const params = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri,
    client_id: input.clientId, client_secret: input.clientSecret, code_verifier: input.codeVerifier, scope: MICROSOFT_SIGN_IN_SCOPES })
  let response: Response
  try {
    response = await (input.fetchImpl ?? defaultFetch)(microsoftTokenUrl(input.tenantId), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS), redirect: "error",
    })
  } catch {
    throw new OAuthTokenExchangeError("Microsoft's token endpoint could not be reached.", "oauth_token_endpoint_unreachable")
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const kind = classifyMicrosoftTokenError(response.status, body)
    const code = kind === "invalid_client" ? "oauth_invalid_client" : kind === "invalid_grant" ? "oauth_invalid_grant" : kind === "token_endpoint_unavailable" ? "oauth_token_endpoint_unavailable" : "oauth_token_exchange_failed"
    throw new OAuthTokenExchangeError(kind === "invalid_client"
      ? "An administrator must repair this credential set's Microsoft app registration: check the client ID and that the client secret has not expired."
      : "Microsoft could not complete sign-in. Start Connect again.", code, { httpStatus: response.status })
  }
  const tokens = readMicrosoftTokens(body)
  if (!tokens || !tokens.idToken) throw new OAuthTokenExchangeError("Microsoft returned an invalid token response. Sign in again.", "oauth_token_response_invalid")
  if (!tokens.refreshToken) throw new OAuthTokenExchangeError("Microsoft did not grant offline access. Ask your administrator to allow the offline_access permission, then Connect again.", "oauth_refresh_token_required")
  return { ...tokens, refreshToken: tokens.refreshToken, idToken: tokens.idToken }
}

function tenantKeys(tenantId: string): JWTVerifyGetKey {
  const key = tenantId.toLowerCase()
  let keys = keySets.get(key)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(microsoftJwksUrl(key)), { timeoutDuration: 5_000 })
    keySets.set(key, keys)
  }
  return keys
}

export type MicrosoftIdentity = { tenantId: string; objectId: string; userName: string | null; clientId: string }

/** Verifies the ID token was issued by the configured tenant to this app for this sign-in attempt. */
export async function verifyMicrosoftIdentity(input: { idToken: string; tenantId: string; clientId: string; nonce: string; keyResolver?: JWTVerifyGetKey }): Promise<MicrosoftIdentity> {
  const tenantId = input.tenantId.toLowerCase()
  const resolveKey: JWTVerifyGetKey = async (...args) => {
    try { return await (input.keyResolver ?? tenantKeys(tenantId))(...args) } catch (error) {
      if (error instanceof errors.JWKSTimeout || error instanceof TypeError
        || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
        throw new OAuthTokenExchangeError("Microsoft account verification is temporarily unavailable. Try Connect again later.", "oauth_identity_unavailable")
      }
      throw error
    }
  }
  try {
    const { payload } = await jwtVerify(input.idToken, resolveKey, {
      algorithms: ["RS256"],
      issuer: microsoftIssuer(tenantId),
      audience: input.clientId,
      requiredClaims: ["sub", "iss", "aud", "exp", "iat", "nonce", "oid", "tid"],
      maxTokenAge: "1h",
    })
    if (typeof payload.tid !== "string" || payload.tid.toLowerCase() !== tenantId || payload.nonce !== input.nonce
      || typeof payload.oid !== "string" || !payload.oid.trim() || payload.oid.length > 255
      || (payload.azp !== undefined && payload.azp !== input.clientId)) throw new Error("invalid_claims")
    const name = [payload.preferred_username, payload.email, payload.upn].find((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 320)
    return { tenantId, objectId: payload.oid, userName: name ?? null, clientId: input.clientId }
  } catch (error) {
    if (error instanceof OAuthTokenExchangeError && error.code === "oauth_identity_unavailable") throw error
    throw new OAuthTokenExchangeError("Microsoft account verification failed. Start Connect again.", "oauth_identity_invalid")
  }
}
