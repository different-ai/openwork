import assert from "node:assert/strict"
import { test } from "node:test"
import { CUSTOMER_CAPABILITY_IDS } from "@openwork/managed-deployments/capabilities"
import {
  CAPABILITY_STATE_LABELS, CAPABILITY_STATE_REASON_LABELS, capabilityStateReasonSchema, capabilityStateSchema, deploymentCapabilityStatusListSchema,
  installedDeploymentCapabilityStates, managedDeploymentCapabilityStates, type DeploymentCapabilityStatus, type InstalledDeploymentSignals,
} from "@openwork/managed-deployments/capability-state"
import { awsTargetSchema } from "@openwork/managed-deployments/schema"

const identity = { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" }
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd"
const modelSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh"
const ownRunner = { headlessRunnerEnabled: true, modelProtocol: "anthropic", modelBaseUrl: "https://model.example.com/v1", model: "customer-model", modelSecretArn }

function summary(capabilities: DeploymentCapabilityStatus[]) {
  assert.deepEqual(capabilities.map((entry) => entry.id), [...CUSTOMER_CAPABILITY_IDS], "every customer capability, in catalog order, and never the runner")
  assert.equal(deploymentCapabilityStatusListSchema.safeParse(capabilities).success, true)
  return Object.fromEntries(capabilities.map((entry) => [entry.id, `${entry.state}:${entry.reason}`]))
}
function aws(target: Record<string, unknown>) {
  const result = managedDeploymentCapabilityStates({ provider: "aws", target: awsTargetSchema.parse({ ...identity, ...target }) })
  assert.equal(result.target, "managed-aws")
  return summary(result.capabilities)
}

test("a managed AWS deployment on the gateway runtime has everything but computers until a provider is chosen", () => {
  assert.deepEqual(aws({ runtimeProfile: "gateway" }), {
    workbot: "on:configured", slackAssistant: "on:configured", automations: "on:configured", aiGateway: "on:configured",
    cloudComputers: "needs_infrastructure:service_not_installed",
  })
  assert.equal(aws({ runtimeProfile: "gateway", assistants: { computerProvider: "daytona", computerSecretArn, computerSnapshot: "snapshot" } }).cloudComputers, "on:configured")
  assert.equal(aws({ runtimeProfile: "gateway", assistants: { computerProvider: "freestyle", computerSecretArn } }).cloudComputers, "on:configured")
})

test("a legacy managed AWS deployment reports each assistant from its own settings", () => {
  assert.deepEqual(aws({}), {
    workbot: "needs_infrastructure:dependency_not_installed", slackAssistant: "needs_infrastructure:dependency_not_installed",
    automations: "on:configured", aiGateway: "needs_infrastructure:service_not_installed",
    cloudComputers: "needs_infrastructure:dependency_not_installed",
  })
  assert.deepEqual(aws({ assistants: ownRunner }), {
    workbot: "needs_infrastructure:service_not_installed", slackAssistant: "off:switched_off",
    automations: "on:configured", aiGateway: "needs_infrastructure:service_not_installed",
    cloudComputers: "needs_infrastructure:service_not_installed",
  })
  assert.deepEqual(aws({ assistants: { ...ownRunner, workbotEnabled: true, slackAssistantEnabled: true, computerProvider: "freestyle", computerSecretArn } }), {
    workbot: "on:configured", slackAssistant: "on:configured", automations: "on:configured",
    aiGateway: "needs_infrastructure:service_not_installed", cloudComputers: "on:configured",
  })
})

test("a managed Google Cloud deployment offers none of the capabilities yet", () => {
  const result = managedDeploymentCapabilityStates({ provider: "gcp" })
  assert.equal(result.target, "managed-gcp")
  assert.deepEqual(new Set(Object.values(summary(result.capabilities))), new Set(["unsupported:not_offered"]))
})

const bare: InstalledDeploymentSignals = {
  headlessRunnerConfigured: false, workbotConfigured: false, gatewayEnabled: false, gatewayAddressConfigured: false,
  automationsEnabled: true, slackAssistantWorkerEnabled: true,
}
const installed = (signals: Partial<InstalledDeploymentSignals>) => summary(installedDeploymentCapabilityStates({ ...bare, ...signals }))

test("a running Den derives each state from its own settings and never says unsupported", () => {
  assert.deepEqual(installed({}), {
    workbot: "needs_infrastructure:dependency_not_installed", slackAssistant: "needs_infrastructure:dependency_not_installed",
    automations: "on:configured", aiGateway: "needs_infrastructure:service_not_installed",
    cloudComputers: "needs_infrastructure:dependency_not_installed",
  })
  assert.deepEqual(installed({ headlessRunnerConfigured: true, workbotConfigured: true, gatewayEnabled: true, gatewayAddressConfigured: true }), {
    workbot: "on:configured", slackAssistant: "on:configured", automations: "on:configured", aiGateway: "on:configured",
    cloudComputers: "on:configured_on_runner",
  })
  assert.deepEqual(installed({ headlessRunnerConfigured: true, gatewayAddressConfigured: true, automationsEnabled: false, slackAssistantWorkerEnabled: false }), {
    workbot: "needs_infrastructure:service_not_installed", slackAssistant: "off:switched_off", automations: "off:switched_off",
    aiGateway: "off:switched_off", cloudComputers: "on:configured_on_runner",
  })
  assert.equal(installed({ workbotConfigured: true }).workbot, "needs_infrastructure:dependency_not_installed", "Workbot without a runner cannot answer")
})

test("every state and reason has a sentence a person can read", () => {
  for (const state of capabilityStateSchema.options) assert.ok(CAPABILITY_STATE_LABELS[state])
  for (const reason of capabilityStateReasonSchema.options) assert.match(CAPABILITY_STATE_REASON_LABELS[reason], /\.$/)
})
