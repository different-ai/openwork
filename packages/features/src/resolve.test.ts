import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_KEYS,
  FEATURES,
  featureKeySchema,
  featureLockEnvName,
  mapFeatures,
  parseFeatureEnvironment,
  resolveFeature,
  resolveFeatures,
  type FeatureContext,
} from "@openwork/features"

const base: FeatureContext = { deployment: "cloud", locks: {}, rollouts: {}, overrides: {} }

test("without stored state, every feature follows its registry default", () => {
  for (const key of FEATURE_KEYS) {
    const resolved = resolveFeature(key, base)
    assert.equal(resolved.enabled, FEATURES[key].default)
    assert.equal(resolved.source, "everyone")
    assert.equal(resolved.overrideApplies, true)
  }
})

test("precedence: unavailable, kill switch, lock, override, everyone", () => {
  const key = "orgManagedDashboards"
  assert.equal(resolveFeature(key, { ...base, rollouts: { [key]: { enabled: true, killed: false } } }).enabled, true)
  const overridden = resolveFeature(key, { ...base, overrides: { [key]: true } })
  assert.equal(overridden.enabled, true)
  assert.equal(overridden.source, "override")
  assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, locks: { [key]: false } }).enabled, false)
  const killed = resolveFeature(key, { ...base, overrides: { [key]: true }, locks: { [key]: true }, rollouts: { [key]: { enabled: true, killed: true } } })
  assert.equal(killed.enabled, false)
  assert.equal(killed.source, "killed")
  assert.equal(killed.overrideApplies, false)
})

test("an organization override can turn a feature off while it is on for everyone", () => {
  const key = "installLinks"
  const resolved = resolveFeature(key, { ...base, overrides: { [key]: false } })
  assert.equal(resolved.everyone, true)
  assert.equal(resolved.enabled, false)
})

test("Slack search is opt-in per organization and independent of Slack Assistant", () => {
  assert.equal(resolveFeature("nativeSlack", base).enabled, false)
  assert.equal(resolveFeature("nativeSlack", { ...base, overrides: { slackAssistant: true } }).enabled, false)
  const enabled = resolveFeature("nativeSlack", { ...base, overrides: { nativeSlack: true } })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.source, "override")
  assert.equal(resolveFeature("slackAssistant", { ...base, overrides: { nativeSlack: true } }).enabled, false)
  const everyone = { nativeSlack: { enabled: true, killed: false } }
  assert.equal(resolveFeature("nativeSlack", { ...base, rollouts: everyone }).enabled, true)
  assert.equal(resolveFeature("nativeSlack", { ...base, rollouts: everyone, overrides: { nativeSlack: false } }).enabled, false)
})

test("Slack search cannot bypass deployment exclusion, kill, or operator lock", () => {
  const override = { ...base, overrides: { nativeSlack: true } }
  const unavailable = resolveFeature("nativeSlack", { ...override, deployment: "self_hosted", locks: { nativeSlack: true } })
  assert.equal(unavailable.enabled, false)
  assert.equal(unavailable.source, "unavailable")
  const locked = resolveFeature("nativeSlack", { ...override, locks: { nativeSlack: false } })
  assert.equal(locked.enabled, false)
  assert.equal(locked.overrideApplies, false)
  const killed = resolveFeature("nativeSlack", { ...override, locks: { nativeSlack: true }, rollouts: { nativeSlack: { enabled: true, killed: true } } })
  assert.equal(killed.enabled, false)
  assert.equal(killed.source, "killed")
})

test("the retired Slack deployment switch cannot grant the registered feature", () => {
  const environment = parseFeatureEnvironment({ DEN_DEPLOYMENT: "cloud", DEN_SLACK_ENABLED: "true" })
  assert.deepEqual(environment.locks, {})
  assert.equal(resolveFeature("nativeSlack", { ...environment, overrides: {}, rollouts: {} }).enabled, false)
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
