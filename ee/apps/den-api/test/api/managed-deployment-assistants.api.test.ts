import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { hashToken } from "@openwork/managed-deployments/lifecycle"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud",
  DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.0.2",
  DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/template.json",
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/bundle.tar.gz",
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
} })
after(() => den.close())
const org = await den.createOrg(await den.signUp("Deployment Owner"), "Managed deployment workspace")
const member = await den.newMember(org.owner, org.orgId, "Deployment Member")
const foreign = await den.createOrg(await den.signUp("Other Owner"), "Other deployment workspace")
const owner = den.as(org.owner, org.orgId)
assert.equal((await den.setFeature(org.orgId, "managedDeployments", true)).status, 200)
const { db } = await import("../../src/db.js")
const assistants = {
  headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true,
  modelProtocol: "openai-responses", modelBaseUrl: "https://model.example.test/v1", model: "customer-model",
  modelSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ab12Cd",
  computerProvider: "daytona", computerSnapshot: "computer-snapshot", computerSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ef34Gh",
}
const input = { provider: "aws", name: "Managed deployment", domainName: "openwork.example.test", ownerEmail: "admin@example.test", target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" } }
async function create(enabled = false) {
  const call = await owner("POST", "/v1/managed-deployments", enabled ? { ...input, target: { ...input.target, assistants } } : input)
  assert.equal(call.status, 200, summary(call))
  return text(field(call.body, "id"), "deployment ID")
}
async function installed(id: string) {
  // Arrange an existing customer install; the assertion path uses only the HTTP API.
  await db.update(ManagedDeploymentTable).set({ installed_version: "1.0.1" }).where(eq(ManagedDeploymentTable.id, id))
}

test("assistant setup is off by default while ordinary managed deployment remains available", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", false)).status, 200)
  const readiness = await owner("GET", "/v1/managed-deployments/configuration")
  assert.equal(field(readiness.body, "assistantsAvailable"), false)
  const denied = await owner("POST", "/v1/managed-deployments", { ...input, target: { ...input.target, assistants } })
  assert.equal(denied.status, 404, summary(denied))
  assert.equal(field(denied.body, "error"), "feature_disabled")
  const id = await create()
  const ordinary = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "install" })
  assert.equal(ordinary.status, 200, summary(ordinary))
  assert.ok(!text(field(ordinary.body, "approvalUrl"), "ordinary approval URL").includes("HeadlessRunnerEnabled"), "older installer templates must not receive new parameters")
})

test("an owner configures an existing deployment with a newer Update and pending settings stay frozen", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", true)).status, 200)
  const id = await create()
  await installed(id)
  const path = `/v1/managed-deployments/${id}/launch`
  const launch = await owner("POST", path, { kind: "update", assistants })
  assert.equal(launch.status, 200, summary(launch))
  assert.equal(field(launch.body, "deployment", "target", "assistants", "headlessRunnerEnabled"), true)
  const command = text(field(launch.body, "command"), "Update command")
  assert.ok(command.includes("HeadlessModelSecretArn"))
  assert.ok(command.includes("HeadlessComputerSnapshot"))
  assert.equal(field(launch.body, "deployment", "target", "assistants", "computerProvider"), "daytona")
  const again = await owner("POST", path, { kind: "update", assistants })
  assert.equal(again.status, 200, summary(again))
  assert.equal(field(again.body, "deployment", "run", "id"), field(launch.body, "deployment", "run", "id"))
  assert.equal(field(again.body, "command"), field(launch.body, "command"))
  const changed = await owner("POST", path, { kind: "update", assistants: { ...assistants, model: "different-model" } })
  assert.equal(changed.status, 409, summary(changed))
  assert.equal(field(changed.body, "error"), "deployment_settings_frozen")
  const reopened = await owner("POST", path, { kind: "update" })
  assert.equal(field(reopened.body, "command"), field(launch.body, "command"))
})

test("concurrent Update requests create one immutable assistant configuration", async () => {
  const id = await create()
  await installed(id)
  const path = `/v1/managed-deployments/${id}/launch`
  const attempts = await Promise.all([
    owner("POST", path, { kind: "update", assistants }),
    owner("POST", path, { kind: "update", assistants: { ...assistants, model: "another-model" } }),
  ])
  assert.deepEqual(attempts.map((call) => call.status).sort(), [200, 409])
  const approved = attempts.find((call) => call.status === 200)
  assert.ok(approved)
  const reopened = await owner("POST", path, { kind: "update" })
  assert.equal(reopened.status, 200, summary(reopened))
  assert.equal(field(reopened.body, "command"), field(approved.body, "command"))
  assert.equal(field(reopened.body, "deployment", "run", "id"), field(approved.body, "deployment", "run", "id"))
  assert.deepEqual(den.production?.concurrentStatements ?? [], [])
})

