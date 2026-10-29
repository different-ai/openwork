import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen } from "./harness.js"

// The real limiter SQL against a fresh local MySQL database. Every call takes
// an explicit `now`, so hours of traffic run in milliseconds.
const den = await bootDen()
after(() => den.close())

const { checkFixedWindowRateLimit, checkRateLimit } = await import("../../src/utils/rate-limit.js")
const { checkOAuthTokenRateLimit } = await import("../../src/oauth-token-rate-limit.js")
const { db } = await import("../../src/db.js")
const { RateLimitTable } = await import("@openwork-ee/den-db/schema")
const { eq } = await import("@openwork-ee/den-db/drizzle")

const T0 = 1_800_000_000_000
const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

async function stored(key: string) {
  const [row] = await db
    .select({ count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)
  return row ?? null
}

async function consumeEvery(key: string, maxRequests: number, windowMs: number, start: number, intervalMs: number, durationMs: number) {
  const results: { at: number; retryAfter: number | null }[] = []
  for (let at = start; at < start + durationMs; at += intervalMs) {
    results.push({ at, retryAfter: await checkFixedWindowRateLimit(key, maxRequests, windowMs, at) })
  }
  return results
}

test("steady traffic below the limit never accumulates across windows", async () => {
  // Two per minute, one every 30 seconds for an hour: each window is exactly full.
  const full = await consumeEvery("windows:steady-full", 2, MINUTE, T0, 30 * SECOND, HOUR)
  assert.equal(full.length, 120)
  assert.deepEqual(full.filter((result) => result.retryAfter !== null), [])

  const roomy = await consumeEvery("windows:steady-roomy", 60, MINUTE, T0, 30 * SECOND, HOUR)
  assert.deepEqual(roomy.filter((result) => result.retryAfter !== null), [])
  assert.deepEqual(await stored("windows:steady-roomy"), { count: 2, lastRequest: T0 + HOUR - MINUTE })
})

test("a burst over the budget inside one window is limited until that window ends", async () => {
  const key = "windows:burst"
  for (const offset of [0, SECOND, 2 * SECOND]) {
    assert.equal(await checkFixedWindowRateLimit(key, 3, MINUTE, T0 + offset), null)
  }
  assert.equal(await checkFixedWindowRateLimit(key, 3, MINUTE, T0 + 10 * SECOND), 50)
  assert.equal(await checkFixedWindowRateLimit(key, 3, MINUTE, T0 + 58_200), 2)
  assert.equal(await checkFixedWindowRateLimit(key, 3, MINUTE, T0 + 59_001), 1)
  assert.deepEqual(await stored(key), { count: 3, lastRequest: T0 }, "blocked requests never move the window")
  assert.equal(await checkFixedWindowRateLimit(key, 3, MINUTE, T0 + MINUTE), null)
})

test("window boundaries: just before, exactly at and just after the end", async () => {
  const key = "windows:boundary"
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0), null)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + 1), null)

  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + MINUTE - 1, false), 1)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + MINUTE - 1), 1)

  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + MINUTE, false), null)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + MINUTE), null)
  assert.deepEqual(await stored(key), { count: 1, lastRequest: T0 + MINUTE }, "the next window starts at its first request")
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + MINUTE + 1), null)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + MINUTE + 2), 60)

  const late = "windows:boundary-late"
  assert.equal(await checkFixedWindowRateLimit(late, 2, MINUTE, T0), null)
  assert.equal(await checkFixedWindowRateLimit(late, 2, MINUTE, T0 + 1), null)
  assert.equal(await checkFixedWindowRateLimit(late, 2, MINUTE, T0 + MINUTE + 1), null)
  assert.deepEqual(await stored(late), { count: 1, lastRequest: T0 + MINUTE + 1 })
})

