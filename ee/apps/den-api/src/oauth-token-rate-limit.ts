import { createHash } from "node:crypto"
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

type OAuthTokenRateLimitAdmission = {
  failureKey: string
  response: Response | null
}

async function defaultRateLimitCheck(
  key: string,
  maxRequests: number,
  windowMs: number,
  now: number,
  consume = true,
) {
  const { checkRateLimit } = await import("./utils/rate-limit.js")
  return checkRateLimit(key, maxRequests, windowMs, now, consume)
}

function requestAddress(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}

function rateLimitHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

async function readFormClientId(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/x-www-form-urlencoded")) return null
  const clientId = new URLSearchParams(await request.clone().text().catch(() => "")).get("client_id")
  return clientId || null
}

async function oauthTokenRateLimitKeys(request: Request) {
  const ipHash = rateLimitHash(requestAddress(request.headers))
  const clientId = readBasicAuthClientId(request.headers) ?? await readFormClientId(request)
  const clientHash = clientId ? rateLimitHash(clientId) : null

  return {
    attempt: clientHash ? `oauth-token:client:${clientHash}` : `oauth-token:anon:${ipHash}`,
    failure: `oauth-token:fail:${clientHash ?? ipHash}`,
    ip: `oauth-token:ip:${ipHash}`,
  }
}

function longestRetryAfter(values: readonly (number | null)[]) {
  let longest: number | null = null
  for (const value of values) {
    if (value !== null) {
      longest = longest === null ? value : Math.max(longest, value)
    }
  }
  return longest
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

export async function checkOAuthTokenRateLimit(
  request: Request,
  rateLimitCheck: OAuthTokenRateLimitCheck = defaultRateLimitCheck,
  now = Date.now(),
): Promise<OAuthTokenRateLimitAdmission> {
  const keys = await oauthTokenRateLimitKeys(request)
  const failureRetryAfter = await rateLimitCheck(
    keys.failure,
    OAUTH_TOKEN_FAILURE_MAX,
    OAUTH_TOKEN_FAILURE_WINDOW_MS,
    now,
    false,
  )
  const ipRetryAfter = await rateLimitCheck(
    keys.ip,
    OAUTH_TOKEN_IP_MAX,
    OAUTH_TOKEN_ATTEMPT_WINDOW_MS,
    now,
  )
  // client_id in a form body is attacker-controlled. Per-client buckets isolate
  // legitimate NAT peers, while the always-consumed IP ceiling bounds clients
  // that rotate random IDs to obtain fresh 60-request budgets.
  const attemptRetryAfter = await rateLimitCheck(
    keys.attempt,
    keys.attempt.startsWith("oauth-token:anon:") ? OAUTH_TOKEN_ANONYMOUS_MAX : OAUTH_TOKEN_ATTEMPT_MAX,
    OAUTH_TOKEN_ATTEMPT_WINDOW_MS,
    now,
  )
  const retryAfter = longestRetryAfter([failureRetryAfter, ipRetryAfter, attemptRetryAfter])

  return {
    failureKey: keys.failure,
    response: retryAfter === null ? null : oauthTokenRateLimitedResponse(retryAfter),
  }
}

export async function recordOAuthTokenFailure(
  failureKey: string,
  response: Response,
  rateLimitCheck: OAuthTokenRateLimitCheck = defaultRateLimitCheck,
  now = Date.now(),
) {
  if (response.status !== 400 && response.status !== 401 && response.status !== 403) return
  await rateLimitCheck(failureKey, OAUTH_TOKEN_FAILURE_MAX, OAUTH_TOKEN_FAILURE_WINDOW_MS, now)
}
