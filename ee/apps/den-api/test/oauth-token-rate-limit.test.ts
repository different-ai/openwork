import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import {
  checkOAuthTokenRateLimit,
  recordOAuthTokenFailure,
  type OAuthTokenRateLimitCheck,
} from "../src/oauth-token-rate-limit.js"

type Bucket = {
  count: number
  lastRequest: number
}

type CheckCall = {
  consume: boolean
  key: string
}

function createInMemoryRateLimit() {
  const buckets = new Map<string, Bucket>()
  const calls: CheckCall[] = []
  const check: OAuthTokenRateLimitCheck = async (key, maxRequests, windowMs, now, consume = true) => {
    calls.push({ consume, key })
    const bucket = buckets.get(key)
    if (!bucket) {
      if (consume) buckets.set(key, { count: 1, lastRequest: now })
      return null
    }

    const elapsed = now - bucket.lastRequest
    if (elapsed > windowMs) {
      if (consume) buckets.set(key, { count: 1, lastRequest: now })
      return null
    }
    if (bucket.count >= maxRequests) {
      return Math.max(1, Math.ceil((windowMs - elapsed) / 1000))
    }
    if (consume) {
      bucket.count += 1
      bucket.lastRequest = now
    }
    return null
  }

  return { buckets, calls, check }
}

function tokenRequest(clientId: string | null, ip: string, basic = false) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-for": `${ip}, 10.0.0.1`,
  })
  const body = new URLSearchParams({ grant_type: "refresh_token" })
  if (clientId && basic) {
    headers.set("authorization", `Basic ${btoa(`${clientId}:never-store-this-secret`)}`)
  } else if (clientId) {
    body.set("client_id", clientId)
  }
  return new Request("https://api.example.com/api/auth/oauth2/token", {
    method: "POST",
    headers,
    body,
  })
}

async function exchange(
  request: Request,
  handlerStatus: number,
  check: OAuthTokenRateLimitCheck,
  now: number,
) {
  const admission = await checkOAuthTokenRateLimit(request, check, now)
  if (admission.response) return { handlerRan: false, response: admission.response }

  const response = new Response(null, { status: handlerStatus })
  await recordOAuthTokenFailure(admission.failureKey, response, check, now)
  return { handlerRan: true, response }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

test("clients behind one IP have independent attempt budgets", async () => {
  const limiter = createInMemoryRateLimit()
  const now = Date.now()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await exchange(tokenRequest("client-a", "203.0.113.10"), 200, limiter.check, now)
    expect(result.response.status).toBe(200)
  }

  expect((await exchange(tokenRequest("client-a", "203.0.113.10"), 200, limiter.check, now)).response.status).toBe(429)
  expect((await exchange(tokenRequest("client-b", "203.0.113.10"), 200, limiter.check, now)).response.status).toBe(200)
})

test("fifteen failed exchanges block the next request before authentication", async () => {
  const limiter = createInMemoryRateLimit()
  const request = tokenRequest("failing-client", "203.0.113.11", true)
  const now = Date.now()
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const result = await exchange(request, attempt % 2 === 0 ? 401 : 403, limiter.check, now)
    expect(result.handlerRan).toBeTrue()
    expect(result.response.status === 401 || result.response.status === 403).toBeTrue()
  }

  const blocked = await exchange(request, 401, limiter.check, now)
  expect(blocked.handlerRan).toBeFalse()
  expect(blocked.response.status).toBe(429)
  expect(blocked.response.headers.get("retry-after")).toBe("300")
  expect(blocked.response.headers.get("cache-control")).toBe("no-store")
  expect(blocked.response.headers.get("pragma")).toBe("no-cache")
  expect(await blocked.response.json()).toEqual({
    error: "rate_limited",
    error_description: "Too many OAuth token requests. Try again later.",
  })
})

test("pre-handler normalization rejections consume the failure budget", async () => {
  const limiter = createInMemoryRateLimit()
  const request = tokenRequest("malformed-client", "203.0.113.14", true)
  const now = Date.now()
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const admission = await checkOAuthTokenRateLimit(request, limiter.check, now)
    expect(admission.response).toBeNull()
    // Model handleAuthRequest rejecting the request in normalization, before
    // auth.handler ever runs.
    await recordOAuthTokenFailure(
      admission.failureKey,
      new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }),
      limiter.check,
      now,
    )
  }

  const blocked = await checkOAuthTokenRateLimit(request, limiter.check, now)
  expect(blocked.response?.status).toBe(429)
  expect(limiter.buckets.get(`oauth-token:fail:${hash("malformed-client")}`)?.count).toBe(15)
})

test("successful exchanges never consume the failure budget", async () => {
  const limiter = createInMemoryRateLimit()
  const clientId = "successful-client"
  const request = tokenRequest(clientId, "203.0.113.12")
  const failureKey = `oauth-token:fail:${hash(clientId)}`
  const now = Date.now()

  for (let attempt = 0; attempt < 30; attempt += 1) {
    expect((await exchange(request, 200, limiter.check, now)).response.status).toBe(200)
  }
  expect(limiter.buckets.has(failureKey)).toBeFalse()

  for (let attempt = 0; attempt < 15; attempt += 1) {
    expect((await exchange(request, 400, limiter.check, now)).response.status).toBe(400)
  }
  expect(limiter.buckets.get(failureKey)?.count).toBe(15)
  expect((await exchange(request, 200, limiter.check, now)).handlerRan).toBeFalse()
})

test("hashed keys bound rotating and anonymous clients without storing raw identities", async () => {
  const identityLimiter = createInMemoryRateLimit()
  const rotatingLimiter = createInMemoryRateLimit()
  const ip = "203.0.113.13"
  const now = Date.now()
  await exchange(tokenRequest("raw-basic-client", ip, true), 200, identityLimiter.check, now)
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await exchange(tokenRequest(`rotating-client-${attempt}`, ip), 200, rotatingLimiter.check, now)
    expect(result.response.status).toBe(200)
  }
  expect((await exchange(tokenRequest("rotating-client-300", ip), 200, rotatingLimiter.check, now)).response.status).toBe(429)

  const anonymousLimiter = createInMemoryRateLimit()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect((await exchange(tokenRequest(null, ip), 200, anonymousLimiter.check, now)).response.status).toBe(200)
  }
  expect((await exchange(tokenRequest(null, ip), 200, anonymousLimiter.check, now)).response.status).toBe(429)

  const keys = [...identityLimiter.calls, ...rotatingLimiter.calls, ...anonymousLimiter.calls].map((call) => call.key)
  expect(keys).toContain(`oauth-token:ip:${hash(ip)}`)
  expect(keys).toContain(`oauth-token:client:${hash("raw-basic-client")}`)
  expect(keys).toContain(`oauth-token:anon:${hash(ip)}`)
  expect(keys).toContain(`oauth-token:fail:${hash(ip)}`)
  for (const key of keys) {
    expect(key).not.toContain(ip)
    expect(key).not.toContain("raw-basic-client")
    expect(key).not.toContain("rotating-client")
    expect(key).not.toContain("never-store-this-secret")
    expect(key.length).toBeLessThan(512)
  }
})
