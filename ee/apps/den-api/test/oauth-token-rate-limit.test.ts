import assert from "node:assert/strict"
import { test } from "node:test"
import {
  checkOAuthTokenRateLimit,
  recordOAuthTokenFailure,
  type OAuthTokenRateLimitAdmission,
  type OAuthTokenRateLimitCheck,
} from "../src/oauth-token-rate-limit.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/oauth_token_rate_limit_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-oauth-token-rate-limit-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-oauth-token-rate-limit-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"

// Every call uses one instant, so nothing here depends on how windows roll over.
const NOW = 1_800_000_000_000
const SHARED_CLIENT = "https://client.example.test/oauth/client.json"
const OFFICE = "198.51.100.7"
const HOME = "203.0.113.20"

/**
 * In-memory counter with the storage contract: `consume: false` only reads and
 * never creates a row, and a consuming call either takes one slot below the
 * limit or reports Retry-After without changing anything.
 */
function memoryLimiter() {
  const counts = new Map<string, number>()
  const consumed: string[] = []
  const check: OAuthTokenRateLimitCheck = async (key, maxRequests, windowMs, _now, consume = true) => {
    const count = counts.get(key) ?? 0
    if (count >= maxRequests) return Math.ceil(windowMs / 1000)
    if (consume) {
      counts.set(key, count + 1)
      consumed.push(key)
    }
    return null
  }
  return { counts, consumed, check }
}

type TokenRequest = {
  ip?: string | null
  clientId?: string | null
  basic?: boolean
  refreshToken?: string
  grantType?: string
}

function tokenRequest({ ip = OFFICE, clientId = SHARED_CLIENT, basic = false, refreshToken, grantType }: TokenRequest = {}) {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" })
  if (ip) headers.set("x-real-ip", ip)
  const body = new URLSearchParams({ grant_type: grantType ?? (refreshToken ? "refresh_token" : "authorization_code") })
  if (refreshToken) body.set("refresh_token", refreshToken)
  else body.set("code", "synthetic-authorization-code")
  if (clientId && basic) headers.set("authorization", `Basic ${btoa(`${clientId}:synthetic-client-secret`)}`)
  else if (clientId) body.set("client_id", clientId)
  return new Request("https://api.example.test/api/auth/oauth2/token", { method: "POST", headers, body })
}

/** What the token endpoint answered. */
type Answer = number | (() => Response)
const invalidGrant = () => Response.json({ error: "invalid_grant", error_description: "invalid refresh token" }, { status: 400 })
const invalidClient = () => Response.json({ error: "invalid_client", error_description: "invalid client_secret" }, { status: 401 })
const notJson = () => new Response("invalid_grant", { status: 400 })

/** The route's sequence: admission, then the handler, then charging a failure. */
async function exchange(request: Request, answer: Answer, check: OAuthTokenRateLimitCheck) {
  const admission = await checkOAuthTokenRateLimit(request, check, NOW)
  if (admission.response) return { handlerRan: false, admission, filled: [], status: admission.response.status }
  const response = typeof answer === "number" ? new Response(null, { status: answer }) : answer()
  const filled = await recordOAuthTokenFailure(admission.failure, response, check, NOW)
  return { handlerRan: true, admission, filled, status: response.status }
}

async function failTimes(times: number, request: () => Request, check: OAuthTokenRateLimitCheck, answer: Answer = 400) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    const result = await exchange(request(), answer, check)
    assert.equal(result.handlerRan, true, `failure ${attempt + 1} should reach the handler`)
  }
}

function buckets(admission: OAuthTokenRateLimitAdmission) {
  return admission.blocked.map((block) => block.bucket)
}

test("a caller replaying a dead refresh token cannot block another installation of the same client", async () => {
  const limiter = memoryLimiter()
  await failTimes(15, () => tokenRequest({ refreshToken: "synthetic-dead-token-a" }), limiter.check, invalidGrant)

  const refused = await exchange(tokenRequest({ refreshToken: "synthetic-dead-token-a" }), invalidGrant, limiter.check)
  assert.equal(refused.handlerRan, false)
  assert.equal(refused.status, 429)
  assert.deepEqual(refused.admission.blocked, [{ bucket: "failure_refresh_token", retryAfterSeconds: 300 }])
  const response = refused.admission.response
  assert.ok(response)
  assert.equal(response.headers.get("retry-after"), "300")
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.deepEqual(await response.json(), { error: "rate_limited", error_description: "Too many OAuth token requests. Try again later." })

  // Same client ID, other token: admitted from the same address and from another one.
  for (const ip of [OFFICE, HOME]) {
    const renewal = await exchange(tokenRequest({ ip, refreshToken: `synthetic-live-token-b-${ip}` }), 200, limiter.check)
    assert.equal(renewal.handlerRan, true, `renewal from ${ip}`)
    assert.deepEqual(renewal.admission.blocked, [])
  }
})

