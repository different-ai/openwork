import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"

type StoredRateLimit = {
  count: number
  lastRequest: number
}

class DuplicateEntryError extends Error {
  code = "ER_DUP_ENTRY"
  errno = 1062
}

const rows = new Map<string, StoredRateLimit>()
let checkRateLimit: typeof import("../src/utils/rate-limit.js").checkRateLimit
let initialMisses = 0
let activeKey = ""
let activeMaxRequests = 0
let activeWindowMs = 0
let activeNow = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return typeof field === "string" ? field : null
}

function numberField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return typeof field === "number" ? field : null
}

function freshKey() {
  return `test:rate-limit:${randomUUID()}`
}

function rowForActiveKey() {
  if (initialMisses > 0) {
    initialMisses -= 1
    return []
  }

  const row = rows.get(activeKey)
  return row ? [{ ...row }] : []
}

function claimActiveKey() {
  const row = rows.get(activeKey)
  if (!row) {
    return { affectedRows: 0 }
  }

  if (activeNow - row.lastRequest > activeWindowMs) {
    row.count = 1
    row.lastRequest = activeNow
    return { affectedRows: 1 }
  }

  if (row.count >= activeMaxRequests) {
    return { affectedRows: 0 }
  }

  row.count += 1
  row.lastRequest = activeNow
  return { affectedRows: 1 }
}

mock.module("../src/db.js", () => ({
  db: {
    select: (_selection: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          limit: (_limit: number) => Promise.resolve(rowForActiveKey()),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        if (!isRecord(values)) {
          throw new Error("rate limit insert values must be an object")
        }

        const key = stringField(values, "key")
        const count = numberField(values, "count")
        const lastRequest = numberField(values, "lastRequest")
        if (!key || count === null || lastRequest === null) {
          throw new Error("rate limit insert values were incomplete")
        }

        if (rows.has(key)) {
          throw new DuplicateEntryError("Duplicate entry for rate_limit_key")
        }

        rows.set(key, { count, lastRequest })
        return Promise.resolve({ affectedRows: 1 })
      },
    }),
    update: (_table: unknown) => ({
      set: (_values: unknown) => ({
        where: (_condition: unknown) => Promise.resolve(claimActiveKey()),
      }),
    }),
  },
}))

function check(key: string, maxRequests: number, windowMs: number, now: number) {
  activeKey = key
  activeMaxRequests = maxRequests
  activeWindowMs = windowMs
  activeNow = now
  return checkRateLimit(key, maxRequests, windowMs, now)
}

beforeAll(async () => {
  checkRateLimit = (await import("../src/utils/rate-limit.js")).checkRateLimit
})

afterAll(() => {
  mock.restore()
})

test("concurrent first checks share one rate-limit row", async () => {
  const key = freshKey()
  initialMisses = 10
  const now = Date.now()

  const results = await Promise.all(Array.from({ length: 10 }, () => check(key, 20, 60_000, now)))

  expect(results).toEqual(Array.from({ length: 10 }, () => null))
  expect(rows.get(key)?.count).toBe(10)
})

test("rate limit preserves retry-after semantics", async () => {
  const key = freshKey()
  const now = Date.now()

  await expect(check(key, 2, 60_000, now)).resolves.toBeNull()
  await expect(check(key, 2, 60_000, now + 1_000)).resolves.toBeNull()
  await expect(check(key, 2, 60_000, now + 2_000)).resolves.toBe(59)
  expect(rows.get(key)?.count).toBe(2)
  await expect(check(key, 2, 60_000, now + 62_000)).resolves.toBeNull()
  expect(rows.get(key)?.count).toBe(1)
})
