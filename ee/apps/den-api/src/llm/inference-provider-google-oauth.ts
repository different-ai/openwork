import { OAuthTokenExchangeError, parseOAuthTokenResponse } from "../capability-sources/generic-oauth.js"

/**
 * Google authorization-code + PKCE plumbing for per-member inference provider
 * credentials (plan §5.6). The OAuth client is the customer's own, stored on
 * the `inference_providers` row; this module never reads the database.
 */

export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
export const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

/** models.dev provider ids whose per-member credential is a Google OAuth token. */
export const GOOGLE_OAUTH_INFERENCE_PROVIDER_IDS = ["google-vertex", "google-vertex-anthropic"] as const

export function isGoogleOAuthInferenceProviderId(providerId: string) {
  return GOOGLE_OAUTH_INFERENCE_PROVIDER_IDS.some((entry) => entry === providerId)
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (url, init) => fetch(url, init)
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

export function buildGoogleAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /** Google Workspace domain hint (`hd`); omitted when the org has no single known domain. */
  hostedDomain?: string
}) {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL)
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", GOOGLE_CLOUD_PLATFORM_SCOPE)
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("include_granted_scopes", "true")
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  if (input.hostedDomain) {
    url.searchParams.set("hd", input.hostedDomain)
  }
  return url.toString()
}

function readOAuthErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const record: Record<string, unknown> = { ...body }
  const error = typeof record.error === "string" ? record.error : null
  const description = typeof record.error_description === "string" ? record.error_description : null
  if (!error) return null
  return description ? `${error}: ${description}` : error
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetchImpl?: FetchLike
}) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  })
  let response: Response
  try {
    response = await (input.fetchImpl ?? defaultFetch)(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new OAuthTokenExchangeError("Google's token endpoint could not be reached.", "oauth_token_endpoint_unreachable")
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const detail = readOAuthErrorMessage(body)
    throw new OAuthTokenExchangeError(
      `Google rejected the OAuth token exchange${detail ? ` (${detail})` : ""}. Try Connect again.`,
      "oauth_token_exchange_failed",
      { httpStatus: response.status, ...(detail ? { providerOAuthError: detail } : {}) },
    )
  }
  return parseOAuthTokenResponse(body)
}

/** Best-effort revocation at Google; a failure is logged by the caller, never surfaced. */
export async function revokeGoogleToken(input: { token: string; fetchImpl?: FetchLike }): Promise<boolean> {
  try {
    const response = await (input.fetchImpl ?? defaultFetch)(GOOGLE_OAUTH_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: input.token }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
