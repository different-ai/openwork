import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, test } from "node:test"
import { enrollmentAudience, heartbeatAudience, serviceAccountEmail } from "@openwork/managed-deployments/gcp"
import {
  deploymentStepSchema, managedDeploymentConfigurationSchema, managedDeploymentLaunchSchema, managedDeploymentListSchema, managedDeploymentSchema,
} from "@openwork/managed-deployments/schema"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { bootDen, field, list, summary, text } from "./harness.js"

const feature = "managedGoogleCloudDeployments"
const path = "/v1/managed-deployments"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud",
  DEN_MANAGED_DEPLOYMENT_GCP_VERSION: "",
  DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify({
    version: "1.0.0", bundleSha256: "a".repeat(64),
    templateUrl: "https://fixture.s3.us-east-1.amazonaws.com/template.json?versionId=fixture",
    bundleUrl: "https://fixture.s3.us-east-1.amazonaws.com/bundle.tar.gz?versionId=fixture",
  }),
} })
after(() => den.close())
const pilot = await den.createOrg(await den.signUp("Pilot Owner"), "Pilot workspace")
const other = await den.createOrg(await den.signUp("Other Owner"), "Other workspace")
const owner = den.as(pilot.owner, pilot.orgId)
const otherOwner = den.as(other.owner, other.orgId)
for (const { orgId } of [pilot, other]) assert.equal((await den.setFeature(orgId, "managedDeployments", true)).status, 200)
const common = { name: "Fixture deployment", domainName: "openwork.example.test", ownerEmail: "owner@example.test" }
const gcp = { ...common, provider: "gcp", target: { projectId: "fixture-project", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "fixture-zone" } }
const aws = { ...common, provider: "aws", target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" } }
const gcpRelease = JSON.stringify({
  version: "1.0.0", bundleSha256: "b".repeat(64),
  templateUrl: "https://storage.googleapis.com/fixture/template.json?generation=1",
  bundleUrl: "https://storage.googleapis.com/fixture/bundle.tar.gz?generation=2",
})
const configuration = async (request: typeof owner) => {
  const response = await request("GET", `${path}/configuration`)
  assert.equal(response.status, 200, summary(response))
  return managedDeploymentConfigurationSchema.parse(response.body).providers
}

function assertRefused(call: Awaited<ReturnType<typeof owner>>, status: number, error: string) {
  assert.equal(call.status, status, summary(call))
  assert.deepEqual(call.body, { error })
}

async function launch(request: typeof owner, input: typeof gcp | typeof aws) {
  const created = await request("POST", path, input)
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "deployment id")
  const response = await request("POST", `${path}/${id}/launch`, { kind: "install" })
  assert.equal(response.status, 200, summary(response))
  return { id, runId: text(field(response.body, "deployment", "run", "id"), "run id"), handoff: field(response.body, "handoff", "action") }
}

test("readiness and creation require organization approval and a configured Google Cloud installer; AWS stays available", async () => {
  process.env.DEN_MANAGED_DEPLOYMENT_GCP_RELEASE = gcpRelease
  assert.deepEqual((await configuration(owner)).find((entry) => entry.provider === "gcp"), {
    provider: "gcp", available: false, version: null, reason: "feature_disabled",
  })
  assertRefused(await owner("POST", path, gcp), 404, "feature_disabled")
  const enabled = await den.setFeature(pilot.orgId, feature, true)
  assert.equal(enabled.status, 200, summary(enabled))
  delete process.env.DEN_MANAGED_DEPLOYMENT_GCP_RELEASE
  assert.equal((await configuration(owner)).find((entry) => entry.provider === "gcp")?.reason, "not_configured")
  assertRefused(await owner("POST", path, gcp), 503, "release_not_configured")

  process.env.DEN_MANAGED_DEPLOYMENT_GCP_RELEASE = gcpRelease
  assert.equal((await configuration(owner)).find((entry) => entry.provider === "gcp")?.reason, "ready")
  assert.equal((await configuration(otherOwner)).find((entry) => entry.provider === "gcp")?.reason, "feature_disabled")
  const memberOverride = await den.asPlatformAdmin("PUT", `/v1/admin/organizations/${other.orgId}/members/${other.owner.memberId}/capabilities`, { capabilities: { [feature]: true } })
  assert.equal(memberOverride.status, 200, summary(memberOverride))
  assert.equal((await configuration(otherOwner)).find((entry) => entry.provider === "gcp")?.reason, "feature_disabled")
  assertRefused(await otherOwner("POST", path, gcp), 404, "feature_disabled")
  assert.deepEqual(field((await otherOwner("GET", path)).body, "deployments"), [])
  assert.equal((await configuration(otherOwner)).find((entry) => entry.provider === "aws")?.reason, "ready")
  assert.equal((await launch(otherOwner, aws)).handoff, "open_link")
})

