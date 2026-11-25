import { createHmac } from "node:crypto"
import { readBasicAuthClientId } from "./oauth-token-rate-limit-observability.js"

const OAUTH_TOKEN_ATTEMPT_MAX = 60
const OAUTH_TOKEN_ANONYMOUS_MAX = 20
const OAUTH_TOKEN_IP_MAX = 300
const OAUTH_TOKEN_ATTEMPT_WINDOW_MS = 60_000
const OAUTH_TOKEN_FAILURE_MAX = 15
const OAUTH_TOKEN_FAILURE_WINDOW_MS = 300_000

export type OAuthTokenRateLimitCheck = (
  key: string,
  maxRequests: number,
  windowMs: number,
  now: number,
  consume?: boolean,
) => Promise<number | null>

export type OAuthTokenRateLimitAdmission = {
  response: Response | null
  blocked: readonly OAuthTokenRateLimitBlock[]
  failure: OAuthTokenFailureBudgets
}

async function defaultRateLimitCheck(
  key: string,
  maxRequests: number,
  windowMs: number,
  now: number,
  consume = true,
) {
  const { checkFixedWindowRateLimit } = await import("./utils/rate-limit.js")
  return checkFixedWindowRateLimit(key, maxRequests, windowMs, now, consume)
}

const OAUTH_TOKEN_SOURCE_FAILURE_MAX = 60

export type OAuthTokenRateLimitBucket =
  | "ip"
  | "client"
  | "anonymous"
  | "failure_refresh_token"
  | "failure_client"
  | "failure_anonymous"
  | "failure_ip"

export type OAuthTokenRateLimitBlock = { bucket: OAuthTokenRateLimitBucket; retryAfterSeconds: number }

type OAuthTokenRateLimitBudget = {
  bucket: OAuthTokenRateLimitBucket
  key: string
  max: number
  windowMs: number
}

export type OAuthTokenFailureBudgets = {
  subject: OAuthTokenRateLimitBudget
  source: OAuthTokenRateLimitBudget | null
}

function bucketId(secret: string, ...parts: string[]) {
  return createHmac("sha256", secret).update(JSON.stringify(parts)).digest("base64url").slice(0, 32)
}

async function readTokenRequestForm(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/x-www-form-urlencoded")) return new URLSearchParams()
  return new URLSearchParams(await request.clone().text().catch(() => ""))
}

function failureBudget(bucket: OAuthTokenRateLimitBucket, key: string, max = OAUTH_TOKEN_FAILURE_MAX): OAuthTokenRateLimitBudget {
  return { bucket, key, max, windowMs: OAUTH_TOKEN_FAILURE_WINDOW_MS }
}

function attemptBudget(bucket: OAuthTokenRateLimitBucket, key: string, max: number): OAuthTokenRateLimitBudget {
  return { bucket, key, max, windowMs: OAUTH_TOKEN_ATTEMPT_WINDOW_MS }
}

async function oauthTokenRateLimitBudgets(request: Request) {
  const [{ env }, { resolveRequestClientIp }, { clientIpRateLimitKey }] = await Promise.all([
    import("./env.js"),
    import("./request-client-ip.js"),
    import("./client-ip.js"),
  ])
  const secret = env.betterAuthSecret
  const address = resolveRequestClientIp(request.headers)
  const source = clientIpRateLimitKey(address)
  const form = await readTokenRequestForm(request)
  const clientId = readBasicAuthClientId(request.headers) ?? (form.get("client_id") || null)
  const refreshToken = form.get("grant_type") === "refresh_token" ? form.get("refresh_token") || null : null

  const attempt = clientId
    ? attemptBudget("client", `oauth-token:client:${bucketId(secret, "client", clientId, source)}`, OAUTH_TOKEN_ATTEMPT_MAX)
    : attemptBudget("anonymous", `oauth-token:anon:${bucketId(secret, "anonymous", source)}`, OAUTH_TOKEN_ANONYMOUS_MAX)
  const subject = refreshToken
    ? failureBudget("failure_refresh_token", `oauth-token:fail:refresh:${bucketId(secret, "refresh_token", refreshToken)}`)
    : clientId
      ? failureBudget("failure_client", `oauth-token:fail:client:${bucketId(secret, "client", clientId, source)}`)
      : failureBudget("failure_anonymous", `oauth-token:fail:anon:${bucketId(secret, "anonymous", source)}`)

  return {
    ip: attemptBudget("ip", `oauth-token:ip:${bucketId(secret, "ip", source)}`, OAUTH_TOKEN_IP_MAX),
    attempt,
    failure: {
      subject,
      source: address.ip
        ? failureBudget("failure_ip", `oauth-token:fail:ip:${bucketId(secret, "ip", source)}`, OAUTH_TOKEN_SOURCE_FAILURE_MAX)
        : null,
    },
  }
}