test("same-version, Retry, foreign secrets and members cannot change assistant settings", async () => {
  const id = await create()
  await installed(id)
  const path = `/v1/managed-deployments/${id}/launch`
  const retry = await owner("POST", path, { kind: "retry", assistants })
  assert.equal(retry.status, 400, summary(retry))
  const secret = await owner("POST", path, { kind: "update", assistants: { ...assistants, modelSecretArn: assistants.modelSecretArn.replace("123456789012", "210987654321") } })
  assert.equal(secret.status, 400, summary(secret))
  const denied = await den.as(member, org.orgId)("POST", path, { kind: "update", assistants })
  assert.equal(denied.status, 403, summary(denied))
  assert.equal((await den.setFeature(foreign.orgId, "managedDeployments", true)).status, 200)
  const isolated = await den.as(foreign.owner, foreign.orgId)("POST", path, { kind: "update", assistants })
  assert.equal(isolated.status, 404, summary(isolated))
  await db.update(ManagedDeploymentTable).set({ installed_version: "1.0.2" }).where(eq(ManagedDeploymentTable.id, id))
  const current = await owner("POST", path, { kind: "update", assistants })
  assert.equal(current.status, 409, summary(current))
  assert.equal(field(current.body, "error"), "already_current")
})

test("Google Cloud targets cannot accept AWS assistant options", async () => {
  const id = randomUUID()
  const target = { projectId: "openwork-test", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-test" }
  const invalid = await owner("POST", "/v1/managed-deployments", { ...input, provider: "gcp", target: { ...target, assistants } })
  assert.equal(invalid.status, 400, summary(invalid))
  await db.insert(ManagedDeploymentTable).values({ id, org_id: org.orgId, provider: "gcp", name: "Google Cloud fixture", target, domain_name: input.domainName, owner_email: input.ownerEmail, size: "small", installed_version: "1.0.1" })
  const launch = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "update", assistants })
  assert.equal(launch.status, 400, summary(launch))
  assert.equal(field(launch.body, "error"), "assistants_aws_only")
})

test("killing assistants blocks new and reopened launches but preserves authenticated installer reports", async () => {
  const id = await create(true)
  const path = `/v1/managed-deployments/${id}/launch`
  const prepared = await owner("POST", path, { kind: "install" })
  assert.equal(prepared.status, 200, summary(prepared))
  const runId = text(field(prepared.body, "deployment", "run", "id"), "run ID")
  const token = randomBytes(32).toString("base64url")
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/managedDeploymentAssistants", { killed: true })).status, 200)
  const reopened = await owner("POST", path, { kind: "install" })
  assert.equal(reopened.status, 404, summary(reopened))
  await db.update(ManagedDeploymentRunTable).set({ state: "provisioning", token_hash: hashToken(token) }).where(eq(ManagedDeploymentRunTable.id, runId))
  const blocked = await owner("POST", path, { kind: "install" })
  assert.equal(blocked.status, 404, summary(blocked))
  assert.equal(field(blocked.body, "error"), "feature_disabled")
  const health = await den.request(null, "POST", `/v1/managed-deployments/${id}/heartbeat`, { body: { checks: [{ id: "runner_service", status: "ok" }] } })
  assert.equal(health.status, 401, summary(health))
  assert.equal(field(health.body, "error"), "unauthorized", "the health route keeps verifying cloud identity, not the feature flag")
  const progress = await den.request(token, "POST", `/v1/managed-deployments/${id}/runs/${runId}/events`, { body: { sequence: 1, step: "runner_connected", outcome: "succeeded" } })
  assert.equal(progress.status, 200, summary(progress))
  const visible = await owner("GET", "/v1/managed-deployments")
  assert.equal(visible.status, 200, summary(visible))
  assert.ok(visible.text.includes("runner_connected"))
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/managedDeploymentAssistants", { killed: false })).status, 200)
})

test("MCP clients see assistant availability and cannot bypass the same feature gate", async () => {
  const token = await den.mintMcpToken(org.owner, org.orgId)
  const configurationName = "getManagedDeploymentsConfiguration"
  const createName = "postManagedDeployments"
  const enabled = await den.callMcpTool(token, "execute_capability", { name: configurationName })
  assert.equal(enabled.isError, false, enabled.raw)
  assert.equal(field(enabled.body, "assistantsAvailable"), true)
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", false)).status, 200)
  const disabled = await den.callMcpTool(token, "execute_capability", { name: configurationName })
  assert.equal(disabled.isError, false, disabled.raw)
  assert.equal(field(disabled.body, "assistantsAvailable"), false)
  const denied = await den.callMcpTool(token, "execute_capability", { name: createName, body: { ...input, target: { ...input.target, assistants } } })
  assert.equal(denied.isError, true, denied.raw)
  assert.equal(field(denied.body, "error"), "feature_disabled")
})
