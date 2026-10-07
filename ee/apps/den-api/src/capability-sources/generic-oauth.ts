import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { env } from "../env.js"
import { publicRequestUrl } from "../request-url.js"
import { clientSelectedFeatures, resolveProviderScopes, type NativeOAuthProviderConfig } from "./provider-registry.js"
import { readProviderTenantId, resolveTenantEndpointTemplate } from "./oauth-tenant.js"
import {
  getConnectedAccount,
  refreshConnectedAccountForActiveMember,
  type ConnectedAccountRow,
} from "./oauth-credentials.js"
import { getNativeOAuthClient, type NativeOAuthClient } from "./native-oauth-client.js"
import { encodeSlackAccountIdentity, parseSlackAccountIdentity, slackCloudPolicyError } from "./slack-policy.js"

/**
 * Shared native OAuth authorization-code driver, with PKCE where supported.
 * Registry entries supply endpoints and permissions; Slack's standard OAuth
 * protocol additionally requires user_scope, grant-specific member token
 * envelopes, and verified workspace/member identity.
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
  callbackMode?: "shared-v1" | "isolated-v1" | "legacy-v1"
  authorizationServerIssuer?: string
  authorizationResponseIssuerRequired?: boolean
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
  callbackMode?: "shared-v1" | "isolated-v1" | "legacy-v1"
  authorizationServerIssuer?: string
  authorizationResponseIssuerRequired?: boolean
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
    ...(input.authorizationResponseIssuerRequired !== undefined
      ? { authorizationResponseIssuerRequired: input.authorizationResponseIssuerRequired }
      : {}),
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
      || (payload.callbackMode !== undefined && payload.callbackMode !== "shared-v1" && payload.callbackMode !== "isolated-v1" && payload.callbackMode !== "legacy-v1")
      || (payload.authorizationServerIssuer !== undefined && typeof payload.authorizationServerIssuer !== "string")
      || (payload.authorizationResponseIssuerRequired !== undefined && typeof payload.authorizationResponseIssuerRequired !== "boolean")
      || typeof payload.nonce !== "string"
      || (payload.iat !== undefined && typeof payload.iat !== "number")
      || typeof payload.exp !== "number"
      || payload.exp < nowSeconds
      || (payload.version === 2 && (
        typeof payload.binding !== "string"
        || (payload.callbackMode !== "shared-v1" && payload.callbackMode !== "isolated-v1" && payload.callbackMode !== "legacy-v1")
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
  client: NativeOAuthClient
  state: string
  redirectUri: string
  codeChallenge?: string
}) {
  const url = new URL(resolveOAuthEndpointUrl({ provider: input.provider, client: input.client, endpoint: "authorize" }))
  url.searchParams.set("client_id", input.client.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  const scopes = resolveProviderScopes(input.provider, clientSelectedFeatures(input.provider, input.client.extra))
  if (input.provider.providerId === "slack") {
    url.searchParams.delete("scope")
    url.searchParams.set("user_scope", scopes.join(","))
  } else {
    url.searchParams.set("scope", scopes.join(" "))
  }
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
  id_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  slackWorkspaceId?: string
  slackUserId?: string
  slackHomeGrant?: SlackHomeGrant
}

export type SlackHomeGrant = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
}

const slackBotGrantSchema = z.object({
  token_type: z.literal("bot"),
  access_token: z.string().trim().min(1),
  bot_user_id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/),
  team: z.object({ id: z.string().regex(/^T[A-Z0-9]{1,63}$/) }),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().nonnegative().optional(),
})

const slackTokenResponseSchema = z.object({
  ok: z.literal(true),
  is_enterprise_install: z.literal(false).optional(),
  team: z.object({ id: z.string().regex(/^T[A-Z0-9]{1,63}$/) }).optional(),
  authed_user: z.object({
    id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/).optional(),
    access_token: z.string().trim().min(1),
    token_type: z.literal("user"),
    scope: z.string().optional(),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().nonnegative().optional(),
  }),
})

const slackRefreshTokenResponseSchema = slackTokenResponseSchema.omit({ authed_user: true }).extend({
  id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/).optional(),
  access_token: z.string().trim().min(1),
  token_type: z.literal("user"),
  scope: z.string().optional(),
  refresh_token: z.string().min(1),
  expires_in: z.number().nonnegative(),
})

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional().catch(undefined),
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
  | "oauth_scope_required"
  | "oauth_refresh_token_required"
  | "oauth_identity_invalid"
  | "oauth_identity_unavailable"
  | "oauth_reauthentication_required"
  | "oauth_token_endpoint_unavailable"

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

export async function slackOAuthConfigurationIsCurrent(input: {
  organizationId: string
  client: NativeOAuthClient
}): Promise<boolean> {
  return !(await slackCloudPolicyError(input.organizationId))
    && env.slackClientId === input.client.clientId
    && env.slackClientSecret === input.client.clientSecret
}

const slackAuthTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().regex(/^T[A-Z0-9]{1,63}$/),
  user_id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/),
  is_enterprise_install: z.literal(false).optional(),
  bot_id: z.never().optional(),
})

/** Verify the member token itself; OAuth workspace hints are not authorization. */
export async function validateSlackTokenIdentity(tokens: TokenResponse, expectedAccountId?: string): Promise<string> {
  let body: unknown
  try {
    const response = await fetch(`${env.slackApiBaseUrl.replace(/\/+$/, "")}/auth.test`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    })
    if (!response.ok) throw new Error("identity_unavailable")
    body = JSON.parse(await readBoundedTokenResponse(response))
  } catch {
    // Provider content and credentials never enter the error or logs.
    throw new OAuthTokenExchangeError("Slack account identity could not be verified. Try Connect again.", "oauth_identity_unavailable")
  }
  const parsed = slackAuthTestSchema.safeParse(body)
  if (!parsed.success
    || (tokens.slackWorkspaceId !== undefined && tokens.slackWorkspaceId !== parsed.data.team_id)
    || (tokens.slackUserId !== undefined && tokens.slackUserId !== parsed.data.user_id)
  ) {
    throw new OAuthTokenExchangeError("Slack could not verify a matching workspace and member identity. Connect again.", "oauth_identity_invalid")
  }
  const identity = encodeSlackAccountIdentity({ workspaceId: parsed.data.team_id, userId: parsed.data.user_id })
  if (expectedAccountId !== undefined && identity !== expectedAccountId) {
    throw new OAuthTokenExchangeError("Slack account identity changed. Reconnect your account.", "oauth_identity_invalid")
  }
  return identity
}

