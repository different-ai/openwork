import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_KEYS,
  FEATURES,
  featureKeySchema,
  featureLockEnvName,
  inRollout,
  mapFeatures,
  parseFeatureEnvironment,
  resolveFeature,
  resolveFeatures,
  rolloutBucket,
  type FeatureContext,
} from "@openwork/features"

const base: FeatureContext = {
  deployment: "cloud",
  locks: {},
  rollouts: {},
  overrides: {},
  subjects: { organizationId: "org_a", personId: "usr_a" },
}

test("starting percentages come from the registry", () => {
  for (const key of FEATURE_KEYS) {
    const resolved = resolveFeature(key, base)
    assert.equal(resolved.percent, FEATURES[key].start)
    assert.equal(resolved.source, "rollout")
    if (FEATURES[key].start === 100) assert.equal(resolved.enabled, true)
    if (FEATURES[key].start === 0) assert.equal(resolved.enabled, false)
  }
})

test("precedence: unavailable, kill switch, lock, override, percentage", () => {
  const key = "orgManagedDashboards"
  assert.equal(resolveFeature(key, { ...base, rollouts: { [key]: { percent: 100, killed: false } } }).enabled, true)
  assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true } }).source, "override")
  assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, locks: { [key]: false } }).enabled, false)
  const killed = resolveFeature(key, { ...base, overrides: { [key]: true }, locks: { [key]: true }, rollouts: { [key]: { percent: 100, killed: true } } })
  assert.equal(killed.enabled, false)
  assert.equal(killed.source, "killed")
  assert.equal(killed.overrideApplies, false)
})

test("percentages are stable, monotonic, and need a subject", () => {
  const key = "workbot"
  assert.equal(inRollout(key, "org_x", 0), false)
  assert.equal(inRollout(key, "org_x", 100), true)
  assert.equal(inRollout(key, null, 100), true)
  assert.equal(inRollout(key, null, 50), false)
  const subjects = Array.from({ length: 2000 }, (_, index) => `org_${index}`)
  for (const subject of subjects) assert.equal(rolloutBucket(key, subject), rolloutBucket(key, subject))
  const at10 = subjects.filter((subject) => inRollout(key, subject, 10))
  const at50 = subjects.filter((subject) => inRollout(key, subject, 50))
  for (const subject of at10) assert.ok(at50.includes(subject), "raising the percentage only adds subjects")
  assert.ok(at10.length > 120 && at10.length < 280, `about 10% of subjects, got ${at10.length}`)
})

test("organization features bucket by organization, ignoring the person", () => {
  const key = "workbot"
  const context = { ...base, rollouts: { [key]: { percent: 50, killed: false } } }
  const forOrg = resolveFeature(key, context).enabled
  for (const personId of ["usr_1", "usr_2", "usr_3", null]) {
    assert.equal(resolveFeature(key, { ...context, subjects: { organizationId: "org_a", personId } }).enabled, forOrg)
  }
  assert.equal(resolveFeature(key, { ...context, subjects: {} }).enabled, false)
})

test("mapFeatures and the key schema cover exactly the registry", () => {
  assert.deepEqual(Object.keys(mapFeatures(() => 0)).sort(), [...FEATURE_KEYS].sort())
  for (const key of FEATURE_KEYS) assert.equal(featureKeySchema.parse(key), key)
  assert.equal(featureKeySchema.safeParse("notAFeature").success, false)
  assert.equal(featureKeySchema.safeParse("appMcpServers").success, false)
  assert.deepEqual(Object.keys(resolveFeatures(base)).sort(), [...FEATURE_KEYS].sort())
})

test("every key maps to a unique DEN_FEATURE_ name", () => {
  const names = FEATURE_KEYS.map(featureLockEnvName)
  for (const name of names) assert.match(name, /^DEN_FEATURE_[A-Z0-9]+(?:_[A-Z0-9]+)*$/)
  assert.equal(new Set(names).size, names.length)
  assert.equal(featureLockEnvName("orgManagedDashboards"), "DEN_FEATURE_ORG_MANAGED_DASHBOARDS")
})

test("environment: self_hosted by default, strict values, unknown keys warn", () => {
  const empty = parseFeatureEnvironment({})
  assert.equal(empty.deployment, "self_hosted")
  assert.deepEqual(empty.locks, {})
  assert.deepEqual(empty.problems, [])

  const parsed = parseFeatureEnvironment({
    DEN_DEPLOYMENT: "cloud",
    DEN_FEATURE_WORKBOT: "true",
    DEN_FEATURE_INSTALL_LINKS: "false",
    DEN_FEATURE_ORG_MANAGED_DASHBOARDS: "",
    DEN_FEATURE_NOT_A_THING: "true",
  })
  assert.equal(parsed.deployment, "cloud")
  assert.deepEqual(parsed.locks, { workbot: true, installLinks: false })
  assert.deepEqual(parsed.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_FEATURE_NOT_A_THING", false]])

  const fatal = parseFeatureEnvironment({ DEN_DEPLOYMENT: "prod", DEN_FEATURE_WORKBOT: "yes" })
  assert.deepEqual(fatal.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_DEPLOYMENT", true], ["DEN_FEATURE_WORKBOT", true]])
})
