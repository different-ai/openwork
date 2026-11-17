import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { hashToken } from "@openwork/managed-deployments/lifecycle"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.0.2",
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
const input = { provider: "aws", name: "Managed deployment", domainName: "openwork.example.test", ownerEmail: "admin@example.test", target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" } }
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd"
const computers = { computerProvider: "daytona", computerSnapshot: "computer-snapshot", computerSecretArn }
async function create(body: unknown = input) {
  const call = await owner("POST", "/v1/managed-deployments", body)
  assert.equal(call.status, 200, summary(call))
  return { id: text(field(call.body, "id"), "deployment ID"), call }
}
async function legacyInstalled() {
  const created = await create({ ...input, target: { ...input.target, runtimeProfile: "legacy" } })
  // Arrange an existing customer install; assertions use only the public HTTP API.
  await db.update(ManagedDeploymentTable).set({ installed_version: "1.0.1", target: input.target }).where(eq(ManagedDeploymentTable.id, created.id))
  return created.id
}

test("feature off keeps historical create and installer handoff unchanged", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", false)).status, 200)
  const { id, call } = await create()
  assert.equal(field(call.body, "target", "runtimeProfile"), "legacy")
  const ordinary = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "install" })
  assert.equal(ordinary.status, 200, summary(ordinary))
  const url = text(field(ordinary.body, "approvalUrl"), "ordinary approval URL")
  assert.ok(!url.includes("HeadlessRunnerEnabled"))
  assert.ok(!url.includes("ManagedRuntimeProfile"))
  const denied = await owner("POST", "/v1/managed-deployments", { ...input, target: { ...input.target, runtimeProfile: "gateway" } })
  assert.equal(denied.status, 404, summary(denied))
})

test("only new omitted-profile AWS creates default to gateway with every runtime service included and no model key", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", true)).status, 200)
  const { id, call } = await create()
  assert.equal(field(call.body, "target", "runtimeProfile"), "gateway")
  for (const key of ["headlessRunnerEnabled", "workbotEnabled", "slackAssistantEnabled"]) assert.equal(field(call.body, "target", "assistants", key), true)
  assert.equal(field(call.body, "target", "assistants", "computerProvider"), "off")
  assert.equal(field(call.body, "target", "assistants", "modelSecretArn"), undefined)
  assert.equal(field(call.body, "health", "state"), "awaiting_report", "unconfigured providers must not be represented as ready")
  const prepared = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "install" })
  assert.equal(prepared.status, 200, summary(prepared))
  assert.ok(text(field(prepared.body, "approvalUrl"), "gateway approval URL").includes("param_ManagedRuntimeProfile=gateway"))
  const normalized = await create({ ...input, target: { ...input.target, runtimeProfile: "gateway", assistants: {
    headlessRunnerEnabled: false, workbotEnabled: false, slackAssistantEnabled: false,
    modelProtocol: "anthropic", modelBaseUrl: "https://legacy-model.example.test/v1", model: "unused-model",
    modelSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh",
  } } })
  for (const key of ["headlessRunnerEnabled", "workbotEnabled", "slackAssistantEnabled"]) assert.equal(field(normalized.call.body, "target", "assistants", key), true)
  for (const key of ["modelProtocol", "modelBaseUrl", "model", "modelSecretArn"]) assert.equal(field(normalized.call.body, "target", "assistants", key), undefined)
  const explicit = await create({ ...input, target: { ...input.target, runtimeProfile: "legacy" } })
  assert.equal(field(explicit.call.body, "target", "runtimeProfile"), "legacy")
})

test("an existing legacy record upgrades only through an explicit newer Update and pending profile/settings stay frozen", async () => {
  const id = await legacyInstalled()
  const path = `/v1/managed-deployments/${id}/launch`
  const unchanged = await owner("POST", path, { kind: "update" })
  assert.equal(unchanged.status, 200, summary(unchanged))
  assert.equal(field(unchanged.body, "deployment", "target", "runtimeProfile"), "legacy")
  assert.ok(!text(field(unchanged.body, "command"), "legacy Update command").includes("ManagedRuntimeProfile"))
  const pendingUpgrade = await owner("POST", path, { kind: "update", runtimeProfile: "gateway" })
  assert.equal(pendingUpgrade.status, 409, summary(pendingUpgrade))
  assert.equal(field(pendingUpgrade.body, "error"), "deployment_settings_frozen")
  const runId = text(field(unchanged.body, "deployment", "run", "id"), "legacy run")
  await db.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, runId))
  const launch = await owner("POST", path, { kind: "update", runtimeProfile: "gateway", assistants: computers })
  assert.equal(launch.status, 200, summary(launch))
  assert.equal(field(launch.body, "deployment", "target", "runtimeProfile"), "gateway")
  const command = text(field(launch.body, "command"), "gateway Update command")
  assert.ok(command.includes(JSON.stringify({ ParameterKey: "ManagedRuntimeProfile", ParameterValue: "gateway" })))
  const again = await owner("POST", path, { kind: "update", runtimeProfile: "gateway", assistants: computers })
  assert.equal(again.status, 200, summary(again))
  assert.equal(field(again.body, "deployment", "run", "id"), field(launch.body, "deployment", "run", "id"))
  assert.equal(field(again.body, "command"), command)
  for (const change of [{ runtimeProfile: "legacy" }, { assistants: { ...computers, computerSnapshot: "different-snapshot" } }]) {
    const changed = await owner("POST", path, { kind: "update", ...change })
    assert.equal(changed.status, 409, summary(changed))
    assert.equal(field(changed.body, "error"), "deployment_settings_frozen")
  }
  assert.equal(field((await owner("POST", path, { kind: "update" })).body, "command"), command)
})

