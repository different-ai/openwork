import assert from "node:assert/strict"
import test from "node:test"
import { commitTiming, percentile, summarize } from "./ci-time-to-green.mjs"

const start = Date.parse("2026-10-26T21:00:00Z")
const check = (name, completedAt, conclusion = "success", app = "github-actions") => ({
  name, status: "completed", conclusion, started_at: "2026-10-26T21:00:05Z", completed_at: completedAt, app: { slug: app },
})

test("time to green counts from the push to the last required check and to the last check of all", () => {
  const timing = commitTiming(start, [
    check("openwork-tests-required", "2026-10-26T21:05:00Z"),
    check("warden-clear", "2026-10-26T21:01:00Z", "success", "diff-warden"),
    check("proof (core-chat)", "2026-10-26T21:09:30Z"),
    { name: "Evidence preview", status: "in_progress", conclusion: null, started_at: "2026-10-26T21:00:05Z", completed_at: null, app: { slug: "github-actions" } },
  ])
  assert.deepEqual(timing, { requiredS: 300, fullS: 570, state: "settled" })
})

test("a failed or unfinished check gives no time to green", () => {
  assert.deepEqual(commitTiming(start, [
    check("openwork-tests-required", "2026-10-26T21:05:00Z", "failure"),
    check("warden-clear", "2026-10-26T21:01:00Z"),
  ]), { requiredS: null, fullS: null, state: "failed" })
  const running = commitTiming(start, [
    check("openwork-tests-required", "2026-10-26T21:05:00Z"),
    check("warden-clear", "2026-10-26T21:01:00Z"),
    { name: "Unit tests", status: "in_progress", conclusion: null, started_at: "2026-10-26T21:00:05Z", completed_at: null, app: { slug: "github-actions" } },
  ])
  assert.equal(running.requiredS, 300)
  assert.equal(running.fullS, null)
  assert.equal(running.state, "running")
})

test("a rerun of a required check uses its latest attempt", () => {
  const timing = commitTiming(start, [
    { ...check("openwork-tests-required", "2026-10-26T21:03:00Z", "failure"), started_at: "2026-10-26T21:00:05Z" },
    { ...check("openwork-tests-required", "2026-10-26T21:12:00Z"), started_at: "2026-10-26T21:08:00Z" },
    check("warden-clear", "2026-10-26T21:01:00Z"),
  ])
  assert.equal(timing.requiredS, 720)
})

test("percentiles use the nearest rank", () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([30, 10, 20], 50), 20)
  assert.equal(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 90), 9)
  assert.deepEqual(summarize([{ fullS: 60 }, { fullS: null }, { fullS: 120 }], "fullS"), { n: 2, p50: 60, p90: 120, p99: 120, max: 120 })
})
