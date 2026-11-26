import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { ManagedInstallerConfigTable } from "@openwork-ee/den-db/schema"
import { managedDeploymentConfigurationSchema, managedDeploymentLaunchSchema } from "@openwork/managed-deployments/schema"
import { bootDen, field, summary, text } from "./harness.js"

const path = "/v1/managed-deployments"
const awsArtifact = (file: string, version: string) => `https://fixture.s3.us-east-1.amazonaws.com/${file}?versionId=${version}`
const coordinates = (version: string) => ({
  version, templateUrl: awsArtifact("cloudformation.json", version),
  bundleUrl: awsArtifact("bundle.tar.gz", version), bundleSha256: "a".repeat(64),
})
const legacy = coordinates("1.0.0")
const current = coordinates("2.0.0")
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud",
  DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify(current),
  DEN_MANAGED_DEPLOYMENT_AWS_VERSION: legacy.version,
  DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: legacy.templateUrl,
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: legacy.bundleUrl,
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: legacy.bundleSha256,
} })
after(() => den.close())
const { db } = await import("../../src/db.js")
const org = await den.createOrg(await den.signUp("Installer owner"), "Installer workspace")
const owner = den.as(org.owner, org.orgId)
assert.equal((await den.setFeature(org.orgId, "managedDeployments", true)).status, 200)

const input = {
  name: "Fixture deployment", provider: "aws", domainName: "openwork.example.test", ownerEmail: "owner@example.test",
  target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" },
}

async function awsReadiness() {
  const result = await owner("GET", `${path}/configuration`)
  assert.equal(result.status, 200, summary(result))
  return managedDeploymentConfigurationSchema.parse(result.body).providers.find((provider) => provider.provider === "aws")
}

test("organization release readiness and launch use the environment even when a platform pin remains stored", async (context) => {
  const oldPin = coordinates("9.0.0")
  await db.insert(ManagedInstallerConfigTable).values({
    provider: "aws", release: oldPin, revision: randomUUID(), updated_at: new Date(),
  })
  context.after(() => { process.env.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE = JSON.stringify(current) })

  assert.equal((await awsReadiness())?.version, current.version)
  const created = await owner("POST", path, input)
  assert.equal(created.status, 200, summary(created))
  assert.equal(field(created.body, "availableVersion"), current.version)
  const id = text(field(created.body, "id"), "deployment id")
  const launch = async () => {
    const result = await owner("POST", `${path}/${id}/launch`, { kind: "install" })
    assert.equal(result.status, 200, summary(result))
    return managedDeploymentLaunchSchema.parse(result.body)
  }
  const initial = await launch()
  assert.equal(initial.deployment.run?.version, current.version)
  assert.equal(initial.deployment.run?.state, "awaiting_approval")
  assert.ok(initial.approvalUrl)
  const approvalParams = new URLSearchParams(new URL(initial.approvalUrl).hash.split("?")[1])
  assert.equal(approvalParams.get("templateURL"), current.templateUrl)

  const newer = coordinates("3.0.0")
  process.env.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE = JSON.stringify(newer)
  const reopened = await launch()
  assert.equal(reopened.deployment.availableVersion, newer.version)
  assert.equal(reopened.deployment.run?.id, initial.deployment.run?.id)
  assert.equal(reopened.approvalUrl, initial.approvalUrl)

  process.env.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE = "{"
  assert.deepEqual(await awsReadiness(), {
    provider: "aws", available: false, version: null, reason: "invalid_configuration",
    missingFields: ["DEN_MANAGED_DEPLOYMENT_AWS_RELEASE"],
  })
  const refused = await owner("POST", path, input)
  assert.equal(refused.status, 503, summary(refused))
  assert.deepEqual(refused.body, { error: "release_not_configured" })

  delete process.env.DEN_MANAGED_DEPLOYMENT_AWS_RELEASE
  assert.equal((await awsReadiness())?.version, legacy.version)
  const stored = await db.$primary.select().from(ManagedInstallerConfigTable)
  assert.deepEqual(stored.find((row) => row.provider === "aws")?.release, oldPin)
})

test("platform installer release endpoints are absent even for a platform admin", async () => {
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/managed-releases")).status, 404)
  const contract = await den.request(null, "GET", "/openapi.json")
  assert.equal(contract.status, 200, summary(contract))
  const routes = field(contract.body, "paths")
  assert.ok(routes && typeof routes === "object")
  assert.ok(Object.hasOwn(routes, path))
  assert.equal(Object.keys(routes).some((route) => route.startsWith("/v1/admin/managed-releases")), false)
})