test("unchanged historical assistant settings can Retry, reopen and Update without adopting a profile", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", true)).status, 200)
  const id = await legacyInstalled()
  const path = `/v1/managed-deployments/${id}/launch`
  const legacyAssistants = { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true, computerProvider: "off", modelProtocol: "anthropic", modelBaseUrl: "https://legacy-model.example.test/v1", model: "legacy-model", modelSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh" }
  await db.update(ManagedDeploymentTable).set({ target: { ...input.target, assistants: legacyAssistants } }).where(eq(ManagedDeploymentTable.id, id))
  const readable = await owner("GET", "/v1/managed-deployments")
  assert.equal(readable.status, 200, summary(readable))
  assert.ok(readable.text.includes("legacy-model"))
  const changed = await owner("POST", path, { kind: "update", assistants: { ...legacyAssistants, model: "changed-model" } })
  assert.equal(changed.status, 400, summary(changed))
  assert.equal(field(changed.body, "error"), "gateway_profile_required")
  const newDirect = await owner("POST", "/v1/managed-deployments", { ...input, target: { ...input.target, runtimeProfile: "legacy", assistants: legacyAssistants } })
  assert.equal(newDirect.status, 400, summary(newDirect))
  assert.equal(field(newDirect.body, "error"), "gateway_profile_required")
  const retry = await owner("POST", path, { kind: "retry" })
  assert.equal(retry.status, 200, summary(retry))
  const retryCommand = text(field(retry.body, "command"), "legacy Retry command")
  assert.ok(retryCommand.includes("legacy-model"))
  assert.ok(!retryCommand.includes("ManagedRuntimeProfile"))
  assert.equal(field(retry.body, "deployment", "target", "runtimeProfile"), "legacy")
  assert.equal(field(retry.body, "deployment", "target", "assistants", "modelSecretArn"), legacyAssistants.modelSecretArn)
  const reopened = await owner("POST", path, { kind: "retry" })
  assert.equal(reopened.status, 200, summary(reopened))
  assert.equal(field(reopened.body, "command"), retryCommand)
  assert.equal(field(reopened.body, "deployment", "run", "id"), field(retry.body, "deployment", "run", "id"))
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/managedDeploymentAssistants", { killed: true })).status, 200)
  assert.equal((await owner("POST", path, { kind: "retry" })).status, 404)
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/managedDeploymentAssistants", { killed: false })).status, 200)
  const retryId = text(field(retry.body, "deployment", "run", "id"), "legacy Retry run")
  await db.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, retryId))
  const ordinaryUpdate = await owner("POST", path, { kind: "update", runtimeProfile: "legacy", assistants: legacyAssistants })
  assert.equal(ordinaryUpdate.status, 200, summary(ordinaryUpdate))
  const ordinaryCommand = text(field(ordinaryUpdate.body, "command"), "unchanged legacy Update command")
  assert.ok(ordinaryCommand.includes("legacy-model"))
  assert.ok(!ordinaryCommand.includes("ManagedRuntimeProfile"))
  const updateReopened = await owner("POST", path, { kind: "update" })
  assert.equal(updateReopened.status, 200, summary(updateReopened))
  assert.equal(field(updateReopened.body, "command"), ordinaryCommand)
  const updateId = text(field(ordinaryUpdate.body, "deployment", "run", "id"), "legacy Update run")
  await db.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, updateId))
  const upgrade = await owner("POST", path, { kind: "update", runtimeProfile: "gateway" })
  assert.equal(upgrade.status, 200, summary(upgrade))
  assert.equal(field(upgrade.body, "deployment", "target", "assistants", "modelSecretArn"), undefined)
  assert.ok(!text(field(upgrade.body, "command"), "gateway command").includes("legacy-model"))
})

