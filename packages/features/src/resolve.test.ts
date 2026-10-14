import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_KEYS,
  FEATURES,
  featureAvailableOn,
  featureDefaultEnabled,
  featureRollout,
  featureKeySchema,
  featureLockEnvName,
  mapFeatures,
  parseFeatureEnvironment,
  resolveFeature,
  resolveFeatures,
  RETIRED_FEATURE_KEYS,
  type FeatureContext,
  type FeatureDeployment,
} from "@openwork/features"

const base: FeatureContext = { deployment: "cloud", locks: {}, rollouts: {}, overrides: {} }
const deployments: FeatureDeployment[] = ["cloud", "self_hosted"]

test("without stored state, every feature follows its deployment default and availability", () => {
  for (const deployment of deployments) {
    for (const key of FEATURE_KEYS) {
      const available = featureAvailableOn(key, deployment)
      const resolved = resolveFeature(key, { ...base, deployment })
      const enabled = featureDefaultEnabled(key, deployment)
      assert.equal(resolved.everyone, enabled)
      assert.equal(resolved.enabled, available && enabled)
      assert.equal(resolved.source, available ? "everyone" : "unavailable")
      assert.equal(resolved.overrideApplies, available)
      if (key !== "whiteLabel") assert.equal(enabled, FEATURES[key].default)
    }
  }
})

test("white-label defaults are on for self-hosted, off for cloud, including without an organization", () => {
  assert.equal(featureDefaultEnabled("whiteLabel", "self_hosted"), true)
  assert.equal(featureDefaultEnabled("whiteLabel", "cloud"), false)
  for (const deployment of deployments) {
    const expected = deployment === "self_hosted"
    const context = { ...base, deployment }
    assert.deepEqual(featureRollout("whiteLabel", {}, deployment), { enabled: expected, killed: false })
    assert.equal(resolveFeatures(context).whiteLabel, expected)
    assert.equal(resolveFeature("whiteLabel", context).source, "everyone")
  }
})

test("stored everyone state supersedes either white-label deployment default", () => {
  for (const deployment of deployments) {
    for (const enabled of [true, false]) {
      const rollout = { enabled, killed: false }
      const rollouts = { whiteLabel: rollout }
      assert.deepEqual(featureRollout("whiteLabel", rollouts, deployment), rollout)
      const resolved = resolveFeature("whiteLabel", { ...base, deployment, rollouts })
      assert.equal(resolved.enabled, enabled)
      assert.equal(resolved.everyone, enabled)
      assert.equal(resolved.source, "everyone")
    }
  }
})

test("white-label deployment defaults do not bypass organization overrides, locks, or kill switches", () => {
  for (const deployment of deployments) {
    const context = { ...base, deployment }
    for (const enabled of [true, false]) {
      const overrides = { whiteLabel: enabled }
      const overridden = resolveFeature("whiteLabel", { ...context, overrides })
      assert.equal(overridden.enabled, enabled)
      assert.equal(overridden.source, "override")
      assert.equal(overridden.overrideApplies, true)

      const locks = { whiteLabel: !enabled }
      const locked = resolveFeature("whiteLabel", { ...context, overrides, locks })
      assert.equal(locked.enabled, !enabled)
      assert.equal(locked.source, "lock")
      assert.equal(locked.overrideApplies, false)

      const rollouts = { whiteLabel: { enabled, killed: true } }
      const killed = resolveFeature("whiteLabel", { ...context, overrides, locks, rollouts })
      assert.equal(killed.enabled, false)
      assert.equal(killed.source, "killed")
      assert.equal(killed.overrideApplies, false)
      assert.deepEqual(featureRollout("whiteLabel", rollouts, deployment), rollouts.whiteLabel)
      assert.equal(resolveFeatures({ ...context, rollouts }).whiteLabel, false)
    }
  }
})

test("precedence: unavailable, kill switch, lock, override, everyone", () => {
  const key = "permissions"
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
  const key = "workbot"
  const resolved = resolveFeature(key, { ...base, rollouts: { [key]: { enabled: true, killed: false } }, overrides: { [key]: false } })
  assert.equal(resolved.everyone, true)
  assert.equal(resolved.enabled, false)
})

test("mapFeatures and the key schema cover exactly the registry", () => {
  assert.deepEqual(Object.keys(mapFeatures(() => 0)).sort(), [...FEATURE_KEYS].sort())
  for (const key of FEATURE_KEYS) assert.equal(featureKeySchema.parse(key), key)
  assert.equal(featureKeySchema.safeParse("notAFeature").success, false)
  assert.equal(featureKeySchema.safeParse("appMcpServers").success, false)
  for (const key of RETIRED_FEATURE_KEYS) assert.equal(featureKeySchema.safeParse(key).success, false, `${key} is retired`)
  assert.deepEqual(Object.keys(resolveFeatures(base)).sort(), [...FEATURE_KEYS].sort())
})

test("every key maps to a unique DEN_FEATURE_ name", () => {
  const names = FEATURE_KEYS.map(featureLockEnvName)
  for (const name of names) assert.match(name, /^DEN_FEATURE_[A-Z0-9]+(?:_[A-Z0-9]+)*$/)
  assert.equal(new Set(names).size, names.length)
  assert.equal(featureLockEnvName("slackWorkbotReplies"), "DEN_FEATURE_SLACK_WORKBOT_REPLIES")
})

test("environment: self_hosted by default, strict values, unknown keys warn", () => {
  const empty = parseFeatureEnvironment({})
  assert.equal(empty.deployment, "self_hosted")
  assert.deepEqual(empty.locks, {})
  assert.deepEqual(empty.problems, [])

  const parsed = parseFeatureEnvironment({
    DEN_DEPLOYMENT: "cloud",
    DEN_FEATURE_WORKBOT: "true",
    DEN_FEATURE_PERMISSIONS: "false",
    DEN_FEATURE_ORG_MANAGED_DASHBOARDS: "",
    DEN_FEATURE_NOT_A_THING: "true",
  })
  assert.equal(parsed.deployment, "cloud")
  assert.deepEqual(parsed.locks, { workbot: true, permissions: false })
  assert.deepEqual(parsed.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_FEATURE_NOT_A_THING", false]])

  const fatal = parseFeatureEnvironment({ DEN_DEPLOYMENT: "prod", DEN_FEATURE_WORKBOT: "yes" })
  assert.deepEqual(fatal.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_DEPLOYMENT", true], ["DEN_FEATURE_WORKBOT", true]])
})
