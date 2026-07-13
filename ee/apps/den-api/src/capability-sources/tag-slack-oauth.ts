import { Buffer } from "node:buffer"
import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import {
  claimTagTokenRefresh,
  completeTagTokenRefresh,
  failTagTokenRefresh,
  getTagConnectionById,
  type TagConnectionRow,
} from "./tag-store.js"

export const TAG_SLACK_OAUTH_PROVIDER_ID = "openwork-tag-slack"
export const TAG_SLACK_OAUTH_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
] as const

const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024
const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000

const tokenBundleSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})

const installResponseSchema = tokenBundleSchema.extend({
  app_id: z.string().min(1).max(32).optional(),
  bot_user_id: z.string().min(1).max(32),
  enterprise: z.object({ id: z.string().min(1).max(32), name: z.string().optional() }).nullable().optional(),
  is_enterprise_install: z.boolean().optional(),
  team: z.object({ id: z.string().min(1).max(32), name: z.string().optional() }),
})

const slackOAuthErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().trim().min(1).max(128),
})

export type TagSlackOAuthConfiguration = {
  accessUrl: string
  authorizeUrl: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

export type TagSlackOAuthInstall = z.infer<typeof installResponseSchema>

export class TagSlackOAuthError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message)
    this.name = "TagSlackOAuthError"
  }
}

export function isRetryableTagSlackOAuthError(error: unknown): boolean {
  return error instanceof TagSlackOAuthError && error.retryable
}

export function configuredTagSlackOAuth(): TagSlackOAuthConfiguration | null {
  const config = env.tagSlackOAuth
  const clientId = process.env.DEN_TAG_SLACK_CLIENT_ID?.trim() || config.clientId
  const clientSecret = process.env.DEN_TAG_SLACK_CLIENT_SECRET?.trim() || config.clientSecret
  const signingSecret = process.env.DEN_TAG_SLACK_SIGNING_SECRET?.trim() || config.signingSecret
  if (!clientId || !clientSecret || !signingSecret) return null
  return {
    accessUrl: process.env.DEN_TAG_SLACK_OAUTH_ACCESS_URL?.trim() || config.accessUrl,
    authorizeUrl: process.env.DEN_TAG_SLACK_OAUTH_AUTHORIZE_URL?.trim() || config.authorizeUrl,
    clientId,
    clientSecret,
    signingSecret,
  }
}

export function buildTagSlackAuthorizeUrl(input: {
  authorizeUrl: string
  clientId: string
  redirectUri: string
  state: string
}) {
  const url = new URL(input.authorizeUrl)
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", TAG_SLACK_OAUTH_SCOPES.join(","))
  url.searchParams.set("state", input.state)
  return url.toString()
}

function parseScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[ ,]+/).map((scope) => scope.trim()).filter(Boolean))].sort()
}

function parseStoredScopes(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((scope): scope is string => typeof scope === "string")
  } catch {
    // Older/non-JSON values fall back to Slack's comma/space-delimited format.
  }
  return parseScopes(value)
}

export function missingTagSlackScopes(value: string | undefined): string[] {
  const granted = new Set(parseScopes(value))
  return TAG_SLACK_OAUTH_SCOPES.filter((scope) => !granted.has(scope))
}