test("a caller retrying through its cooldown spends nothing its neighbors share", async () => {
  const limiter = memoryLimiter()
  await failTimes(15, () => tokenRequest({ refreshToken: "synthetic-dead-token-a" }), limiter.check, invalidGrant)
  const consumedBefore = limiter.consumed.length

  // More retries than the address's 300-request ceiling would allow.
  for (let retry = 0; retry < 400; retry += 1) {
    const result = await exchange(tokenRequest({ refreshToken: "synthetic-dead-token-a" }), invalidGrant, limiter.check)
    assert.equal(result.status, 429)
  }
  assert.equal(limiter.consumed.length, consumedBefore, "refused retries consume no budget")

  const renewal = await exchange(tokenRequest({ refreshToken: "synthetic-live-token-b" }), 200, limiter.check)
  assert.equal(renewal.handlerRan, true)
})

test("dead refresh tokens refused as invalid_grant never fill the ceiling of the address they share", async () => {
  // One server renewing for many people: one client ID, one address.
  const server = memoryLimiter()
  for (let person = 0; person < 5; person += 1) {
    await failTimes(11, () => tokenRequest({ refreshToken: `synthetic-dead-token-${person}` }), server.check, invalidGrant)
  }
  const renewal = await exchange(tokenRequest({ refreshToken: "synthetic-live-token-b" }), 200, server.check)
  assert.equal(renewal.handlerRan, true)
  const ceiling = renewal.admission.failure.source
  assert.ok(ceiling)
  assert.equal(server.counts.has(ceiling.key), false, "invalid_grant refusals are never charged to the address")

  // Six exhausted tokens, more failures than the ceiling holds, still leave a live token alone.
  const many = memoryLimiter()
  for (let person = 0; person < 6; person += 1) {
    const clientId = `synthetic-client-${person}`
    await failTimes(15, () => tokenRequest({ clientId, refreshToken: `synthetic-dead-token-${person}` }), many.check, invalidGrant)
  }
  assert.equal((await exchange(tokenRequest({ refreshToken: "synthetic-live-token-b" }), 200, many.check)).handlerRan, true)
})

test("client-authentication failures on refresh still fill the address ceiling", async () => {
  const limiter = memoryLimiter()
  for (let token = 0; token < 4; token += 1) {
    await failTimes(15, () => tokenRequest({ refreshToken: `synthetic-token-${token}` }), limiter.check, invalidClient)
  }
  assert.deepEqual(buckets((await exchange(tokenRequest({ refreshToken: "synthetic-live-token-b" }), 200, limiter.check)).admission), ["failure_ip"])
  assert.equal((await exchange(tokenRequest({ ip: HOME, refreshToken: "synthetic-live-token-c" }), 200, limiter.check)).handlerRan, true)
})

test("failures without a refresh token are charged per client ID and address", async () => {
  const limiter = memoryLimiter()
  const clientId = "synthetic-confidential-client"
  await failTimes(15, () => tokenRequest({ clientId, basic: true }), limiter.check)

  const refused = await exchange(tokenRequest({ clientId, basic: true }), 400, limiter.check)
  assert.deepEqual(buckets(refused.admission), ["failure_client"])
  // The same client ID from another address keeps its own budget.
  assert.equal((await exchange(tokenRequest({ ip: HOME, clientId, basic: true }), 200, limiter.check)).handlerRan, true)
  // A refresh at the same address is charged to its own token, not to these failures.
  assert.equal((await exchange(tokenRequest({ clientId, refreshToken: "synthetic-live-token-b" }), 200, limiter.check)).handlerRan, true)
  // Another code exchange with that client ID from that address shares the budget it exhausted.
  assert.deepEqual(buckets((await exchange(tokenRequest({ clientId }), 200, limiter.check)).admission), ["failure_client"])
})

