import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { CachedAuthSession } from "../src/cache.js"

// No database or Redis is contacted: the cache gets an in-memory Redis double
// and injected loaders.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/auth_cache_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-auth-cache-unit-test-secret-000"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-auth-cache-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://api.unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { getRequestSession } = await import("../src/session.js")
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { cache, setCacheDependenciesForTest } = await import("../src/cache.js")
const { sealSessionTokenDigest, sessionTokenDigest } = await import("../src/session-token.js")

/** In-memory Redis with the Lua tombstone check; `refuseWrites` mimics a full Redis that still accepts deletes. */
function fakeRedis() {
  const redis = {
    values: new Map<string, string>(),
    calls: [] as string[],
    refuseWrites: false,
    async get(key: string) {
      redis.calls.push(`get ${key}`)
      return redis.values.get(key) ?? null
    },
    async set(key: string, value: string) {
      redis.calls.push(`set ${key}`)
      if (redis.refuseWrites) throw new Error("OOM command not allowed when used memory > 'maxmemory'.")
      redis.values.set(key, value)
      return "OK"
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        redis.calls.push(`del ${key}`)
        redis.values.delete(key)
      }
      return keys.length
    },
    async eval(_script: string, _numberOfKeys: number, ...args: Array<string | number>) {
      const [key, revokedKey, value] = args.map(String)
      redis.calls.push(`eval ${key}`)
      if (redis.values.has(revokedKey)) return 0
      if (redis.refuseWrites) throw new Error("OOM command not allowed when used memory > 'maxmemory'.")
      redis.values.set(key, value)
      return 1
    },
  }
  return redis
}

