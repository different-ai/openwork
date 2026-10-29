/**
 * When the Workbot page's live stream tries again: at once after a stream that was open, and with growing, jittered
 * waits after refusals, so a page whose runner is unavailable doesn't ask every few seconds for hours.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { LIVE_REOPEN_MS, LIVE_RETRY_MAX_MS, liveRetryDelay, liveStreamOff, retryAfterMs } from "../../../packages/workbot-ui/src/live-retry.js"

const shortest = () => 0
const longest = () => 1

test("a stream that was open comes back at once; refusals in a row wait twice as long each time, up to a minute", () => {
  assert.equal(liveRetryDelay(0, null, longest), LIVE_REOPEN_MS)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 50, 5_000].map((failures) => liveRetryDelay(failures, null, longest)), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000])
  // Jitter stays in the upper half of each window.
  assert.deepEqual([1, 2, 7].map((failures) => liveRetryDelay(failures, null, shortest)), [500, 1_000, 30_000])
  for (let failures = 1; failures < 12; failures += 1) {
    const delay = liveRetryDelay(failures)
    assert.ok(delay >= liveRetryDelay(failures, null, shortest) && delay <= liveRetryDelay(failures, null, longest))
  }
})

test("a server's Retry-After is the least the page waits, within the same cap", () => {
  assert.equal(liveRetryDelay(1, 5_000, longest), 5_000)
  assert.equal(liveRetryDelay(6, 5_000, longest), 32_000)
  assert.equal(liveRetryDelay(1, 3_600_000, longest), LIVE_RETRY_MAX_MS)
  assert.equal(retryAfterMs("5"), 5_000)
  assert.equal(retryAfterMs("0"), 0)
  for (const unreadable of [null, "", " ", "soon", "-1", "Wed, 21 Oct 2015 07:28:00 GMT"]) assert.equal(retryAfterMs(unreadable), null)
})

test("an hour of refusals costs at most a couple of requests a minute", () => {
  let waited = 0
  let requests = 0
  while (waited < 3_600_000) {
    requests += 1
    waited += liveRetryDelay(requests, 5_000, shortest)
  }
  // Waiting 8 s at most, as the page did before, made about 450.
  assert.ok(requests <= 125, `${requests} requests`)
})

test("only Workbot being off for the organization stops the page trying", () => {
  assert.equal(liveStreamOff(409, { error: "workbot_not_enabled" }), true)
  assert.equal(liveStreamOff(409, { error: "workbot_runner_unavailable" }), false)
  assert.equal(liveStreamOff(503, { error: "workbot_not_enabled" }), false)
  assert.equal(liveStreamOff(409, null), false)
})
