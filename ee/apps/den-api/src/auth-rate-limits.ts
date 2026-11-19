import { createHmac } from "node:crypto"

/**
 * Rate limits for the email sign-up, sign-in and code endpoints.
 *
 * Better Auth's own limiter counts only by address, so everyone behind one
 * office or school router shared five sign-ups an hour. These endpoints are
 * limited here instead, per person first:
 * - a tight bucket per email address (what an attacker would target);
 * - a generous ceiling per address, which still bounds one source spraying
 *   many addresses but lets a whole team sign up together;
 * - a sign-up from a valid invitation link was approved by an admin, so it
 *   is counted against that invitation instead of the shared address.
 *
 * Failed passwords are additionally locked out per email (auth-protection.ts).
 */

export type AuthRateLimitPolicy = {
  windowMs: number
  emailMax: number
  ipMax: number
  /** Sign-ups from a valid invitation use this bucket instead of the address ceiling. */
  invitationMax?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Keyed by the Better Auth path (without the `/api/auth` prefix); POST only. */
export const AUTH_RATE_LIMIT_POLICIES: Readonly<Record<string, AuthRateLimitPolicy>> = {
  "/sign-up/email": { windowMs: HOUR_MS, emailMax: 5, ipMax: 60, invitationMax: 10 },
  "/sign-in/email": { windowMs: 5 * MINUTE_MS, emailMax: 10, ipMax: 100 },
  "/email-otp/send-verification-otp": { windowMs: HOUR_MS, emailMax: 5, ipMax: 60 },
  "/email-otp/verify-email": { windowMs: 5 * MINUTE_MS, emailMax: 10, ipMax: 100 },
  "/request-password-reset": { windowMs: HOUR_MS, emailMax: 5, ipMax: 30 },
}

/** Paths whose Better Auth address-only limit is replaced by the policies above. */
export const DEN_LIMITED_BETTER_AUTH_PATHS = Object.keys(AUTH_RATE_LIMIT_POLICIES)

export type AuthRateLimitBucket = "email" | "ip" | "invitation"

export type AuthRateLimitInput = {
  path: string
  email: string | null
  clientIpKey: string
  /** The invitation id or token of a sign-up already checked to be pending and addressed to this email. */
  invitation: string | null
  /** Server secret the bucket keys are derived with. */
  keySecret: string
}

export type AuthRateLimitCheck = (key: string, maxRequests: number, windowMs: number, now: number) => Promise<number | null>

export type AuthRateLimitResult = { bucket: AuthRateLimitBucket; retryAfterSeconds: number }

/** Keyed so stored bucket keys cannot be matched against a list of emails or invitation tokens. */
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