export function resolveOAuthEndpointUrl(input: {
  provider: NativeOAuthProviderConfig
  client: NativeOAuthClient
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
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" })
  if (input.provider.providerId === "slack") {
    const clientId = input.params.get("client_id") ?? ""
    const clientSecret = input.params.get("client_secret") ?? ""
    headers.set("authorization", `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`)
    input.params.delete("client_id")
    input.params.delete("client_secret")
  }
  let response: Response
  try {
    response = await fetch(input.tokenUrl, {
      method: "POST",
      headers,
      body: input.params,
      redirect: input.provider.providerId === "slack" ? "error" : "follow",
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
    if (input.provider.providerId === "slack") {
      throw new OAuthTokenExchangeError("Slack rejected the token exchange. Try Connect again.", "oauth_token_exchange_failed", { httpStatus: response.status })
    }
    throw oauthTokenExchangeErrorFromResponse({
      provider: input.provider,
      status: response.status,
      body,
    })
  }
  if (input.provider.providerId === "slack") {
    // The requested grant determines the envelope, not the presence of a token.
    // User refresh replies are top-level; authorization-code replies are not.
    // https://docs.slack.dev/authentication/using-token-rotation/#refresh
    if (input.params.get("grant_type") === "refresh_token") {
      const parsed = slackRefreshTokenResponseSchema.safeParse(body)
      if (!parsed.success) {
        throw new OAuthTokenExchangeError("Slack did not return a valid member token refresh.", "oauth_token_response_invalid")
      }
      return {
        ...parsed.data,
        slackWorkspaceId: parsed.data.team?.id,
        slackUserId: parsed.data.id,
      }
    }
    const parsed = slackTokenResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new OAuthTokenExchangeError("Slack did not return a valid member authorization.", "oauth_token_response_invalid")
    }
    // Authorization-code replies can also contain a top-level bot grant.
    // Only authed_user is the member's grant here; never substitute a top-level token.
    const bot = slackBotGrantSchema.safeParse(body)
    return {
      ...parsed.data.authed_user,
      scope: parsed.data.authed_user.scope ?? "",
      slackWorkspaceId: parsed.data.team?.id,
      slackUserId: parsed.data.authed_user.id,
      ...(bot.success ? { slackHomeGrant: {
        accessToken: bot.data.access_token,
        refreshToken: bot.data.refresh_token ?? null,
        expiresAt: bot.data.expires_in === undefined ? null : new Date(Date.now() + bot.data.expires_in * 1000),
      } } : {}),
    }
  }
  return parseOAuthTokenResponse(body)
}

export async function exchangeCodeForTokens(input: {
  provider: NativeOAuthProviderConfig
  client: NativeOAuthClient
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
  client: NativeOAuthClient
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
  credentialProviderId: string
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<{ accessToken: string; account: ConnectedAccountRow } | { error: "not_connected" | "client_not_configured" }> {
  if (input.provider.providerId === "slack"
    && (input.credentialProviderId !== "slack" || await slackCloudPolicyError(input.organizationId))
  ) return { error: "not_connected" }
  const account = await getConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.credentialProviderId,
  })
  if (!account || !account.accessToken) {
    return { error: "not_connected" }
  }

  if (input.provider.providerId === "slack") {
    const identity = parseSlackAccountIdentity(account.externalAccountId)
    if (!identity || await slackCloudPolicyError(input.organizationId)) {
      return { error: "not_connected" }
    }
  }
  const stillValid = !account.expiresAt || account.expiresAt.getTime() - TOKEN_EXPIRY_SAFETY_WINDOW_MS > Date.now()
  if (stillValid) {
    return { accessToken: account.accessToken, account }
  }

  if (!account.refreshToken) {
    return { error: "not_connected" }
  }

  const client = await getNativeOAuthClient(input.organizationId, input.credentialProviderId)
  if (!client) {
    return { error: "client_not_configured" }
  }

  const refreshed = await refreshTokens({ provider: input.provider, client, refreshToken: account.refreshToken })
  const slackIdentity = input.provider.providerId === "slack"
    ? await validateSlackTokenIdentity(refreshed, account.externalAccountId ?? "")
    : undefined
  if (input.provider.providerId === "slack" && !await slackOAuthConfigurationIsCurrent({
    organizationId: input.organizationId, client,
  })) return { error: "not_connected" }
  const expiresAt = refreshed.expires_in !== undefined ? new Date(Date.now() + refreshed.expires_in * 1000) : null
  const updated = await refreshConnectedAccountForActiveMember({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.credentialProviderId,
    expectedAccountId: account.id,
    expectedAccessToken: account.accessToken,
    expectedRefreshToken: account.refreshToken,
    accessToken: refreshed.access_token,
    // Most providers (Google included) omit refresh_token on refresh responses; keep the existing one.
    refreshToken: refreshed.refresh_token ?? account.refreshToken,
    tokenType: refreshed.token_type ?? account.tokenType,
    expiresAt,
    ...(slackIdentity !== undefined ? {
      externalAccountId: slackIdentity,
      // Refresh may omit unchanged scopes (RFC 6749 §§5.1, 6). Retain only
      // previously confirmed grants, never the provider's requested defaults.
      scopes: refreshed.scope === undefined
        ? account.scopes
        : [...new Set(refreshed.scope.split(/[\s,]+/).filter(Boolean))],
    } : {}),
  })
  if (input.provider.providerId === "slack" && !await slackOAuthConfigurationIsCurrent({
    organizationId: input.organizationId, client,
  })) return { error: "not_connected" }
  if (updated?.accessToken) {
    return { accessToken: updated.accessToken, account: updated }
  }

  // Another in-flight refresh may have won the compare-and-set. Reuse its
  // fresh token, but never recreate a row deleted by disconnect/removal/rotation.
  const current = await getConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.credentialProviderId,
  })
  if (input.provider.providerId === "slack" && (
    !await slackOAuthConfigurationIsCurrent({ organizationId: input.organizationId, client })
    || current?.externalAccountId !== slackIdentity
  )) return { error: "not_connected" }
  if (
    current?.accessToken
    && (!current.expiresAt || current.expiresAt.getTime() - TOKEN_EXPIRY_SAFETY_WINDOW_MS > Date.now())
  ) {
    return { accessToken: current.accessToken, account: current }
  }
  return { error: "not_connected" }
}
