import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_KEYS,
  FEATURES,
  featureKeySchema,
  featureLockEnvName,
  mapFeatures,
  parseFeatureEnvironment,
  resolveAvailability,
  resolveFeature,
  resolveFeatures,
} from "@openwork/features"

const platformOff = { control: "platform", default: false } as const
const platformOn = { control: "platform", default: true } as const

test("fixed availabilities ignore locks and overrides", () => {
  for (const lock of [undefined, true, false]) {
    for (const override of [null, true, false]) {
      assert.equal(resolveAvailability("unavailable", { lock, override }).enabled, false)
      assert.equal(resolveAvailability("off", { lock, override }).enabled, false)
      assert.equal(resolveAvailability("on", { lock, override }).enabled, true)
      assert.equal(resolveAvailability("on", { lock, override }).adminCanChange, false)
    }
  }
})

test("platform features: lock beats override beats default", () => {
  assert.deepEqual(resolveAvailability(platformOff, { lock: undefined, override: null }), {
    enabled: false, source: "default", adminCanChange: true, override: null, default: false,
  })
  assert.deepEqual(resolveAvailability(platformOff, { lock: undefined, override: true }), {
    enabled: true, source: "override", adminCanChange: true, override: true, default: false,
  })
  assert.deepEqual(resolveAvailability(platformOn, { lock: false, override: true }), {
    enabled: false, source: "lock", adminCanChange: false, override: true, default: true,
  })
  assert.equal(resolveAvailability(platformOn, { lock: undefined, override: false }).enabled, false)
})

test("resolveFeature reads the registry for the given deployment", () => {
  for (const key of FEATURE_KEYS) {
    const resolved = resolveFeature(key, { deployment: "self_hosted", locks: {}, overrides: {} })
    const availability = FEATURES[key].selfHosted
    assert.equal(resolved.key, key)
    if (typeof availability === "object") assert.equal(resolved.enabled, availability.default)
  }
  const map = resolveFeatures({ deployment: "cloud", locks: { workbot: true }, overrides: { installLinks: false } })
  assert.equal(map.workbot, true)
  assert.equal(map.installLinks, false)
})

test("mapFeatures and the key schema cover exactly the registry", () => {
  assert.deepEqual(Object.keys(mapFeatures(() => 0)).sort(), [...FEATURE_KEYS].sort())
  for (const key of FEATURE_KEYS) assert.equal(featureKeySchema.parse(key), key)
  assert.equal(featureKeySchema.safeParse("notAFeature").success, false)
  assert.equal(featureKeySchema.safeParse("appMcpServers").success, false)
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
