import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { FeatureRolloutTable, OrganizationFeatureTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/slack_policy_cache_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-slack-policy-cache-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-slack-policy-cache-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DEPLOYMENT = "cloud"
process.env.DEN_ORG_MODE = "multi_org"
process.env.DEN_FEATURE_NATIVE_SLACK = ""
process.env.DEN_FEATURE_TEAM_MEMBERSHIP_CACHE = ""
const { db } = await import("../src/db.js")
const { env } = await import("../src/env.js")
const { setCacheDependenciesForTest } = await import("../src/cache.js")
const {
  deploymentFeatureEnabled, getDeploymentFeatureState, organizationFeatureEnabled,
  updateFeatureRollout, updateOrganizationFeatureOverrides,
} = await import("../src/features.js")
const { slackCloudPolicyError, slackHomePolicyError } = await import("../src/capability-sources/slack-policy.js")

const organizationId = createDenTypeId("organization")
const initialFeatures = env.features
const initialOrgMode = env.orgMode
afterEach(() => {
  mock.restoreAll()
  env.features = initialFeatures
  env.orgMode = initialOrgMode
})

// Only the DB/Redis boundaries are mocked: policy, feature resolution, cache
// invalidation and den-db persistence all execute their production code.
function setup() {
  env.features = { deployment: "cloud", locks: {} }
  env.orgMode = "multi_org"
  const state: { enabled: boolean | null; killed: boolean; override: boolean | null; failDb: boolean } = {
    enabled: true, killed: false, override: true, failDb: false,
  }
  const rolloutKey = "cache:features:rollouts:old"
  const overrideKey = `cache:features:overrides:old:${organizationId}`
  const values = new Map([
    ["cache:features:generation:deployment", "old"],
    [rolloutKey, JSON.stringify({ nativeSlack: { enabled: true, killed: false }, teamMembershipCache: { enabled: true, killed: false } })],
    [overrideKey, JSON.stringify({ nativeSlack: true })],
  ])
  const snapshot = new Map(values)
  let failedBumps = 0
  const redis = {
    async get(key: string) { return values.get(key) ?? null },
    async set() { failedBumps++; throw new Error("OOM command not allowed when used memory > maxmemory") },
    async del(...keys: string[]) { keys.forEach((key) => values.delete(key)) },
  }
  const restore = setCacheDependenciesForTest({ redis })
  mock.method(console, "error", () => {})
  mock.method(db, "select", (fields: Record<string, unknown>) => {
    const rows = () => {
      if (state.failDb) throw new Error("authoritative Slack feature state unavailable")
      if ("metadata" in fields) return [{ metadata: {} }]
      if ("feature_key" in fields && "killed" in fields) return [
        ...(state.enabled === null ? [] : [{ feature_key: "nativeSlack", enabled: state.enabled, killed: state.killed }]),
        { feature_key: "teamMembershipCache", enabled: false, killed: false },
      ]
      if ("feature_key" in fields) return state.override === null ? [] : [{ feature_key: "nativeSlack", enabled: state.override }]
      throw new Error("unexpected Slack feature selection")
    }
    const chain = {
      from: () => chain, where: () => chain, limit: () => chain, for: () => chain,
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(rows).then(resolve, reject),
    }
    return chain
  })
  mock.method(db, "insert", (table: typeof FeatureRolloutTable | typeof OrganizationFeatureTable) => ({
    values(value: Record<string, unknown>) {
      assert.equal(value.feature_key, "nativeSlack")
      return { async onDuplicateKeyUpdate() {
        assert.equal(typeof value.enabled, "boolean")
        if (typeof value.enabled !== "boolean") throw new Error("invalid fixture write")
        if (table === FeatureRolloutTable) {
          assert.equal(typeof value.killed, "boolean")
          if (typeof value.killed !== "boolean") throw new Error("invalid fixture kill switch")
          state.enabled = value.enabled
          state.killed = value.killed
        } else {
          assert.equal(table, OrganizationFeatureTable)
          assert.equal(value.organization_id, organizationId)
          state.override = value.enabled
        }
      } }
    },
  }))
  mock.method(db, "delete", (table: typeof OrganizationFeatureTable) => {
    assert.equal(table, OrganizationFeatureTable)
    return { async where() { state.override = null } }
  })
  mock.method(db, "update", (table: typeof OrganizationTable) => {
    assert.equal(table, OrganizationTable)
    return { set: () => ({ async where() {} }) }
  })
  mock.method(db, "transaction", async (callback: (database: typeof db) => Promise<unknown>) => callback(db))
  return { state, values, snapshot, restore, failedBumps: () => failedBumps }
}

test("Slack organization authorization rejects an explicit off despite stale grants and failed Redis invalidation", async () => {
  const h = setup()
  try {
    assert.equal(await slackCloudPolicyError(organizationId), null)
    await updateOrganizationFeatureOverrides({ organizationId, changes: { nativeSlack: false }, source: "platform" })
    assert.equal(h.failedBumps(), 1)
    assert.deepEqual(h.values, h.snapshot, "Redis still serves the old positive rollout and override after failed SET")
    assert.equal(await organizationFeatureEnabled(organizationId, "nativeSlack"), true, "ordinary feature reads remain cached")
    assert.equal((await slackCloudPolicyError(organizationId))?.kind, "policy_blocked")
  } finally { h.restore() }
})

test("clearing the Slack organization override uses the live deployment default after failed invalidations", async () => {
  const h = setup()
  try {
    assert.equal(await slackCloudPolicyError(organizationId), null)
    await updateFeatureRollout({ key: "nativeSlack", enabled: false, defaultEnabled: false })
    assert.equal(await slackCloudPolicyError(organizationId), null, "the organization remains explicitly opted in")
    await updateOrganizationFeatureOverrides({ organizationId, changes: { nativeSlack: null }, source: "platform" })
    assert.equal(h.failedBumps(), 2)
    assert.deepEqual(h.values, h.snapshot)
    assert.equal((await slackCloudPolicyError(organizationId))?.kind, "policy_blocked")
  } finally { h.restore() }
})

for (const lockedOn of [false, true]) {
  test(`a live Slack kill switch blocks organization access and App Home despite stale grants${lockedOn ? " and an operator on lock" : ""}`, async () => {
    const h = setup()
    try {
      if (lockedOn) env.features.locks.nativeSlack = true
      assert.equal(await slackCloudPolicyError(organizationId), null)
      assert.equal(await slackHomePolicyError(), null)
      await updateFeatureRollout({ key: "nativeSlack", killed: true, defaultEnabled: false })
      assert.equal(h.failedBumps(), 1)
      assert.deepEqual(h.values, h.snapshot)
      assert.equal((await slackCloudPolicyError(organizationId))?.kind, "policy_blocked")
      assert.equal((await slackHomePolicyError())?.kind, "policy_blocked")
    } finally { h.restore() }
  })
}

test("Slack organization access and App Home reject database failures instead of falling back to cached grants", async () => {
  const h = setup()
  try {
    assert.equal(await slackCloudPolicyError(organizationId), null)
    assert.equal(await slackHomePolicyError(), null)
    h.state.failDb = true
    assert.equal(await organizationFeatureEnabled(organizationId, "nativeSlack"), true, "Redis can still serve the stale grant")
    await assert.rejects(slackCloudPolicyError(organizationId), /authoritative Slack feature state unavailable/)
    await assert.rejects(slackHomePolicyError(), /authoritative Slack feature state unavailable/)
  } finally { h.restore() }
})

for (const enabled of [null, false]) {
  test(`Slack App Home remains available with ${enabled === null ? "the registry" : "a stored"} default off when organization overrides can apply`, async () => {
    const h = setup()
    try {
      h.state.enabled = enabled
      const deployment = await getDeploymentFeatureState("nativeSlack")
      assert.equal(deployment.enabled, false)
      assert.equal(deployment.overrideApplies, true)
      assert.equal(await slackHomePolicyError(), null)
      assert.equal(await slackCloudPolicyError(organizationId), null, "the opted-in organization remains authorized")
      await updateOrganizationFeatureOverrides({ organizationId, changes: { nativeSlack: false }, source: "platform" })
      assert.equal((await slackCloudPolicyError(organizationId))?.kind, "policy_blocked")
      assert.equal(await slackHomePolicyError(), null, "generic App Home is not an organization read grant")
    } finally { h.restore() }
  })
}

for (const constraint of ["operator off lock", "excluded deployment", "single organization mode"]) {
  test(`Slack organization access and App Home reject ${constraint} despite positive feature state`, async () => {
    const h = setup()
    try {
      assert.equal(await slackCloudPolicyError(organizationId), null)
      assert.equal(await slackHomePolicyError(), null)
      if (constraint === "operator off lock") env.features.locks.nativeSlack = false
      if (constraint === "excluded deployment") env.features.deployment = "self_hosted"
      if (constraint === "single organization mode") env.orgMode = "single_org"
      assert.equal((await slackCloudPolicyError(organizationId))?.kind, "policy_blocked")
      assert.equal((await slackHomePolicyError())?.kind, "policy_blocked")
    } finally { h.restore() }
  })
}

test("ordinary feature flags still use Redis independently of Slack's live authorization reads", async () => {
  const h = setup()
  try {
    assert.equal(await organizationFeatureEnabled(organizationId, "teamMembershipCache", { database: db }), false)
    assert.equal(await organizationFeatureEnabled(organizationId, "teamMembershipCache"), true)
    assert.equal(await deploymentFeatureEnabled("teamMembershipCache"), true)
    h.state.failDb = true
    assert.equal(await organizationFeatureEnabled(organizationId, "teamMembershipCache"), true)
    assert.equal(await deploymentFeatureEnabled("teamMembershipCache"), true)
    await assert.rejects(slackCloudPolicyError(organizationId), /authoritative Slack feature state unavailable/)
  } finally { h.restore() }
})
