import { createHmac } from "node:crypto"

export type AuthRateLimitPolicy = {
  windowMs: number
  emailMax: number
  ipMax: number
  invitationMax?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export const AUTH_RATE_LIMIT_POLICIES: Readonly<Record<string, AuthRateLimitPolicy>> = {
  "/sign-up/email": { windowMs: HOUR_MS, emailMax: 5, ipMax: 60, invitationMax: 10 },
  "/sign-in/email": { windowMs: 5 * MINUTE_MS, emailMax: 10, ipMax: 100 },
  "/email-otp/send-verification-otp": { windowMs: HOUR_MS, emailMax: 5, ipMax: 60 },
  "/email-otp/verify-email": { windowMs: 5 * MINUTE_MS, emailMax: 10, ipMax: 100 },
  "/request-password-reset": { windowMs: HOUR_MS, emailMax: 5, ipMax: 30 },
}

export const DEN_LIMITED_BETTER_AUTH_PATHS = Object.keys(AUTH_RATE_LIMIT_POLICIES)

export type AuthRateLimitBucket = "email" | "ip" | "invitation"

export type AuthRateLimitInput = {
  path: string
  email: string | null
  clientIpKey: string
  invitation: string | null
  keySecret: string
}

export type AuthRateLimitCheck = (key: string, maxRequests: number, windowMs: number, now: number) => Promise<number | null>

export type AuthRateLimitResult = { bucket: AuthRateLimitBucket; retryAfterSeconds: number }

function bucketId(keySecret: string, value: string) {
  return createHmac("sha256", keySecret).update(value).digest("base64url").slice(0, 32)
}

function scope(path: string) {
  return path.replace(/^\//, "").replace(/\//g, ":")
}

export function authRateLimitBuckets(input: AuthRateLimitInput) {
  const policy = AUTH_RATE_LIMIT_POLICIES[input.path]
  if (!policy) return []
  const prefix = `auth:${scope(input.path)}`
  const buckets: { bucket: AuthRateLimitBucket; key: string; max: number; windowMs: number }[] = []
  const email = input.email?.trim().toLowerCase() || null
  if (email) {
    buckets.push({ bucket: "email", key: `${prefix}:email:${bucketId(input.keySecret, email)}`, max: policy.emailMax, windowMs: policy.windowMs })
  }
  if (input.invitation && policy.invitationMax !== undefined) {
    buckets.push({ bucket: "invitation", key: `${prefix}:invite:${bucketId(input.keySecret, input.invitation)}`, max: policy.invitationMax, windowMs: policy.windowMs })
  } else {
    buckets.push({ bucket: "ip", key: `${prefix}:ip:${bucketId(input.keySecret, input.clientIpKey)}`, max: policy.ipMax, windowMs: policy.windowMs })
  }
  return buckets
}

export async function checkAuthRateLimit(
  input: AuthRateLimitInput,
  check: AuthRateLimitCheck,
  now = Date.now(),
): Promise<AuthRateLimitResult | null> {
  for (const bucket of authRateLimitBuckets(input)) {
    const retryAfterSeconds = await check(bucket.key, bucket.max, bucket.windowMs, now)
    if (retryAfterSeconds !== null) return { bucket: bucket.bucket, retryAfterSeconds }
  }
  return null
}

function waitPhrase(seconds: number) {
  if (seconds < 60) return "a minute"
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? "a minute" : `${minutes} minutes`
}

export function authRateLimitedResponse(result: AuthRateLimitResult) {
  const retryAfter = String(result.retryAfterSeconds)
  return new Response(JSON.stringify({
    error: "rate_limited",
    message: `Too many attempts. Please try again in ${waitPhrase(result.retryAfterSeconds)}.`,
    retryAfterSeconds: result.retryAfterSeconds,
  }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "Retry-After": retryAfter,
    },
  })
}