test("concurrent profile/computer Updates create only one immutable configuration", async () => {
  const id = await legacyInstalled()
  const path = `/v1/managed-deployments/${id}/launch`
  const attempts = await Promise.all([
    owner("POST", path, { kind: "update", runtimeProfile: "gateway", assistants: computers }),
    owner("POST", path, { kind: "update", runtimeProfile: "gateway", assistants: { ...computers, computerSnapshot: "another-snapshot" } }),
  ])
  assert.deepEqual(attempts.map((call) => call.status).sort(), [200, 409])
  const approved = attempts.find((call) => call.status === 200)
  assert.ok(approved)
  const reopened = await owner("POST", path, { kind: "update" })
  assert.equal(field(reopened.body, "command"), field(approved.body, "command"))
  assert.deepEqual(den.production?.concurrentStatements ?? [], [])
})

test("same-version, Retry, foreign secrets, other workspaces and unauthorized members cannot change a runtime", async () => {
  const id = await legacyInstalled()
  const path = `/v1/managed-deployments/${id}/launch`
  const change = { kind: "update", runtimeProfile: "gateway", assistants: computers }
  assert.equal((await owner("POST", path, { ...change, kind: "retry" })).status, 400)
  assert.equal((await owner("POST", path, { ...change, assistants: { ...computers, computerSecretArn: computerSecretArn.replace("123456789012", "210987654321") } })).status, 400)
  assert.equal((await den.as(member, org.orgId)("POST", path, change)).status, 403)
  assert.equal((await den.setFeature(foreign.orgId, "managedDeployments", true)).status, 200)
  assert.equal((await den.as(foreign.owner, foreign.orgId)("POST", path, change)).status, 404)
  await db.update(ManagedDeploymentTable).set({ installed_version: "1.0.2" }).where(eq(ManagedDeploymentTable.id, id))
  const current = await owner("POST", path, change)
  assert.equal(current.status, 409, summary(current))
  assert.equal(field(current.body, "error"), "already_current")
})

test("Google Cloud rejects AWS profiles and computer settings", async () => {
  const id = randomUUID()
  const target = { projectId: "openwork-test", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-test" }
  assert.equal((await owner("POST", "/v1/managed-deployments", { ...input, provider: "gcp", target: { ...target, runtimeProfile: "gateway" } })).status, 400)
  await db.insert(ManagedDeploymentTable).values({ id, org_id: org.orgId, provider: "gcp", name: "Google Cloud fixture", target, domain_name: input.domainName, owner_email: input.ownerEmail, size: "small", installed_version: "1.0.1" })
  for (const change of [{ runtimeProfile: "gateway" }, { assistants: computers }]) {
    const launch = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "update", ...change })
    assert.equal(launch.status, 400, summary(launch))
    assert.equal(field(launch.body, "error"), "assistants_aws_only")
  }
})

test("kill blocks stored gateway-profile launches and reopening but not authenticated reporting or health identity checks", async () => {
  const { id } = await create()
  const path = `/v1/managed-deployments/${id}/launch`
  const prepared = await owner("POST", path, { kind: "install" })
  assert.equal(prepared.status, 200, summary(prepared))
  const runId = text(field(prepared.body, "deployment", "run", "id"), "run ID")
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/managedDeploymentAssistants", { killed: true })).status, 200)
  assert.equal((await owner("POST", path, { kind: "install" })).status, 404)
  const token = randomBytes(32).toString("base64url")
  await db.update(ManagedDeploymentRunTable).set({ state: "provisioning", token_hash: hashToken(token) }).where(eq(ManagedDeploymentRunTable.id, runId))
  const health = await den.request(null, "POST", `/v1/managed-deployments/${id}/heartbeat`, { body: { checks: [{ id: "ai_gateway_available", status: "ok" }] } })
  assert.equal(health.status, 401, summary(health))
  assert.equal(field(health.body, "error"), "unauthorized")
  const progress = await den.request(token, "POST", `/v1/managed-deployments/${id}/runs/${runId}/events`, { body: { sequence: 1, step: "runner_connected", outcome: "succeeded" } })
  assert.equal(progress.status, 200, summary(progress))
  assert.equal((await owner("GET", "/v1/managed-deployments")).status, 200)
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/managedDeploymentAssistants", { killed: false })).status, 200)
})

test("MCP uses the same gateway defaults and feature gate without requesting upstream keys", async () => {
  const token = await den.mintMcpToken(org.owner, org.orgId)
  const enabled = await den.callMcpTool(token, "execute_capability", { name: "getManagedDeploymentsConfiguration" })
  assert.equal(enabled.isError, false, enabled.raw)
  assert.equal(field(enabled.body, "assistantsAvailable"), true)
  const created = await den.callMcpTool(token, "execute_capability", { name: "postManagedDeployments", body: input })
  assert.equal(created.isError, false, created.raw)
  assert.equal(field(created.body, "target", "runtimeProfile"), "gateway")
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", false)).status, 200)
  const denied = await den.callMcpTool(token, "execute_capability", { name: "postManagedDeployments", body: { ...input, target: { ...input.target, runtimeProfile: "gateway" } } })
  assert.equal(denied.isError, true, denied.raw)
  assert.equal(field(denied.body, "error"), "feature_disabled")
})