test("a Google Cloud deployment in Hong Kong is recorded, listed and handed to the installer with its region", async () => {
  process.env.DEN_MANAGED_DEPLOYMENT_GCP_RELEASE = gcpRelease
  const enabled = await den.setFeature(pilot.orgId, feature, true)
  assert.equal(enabled.status, 200, summary(enabled))
  const target = { ...gcp.target, region: "asia-east2" }
  const created = await owner("POST", path, { ...gcp, domainName: "hong-kong.example.test", target })
  assert.equal(created.status, 200, summary(created))
  assert.deepEqual(managedDeploymentSchema.parse(created.body).target, target)
  const id = text(field(created.body, "id"), "deployment id")

  const listed = await owner("GET", path)
  assert.equal(listed.status, 200, summary(listed))
  assert.deepEqual(managedDeploymentListSchema.parse(listed.body).deployments.find((entry) => entry.id === id)?.target, target)

  const launched = await owner("POST", `${path}/${id}/launch`, { kind: "install" })
  assert.equal(launched.status, 200, summary(launched))
  const { handoff } = managedDeploymentLaunchSchema.parse(launched.body)
  assert.equal(handoff.action, "run_in_cloud_shell")
  const encoded = handoff.command?.match(/--config-base64 '([A-Za-z0-9+/=]+)'/)?.[1]
  assert.ok(encoded)
  assert.deepEqual(field(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), "target"), target)

  const refused = await owner("POST", path, { ...gcp, target: { ...gcp.target, region: "ap-east-1" } })
  assert.equal(refused.status, 400, summary(refused))
  assert.equal(field(refused.body, "error"), "invalid_request")
})

test("turning off Google Cloud blocks pending handoffs and enrollment, but enrolled progress and signed health still work", async (t) => {
  process.env.DEN_MANAGED_DEPLOYMENT_GCP_RELEASE = gcpRelease
  const enabled = await den.setFeature(pilot.orgId, feature, true)
  assert.equal(enabled.status, 200, summary(enabled))
  const { db } = await import("../../src/db.js")
  const { ManagedDeploymentRunTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const key = { ...await exportJWK(publicKey), kid: "fixture-key" }
  const fetch = globalThis.fetch
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => String(input) === "https://www.googleapis.com/oauth2/v3/certs"
    ? Promise.resolve(Response.json({ keys: [key] }))
    : fetch(input, init))
  const signedIdentity = (id: string, purpose: "runner" | "health", audience: string) => new SignJWT({ email: serviceAccountEmail(id, gcp.target.projectId, purpose), email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer("https://accounts.google.com").setSubject("fixture").setAudience(audience)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey)
  const enroll = async ({ id, runId }: { id: string; runId: string }) => {
    const [run] = await db.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId))
    assert.ok(run)
    return den.request(null, "POST", `${path}/${id}/runs/${runId}/enroll`, { body: {
      provider: "gcp", idToken: await signedIdentity(id, "runner", enrollmentAudience(run.api_origin, id, runId, run.challenge)),
    } })
  }

  const started = await launch(owner, gcp)
  assert.equal(started.handoff, "run_in_cloud_shell")
  const pending = await launch(owner, { ...gcp, domainName: "pending.example.test" })
  const enrolled = await enroll(started)
  assert.equal(enrolled.status, 200, summary(enrolled))
  const token = text(field(enrolled.body, "token"), "run token")
  const kill = await den.asPlatformAdmin("PUT", `/v1/admin/features/${feature}`, { killed: true })
  assert.equal(kill.status, 200, summary(kill))

  assert.equal((await configuration(owner)).find((entry) => entry.provider === "gcp")?.reason, "feature_disabled")
  assertRefused(await owner("POST", path, gcp), 404, "feature_disabled")
  assertRefused(await owner("POST", `${path}/${pending.id}/launch`, { kind: "install" }), 404, "feature_disabled")
  assertRefused(await enroll(pending), 404, "feature_disabled")
  for (const [index, step] of deploymentStepSchema.options.entries()) {
    const event = await den.request(token, "POST", `${path}/${started.id}/runs/${started.runId}/events`, { body: { sequence: index + 1, step, outcome: "succeeded" } })
    assert.equal(event.status, 200, summary(event))
  }
  const rawBody = JSON.stringify({ nonce: "a".repeat(32), version: "1.0.0", checks: [{ id: "api_health", status: "ok" }] })
  const digest = createHash("sha256").update(rawBody).digest("hex")
  const heartbeat = await den.request(null, "POST", `${path}/${started.id}/heartbeat`, { rawBody, headers: {
    "content-type": "application/json", authorization: `Bearer ${await signedIdentity(started.id, "health", heartbeatAudience(process.env.DEN_API_PUBLIC_URL ?? "", started.id, digest))}`,
  } })
  assert.equal(heartbeat.status, 200, summary(heartbeat))
  const deployments = await owner("GET", path)
  assert.equal(deployments.status, 200, summary(deployments))
  const rows = list(field(deployments.body, "deployments"))
  assert.equal(field(rows.find((row) => row.id === started.id), "health", "state"), "operational")
  assert.equal(field(rows.find((row) => row.id === started.id), "run", "state"), "ready")
  assert.equal(field(rows.find((row) => row.id === pending.id), "run", "state"), "awaiting_approval")
})
