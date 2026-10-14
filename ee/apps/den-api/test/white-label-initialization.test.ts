import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { FeatureRolloutTable, OrganizationFeatureTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { resolveFeature } from "@openwork/features"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/white_label_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-white-label-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-white-label-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DEPLOYMENT = "cloud"
const { db } = await import("../src/db.js")
const { cache } = await import("../src/cache.js")
const { initializeWhiteLabelFeature, initializationAffectedRows } = await import("../src/white-label-initialization.js")
afterEach(() => mock.restoreAll())

const cutoff = new Date("2026-10-13T12:00:00Z")
const old = new Date(cutoff.getTime() - 1000)
type Rollout = { cutoff: Date; enabled: boolean; killed: boolean; updated_by_user_id: string | null }
function setup(preconfigured: Rollout | null = null) {
  const organizations = [
    { id: "old_name", createdAt: old, logo: null, metadata: { brandAppName: "Old desktop" } },
    { id: "old_logo", createdAt: old, logo: "https://example.com/logo", metadata: {} },
    { id: "old_accent", createdAt: old, logo: null, metadata: JSON.stringify({ brandAccentColor: "#334455" }) },
    { id: "old_asset", createdAt: old, logo: null, metadata: { brandIconAsset: { version: "asset-version", key: "icon" } } },
    { id: "explicit_off", createdAt: old, logo: null, metadata: { brandAppName: "Preserved" } },
    { id: "ordinary_old", createdAt: old, logo: null, metadata: {} },
    { id: "new_fake", createdAt: new Date(cutoff.getTime() + 1), logo: "https://example.com/fake", metadata: { brandAppName: "Fake" } },
    { id: "at_cutoff", createdAt: cutoff, logo: null, metadata: { brandAppName: "Fake" } },
  ]
  const assets = [new Uint8Array([0, 1, 127, 255])]
  const original = structuredClone({ organizations, assets })
  const state = { rollout: preconfigured, invalidations: 0, scans: 0, fail: false }
  const overrides = new Map<string, { enabled: boolean; source: string }>([["explicit_off", { enabled: false, source: "platform" }]])
  const locks: string[] = []
  // A unique INSERT IGNORE serializes contending transactions in MySQL. Model
  // that ordering here to verify the losing initializer does no other work.
  let transactionTail = Promise.resolve()
  mock.method(cache.features, "invalidate", async () => { assert.ok(state.rollout); state.invalidations++ })
  mock.method(db, "transaction", (callback: (database: typeof db) => Promise<unknown>) => {
    const result = transactionTail.then(async () => {
      const before = structuredClone({ rollout: state.rollout, overrides })
      try { return await callback(db) } catch (error) {
        state.rollout = before.rollout
        overrides.clear()
        for (const [key, value] of before.overrides) overrides.set(key, value)
        throw error
      }
    })
    transactionTail = result.then(() => undefined, () => undefined)
    return result
  })
  mock.method(db, "select", () => {
    let table: unknown
    const chain = {
      from(value: unknown) { table = value; return chain }, where() { return chain },
      async for(lock: string) {
        locks.push(lock)
        if (table === FeatureRolloutTable) return state.rollout ? [state.rollout] : []
        assert.equal(table, OrganizationTable)
        state.scans++
        if (state.fail) throw new Error("synthetic initializer failure")
        return organizations
      },
    }
    return chain
  })
  mock.method(db, "insert", (table: unknown) => ({ ignore() { return { async values(value: Record<string, unknown>) {
    if (table === FeatureRolloutTable) {
      if (state.rollout) return [{ affectedRows: 0 }, []]
      state.rollout = { cutoff, enabled: false, killed: false, updated_by_user_id: null }
      return [{ affectedRows: 1 }, []]
    }
    assert.equal(table, OrganizationFeatureTable)
    assert.equal(value.feature_key, "whiteLabel")
    assert.equal(value.enabled, true)
    assert.equal(value.source, "migration")
    const id = String(value.organization_id)
    if (overrides.has(id)) return { rowsAffected: 0 }
    overrides.set(id, { enabled: true, source: "migration" })
    return { rowsAffected: 1 }
  } } } }))
  // Existing metadata, asset bytes and policies must never be rewritten.
  mock.method(db, "update", () => { throw new Error("initialization must not rewrite existing rows") })
  return { organizations, assets, original, state, overrides, locks }
}

test("concurrent startup snapshots old usage exactly once, preserving explicit off, metadata and bytes", async () => {
  const h = setup()
  await Promise.all([initializeWhiteLabelFeature(), initializeWhiteLabelFeature()])
  assert.deepEqual([...h.overrides.keys()].sort(), ["explicit_off", "old_accent", "old_asset", "old_logo", "old_name"])
  assert.deepEqual(h.overrides.get("explicit_off"), { enabled: false, source: "platform" })
  assert.equal(h.state.scans, 1)
  assert.equal(h.state.invalidations, 1)
  assert.deepEqual(h.locks, ["update", "update"])
  assert.deepEqual({ organizations: h.organizations, assets: h.assets }, h.original)
  const first = structuredClone(h.overrides)
  await initializeWhiteLabelFeature()
  assert.deepEqual(h.overrides, first)
  assert.equal(h.state.scans, 1)
})

test("clearing a grandfathered override stays Cloud default off after restart; later fake metadata cannot grant access", async () => {
  const h = setup()
  await initializeWhiteLabelFeature()
  h.overrides.delete("old_name") // /admin: Use default (null), not an explicit false.
  h.organizations.push({ id: "later_fake", createdAt: new Date(cutoff.getTime() + 1000), logo: null, metadata: { brandAppName: "Fake" } })
  const ordinary = h.organizations.find((organization) => organization.id === "ordinary_old")
  assert.ok(ordinary)
  ordinary.metadata = { brandAppName: "Written after cutover" }
  await initializeWhiteLabelFeature()
  assert.equal(h.overrides.has("old_name"), false)
  assert.equal(h.overrides.has("later_fake"), false)
  assert.equal(h.overrides.has("ordinary_old"), false)
  assert.equal(h.overrides.has("new_fake"), false)
  assert.equal(resolveFeature("whiteLabel", { deployment: "cloud", locks: {}, overrides: {}, rollouts: { whiteLabel: { enabled: false, killed: false } } }).enabled, false)
  assert.equal(h.state.scans, 1)
})

test("an existing operator/admin rollout is authoritative: no grandfathering or policy changes", async () => {
  const policy = { cutoff, enabled: true, killed: true, updated_by_user_id: "platform-admin" }
  const h = setup(policy)
  await initializeWhiteLabelFeature()
  assert.deepEqual(h.state.rollout, policy)
  assert.deepEqual([...h.overrides], [["explicit_off", { enabled: false, source: "platform" }]])
  assert.equal(h.state.scans, 0)
  assert.equal(h.state.invalidations, 0)
})

test("a failed first initialization rolls back the cutoff and never invalidates caches", async () => {
  const h = setup()
  h.state.fail = true
  await assert.rejects(initializeWhiteLabelFeature(), /synthetic initializer failure/)
  assert.equal(h.state.rollout, null)
  assert.equal(h.state.invalidations, 0)
  assert.equal(h.overrides.size, 1)
  h.state.fail = false
  await initializeWhiteLabelFeature()
  assert.equal(h.overrides.get("old_name")?.enabled, true)
  assert.equal(h.state.invalidations, 1)
})

test("INSERT IGNORE affected-row parsing accepts only unambiguous supported envelopes", () => {
  for (const count of [0, 1]) {
    assert.equal(initializationAffectedRows([{ affectedRows: count }, []]), count)
    assert.equal(initializationAffectedRows({ rowsAffected: count }), count)
  }
  for (const invalid of [null, undefined, {}, [], { affectedRows: "1" }, { rowsAffected: 2 }, { affectedRows: -1 }, { affectedRows: NaN }]) assert.throws(() => initializationAffectedRows(invalid), /unknown_insert_result/)
})
