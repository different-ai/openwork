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

test("mapFeatures and the key schema cover exactly the registry", () => {
  assert.deepEqual(Object.keys(mapFeatures(() => 0)).sort(), [...FEATURE_KEYS].sort())
  for (const key of FEATURE_KEYS) assert.equal(featureKeySchema.parse(key), key)
  assert.equal(featureKeySchema.safeParse("notAFeature").success, false)
  assert.equal(featureKeySchema.safeParse("workflows").success, false)
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

test("deployment: explicit wins; unset means cloud only for multi-organization installs", () => {
  assert.equal(parseFeatureEnvironment({ DEN_ORG_MODE: "multi_org" }).deployment, "cloud")
  assert.equal(parseFeatureEnvironment({ DEN_ORG_MODE: "single_org" }).deployment, "self_hosted")
  assert.equal(parseFeatureEnvironment({ DEN_ORG_MODE: "multi_org", DEN_DEPLOYMENT: "self_hosted" }).deployment, "self_hosted")
})

test("legacy switches lock only when they differ from the registry default", () => {
  // The chart renders the old defaults; they must not freeze /admin.
  assert.deepEqual(parseFeatureEnvironment({ DEN_DASHBOARDS_ENABLED: "false", DEN_APP_MCP_SERVERS_ENABLED: "true" }).locks, {})
  const parsed = parseFeatureEnvironment({ DEN_DASHBOARDS_ENABLED: "true", DEN_APP_MCP_SERVERS_ENABLED: "false", DEN_AUTOMATIONS_ENABLED: "1" })
  assert.deepEqual(parsed.locks, { dashboard: true, appMcpServers: false, automations: true })
  assert.ok(parsed.problems.every((problem) => !problem.fatal && problem.message.includes("deprecated")))
  // The new variable wins over the legacy one.
  assert.deepEqual(parseFeatureEnvironment({ DEN_DASHBOARDS_ENABLED: "true", DEN_FEATURE_DASHBOARD: "false" }).locks, { dashboard: false })
})

test("OpenWork Web is cloud only, even when the legacy switch says otherwise", () => {
  const selfHosted = parseFeatureEnvironment({ DEN_OPENWORK_WEB_ENABLED: "true" })
  assert.deepEqual(selfHosted.locks, {})
  assert.equal(resolveFeature("openworkWeb", { ...selfHosted, rollouts: { openworkWeb: { enabled: true, killed: false } }, overrides: { openworkWeb: true } }).source, "unavailable")
  const cloud = parseFeatureEnvironment({ DEN_ORG_MODE: "multi_org", DEN_OPENWORK_WEB_ENABLED: "true" })
  assert.deepEqual(cloud.locks, { openworkWeb: true })
})