function sessionRow(token: string): CachedAuthSession {
  const now = new Date()
  const userId = createDenTypeId("user")
  return {
    session: {
      id: createDenTypeId("session"),
      token,
      userId,
      activeOrganizationId: null,
      activeTeamId: null,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: { id: userId, name: "Unit User", email: "unit@example.com", emailVerified: true, image: null, createdAt: now, updatedAt: now },
  }
}

test("an MCP bearer token never reaches the session cache or database", async () => {
  const redis = fakeRedis()
  let loads = 0
  const restore = setCacheDependenciesForTest({ redis, authSessionLoader: async () => { loads += 1; return null } })
  try {
    for (const token of ["eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl", "ow_mcp_at_0123456789abcdefghijklmnop"]) {
      assert.equal(await getRequestSession(new Headers({ authorization: `Bearer ${token}` })), null)
    }
    assert.deepEqual(redis.calls, [])
    assert.equal(loads, 0)

    // A Den session token (32 letters and digits) is still looked up.
    assert.equal(await getRequestSession(new Headers({ authorization: `Bearer ${"a1B2".repeat(8)}` })), null)
    assert.equal(loads, 1)
  } finally {
    restore()
  }
})

test("revoking a session clears its cache entry even when Redis refuses the tombstone", async (t) => {
  t.mock.method(console, "error", () => {})
  const token = "Rv0kedSessionT0kenRv0kedSessionT"
  const redis = fakeRedis()
  const restore = setCacheDependenciesForTest({ redis, authSessionLoader: async () => sessionRow(token) })
  try {
    assert.ok(await cache.auth.session(token))
    assert.ok(redis.values.has(`cache:auth:session:${sessionTokenDigest(token)}`))

    redis.refuseWrites = true
    await cache.auth.revokeSession(token)
    assert.equal(redis.values.has(`cache:auth:session:${sessionTokenDigest(token)}`), false)
  } finally {
    restore()
  }
})

test("the session cache is keyed by the token's hash and never holds the token", async () => {
  const token = "CacheKeyT0kenCacheKeyT0kenCacheK"
  const redis = fakeRedis()
  let loads = 0
  const restore = setCacheDependenciesForTest({ redis, authSessionLoader: async (presented) => {
    loads += 1
    return presented === token ? sessionRow(token) : null
  } })
  try {
    assert.equal((await cache.auth.session(token))?.session.token, token)
    assert.deepEqual([...redis.values.keys()], [`cache:auth:session:${sessionTokenDigest(token)}`])
    assert.equal([...redis.values.values()].some((value) => value.includes(token)), false)

    // A hit comes back with the caller's token; the hash is just another unknown token.
    assert.equal((await cache.auth.session(token))?.session.token, token)
    assert.equal(loads, 1)
    assert.equal(await cache.auth.session(sessionTokenDigest(token)), null)
  } finally {
    restore()
  }
})

test("revoking by the stored hash or a sealed reference clears the caller's cache entry", async () => {
  const token = "StoredF0rmT0kenStoredF0rmT0kenSt"
  for (const form of [sessionTokenDigest(token), sealSessionTokenDigest("unit-secret", sessionTokenDigest(token))]) {
    const redis = fakeRedis()
    const restore = setCacheDependenciesForTest({ redis, authSessionLoader: async () => sessionRow(token) })
    try {
      assert.ok(await cache.auth.session(token))
      await cache.auth.revokeSession(form)
      assert.equal(redis.values.has(`cache:auth:session:${sessionTokenDigest(token)}`), false)
      assert.equal(await cache.auth.session(token), null)
    } finally {
      restore()
    }
  }
})

test("revoking a session id clears its cache entry even when Redis refuses the tombstone", async (t) => {
  t.mock.method(console, "error", () => {})
  const sessionId = createDenTypeId("session")
  const redis = fakeRedis()
  redis.values.set(`cache:auth:session-id:${sessionId}`, JSON.stringify({ id: sessionId, expiresAt: new Date(Date.now() + 60_000) }))
  const restore = setCacheDependenciesForTest({ redis })
  try {
    redis.refuseWrites = true
    await cache.auth.revokeSessionId(sessionId)
    assert.equal(redis.values.has(`cache:auth:session-id:${sessionId}`), false)
  } finally {
    restore()
  }
})

test("membership is cached between checks", async () => {
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const membership = { id: createDenTypeId("member"), role: "member", isOwner: false }
  const redis = fakeRedis()
  let loads = 0
  const restore = setCacheDependenciesForTest({ redis, orgMembershipLoader: async () => { loads += 1; return membership } })
  try {
    assert.deepEqual(await cache.org.membership({ organizationId, userId }), membership)
    assert.deepEqual(await cache.org.membership({ organizationId, userId }), membership)
    assert.equal(loads, 1)
  } finally {
    restore()
  }
})

test("a request that read a membership before its revocation cannot cache it", async () => {
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const membership = { id: createDenTypeId("member"), role: "member", isOwner: false }
  const redis = fakeRedis()
  let row: typeof membership | null = membership
  let loads = 0
  let release = () => {}
  let readStarted = () => {}
  const loaderGate = new Promise<void>((resolve) => { release = resolve })
  const loaderRead = new Promise<void>((resolve) => { readStarted = resolve })
  const restore = setCacheDependenciesForTest({
    redis,
    orgMembershipLoader: async () => {
      loads += 1
      const read = row
      readStarted()
      await loaderGate
      return read
    },
  })
  try {
    // A request reads the membership, then the member is removed before it writes the cache.
    const racing = cache.org.membership({ organizationId, userId })
    await loaderRead
    row = null
    await cache.org.revokeMembership({ organizationId, userId })
    release()
    assert.deepEqual(await racing, membership)

    // The stale row was not cached: the next check reads the database and sees the removal.
    assert.equal(redis.values.has(`cache:org:member:${organizationId}:${userId}`), false)
    assert.equal(await cache.org.membership({ organizationId, userId }), null)
    assert.equal(loads, 2)

    // The tombstone never denies: a member added back is read from the database.
    row = membership
    assert.deepEqual(await cache.org.membership({ organizationId, userId }), membership)
    assert.equal(loads, 3)
  } finally {
    restore()
  }
})