test("a failure budget expires a window after its first failure, however often blocked calls retry", async () => {
  // Shaped like the OAuth token failure budget: admission only reads it, and
  // each rejected exchange consumes it.
  const key = "windows:failures"
  const max = 15
  const window = 5 * MINUTE
  for (let failure = 0; failure < max; failure += 1) {
    assert.equal(await checkFixedWindowRateLimit(key, max, window, T0 + failure * 5 * SECOND), null)
  }
  assert.equal(await checkFixedWindowRateLimit(key, max, window, T0 + 100 * SECOND, false), 200)
  for (const at of [T0 + 150 * SECOND, T0 + 200 * SECOND, T0 + 299 * SECOND]) {
    assert.ok((await checkFixedWindowRateLimit(key, max, window, at)) !== null)
  }
  assert.deepEqual(await stored(key), { count: max, lastRequest: T0 })
  assert.equal(await checkFixedWindowRateLimit(key, max, window, T0 + window - 1, false), 1)
  assert.equal(await checkFixedWindowRateLimit(key, max, window, T0 + window, false), null)

  // One failure a minute for an hour stays under 15 per five minutes.
  const spread = await consumeEvery("windows:failures-spread", max, window, T0, MINUTE, HOUR)
  assert.deepEqual(spread.filter((result) => result.retryAfter !== null), [])
})

test("concurrent requests admit exactly the budget, for a new key and a reopening window", async () => {
  const max = 10
  const fresh = await Promise.all(Array.from({ length: 25 }, () => checkFixedWindowRateLimit("windows:concurrent", max, MINUTE, T0)))
  assert.equal(fresh.filter((retryAfter) => retryAfter === null).length, max)
  assert.ok(fresh.every((retryAfter) => retryAfter === null || retryAfter === 60), fresh.join(","))
  assert.deepEqual(await stored("windows:concurrent"), { count: max, lastRequest: T0 })

  const reopenAt = T0 + MINUTE + 5
  const reopened = await Promise.all(Array.from({ length: 25 }, () => checkFixedWindowRateLimit("windows:concurrent", max, MINUTE, reopenAt)))
  assert.equal(reopened.filter((retryAfter) => retryAfter === null).length, max)
  assert.deepEqual(await stored("windows:concurrent"), { count: max, lastRequest: reopenAt })
})

test("reading without consuming never writes", async () => {
  assert.equal(await checkFixedWindowRateLimit("windows:read-missing", 2, MINUTE, T0, false), null)
  assert.equal(await stored("windows:read-missing"), null)

  const key = "windows:read"
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0), null)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + SECOND, false), null)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + 2 * MINUTE, false), null)
  assert.deepEqual(await stored(key), { count: 1, lastRequest: T0 }, "a read neither counts nor opens a window")

  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + 2 * SECOND), null)
  assert.equal(await checkFixedWindowRateLimit(key, 2, MINUTE, T0 + 3 * SECOND, false), 57)
  assert.deepEqual(await stored(key), { count: 2, lastRequest: T0 })
})

test("checkRateLimit keeps its inactivity-reset accounting for its other callers", async () => {
  const key = "windows:inactivity"
  for (let at = T0; at < T0 + 2 * MINUTE; at += 30 * SECOND) {
    assert.equal(await checkRateLimit(key, 4, MINUTE, at), null)
  }
  // Activity every 30 seconds never lets the counter reset.
  assert.equal(await checkRateLimit(key, 4, MINUTE, T0 + 2 * MINUTE), 30)
  assert.deepEqual(await stored(key), { count: 4, lastRequest: T0 + 90 * SECOND })
})

test("a key last counted by checkRateLimit waits at most one more window", async () => {
  const key = "windows:moved-over"
  for (let at = T0; at < T0 + 2 * MINUTE; at += 30 * SECOND) {
    assert.equal(await checkRateLimit(key, 4, MINUTE, at), null)
  }
  // The stored last-request time (T0 + 90 s) now reads as the window start.
  assert.equal(await checkFixedWindowRateLimit(key, 4, MINUTE, T0 + 2 * MINUTE), 30)
  const later = await consumeEvery(key, 4, MINUTE, T0 + 150 * SECOND, 30 * SECOND, HOUR)
  assert.deepEqual(later.filter((result) => result.retryAfter !== null), [])
})

test("the OAuth token limiter counts in fixed windows by default", async () => {
  // A client refreshing every 30 seconds for an hour stays under its per-minute budget.
  const statuses: number[] = []
  for (let at = T0; at < T0 + HOUR; at += 30 * SECOND) {
    const request = new Request("http://den.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": "203.0.113.20" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "synthetic-steady-client" }),
    })
    const admission = await checkOAuthTokenRateLimit(request, undefined, at)
    statuses.push(admission.response?.status ?? 200)
  }
  assert.equal(statuses.length, 120)
  assert.deepEqual(statuses.filter((status) => status !== 200), [])
})
