import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_CATEGORIES,
  FEATURE_KEYS,
  FEATURES,
  FEATURE_DOCS_BASE_URL,
  featuresByCategory,
  featureDocsUrl,
  featureKeySchema,
  featureLockEnvName,
  mapFeatures,
  parseFeatureEnvironment,
  resolveFeature,
  resolveFeatures,
  RETIRED_FEATURE_KEYS,
  type FeatureContext,
  type FeatureDefinition,
} from "@openwork/features"

const base: FeatureContext = { deployment: "cloud", locks: {}, rollouts: {}, overrides: {} }
const featureDocs = (feature: FeatureDefinition) => feature.docs

test("without stored state, every feature follows its registry default", () => {
  for (const key of FEATURE_KEYS) {
    const resolved = resolveFeature(key, base)
    assert.equal(resolved.enabled, FEATURES[key].default)
    assert.equal(resolved.source, "everyone")
    assert.equal(resolved.overrideApplies, true)
  }
})

test("features by category keeps category order and lists every feature once", () => {
  const groups = featuresByCategory()
  assert.deepEqual(groups.map((group) => group.category), Object.keys(FEATURE_CATEGORIES).filter((category) => groups.some((group) => group.category === category)))
  assert.deepEqual(groups.flatMap((group) => group.keys).sort(), [...FEATURE_KEYS].sort())
  assert.ok(groups.every((group) => group.keys.length > 0))
})

test("feature docs resolve to internal docs in the repo or no link", () => {
  for (const key of FEATURE_KEYS) {
    const docs = featureDocs(FEATURES[key])
    if (docs === undefined) {
      assert.equal(featureDocsUrl(key), null)
    } else {
      assert.ok(docs.startsWith("docs/") && !docs.startsWith("docs/../"), key)
      assert.equal(featureDocsUrl(key), `${FEATURE_DOCS_BASE_URL}${docs}`)
    }
  }
})

test("precedence: unavailable, kill switch, lock, override, everyone", () => {
  const key = "connectStandardTools"
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
  const key = "connectStandardTools"
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

test("managed deployments stays cloud-only even when every control enables it", () => {
  const selfHosted = resolveFeature("managedDeployments", {
    ...base,
    deployment: "self_hosted",
    locks: { managedDeployments: true },
    overrides: { managedDeployments: true },
    rollouts: { managedDeployments: { enabled: true, killed: false } },
  })
  assert.equal(selfHosted.enabled, false)
  assert.equal(selfHosted.source, "unavailable")
})

test("Your agent, browser and computer use honor explicit overrides and kill switches", () => {
  const parents = ["workbotProactive", "browserUse", "computerUse"] satisfies Array<keyof typeof FEATURES>
  for (const key of parents) {
    for (const deployment of ["cloud", "self_hosted"] satisfies Array<FeatureContext["deployment"]>) {
      const context = { ...base, deployment }
      assert.equal(resolveFeature(key, { ...context, overrides: { [key]: true } }).enabled, true)
      assert.equal(resolveFeature(key, {
        ...context,
        overrides: { [key]: true },
        rollouts: { [key]: { enabled: true, killed: true } },
      }).enabled, false)
      assert.equal(resolveFeature(key, {
        ...context,
        overrides: { [key]: true },
        memberOverrides: { [key]: false },
      }).enabled, false)
    }
  }
})

test("every key maps to a unique DEN_FEATURE_ name", () => {
  const names = FEATURE_KEYS.map(featureLockEnvName)
  for (const name of names) assert.match(name, /^DEN_FEATURE_[A-Z0-9]+(?:_[A-Z0-9]+)*$/)
  assert.equal(new Set(names).size, names.length)
  assert.equal(featureLockEnvName("connectStandardTools"), "DEN_FEATURE_CONNECT_STANDARD_TOOLS")
})

test("environment: self_hosted by default, strict values, unknown keys warn", () => {
  const empty = parseFeatureEnvironment({})
  assert.equal(empty.deployment, "self_hosted")
  assert.deepEqual(empty.locks, {})
  assert.deepEqual(empty.problems, [])

  const parsed = parseFeatureEnvironment({
    DEN_DEPLOYMENT: "cloud",
    DEN_FEATURE_WORKBOT_DOCUMENTS: "true",
    DEN_FEATURE_CONNECT_STANDARD_TOOLS: "false",
    DEN_FEATURE_WORKBOT: "false",
    DEN_FEATURE_PERMISSIONS: "false",
    DEN_FEATURE_ORG_MANAGED_DASHBOARDS: "",
    DEN_FEATURE_NOT_A_THING: "true",
  })
  assert.equal(parsed.deployment, "cloud")
  assert.deepEqual(parsed.locks, { workbotDocuments: true, connectStandardTools: false })
  assert.deepEqual(parsed.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_FEATURE_WORKBOT", false], ["DEN_FEATURE_PERMISSIONS", false], ["DEN_FEATURE_NOT_A_THING", false]])

  const fatal = parseFeatureEnvironment({ DEN_DEPLOYMENT: "prod", DEN_FEATURE_CONNECT_STANDARD_TOOLS: "yes" })
  assert.deepEqual(fatal.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_DEPLOYMENT", true], ["DEN_FEATURE_CONNECT_STANDARD_TOOLS", true]])
})

test("member overrides inherit by default and take priority over organization and everyone", () => {
  const key = "connectStandardTools"
  const context: FeatureContext = { ...base, overrides: { [key]: false }, memberOverrides: { [key]: true } }
  assert.equal(resolveFeature(key, context).enabled, true)
  assert.equal(resolveFeature(key, context).source, "member")
  assert.equal(resolveFeature(key, { ...context, memberOverrides: {} }).enabled, false)
  assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, memberOverrides: { [key]: false } }).enabled, false)
  // Other features and organization-only reads are unaffected.
  assert.equal(resolveFeature(key, { ...base, overrides: context.overrides }).enabled, false)
  assert.equal(resolveFeature("managedDeployments", context).enabled, resolveFeature("managedDeployments", base).enabled)
})

test("member overrides cannot bypass deployment restrictions, operator locks or the kill switch", () => {
  const key = "connectStandardTools"
  const context: FeatureContext = { ...base, memberOverrides: { [key]: true } }
  assert.equal(resolveFeature(key, { ...context, locks: { [key]: false } }).source, "lock")
  assert.equal(resolveFeature(key, { ...context, locks: { [key]: false } }).enabled, false)
  assert.equal(resolveFeature(key, { ...context, rollouts: { [key]: { enabled: true, killed: true } } }).enabled, false)
  assert.equal(resolveFeature("managedDeployments", { ...base, deployment: "self_hosted", memberOverrides: { managedDeployments: true } }).enabled, false)
})