function oauthTokenRateLimitedResponse(retryAfter: number) {
  return new Response(JSON.stringify({
    error: "rate_limited",
    error_description: "Too many OAuth token requests. Try again later.",
  }), {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "content-type": "application/json",
      Pragma: "no-cache",
      "Retry-After": String(retryAfter),
    },
  })
}

async function blockedBy(
  budgets: readonly OAuthTokenRateLimitBudget[],
  rateLimitCheck: OAuthTokenRateLimitCheck,
  now: number,
  consume: boolean,
) {
  const blocked: OAuthTokenRateLimitBlock[] = []
  for (const budget of budgets) {
    const retryAfterSeconds = await rateLimitCheck(budget.key, budget.max, budget.windowMs, now, consume)
    if (retryAfterSeconds !== null) blocked.push({ bucket: budget.bucket, retryAfterSeconds })
  }
  return blocked
}

function admission(blocked: readonly OAuthTokenRateLimitBlock[], failure: OAuthTokenFailureBudgets): OAuthTokenRateLimitAdmission {
  const retryAfter = blocked.reduce((longest, block) => Math.max(longest, block.retryAfterSeconds), 0)
  return {
    response: blocked.length ? oauthTokenRateLimitedResponse(retryAfter) : null,
    blocked,
    failure,
  }
}

export async function checkOAuthTokenRateLimit(
  request: Request,
  rateLimitCheck: OAuthTokenRateLimitCheck = defaultRateLimitCheck,
  now = Date.now(),
): Promise<OAuthTokenRateLimitAdmission> {
  const budgets = await oauthTokenRateLimitBudgets(request)
  const { subject, source } = budgets.failure
  const failureBlocked = await blockedBy(source ? [subject, source] : [subject], rateLimitCheck, now, false)
  if (failureBlocked.length) return admission(failureBlocked, budgets.failure)

  return admission(await blockedBy([budgets.ip, budgets.attempt], rateLimitCheck, now, true), budgets.failure)
}

async function isRefreshTokenRejection(failure: OAuthTokenFailureBudgets, response: Response) {
  if (failure.subject.bucket !== "failure_refresh_token") return false
  const body: unknown = await response.clone().json().catch(() => null)
  return typeof body === "object" && body !== null && "error" in body && body.error === "invalid_grant"
}

export async function recordOAuthTokenFailure(
  failure: OAuthTokenFailureBudgets,
  response: Response,
  rateLimitCheck: OAuthTokenRateLimitCheck = defaultRateLimitCheck,
  now = Date.now(),
): Promise<readonly OAuthTokenRateLimitBlock[]> {
  if (response.status !== 400 && response.status !== 401 && response.status !== 403) return []
  const { subject, source } = failure
  const charged: OAuthTokenRateLimitBudget[] = []
  if (await rateLimitCheck(subject.key, subject.max, subject.windowMs, now) === null) charged.push(subject)
  if (charged.length && source && !await isRefreshTokenRejection(failure, response)) {
    if (await rateLimitCheck(source.key, source.max, source.windowMs, now) === null) charged.push(source)
  }
  return blockedBy(charged, rateLimitCheck, now, false)
}
