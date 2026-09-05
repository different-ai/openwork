import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const sessionId = createDenTypeId("session")
const sessionToken = "cached-session-token"
const cachedValues = new Map<string, string>()
const setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = []
const deleteCalls: string[] = []
let selectCount = 0
let membershipSelectCount = 0
let authSelectCount = 0
let authSessionIdSelectCount = 0
let authSessionExpiresAt = new Date("2026-08-17T12:00:00.000Z")
let authSessionLive = true
let cacheModule: typeof import("../src/cache.js")
let restoreCacheDependencies: (() => void) | null = null

const redis = {
  get: (key: string) => Promise.resolve(cachedValues.get(key) ?? null),
  set: (key: string, value: string, mode: string, ttl: number) => {
    setCalls.push({ key, value, mode, ttl })
    cachedValues.set(key, value)
    return Promise.resolve("OK")
  },
  del: (...keys: string[]) => {
    for (const key of keys) {
      deleteCalls.push(key)
      cachedValues.delete(key)
    }
    return Promise.resolve(1)
  },
  scan: (cursor: string, mode: "MATCH", pattern: string, countMode: "COUNT", count: number) => {
    void cursor
    void mode
    void countMode
    void count
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern
    return Promise.resolve(["0", Array.from(cachedValues.keys()).filter((key) => key.startsWith(prefix))] as [string, string[]])
  },
}

function memberRows() {
  const now = new Date("2026-08-10T12:00:00.000Z")
  return [{
    id: memberId,
    userId,
    inviteId: null,
    role: "member",
    createdAt: now,
    joinedAt: now,
    user: {
      id: userId,
      email: "member@example.com",
      name: "Member User",
      image: null,
    },
    isOwner: false,
  }]
}

