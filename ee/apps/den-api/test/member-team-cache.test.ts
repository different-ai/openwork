import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/team_cache_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-team-cache-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-team-cache-unit-test-key"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_REDIS_URL = ""
const { db } = await import("../src/db.js")
const { cache, setCacheDependenciesForTest } = await import("../src/cache.js")
const { listTeamsForMember } = await import("../src/member-teams.js")

function setup() {
  const values = new Map<string, string>()
  let failRedis = false
  let failDatabase = false
  const redis = {
    async get(key: string) {
      if (failRedis) throw new Error("Redis unavailable")
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      if (failRedis) throw new Error("Redis unavailable")
      values.set(key, value)
    },
    async del(...keys: string[]) { keys.forEach((key) => values.delete(key)) },
  }
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  const input = { organizationId, memberId }
  const team = { id: createDenTypeId("team"), name: "Team", organizationId, createdAt: new Date(), updatedAt: new Date() }
  let teams = [team]
  let revision = "initial"
  let active = true
  let joins = 0
  let checks = 0
  mock.method(db, "select", (fields: Record<string, unknown>) => {
    const isTeamRead = "name" in fields
    const rows = () => {
      if (failDatabase) throw new Error("DB unavailable")
      if (isTeamRead) { joins++; return active ? teams : [] }
      assert.deepEqual(Object.keys(fields), ["revision"])
      checks++
      return active ? [{ revision }] : []
    }
    const chain = {
      from: () => chain, innerJoin: () => chain, where: () => chain, limit: () => chain, orderBy: () => chain,
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(rows).then(resolve, reject),
    }
    return chain
  })
  const restore = setCacheDependenciesForTest({ redis })
  mock.method(cache.features, "state", async () => ({ rollouts: {}, overrides: { teamMembershipCache: true } }))
  return {
    input, team, values, restore, joins: () => joins, checks: () => checks,
    revoke: () => { teams = []; revision = "revoked" },
    restoreTeam: () => { teams = [team]; revision = "regranted" },
    removeMember: () => { active = false },
    failRedis: (value: boolean) => { failRedis = value },
    failDatabase: () => { failDatabase = true },
  }
}

afterEach(() => mock.restoreAll())

test("repeated reads cache the team join, restore dates and read only the DB revision/liveness", async () => {
  const h = setup()
  try {
    assert.deepEqual(await listTeamsForMember(h.input), [h.team])
    assert.deepEqual(await listTeamsForMember(h.input), [h.team])
    assert.equal(h.joins(), 1)
    assert.equal(h.checks(), 2)
  } finally { h.restore() }
})

test("an already-resolved cache flag avoids another feature lookup without skipping live authority", async () => {
  const h = setup()
  try {
    const featureRead = mock.method(cache.features, "state", async () => { throw new Error("unexpected second feature lookup") })
    assert.deepEqual(await listTeamsForMember({ ...h.input, teamMembershipCache: true }), [h.team])
    assert.deepEqual(await listTeamsForMember({ ...h.input, teamMembershipCache: true }), [h.team])
    assert.equal(featureRead.mock.callCount(), 0)
    assert.equal(h.joins(), 1)
    assert.equal(h.checks(), 2)
    h.revoke()
    assert.deepEqual(await listTeamsForMember({ ...h.input, teamMembershipCache: true }), [])
    assert.equal(h.checks(), 3)
  } finally { h.restore() }
})

test("turning the rollout off bypasses already-populated cache entries", async () => {
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    mock.method(cache.features, "state", async () => ({ rollouts: {}, overrides: { teamMembershipCache: false } }))
    assert.deepEqual(await listTeamsForMember(h.input), [h.team])
    assert.deepEqual(await listTeamsForMember(h.input), [h.team])
    assert.equal(h.joins(), 3)
    assert.equal(h.checks(), 1)
  } finally { h.restore() }
})

test("a committed team revocation drops cached rows immediately, without Redis invalidation", async () => {
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    h.revoke()
    assert.deepEqual(await listTeamsForMember(h.input), [])
    assert.deepEqual(await listTeamsForMember(h.input), [])
    assert.equal(h.joins(), 2)
    h.restoreTeam()
    assert.deepEqual(await listTeamsForMember(h.input), [h.team])
    assert.equal(h.joins(), 3)
  } finally { h.restore() }
})

test("a loader racing revocation can only populate the old revision's key", async () => {
  const h = setup()
  try {
    const old = await cache.org.memberTeams({
      ...h.input,
      revision: async () => "initial",
      enabled: async () => true,
      load: async () => { h.revoke(); return [h.team] },
    })
    assert.deepEqual(old, [h.team])
    assert.deepEqual(await listTeamsForMember(h.input), [])
  } finally { h.restore() }
})

test("Redis snapshot rollback cannot resurrect a revoked team grant", async () => {
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    const snapshot = new Map(h.values)
    h.revoke()
    assert.deepEqual(await listTeamsForMember(h.input), [])
    h.values.clear()
    snapshot.forEach((value, key) => h.values.set(key, value))
    assert.deepEqual(await listTeamsForMember(h.input), [])
    assert.equal(h.joins(), 3)
  } finally { h.restore() }
})

test("Redis failure and recovery never serve old team memberships", async (t) => {
  t.mock.method(console, "error", () => {})
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    h.failRedis(true)
    h.revoke()
    assert.deepEqual(await listTeamsForMember(h.input), [])
    h.failRedis(false)
    assert.deepEqual(await listTeamsForMember(h.input), [])
  } finally { h.restore() }
})

test("out-of-band member removal excludes cached teams without invalidation", async () => {
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    h.removeMember()
    assert.deepEqual(await listTeamsForMember(h.input), [])
    assert.equal(h.joins(), 1)
  } finally { h.restore() }
})

test("DB failure rejects a cache hit rather than using old authority", async () => {
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    h.failDatabase()
    await assert.rejects(listTeamsForMember(h.input), /DB unavailable/)
  } finally { h.restore() }
})

test("a cached key is scoped to organization and member, not only to revision", async () => {
  const h = setup()
  try {
    await listTeamsForMember(h.input)
    const load = mock.fn(async () => [])
    const other = { organizationId: createDenTypeId("organization"), memberId: createDenTypeId("member") }
    assert.deepEqual(await cache.org.memberTeams({ ...other, revision: async () => "initial", enabled: async () => true, load }), [])
    assert.equal(load.mock.callCount(), 1)
  } finally { h.restore() }
})
