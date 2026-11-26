import assert from "node:assert/strict"
import { test } from "node:test"
import { createFeatureCache } from "../src/feature-cache.js"

test("lookup failure returns false without a last value and keeps the last value until success", async () => {
  let time = 0
  let lookup: boolean | Error = new Error("Fixture outage")
  const errors: string[] = []
  const cache = createFeatureCache({ maxEntries: 10, ttlMs: 5, now: () => time, fallback: false,
    lookup: async (key: string) => {
      if (lookup instanceof Error) throw lookup
      return key === "Dana" && lookup
    }, onError: (key) => { errors.push(key) },
  })
  assert.deepEqual(await Promise.all([cache.get("Dana"), cache.get("Dana")]), [false, false])
  assert.deepEqual(errors, ["Dana"])
  lookup = true
  time += 6
  assert.equal(await cache.get("Dana"), true)
  lookup = new Error("Fixture outage again")
  cache.invalidate()
  assert.equal(await cache.get("Dana"), true)
  time += 6
  assert.equal(await cache.get("Dana"), true)
  assert.equal(await cache.get("Priya"), false)
  lookup = false
  time += 6
  assert.equal(await cache.get("Dana"), false)
  assert.deepEqual(errors, ["Dana", "Dana", "Dana", "Priya"])
})

test("a pending lookup stays single-flight even after its TTL elapses", async () => {
  let time = 0
  const deferred = Promise.withResolvers<boolean>()
  let calls = 0
  const cache = createFeatureCache({ maxEntries: 10, ttlMs: 5, now: () => time, fallback: false,
    lookup: (_key: string) => { calls += 1; return deferred.promise }, onError: () => assert.fail(),
  })
  const first = cache.get("Dana")
  time += 6
  assert.equal(cache.get("Dana"), first)
  deferred.resolve(true)
  assert.equal(await first, true)
  assert.equal(calls, 1)
})

test("eviction removes only the oldest entry", async () => {
  const lookups: string[] = []
  const cache = createFeatureCache({ maxEntries: 2, ttlMs: 5, now: () => 0, fallback: false,
    lookup: async (key: string) => { lookups.push(key); return true }, onError: () => assert.fail(),
  })
  for (const key of ["Dana", "Sam", "Priya", "Sam", "Priya", "Dana"]) assert.equal(await cache.get(key), true)
  assert.deepEqual(lookups, ["Dana", "Sam", "Priya", "Dana"])
})
