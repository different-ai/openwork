import assert from "node:assert/strict"
import { test } from "node:test"
import type { FeatureKey } from "@openwork/features"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/feature_usage_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-feature-usage-unit-test-secret-not-for-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-feature-usage-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
const { createFeatureUsageMarker } = await import("../src/feature-usage.js")

type Written = { memberId: string; keys: readonly FeatureKey[]; day: string }

function harness(options: { fail?: () => boolean } = {}) {
  let now = new Date("2026-10-27T10:00:00.000Z")
  const writes: Written[] = []
  const mark = createFeatureUsageMarker(async (input) => {
    if (options.fail?.()) throw new Error("database unavailable")
    writes.push({ memberId: input.memberId, keys: input.keys, day: input.at.toISOString().slice(0, 10) })
  }, () => now)
  return { mark, writes, setNow: (value: string) => { now = new Date(value) } }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("a member's feature is written once per UTC day per replica", async () => {
  const { mark, writes, setNow } = harness()
  mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter", "autoRouter"] })
  mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter"] })
  setNow("2026-10-27T23:59:59.000Z")
  mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter", "nativeDictation"] })
  mark({ organizationId: "org", memberId: "member-b", keys: ["autoRouter"] })
  await settle()
  assert.deepEqual(writes, [
    { memberId: "member-a", keys: ["autoRouter"], day: "2026-10-27" },
    { memberId: "member-a", keys: ["nativeDictation"], day: "2026-10-27" },
    { memberId: "member-b", keys: ["autoRouter"], day: "2026-10-27" },
  ])
})

test("the next UTC day writes again", async () => {
  const { mark, writes, setNow } = harness()
  mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter"] })
  setNow("2026-10-28T00:00:01.000Z")
  mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter"] })
  mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter"] })
  await settle()
  assert.deepEqual(writes.map((write) => write.day), ["2026-10-27", "2026-10-28"])
})

test("a failed write is retried by the next use the same day and never throws", async () => {
  let failing = true
  const { mark, writes } = harness({ fail: () => failing })
  const warn = console.warn
  console.warn = () => undefined
  try {
    assert.doesNotThrow(() => mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter"] }))
    await settle()
    failing = false
    mark({ organizationId: "org", memberId: "member-a", keys: ["autoRouter"] })
    await settle()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(writes.map((write) => write.keys), [["autoRouter"]])
})

test("nothing is written for an empty list", async () => {
  const { mark, writes } = harness()
  mark({ organizationId: "org", memberId: "member-a", keys: [] })
  await settle()
  assert.equal(writes.length, 0)
})