test("failures that are not an invalid_grant refresh, and rotating client IDs, stay bounded per address", async () => {
  // A refresh refusal whose body is not JSON is charged to the address.
  const tokens = memoryLimiter()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await exchange(tokenRequest({ refreshToken: `synthetic-random-token-${attempt}` }), attempt % 2 ? notJson : 400, tokens.check)
    assert.equal(result.handlerRan, true)
  }
  const flooded = await exchange(tokenRequest({ refreshToken: "synthetic-random-token-60" }), notJson, tokens.check)
  assert.deepEqual(buckets(flooded.admission), ["failure_ip"])
  // The address ceiling covers every caller there, valid or not; other addresses are unaffected.
  assert.deepEqual(buckets((await exchange(tokenRequest({ refreshToken: "synthetic-live-token-b" }), 200, tokens.check)).admission), ["failure_ip"])
  assert.equal((await exchange(tokenRequest({ ip: HOME, refreshToken: "synthetic-live-token-c" }), 200, tokens.check)).handlerRan, true)

  // invalid_grant on another grant type is charged to the address too.
  const clients = memoryLimiter()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await failTimes(1, () => tokenRequest({ clientId: `synthetic-rotating-client-${attempt}` }), clients.check, invalidGrant)
  }
  const rotated = await exchange(tokenRequest({ clientId: "synthetic-rotating-client-60" }), invalidGrant, clients.check)
  assert.deepEqual(buckets(rotated.admission), ["failure_ip"])

  // Successful exchanges under rotating IDs are still capped by the address ceiling.
  const attempts = memoryLimiter()
  for (let attempt = 0; attempt < 300; attempt += 1) {
    assert.equal((await exchange(tokenRequest({ clientId: `synthetic-rotating-client-${attempt}` }), 200, attempts.check)).handlerRan, true)
  }
  assert.deepEqual(buckets((await exchange(tokenRequest({ clientId: "synthetic-rotating-client-300" }), 200, attempts.check)).admission), ["ip"])
})

test("anonymous and malformed requests stay limited", async () => {
  const failures = memoryLimiter()
  await failTimes(15, () => tokenRequest({ clientId: null, grantType: "not-a-grant" }), failures.check)
  assert.deepEqual(buckets((await exchange(tokenRequest({ clientId: null }), 400, failures.check)).admission), ["failure_anonymous"])

  const attempts = memoryLimiter()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await exchange(tokenRequest({ clientId: null }), 200, attempts.check)).handlerRan, true)
  }
  assert.deepEqual(buckets((await exchange(tokenRequest({ clientId: null }), 200, attempts.check)).admission), ["anonymous"])
})

test("one client ID shares an attempt budget only within one address", async () => {
  const limiter = memoryLimiter()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    assert.equal((await exchange(tokenRequest({ refreshToken: `synthetic-token-${attempt}` }), 200, limiter.check)).handlerRan, true)
  }
  assert.deepEqual(buckets((await exchange(tokenRequest({ refreshToken: "synthetic-token-60" }), 200, limiter.check)).admission), ["client"])
  assert.equal((await exchange(tokenRequest({ ip: HOME, refreshToken: "synthetic-token-61" }), 200, limiter.check)).handlerRan, true)
})

test("a concurrent burst of one caller's failures does not spill onto others at its address", async () => {
  const limiter = memoryLimiter()
  // Worst case: every request is admitted before any failure is charged.
  const admissions = await Promise.all(Array.from({ length: 40 }, () =>
    checkOAuthTokenRateLimit(tokenRequest({ refreshToken: "synthetic-dead-token-a" }), limiter.check, NOW)))
  assert.ok(admissions.every((admission) => admission.response === null))
  const filled = await Promise.all(admissions.map((admission) =>
    recordOAuthTokenFailure(admission.failure, invalidClient(), limiter.check, NOW)))

  const subject = admissions[0]?.failure.subject
  const source = admissions[0]?.failure.source
  assert.ok(subject && source)
  assert.equal(limiter.counts.get(subject.key), 15)
  assert.equal(limiter.counts.get(source.key), 15, "only the failures within the caller's own budget reach the address ceiling")
  assert.ok(filled.some((blocks) => blocks.some((block) => block.bucket === "failure_refresh_token")))
  assert.ok(filled.every((blocks) => blocks.every((block) => block.bucket === "failure_refresh_token")))

  // While that caller is cooling down, a concurrent mix of its retries and other installations' renewals.
  const results = await Promise.all([
    ...Array.from({ length: 30 }, () => checkOAuthTokenRateLimit(tokenRequest({ refreshToken: "synthetic-dead-token-a" }), limiter.check, NOW)),
    ...Array.from({ length: 10 }, (_, index) => checkOAuthTokenRateLimit(tokenRequest({ refreshToken: `synthetic-live-token-${index}` }), limiter.check, NOW)),
  ])
  assert.ok(results.slice(0, 30).every((admission) => buckets(admission).join() === "failure_refresh_token"))
  assert.ok(results.slice(30).every((admission) => admission.response === null))
})

