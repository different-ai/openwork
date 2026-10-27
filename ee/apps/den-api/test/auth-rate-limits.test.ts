import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AUTH_RATE_LIMIT_POLICIES,
  authRateLimitBuckets,
  authRateLimitedResponse,
  checkAuthRateLimit,
  type AuthRateLimitCheck,
} from "../src/auth-rate-limits.js"

/** In-memory fixed-window counter with the same contract as utils/rate-limit.ts checkRateLimit. */
function memoryLimiter(): AuthRateLimitCheck {
  const rows = new Map<string, { count: number; start: number }>()
  return async (key, max, windowMs, now) => {
    const row = rows.get(key)
    if (!row || now - row.start > windowMs) {
      rows.set(key, { count: 1, start: now })
      return null
    }
    if (row.count >= max) return Math.ceil((windowMs - (now - row.start)) / 1000)
    row.count += 1
    return null
  }
}

const OFFICE_IP = "198.51.100.7"
const KEY_SECRET = "auth-rate-limit-unit-test-secret-0123456789"
const NOW = 1_800_000_000_000

test("a whole office behind one address can sign up together", async () => {
  const check = memoryLimiter()
  for (let person = 0; person < 40; person += 1) {
    const result = await checkAuthRateLimit({
      path: "/sign-up/email",
      email: `person${person}@acme.test`,
      clientIpKey: OFFICE_IP,
      invitation: null,
    keySecret: KEY_SECRET,
      keySecret: KEY_SECRET,
    }, check, NOW + person)
    assert.equal(result, null, `person ${person} should not be limited`)
    const otp = await checkAuthRateLimit({
      path: "/email-otp/send-verification-otp",
      email: `person${person}@acme.test`,
      clientIpKey: OFFICE_IP,
      invitation: null,
    keySecret: KEY_SECRET,
      keySecret: KEY_SECRET,
    }, check, NOW + person)
    assert.equal(otp, null, `person ${person}'s code should send`)
  }
})

test("one email is still limited tightly, independent of address", async () => {
  const check = memoryLimiter()
  const max = AUTH_RATE_LIMIT_POLICIES["/email-otp/send-verification-otp"]?.emailMax ?? 0
  for (let attempt = 0; attempt < max; attempt += 1) {
    const result = await checkAuthRateLimit({
      path: "/email-otp/send-verification-otp",
      email: "target@acme.test",
      clientIpKey: `203.0.113.${attempt}`,
      invitation: null,
    keySecret: KEY_SECRET,
      keySecret: KEY_SECRET,
    }, check, NOW)
    assert.equal(result, null)
  }
  const blocked = await checkAuthRateLimit({
    path: "/email-otp/send-verification-otp",
    email: "Target@Acme.test",
    clientIpKey: "203.0.113.200",
    invitation: null,
    keySecret: KEY_SECRET,
  }, check, NOW)
  assert.equal(blocked?.bucket, "email")
})

test("one address spraying many emails hits the address ceiling", async () => {
  const check = memoryLimiter()
  const max = AUTH_RATE_LIMIT_POLICIES["/sign-up/email"]?.ipMax ?? 0
  let blocked = null
  for (let attempt = 0; attempt <= max && !blocked; attempt += 1) {
    blocked = await checkAuthRateLimit({
      path: "/sign-up/email",
      email: `spray${attempt}@example.test`,
      clientIpKey: OFFICE_IP,
      invitation: null,
    keySecret: KEY_SECRET,
      keySecret: KEY_SECRET,
    }, check, NOW)
  }
  assert.equal(blocked?.bucket, "ip")
})

test("an invited sign-up counts against its invitation, not the shared address", async () => {
  const check = memoryLimiter()
  const max = AUTH_RATE_LIMIT_POLICIES["/sign-up/email"]?.ipMax ?? 0
  for (let attempt = 0; attempt < max; attempt += 1) {
    await checkAuthRateLimit({ path: "/sign-up/email", email: `spray${attempt}@example.test`, clientIpKey: OFFICE_IP, invitation: null, keySecret: KEY_SECRET }, check, NOW)
  }
  const invited = await checkAuthRateLimit({
    path: "/sign-up/email",
    email: "new.hire@acme.test",
    clientIpKey: OFFICE_IP,
    invitation: "inv_123",
    keySecret: KEY_SECRET,
  }, check, NOW)
  assert.equal(invited, null)

  const buckets = authRateLimitBuckets({ path: "/sign-up/email", email: "new.hire@acme.test", clientIpKey: OFFICE_IP, invitation: "inv_123", keySecret: KEY_SECRET })
  assert.deepEqual(buckets.map((bucket) => bucket.bucket), ["email", "invitation"])
})

test("keys never contain the raw email, address or invitation", () => {
  const buckets = authRateLimitBuckets({ path: "/sign-in/email", email: "a@acme.test", clientIpKey: OFFICE_IP, invitation: null, keySecret: KEY_SECRET })
  for (const bucket of buckets) {
    assert.ok(!bucket.key.includes("acme"))
    assert.ok(!bucket.key.includes(OFFICE_IP))
  }
})

test("other paths are not limited here", () => {
  assert.deepEqual(authRateLimitBuckets({ path: "/get-session", email: null, clientIpKey: OFFICE_IP, invitation: null, keySecret: KEY_SECRET }), [])
})

test("the 429 tells people how long to wait", async () => {
  const response = authRateLimitedResponse({ bucket: "email", retryAfterSeconds: 600 })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "600")
  const body: unknown = await response.json()
  assert.deepEqual(body, { error: "rate_limited", message: "Too many attempts. Please try again in 10 minutes.", retryAfterSeconds: 600 })
})