function authSession() {
  const now = new Date("2026-08-10T12:00:00.000Z")
  return {
    session: {
      id: sessionId,
      token: sessionToken,
      userId,
      activeOrganizationId: null,
      activeTeamId: null,
      expiresAt: authSessionExpiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: userId,
      name: "Session User",
      email: "session@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"

  cacheModule = await import("../src/cache.js")
  restoreCacheDependencies = cacheModule.setCacheDependenciesForTest({
    redis,
    orgMembersLoader: () => {
      selectCount += 1
      return Promise.resolve(memberRows())
    },
    orgMembershipLoader: () => {
      membershipSelectCount += 1
      return Promise.resolve({ id: memberId, role: "member", isOwner: false })
    },
    authSessionLoader: () => {
      authSelectCount += 1
      return Promise.resolve(authSession())
    },
    authSessionIdLoader: () => {
      authSessionIdSelectCount += 1
      return Promise.resolve(authSessionLive ? {
        id: sessionId,
        expiresAt: authSessionExpiresAt,
      } : null)
    },
  })
})

beforeEach(() => {
  cachedValues.clear()
  setCalls.length = 0
  deleteCalls.length = 0
  selectCount = 0
  membershipSelectCount = 0
  authSelectCount = 0
  authSessionIdSelectCount = 0
  authSessionExpiresAt = new Date("2026-08-17T12:00:00.000Z")
  authSessionLive = true
  setSystemTime(new Date("2026-08-10T12:00:00.000Z"))
})

afterAll(() => {
  setSystemTime()
  restoreCacheDependencies?.()
})

test("cache.org.members stores and reuses org member query results", async () => {
  const first = await cacheModule.cache.org.members(organizationId)
  const second = await cacheModule.cache.org.members(organizationId)

  expect(first).toEqual(second)
  expect(first).toHaveLength(1)
  expect(first[0].id).toBe(memberId)
  expect(selectCount).toBe(1)
  expect(setCalls).toHaveLength(1)
  expect(setCalls[0]).toMatchObject({
    key: `cache:org:members:${organizationId}`,
    mode: "EX",
    ttl: 300,
  })
})

test("cache.auth.session uses the Den key and caps Redis TTL at one hour", async () => {
  const first = await cacheModule.cache.auth.session(sessionToken)
  const second = await cacheModule.cache.auth.session(sessionToken)

  expect(first).toEqual(second)
  expect(first?.session.id).toBe(sessionId)
  expect(authSelectCount).toBe(1)
  expect(authSessionIdSelectCount).toBe(0)
  expect(setCalls).toHaveLength(1)
  expect(setCalls[0]).toMatchObject({
    key: `cache:auth:session:${sessionToken}`,
    mode: "EX",
    ttl: 3600,
  })
})

test("cache.auth.activeSessionId stores and reuses session id liveness", async () => {
  const first = await cacheModule.cache.auth.activeSessionId(sessionId)
  const second = await cacheModule.cache.auth.activeSessionId(sessionId)

  expect(first).toEqual(second)
  expect(first?.id).toBe(sessionId)
  expect(authSessionIdSelectCount).toBe(1)
  expect(setCalls).toHaveLength(1)
  expect(setCalls[0]).toMatchObject({
    key: `cache:auth:session-id:${sessionId}`,
    mode: "EX",
    ttl: 60,
  })
})

test("cache.auth.activeSessionId does not re-check the database on cached liveness hits", async () => {
  authSessionExpiresAt = new Date("2026-08-16T11:00:00.000Z")
  const first = await cacheModule.cache.auth.activeSessionId(sessionId)
  authSessionExpiresAt = new Date("2026-08-17T12:00:00.000Z")

  const second = await cacheModule.cache.auth.activeSessionId(sessionId)

  expect(first?.expiresAt).toEqual(new Date("2026-08-16T11:00:00.000Z"))
  expect(second?.expiresAt).toEqual(new Date("2026-08-16T11:00:00.000Z"))
  expect(authSessionIdSelectCount).toBe(1)
  expect(setCalls).toHaveLength(1)
})

test("cache.auth.activeSessionId rejects missing database sessions", async () => {
  authSessionLive = false

  const resolved = await cacheModule.cache.auth.activeSessionId(sessionId)

  expect(resolved).toBeNull()
  expect(authSessionIdSelectCount).toBe(1)
  expect(setCalls).toHaveLength(0)
})

test("cache.auth.session returns cached entries without a database liveness check", async () => {
  await cacheModule.cache.auth.session(sessionToken)
  authSessionLive = false

  const resolved = await cacheModule.cache.auth.session(sessionToken)

  expect(resolved?.session.id).toBe(sessionId)
  expect(authSelectCount).toBe(1)
  expect(authSessionIdSelectCount).toBe(0)
  expect(deleteCalls).toEqual([])
})

test("cache.auth.session limits TTL to the remaining session lifetime", async () => {
  authSessionExpiresAt = new Date("2026-08-10T12:30:00.000Z")

  await cacheModule.cache.auth.session(sessionToken)

  expect(setCalls[0]?.ttl).toBe(1800)
})

test("cache.auth.deleteSession invalidates the exact Den cache key", async () => {
  await cacheModule.cache.auth.session(sessionToken)
  await cacheModule.cache.auth.activeSessionId(sessionId)
  deleteCalls.length = 0
  await cacheModule.cache.auth.deleteSession(sessionToken)

  expect(deleteCalls).toEqual([`cache:auth:session:${sessionToken}`, `cache:auth:session-id:${sessionId}`])
})

test("cache.auth.revokeSession blocks stale session cache repopulation", async () => {
  await cacheModule.cache.auth.revokeSession(sessionToken)
  authSessionLive = true

  const resolved = await cacheModule.cache.auth.session(sessionToken)

  expect(resolved).toBeNull()
  expect(authSelectCount).toBe(0)
  expect(cachedValues.has(`cache:auth:session:${sessionToken}`)).toBe(false)
})

test("cache.auth.deleteSessionId invalidates liveness without a token cache entry", async () => {
  await cacheModule.cache.auth.activeSessionId(sessionId)
  deleteCalls.length = 0

  await cacheModule.cache.auth.deleteSessionId(sessionId)

  expect(deleteCalls).toEqual([`cache:auth:session-id:${sessionId}`])
})

test("cache.auth.revokeSessionId blocks stale liveness cache repopulation", async () => {
  await cacheModule.cache.auth.revokeSessionId(sessionId)
  authSessionLive = true

  const resolved = await cacheModule.cache.auth.activeSessionId(sessionId)

  expect(resolved).toBeNull()
  expect(authSessionIdSelectCount).toBe(0)
  expect(cachedValues.has(`cache:auth:session-id:${sessionId}`)).toBe(false)
})

test("cache.org.membership stores and reuses user organization membership checks", async () => {
  const first = await cacheModule.cache.org.membership({ organizationId, userId })
  const second = await cacheModule.cache.org.membership({ organizationId, userId })

  expect(first).toEqual(second)
  expect(first?.id).toBe(memberId)
  expect(membershipSelectCount).toBe(1)
  expect(setCalls).toHaveLength(1)
  expect(setCalls[0]).toMatchObject({
    key: `cache:org:member:${organizationId}:${userId}`,
    mode: "EX",
    ttl: 300,
  })
})

test("cache.org.deleteMembers invalidates aggregate and per-user membership caches", async () => {
  await cacheModule.cache.org.members(organizationId)
  await cacheModule.cache.org.membership({ organizationId, userId })
  deleteCalls.length = 0

  await cacheModule.cache.org.deleteMembers(organizationId)

  expect(deleteCalls).toEqual([
    `cache:org:members:${organizationId}`,
    `cache:org:member:${organizationId}:${userId}`,
  ])
})

test("cache.org.deleteMemberList invalidates only the aggregate member list", async () => {
  await cacheModule.cache.org.members(organizationId)
  await cacheModule.cache.org.membership({ organizationId, userId })
  deleteCalls.length = 0

  await cacheModule.cache.org.deleteMemberList(organizationId)

  expect(deleteCalls).toEqual([`cache:org:members:${organizationId}`])
})

test("cache.org.deleteMembership invalidates one per-user membership cache", async () => {
  await cacheModule.cache.org.members(organizationId)
  await cacheModule.cache.org.membership({ organizationId, userId })
  deleteCalls.length = 0

  await cacheModule.cache.org.deleteMembership({ organizationId, userId })

  expect(deleteCalls).toEqual([`cache:org:member:${organizationId}:${userId}`])
})

test("cache.auth.session falls back to the database loader without Redis", async () => {
  const restore = cacheModule.setCacheDependenciesForTest({ redis: null })
  try {
    const resolved = await cacheModule.cache.auth.session(sessionToken)
    expect(resolved?.session.token).toBe(sessionToken)
    expect(authSelectCount).toBe(1)
    expect(setCalls).toHaveLength(0)
  } finally {
    restore()
  }
})
