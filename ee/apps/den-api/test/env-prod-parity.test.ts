import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ENV_PARITY_SNAPSHOTS, ENV_PARITY_SNAPSHOT_NAMES, type EnvParitySnapshotName } from "./fixtures/env-parity/snapshots.js"
import { readParsedEnv } from "./support/parsed-env.js"

/**
 * den-api must read the environment of every existing installation exactly
 * as it did before. Each snapshot is the whole environment one kind of
 * installation starts den-api with; the recorded file beside it is what
 * `src/env.ts` made of it. A difference here is a setting some running
 * installation would read differently after an upgrade.
 *
 * When a change in how the environment is read is intended, record it with
 * `pnpm --filter @openwork-ee/den-api env:parity:write` and review that diff.
 */
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-parity")

function recorded(name: EnvParitySnapshotName): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, `${name}.parsed.json`), "utf8"))
}

function parse(name: EnvParitySnapshotName) {
  const result = readParsedEnv(ENV_PARITY_SNAPSHOTS[name])
  if (!result.booted) assert.fail(`den-api did not start with the ${name} environment:\n${result.stderr}`)
  return result
}

for (const name of ENV_PARITY_SNAPSHOT_NAMES) {
  test(`${name}: den-api starts and reads every setting as recorded`, () => {
    assert.deepEqual(parse(name).env, recorded(name))
  })
}

test("OpenWork Cloud: every address that is set explicitly is used as set", () => {
  const { env, stderr } = parse("openwork-cloud")
  assert.equal(env.betterAuthUrl, "https://app.openworklabs.com")
  assert.equal(env.apiPublicUrl, "https://api.openworklabs.com")
  assert.equal(env.mcpResourceUrl, "https://api.openworklabs.com/mcp")
  assert.equal(env.mcpClaimNamespace, "https://openworklabs.com")
  assert.equal(env.betterAuthCookieDomain, "openworklabs.com")
  assert.equal(env.workerActivityBaseUrl, "https://api.openworklabs.com")
  assert.deepEqual(env.corsOrigins, ["https://app.openworklabs.com", "https://web.openworklabs.com", "https://chat.openworklabs.com"])
  assert.deepEqual(env.features, { deployment: "cloud", locks: {} })
  assert.equal(env.orgMode, "multi_org")
  assert.equal(env.provisionerMode, "daytona")
  assert.match(stderr, /DEN_FEATURE_RETIRED_EXAMPLE is not a known feature and is ignored/)
})

test("OpenWork Cloud: internal tuning set by hand on the service is still honored", () => {
  const { env } = parse("openwork-cloud")
  assert.deepEqual(env.automations, {
    enabled: true,
    runtimeEnabled: true,
    pollIntervalMs: 5_000,
    batchSize: 25,
    maxConcurrency: 4,
    headlessMaxConcurrency: 32,
    leaseMs: 60_000,
    runTimeoutMs: 1_200_000,
    runnerClaimDeadlineMs: 900_000,
  })
  assert.deepEqual(env.adminMetrics, { enabled: true, fastIntervalMs: 120_000, heavyIntervalMs: 1_800_000 })
  assert.equal(env.cloudIdleStopMs, 45 * 60_000)
  assert.equal(env.scimMaintenanceIntervalMs, 600_000)
})

test("a self-hosted install that sets only its address, database, secrets and first administrator gets every address from DEN_BASE_URL", () => {
  const { env } = parse("minimal-self-hosted")
  assert.equal(env.betterAuthUrl, "https://openwork.example.test")
  assert.equal(env.webUrl, "https://openwork.example.test")
  assert.equal(env.apiPublicUrl, "https://api.openwork.example.test")
  assert.equal(env.mcpResourceUrl, "https://api.openwork.example.test/mcp")
  assert.equal(env.mcpClaimNamespace, "https://openwork.example.test")
  assert.equal(env.betterAuthCookieDomain, "openwork.example.test")
  assert.equal(env.workerActivityBaseUrl, "https://openwork.example.test")
  assert.equal(env.marketingUrl, "https://openwork.example.test")
  assert.deepEqual(env.corsOrigins, ["https://openwork.example.test"])
  assert.deepEqual(env.betterAuthTrustedOrigins, ["https://openwork.example.test"])
  assert.deepEqual(env.webAppHosts, ["openwork.example.test"])
  assert.deepEqual(env.features, { deployment: "self_hosted", locks: {} })
  assert.equal(env.orgMode, "single_org")
  assert.deepEqual(env.bootstrapAdminEmails, ["admin@example.test"])
})

test("the Helm chart's explicit addresses win over the ones DEN_BASE_URL would give", () => {
  const { env } = parse("helm-chart-0.2.0")
  assert.equal(env.apiPublicUrl, "https://openwork-api.example.test")
  assert.equal(env.mcpResourceUrl, "https://openwork-api.example.test/mcp")
  assert.equal(env.betterAuthCookieDomain, "example.test")
  assert.equal(env.desktopDenBaseUrl, "https://openwork.example.test")
  assert.deepEqual(env.corsOrigins, ["https://openwork.example.test", "https://intranet.example.test"])
  assert.equal(env.workerProvisioningReconcileStaleMs, 1_200_000)
})
