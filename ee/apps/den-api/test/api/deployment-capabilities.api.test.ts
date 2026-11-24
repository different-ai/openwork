import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { CUSTOMER_CAPABILITY_IDS } from "@openwork/managed-deployments/capabilities"
import { managedDeploymentCapabilitiesSchema } from "@openwork/managed-deployments/capability-state"
import { parseDeploymentCapabilities } from "@openwork/types/den/deployment-capabilities"
import { bootDen, field, summary, text, type Call } from "./harness.js"

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.0.2",
  DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/template.json",
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/bundle.tar.gz",
  DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
  DEN_HEADLESS_RUNNER_URL: "http://headless-runner:8795",
  DEN_HEADLESS_RUNNER_TOKEN: "capability-test-runner-token-0123456789abcdef",
  DEN_WORKBOT_URL: "https://chat.example.test",
  DEN_SLACK_ASSISTANT_WORKER_ENABLED: "false",
} })
after(() => den.close())
const org = await den.createOrg(await den.signUp("Capability Owner"), "Capability workspace")
const member = await den.newMember(org.owner, org.orgId, "Capability Member")
const foreign = await den.createOrg(await den.signUp("Foreign Owner"), "Foreign workspace")
const owner = den.as(org.owner, org.orgId)
const { db } = await import("../../src/db.js")

function states(call: Call) {
  assert.equal(call.status, 200, summary(call))
  const report = parseDeploymentCapabilities(field(call.body, "deploymentCapabilities"))
  assert.ok(report.capabilities, "the organization context carries capability states")
  assert.deepEqual(report.capabilities.map((entry) => entry.id), [...CUSTOMER_CAPABILITY_IDS])
  return { report, byId: Object.fromEntries(report.capabilities.map((entry) => [entry.id, `${entry.state}:${entry.reason}`])) }
}

test("the organization context reports each capability from Den's own settings and keeps the aiGateway boolean", async () => {
  const { report, byId } = states(await owner("GET", "/v1/org"))
  assert.equal(report.version, 1)
  assert.equal(report.aiGateway, false, "the existing boolean is unchanged")
  assert.deepEqual(byId, {
    workbot: "on:configured",
    slackAssistant: "off:switched_off",
    automations: "on:configured",
    aiGateway: "needs_infrastructure:service_not_installed",
    cloudComputers: "off:rollout_flag_off",
  })
  assert.deepEqual(states(await den.as(member, org.orgId)("GET", "/v1/org")).byId, byId, "members read the same report")
})

test("cloud computers turn on with the organization's remote computers feature, and only for that organization", async () => {
  assert.equal((await den.setFeature(org.orgId, "remoteComputers", true)).status, 200)
  assert.equal(states(await owner("GET", "/v1/org")).byId.cloudComputers, "on:configured_on_runner")
  assert.equal(states(await den.as(foreign.owner, foreign.orgId)("GET", "/v1/org")).byId.cloudComputers, "off:rollout_flag_off")
  assert.equal((await den.setFeature(org.orgId, "remoteComputers", false)).status, 200)
  assert.equal(states(await owner("GET", "/v1/org")).byId.cloudComputers, "off:rollout_flag_off")
})

const aws = { provider: "aws", name: "Capability deployment", domainName: "openwork.example.test", ownerEmail: "admin@example.test", target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" } }
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd"

async function create(target: Record<string, unknown>) {
  const call = await owner("POST", "/v1/managed-deployments", { ...aws, target: { ...aws.target, ...target } })
  assert.equal(call.status, 200, summary(call))
  return text(field(call.body, "id"), "deployment id")
}
async function capabilities(id: string, request = owner) {
  const call = await request("GET", `/v1/managed-deployments/${id}/capabilities`)
  assert.equal(call.status, 200, summary(call))
  const parsed = managedDeploymentCapabilitiesSchema.parse(call.body)
  assert.equal(parsed.deploymentId, id)
  assert.deepEqual(parsed.capabilities.map((entry) => entry.id), [...CUSTOMER_CAPABILITY_IDS])
  return { target: parsed.target, byId: Object.fromEntries(parsed.capabilities.map((entry) => [entry.id, `${entry.state}:${entry.reason}`])) }
}

test("a managed deployment's capabilities need the managed deployments feature and the view permission", async () => {
  const id = randomUUID()
  assert.equal((await owner("GET", `/v1/managed-deployments/${id}/capabilities`)).status, 404, "feature off")
  assert.equal((await den.setFeature(org.orgId, "managedDeployments", true)).status, 200)
  const missing = await owner("GET", `/v1/managed-deployments/${id}/capabilities`)
  assert.equal(missing.status, 404, summary(missing))
  assert.deepEqual(missing.body, { error: "deployment_not_found" })
  assert.equal((await owner("GET", "/v1/managed-deployments/not-an-id/capabilities")).status, 400)
})

test("a managed AWS deployment reports its recorded target: legacy, then the gateway runtime with computers", async () => {
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", true)).status, 200)
  const legacy = await capabilities(await create({ runtimeProfile: "legacy" }))
  assert.equal(legacy.target, "managed-aws")
  assert.deepEqual(legacy.byId, {
    workbot: "needs_infrastructure:dependency_not_installed",
    slackAssistant: "needs_infrastructure:dependency_not_installed",
    automations: "on:configured",
    aiGateway: "needs_infrastructure:service_not_installed",
    cloudComputers: "needs_infrastructure:dependency_not_installed",
  })
  const gateway = await capabilities(await create({}))
  assert.deepEqual(gateway.byId, {
    workbot: "on:configured", slackAssistant: "on:configured", automations: "on:configured", aiGateway: "on:configured",
    cloudComputers: "needs_infrastructure:service_not_installed",
  })
  const withComputers = await create({ assistants: { computerProvider: "daytona", computerSnapshot: "computer-snapshot", computerSecretArn } })
  assert.equal((await capabilities(withComputers)).byId.cloudComputers, "on:needs_rollout_flag")

  const outsider = await den.as(foreign.owner, foreign.orgId)("GET", `/v1/managed-deployments/${withComputers}/capabilities`)
  assert.equal(outsider.status, 404, "another organization cannot read it")
  assert.equal((await den.setFeature(foreign.orgId, "managedDeployments", true)).status, 200)
  const stillOutside = await den.as(foreign.owner, foreign.orgId)("GET", `/v1/managed-deployments/${withComputers}/capabilities`)
  assert.equal(stillOutside.status, 404, summary(stillOutside))
  assert.deepEqual(stillOutside.body, { error: "deployment_not_found" })
  const plainMember = await den.as(member, org.orgId)("GET", `/v1/managed-deployments/${withComputers}/capabilities`)
  assert.equal(plainMember.status, 403, summary(plainMember))
})

test("a managed Google Cloud deployment reports every capability as unsupported", async () => {
  const id = randomUUID()
  await db.insert(ManagedDeploymentTable).values({
    id, org_id: org.orgId, provider: "gcp", name: "Google Cloud deployment", domain_name: "gcp.example.test", owner_email: "admin@example.test", size: "small",
    target: { projectId: "fixture-project", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "fixture-zone" },
  })
  const report = await capabilities(id)
  assert.equal(report.target, "managed-gcp")
  assert.deepEqual(new Set(Object.values(report.byId)), new Set(["unsupported:not_offered"]))
})
