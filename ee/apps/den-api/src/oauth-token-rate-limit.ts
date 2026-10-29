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

/**
 * Failures from one address across every client ID. It bounds callers that
 * rotate client IDs or credentials to mint fresh per-caller budgets, and stays
 * above OAUTH_TOKEN_FAILURE_MAX so one stuck caller cannot fill it for its
 * neighbors. Refused refresh tokens are not charged to it (see
 * isRefreshTokenRejection).
 */
const OAUTH_TOKEN_SOURCE_FAILURE_MAX = 60

/** Safe-to-log names of the budgets that can refuse a token request. */
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

/**
 * Charged when the request fails: the caller's own budget, then the ceiling for
 * its address. `source` is null when no trusted address was found, because all
 * such callers would share one ceiling.
 */
export type OAuthTokenFailureBudgets = {
  subject: OAuthTokenRateLimitBudget
  source: OAuthTokenRateLimitBudget | null
}

/** Keyed with the server secret so stored keys cannot be matched against client IDs, addresses or tokens. */
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

/**
 * client_id is public and often shared by every installation of one app, so
 * no budget is keyed by it alone. A refresh token's failures are charged to
 * that token, so a caller replaying a dead token only exhausts its own budget;
 * other failures are charged per client ID and address. The keys depend only
 * on what the caller sent, never on whether a credential is valid, so a
 * refusal reveals nothing about stored grants.
 */
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
  // Failure budgets are only read here. A caller already refused for failing
  // is turned away without spending the attempt ceilings it shares with its
  // neighbors, so retrying through a cooldown cannot lock them out.
  const failureBlocked = await blockedBy(source ? [subject, source] : [subject], rateLimitCheck, now, false)
  if (failureBlocked.length) return admission(failureBlocked, budgets.failure)

  // The always-consumed address ceiling bounds callers that rotate client IDs
  // to obtain fresh per-client budgets.
  return admission(await blockedBy([budgets.ip, budgets.attempt], rateLimitCheck, now, true), budgets.failure)
}

/**
 * A presented refresh token refused as invalid_grant (unknown, expired, reused
 * or revoked) is charged to that token alone. Refresh tokens cannot be guessed,
 * so made-up ones gain an attacker nothing, while a server that renews for many
 * people from one address is not locked out by a few dead tokens; the attempt
 * ceilings still bound volume. The body is read from a clone and never logged.
 */
async function isRefreshTokenRejection(failure: OAuthTokenFailureBudgets, response: Response) {
  if (failure.subject.bucket !== "failure_refresh_token") return false
  const body: unknown = await response.clone().json().catch(() => null)
  return typeof body === "object" && body !== null && "error" in body && body.error === "invalid_grant"
}

/** Charges a failed request and returns the budgets it charged that are now full (empty otherwise). */
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
  // A failure past the caller's own budget (a concurrent burst admitted before
  // it filled) is not charged to the address, so one caller contributes at most
  // OAUTH_TOKEN_FAILURE_MAX to the ceiling it shares with others.
  if (charged.length && source && !await isRefreshTokenRejection(failure, response)) {
    if (await rateLimitCheck(source.key, source.max, source.windowMs, now) === null) charged.push(source)
  }
  return blockedBy(charged, rateLimitCheck, now, false)
}
