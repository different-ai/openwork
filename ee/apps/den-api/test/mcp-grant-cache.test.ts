import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const grantId = createDenTypeId("oauthConsent")
const cachedValues = new Map<string, string>()
const setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = []
let loaderCalls = 0
let cacheModule: typeof import("../src/cache.js")
let restoreCacheDependencies: (() => void) | null = null

const AuthSessionTable = { id: "session.id" }
const AuthUserTable = { id: "user.id" }
const InvitationTable = { id: "invitation.id" }
const MemberTable = { id: "member.id" }
const OAuthConsentTable = { id: "consent.id" }
const OrganizationTable = { id: "organization.id" }

let failSetForKeyPrefix: string | null = null

const redis = {
  get: (key: string) => Promise.resolve(cachedValues.get(key) ?? null),
  set: (key: string, value: string, mode: string, ttl: number) => {
    if (failSetForKeyPrefix && key.startsWith(failSetForKeyPrefix)) {
      return Promise.reject(new Error("redis set unavailable"))
    }
    setCalls.push({ key, value, mode, ttl })
    cachedValues.set(key, value)
    return Promise.resolve("OK")
  },
  del: (...keys: string[]) => {
    for (const key of keys) {
      cachedValues.delete(key)
    }
    return Promise.resolve(keys.length)
  },
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"

  mock.module("@openwork-ee/den-db/schema", () => ({
    AuthSessionTable,
    AuthUserTable,
    InvitationTable,
    MemberTable,
    OAuthConsentTable,
    OrganizationTable,
  }))
  mock.module("@openwork-ee/den-db/drizzle", () => ({
    and: (...conditions: unknown[]) => ({ conditions }),
    asc: (field: unknown) => field,
    eq: (field: unknown, value: unknown) => ({ field, value }),
    gt: (field: unknown, value: unknown) => ({ field, value }),
    isNull: (field: unknown) => ({ field }),
    lt: (field: unknown, value: unknown) => ({ field, value }),
    lte: (field: unknown, value: unknown) => ({ field, value }),
  }))
  mock.module("../src/db.js", () => ({ db: {} }))

  cacheModule = await import("../src/cache.js")
  restoreCacheDependencies = cacheModule.setCacheDependenciesForTest({
    redis,
    authGrantLoader: (requestedGrantId) => {
      loaderCalls += 1
      return Promise.resolve({ id: requestedGrantId })
    },
  })
})

beforeEach(() => {
  cachedValues.clear()
  setCalls.length = 0
  loaderCalls = 0
  failSetForKeyPrefix = null
})

afterAll(() => {
  restoreCacheDependencies?.()
  mock.restore()
})

test("grant liveness cache hits avoid repeated loader calls", async () => {
  const first = await cacheModule.cache.auth.grant(grantId)
  const second = await cacheModule.cache.auth.grant(grantId)

  expect(first).toEqual({ id: grantId })
  expect(second).toEqual(first)
  expect(loaderCalls).toBe(1)
  expect(setCalls).toContainEqual({
    key: `cache:auth:grant:${grantId}`,
    value: JSON.stringify({ id: grantId }),
    mode: "EX",
    ttl: 60,
  })
})

test("a failed tombstone write still clears the stale positive grant entry", async () => {
  await cacheModule.cache.auth.grant(grantId)
  expect(cachedValues.has(`cache:auth:grant:${grantId}`)).toBe(true)

  failSetForKeyPrefix = "cache:auth:grant-revoked:"
  await cacheModule.cache.auth.revokeGrant(grantId)

  expect(cachedValues.has(`cache:auth:grant:${grantId}`)).toBe(false)
  const resolved = await cacheModule.cache.auth.grant(grantId)
  expect(resolved).toEqual({ id: grantId })
  // The stale positive entry is gone, so liveness re-consults the loader
  // (database-authoritative) instead of serving the pre-revocation cache hit.
  expect(loaderCalls).toBe(2)
})

test("grant revocation tombstones block stale cache repopulation", async () => {
  await cacheModule.cache.auth.revokeGrant(grantId)
  const resolved = await cacheModule.cache.auth.grant(grantId)

  expect(resolved).toBeNull()
  expect(loaderCalls).toBe(0)
  expect(cachedValues.get(`cache:auth:grant-revoked:${grantId}`)).toBe("1")
  expect(cachedValues.has(`cache:auth:grant:${grantId}`)).toBe(false)
})