async function slackOAuthRequest(input: {
  body: URLSearchParams
  config: Pick<TagSlackOAuthConfiguration, "accessUrl" | "clientId" | "clientSecret">
  fetchImpl?: typeof fetch
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(input.config.accessUrl, {
      body: input.body,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${input.config.clientId}:${input.config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new TagSlackOAuthError(
      `Slack OAuth is temporarily unreachable: ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > TOKEN_RESPONSE_MAX_BYTES) {
    throw new TagSlackOAuthError("Slack returned an oversized OAuth response.")
  }
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > TOKEN_RESPONSE_MAX_BYTES) {
    throw new TagSlackOAuthError("Slack returned an oversized OAuth response.")
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new TagSlackOAuthError("Slack returned an invalid OAuth response.", response.status >= 500)
  }
  const slackError = slackOAuthErrorSchema.safeParse(payload)
  if (!response.ok || slackError.success) {
    const code = slackError.success ? slackError.data.error : `http_${response.status}`
    const retryable = response.status === 429 || response.status >= 500 || code === "fatal_error"
    throw new TagSlackOAuthError(`Slack OAuth failed: ${code}.`, retryable)
  }
  return payload
}

export async function exchangeTagSlackOAuthCode(input: {
  code: string
  config: TagSlackOAuthConfiguration
  fetchImpl?: typeof fetch
  redirectUri: string
}): Promise<TagSlackOAuthInstall> {
  const body = new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri })
  const payload = await slackOAuthRequest({ body, config: input.config, fetchImpl: input.fetchImpl })
  const parsed = installResponseSchema.safeParse(payload)
  if (!parsed.success) throw new TagSlackOAuthError("Slack returned an incomplete installation response.")
  return parsed.data
}

async function refreshTagSlackOAuthToken(input: {
  config: TagSlackOAuthConfiguration
  fetchImpl?: typeof fetch
  refreshToken: string
}) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken })
  const payload = await slackOAuthRequest({ body, config: input.config, fetchImpl: input.fetchImpl })
  const parsed = tokenBundleSchema.safeParse(payload)
  if (!parsed.success) {
    throw new TagSlackOAuthError("Slack returned an incomplete rotating-token response.")
  }
  const refreshToken = parsed.data.refresh_token
  const expiresIn = parsed.data.expires_in
  if (!refreshToken || !expiresIn) {
    throw new TagSlackOAuthError("Slack returned an incomplete rotating-token response.")
  }
  return { ...parsed.data, refresh_token: refreshToken, expires_in: expiresIn }
}

function tokenIsExpired(connection: TagConnectionRow, now = Date.now()) {
  return Boolean(connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= now)
}

function tokenNeedsRefresh(connection: TagConnectionRow, now = Date.now()) {
  return Boolean(connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= now + TOKEN_REFRESH_WINDOW_MS)
}

async function waitForConcurrentRefresh(connectionId: DenTypeId<"tagConnection">) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const current = await getTagConnectionById(connectionId)
    if (!current) return null
    if (!current.tokenRefreshLease && !tokenIsExpired(current)) return current
    if (current.status !== "active") return current
  }
  return getTagConnectionById(connectionId)
}

/** Returns a usable bot token and rotates expiring OAuth credentials exactly once across Den replicas. */
export async function ensureFreshTagConnection(
  connection: TagConnectionRow,
  input: { config?: TagSlackOAuthConfiguration; fetchImpl?: typeof fetch } = {},
): Promise<TagConnectionRow> {
  if (connection.installSource !== "oauth" || !tokenNeedsRefresh(connection)) return connection
  const config = input.config ?? configuredTagSlackOAuth()
  if (!config || !connection.refreshToken) {
    if (!tokenIsExpired(connection)) return connection
    throw new TagSlackOAuthError("OpenWork Tag's Slack OAuth credentials must be reinstalled.")
  }

  const claim = await claimTagTokenRefresh(connection.id)
  if (!claim) {
    const current = await getTagConnectionById(connection.id)
    if (current && !tokenIsExpired(current)) return current
    const refreshed = await waitForConcurrentRefresh(connection.id)
    if (refreshed?.status === "active" && !tokenIsExpired(refreshed)) return refreshed
    throw new TagSlackOAuthError("Slack token refresh is still in progress.", true)
  }

  try {
    if (!claim.connection.refreshToken) throw new TagSlackOAuthError("Slack did not retain a refresh token.")
    const token = await refreshTagSlackOAuthToken({
      config,
      fetchImpl: input.fetchImpl,
      refreshToken: claim.connection.refreshToken,
    })
    const scopes = token.scope ? parseScopes(token.scope) : parseStoredScopes(claim.connection.oauthScopes)
    const saved = await completeTagTokenRefresh({
      accessToken: token.access_token,
      connectionId: connection.id,
      expiresAt: new Date(Date.now() + token.expires_in * 1_000),
      lease: claim.lease,
      refreshToken: token.refresh_token,
      scopes,
    })
    if (!saved) throw new TagSlackOAuthError("Slack token rotation lost its persistence lease.", true)
    const current = await getTagConnectionById(connection.id)
    if (!current) throw new TagSlackOAuthError("The Slack installation was removed during token rotation.")
    return current
  } catch (error) {
    await failTagTokenRefresh({
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
      expired: tokenIsExpired(claim.connection),
      lease: claim.lease,
    })
    throw error
  }
}
