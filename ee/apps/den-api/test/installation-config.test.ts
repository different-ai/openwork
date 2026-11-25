import assert from "node:assert/strict"
import { test } from "node:test"
import { installationConfigSchema } from "@openwork/types/den/diagnostics"
import { installationConfig, releaseVersion, runningAppVersion } from "../src/diagnostics/installation-config.js"

const capabilities = [
  { id: "workbot", state: "on", reason: "configured" },
  { id: "aiGateway", state: "needs_infrastructure", reason: "service_not_installed" },
] as const

function config(overrides: Partial<Parameters<typeof installationConfig>[0]> = {}) {
  return installationConfig({ serviceVersion: "0.19.2", helmChartVersion: "0.2.0", helmAppVersion: "0.19.2", capabilities, locks: {}, ...overrides })
}

test("a chart and a server on the same release report no version skew", () => {
  assert.deepEqual(config(), {
    appVersion: "0.19.2",
    helmChartVersion: "0.2.0",
    helmAppVersion: "0.19.2",
    versionSkew: false,
    deploymentCapabilities: [...capabilities],
    lockedFeatures: {},
  })
  assert.equal(config({ helmAppVersion: "v0.19.2" }).versionSkew, false, "a leading v is the same release")
})

test("a server image that differs from the chart's app version is version skew", () => {
  assert.equal(config({ serviceVersion: "0.19.3" }).versionSkew, true)
  assert.equal(config({ serviceVersion: "commit 1a2b3c4" }).versionSkew, true, "a source build under a release chart")
  assert.equal(config({ serviceVersion: "dev" }).versionSkew, true)
})

test("without a chart app version there is nothing to compare, so no skew and no chart fields", () => {
  const plain = config({ helmChartVersion: undefined, helmAppVersion: undefined })
  assert.equal(plain.versionSkew, false)
  assert.equal("helmChartVersion" in plain, false)
  assert.equal("helmAppVersion" in plain, false)
  assert.equal(config({ helmAppVersion: "   " }).versionSkew, false)
})

test("only versions are echoed: anything else set in a version variable is dropped", () => {
  const leaked = "https://user:hunter2@registry.internal.example/openwork?token=abc"
  const report = config({ serviceVersion: leaked, helmChartVersion: "sk-live-0123456789abcdef", helmAppVersion: "admin@example.test" })
  assert.deepEqual(report, { appVersion: "unknown", versionSkew: false, deploymentCapabilities: [...capabilities], lockedFeatures: {} })
  assert.equal(runningAppVersion("release-candidate"), "unknown")
  assert.equal(runningAppVersion("commit 1A2B3C4"), "unknown")
  assert.equal(runningAppVersion(" v1.2.3-rc.1 "), "1.2.3-rc.1")
  assert.equal(releaseVersion("1.2"), undefined)
  assert.equal(releaseVersion("1.2.3+build.5"), "1.2.3+build.5")
  assert.equal(releaseVersion("1.2.3; rm -rf /"), undefined)
})

test("feature locks are listed by key with their boolean, sorted, and nothing else", () => {
  const report = config({ locks: { workbotMobile: false, administratorRecovery: true, mcpThreads: undefined } })
  assert.deepEqual(Object.entries(report.lockedFeatures), [["administratorRecovery", true], ["workbotMobile", false]])
})

test("every report satisfies the published schema, which has no free-text field", () => {
  for (const report of [config(), config({ serviceVersion: "dev", helmAppVersion: undefined }), config({ locks: { administratorRecovery: true } })]) {
    assert.deepEqual(installationConfigSchema.parse(report), report)
  }
  assert.equal(installationConfigSchema.safeParse({ ...config(), databaseUrl: "mysql://root@db/den" }).success, false, "an extra key is rejected")
  assert.equal(installationConfigSchema.safeParse({ ...config(), appVersion: "https://den.example.test" }).success, false, "an address is not a version")
  assert.equal(installationConfigSchema.safeParse({ ...config(), lockedFeatures: { DEN_GATEWAY_KEY: true } }).success, false, "a variable name is not a feature key")
})