test("recording a failure reports a budget exactly when that failure fills it", async () => {
  const limiter = memoryLimiter()
  const filled: string[][] = []
  for (let token = 0; token < 4; token += 1) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const result = await exchange(tokenRequest({ refreshToken: `synthetic-token-${token}` }), invalidClient, limiter.check)
      assert.equal(result.handlerRan, true)
      filled.push(result.filled.map((block) => `${block.bucket}:${block.retryAfterSeconds}`))
    }
  }
  filled.forEach((blocks, index) => {
    const expected = index === 59
      ? ["failure_refresh_token:300", "failure_ip:300"]
      : index % 15 === 14 ? ["failure_refresh_token:300"] : []
    assert.deepEqual(blocks, expected, `failure ${index + 1}`)
  })

  // Nothing is reported for a failure past a full budget, for successes, or for statuses that are not failures.
  const admission = await checkOAuthTokenRateLimit(tokenRequest({ ip: HOME, refreshToken: "synthetic-token-0" }), limiter.check, NOW)
  assert.deepEqual(await recordOAuthTokenFailure(admission.failure, invalidGrant(), limiter.check, NOW), [])
  for (const status of [200, 429, 500]) {
    assert.deepEqual(await recordOAuthTokenFailure(admission.failure, new Response(null, { status }), limiter.check, NOW), [])
  }
})

test("both failure budgets are reported when both refuse", async () => {
  const limiter = memoryLimiter()
  for (let token = 0; token < 4; token += 1) {
    await failTimes(15, () => tokenRequest({ refreshToken: `synthetic-dead-token-${token}` }), limiter.check)
  }
  const refused = await checkOAuthTokenRateLimit(tokenRequest({ refreshToken: "synthetic-dead-token-0" }), limiter.check, NOW)
  assert.deepEqual(refused.blocked, [
    { bucket: "failure_refresh_token", retryAfterSeconds: 300 },
    { bucket: "failure_ip", retryAfterSeconds: 300 },
  ])
})

test("callers without a trusted address get no shared failure ceiling", async () => {
  const limiter = memoryLimiter()
  for (let token = 0; token < 5; token += 1) {
    const clientId = `synthetic-client-${token}`
    await failTimes(15, () => tokenRequest({ ip: null, clientId, refreshToken: `synthetic-dead-token-${token}` }), limiter.check)
  }
  const admission = await checkOAuthTokenRateLimit(tokenRequest({ ip: null, refreshToken: "synthetic-live-token-b" }), limiter.check, NOW)
  assert.equal(admission.failure.source, null)
  assert.equal(admission.response, null)
})

test("only charged budgets are stored, under keys that reveal no credential, client ID or address", async () => {
  const limiter = memoryLimiter()
  const secretClient = "synthetic-basic-client"
  const secretToken = "synthetic-refresh-token-value"
  await exchange(tokenRequest({ clientId: secretClient, basic: true, refreshToken: secretToken }), 200, limiter.check)
  assert.equal(limiter.counts.size, 2, "an admitted success stores only the attempt budgets")

  await exchange(tokenRequest({ clientId: secretClient, basic: true, refreshToken: secretToken }), 401, limiter.check)
  assert.equal(limiter.counts.size, 4, "a failure adds its own budget and the address ceiling")

  for (const key of limiter.counts.keys()) {
    assert.match(key, /^oauth-token:(ip|client|fail:refresh|fail:ip):[A-Za-z0-9_-]{32}$/)
    for (const raw of [secretClient, secretToken, OFFICE, "synthetic-client-secret"]) assert.ok(!key.includes(raw), key)
  }
})
