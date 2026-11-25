import assert from "node:assert/strict"
import { after, test } from "node:test"
import { enrollmentAudience, serviceAccountEmail } from "@openwork/managed-deployments/gcp"
import { deploymentStepSchema } from "@openwork/managed-deployments/schema"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { bootDen, field, summary, text } from "./harness.js"

const path = "/v1/managed-deployments"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud",
  DEN_MANAGED_DEPLOYMENT_GCP_VERSION: "",
  DEN_MANAGED_DEPLOYMENT_GCP_RELEASE: JSON.stringify({
    version: "1.0.0", bundleSha256: "b".repeat(64),
    templateUrl: "https://storage.googleapis.com/fixture/template.json?generation=1",
    bundleUrl: "https://storage.googleapis.com/fixture/bundle.tar.gz?generation=2",
  }),
} })
after(() => den.close())
const pilot = await den.createOrg(await den.signUp("Pilot Owner"), "Pilot workspace")
const owner = den.as(pilot.owner, pilot.orgId)
for (const feature of ["managedDeployments", "managedGoogleCloudDeployments"]) assert.equal((await den.setFeature(pilot.orgId, feature, true)).status, 200)
const target = { projectId: "fixture-project", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "fixture-zone" }

test("an install approved near the end of its handoff still gets a full lifetime once its installer enrolls", async (t) => {
  const { db } = await import("../../src/db.js")
  const { ManagedDeploymentRunTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { RUN_LIFETIME_MS } = await import("../../src/routes/org/managed-deployments.js")
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const key = { ...await exportJWK(publicKey), kid: "fixture-key" }
  const fetch = globalThis.fetch
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => String(input) === "https://www.googleapis.com/oauth2/v3/certs"
    ? Promise.resolve(Response.json({ keys: [key] }))
    : fetch(input, init))

  const created = await owner("POST", path, { name: "Fixture deployment", domainName: "late.example.test", ownerEmail: "owner@example.test", provider: "gcp", target })
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "deployment id")
  const launched = await owner("POST", `${path}/${id}/launch`, { kind: "install" })
  assert.equal(launched.status, 200, summary(launched))
  const runId = text(field(launched.body, "deployment", "run", "id"), "run id")
  const [run] = await db.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId))
  assert.ok(run)
  assert.equal(run.kind, "install")

  // The person approved with two minutes of the handoff left; the installer still has to
  // create a database and wait for a certificate.
  await db.update(ManagedDeploymentRunTable).set({ expires_at: new Date(Date.now() + 120_000) }).where(eq(ManagedDeploymentRunTable.id, runId))
  const idToken = await new SignJWT({ email: serviceAccountEmail(id, target.projectId, "runner"), email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer("https://accounts.google.com").setSubject("fixture")
    .setAudience(enrollmentAudience(run.api_origin, id, runId, run.challenge)).setIssuedAt().setExpirationTime("5m").sign(privateKey)
  const before = Date.now()
  const enrolled = await den.request(null, "POST", `${path}/${id}/runs/${runId}/enroll`, { body: { provider: "gcp", idToken } })
  assert.equal(enrolled.status, 200, summary(enrolled))
  const deadline = Date.parse(text(field(enrolled.body, "expiresAt"), "enrollment deadline"))
  assert.ok(deadline >= before + RUN_LIFETIME_MS - 1000 && deadline <= Date.now() + RUN_LIFETIME_MS, `deadline ${new Date(deadline).toISOString()} is a full lifetime after enrollment`)
  const [stored] = await db.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId))
  assert.equal(stored?.expires_at.toISOString(), new Date(deadline).toISOString(), "the installer is told the deadline that is stored")

  // Half an hour later, past the original handoff deadline, the installer can still report.
  const token = text(field(enrolled.body, "token"), "run token")
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * 60_000 })
  const event = await den.request(token, "POST", `${path}/${id}/runs/${runId}/events`, { body: { sequence: 1, step: deploymentStepSchema.options[0], outcome: "succeeded" } })
  t.mock.timers.reset()
  assert.equal(event.status, 200, summary(event))
})
