import assert from "node:assert/strict"
import { test } from "node:test"
import { quickCreateUrl, updateStackCommand } from "@openwork/managed-deployments/aws"
import { summarizeHealth } from "@openwork/managed-deployments/lifecycle"
import * as schema from "@openwork/managed-deployments/schema"

const target = { accountId: "123456789012", region: schema.awsRegionSchema.enum["us-east-1"], route53ZoneId: "ZTEST" }
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd"

test("legacy views do not silently upgrade old AWS targets", () => {
  assert.equal(schema.awsTargetSchema.parse(target).runtimeProfile, "legacy")
})

test("gateway targets include all runtime services without a direct-model credential", () => {
  const parsed = schema.awsTargetSchema.parse({ ...target, runtimeProfile: "gateway", assistants: { headlessRunnerEnabled: false, workbotEnabled: false, slackAssistantEnabled: false } })
  assert.equal(parsed.runtimeProfile, "gateway")
  assert.deepEqual(parsed.assistants, { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true, computerProvider: "off" })
  const cleared = schema.awsTargetSchema.parse({ ...target, runtimeProfile: "gateway", assistants: { modelProtocol: "anthropic", modelBaseUrl: "https://model.example.test/v1", model: "unused-model", modelSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh" } })
  assert.equal(cleared.assistants.modelSecretArn, undefined)
  assert.equal(cleared.assistants.modelBaseUrl, undefined)
  assert.equal(cleared.assistants.model, undefined)
  assert.equal(cleared.assistants.modelProtocol, undefined)
})

test("create normalization and view normalization have deliberately different defaults", () => {
  assert.equal(schema.normalizeAwsTargetForCreate(target, { gatewayByDefault: true }).runtimeProfile, "gateway")
  assert.equal(schema.normalizeAwsTargetForCreate(target, { gatewayByDefault: false }).runtimeProfile, "legacy")
  assert.equal(schema.normalizeAwsTargetForCreate({ ...target, runtimeProfile: "legacy" }, { gatewayByDefault: true }).runtimeProfile, "legacy")
  assert.equal(schema.awsTargetSchema.parse(target).runtimeProfile, "legacy")
})

test("only selected computers require their own key and Daytona snapshot", () => {
  assert.equal(schema.awsTargetSchema.safeParse({ ...target, runtimeProfile: "gateway" }).success, true)
  assert.equal(schema.awsTargetSchema.safeParse({ ...target, runtimeProfile: "gateway", assistants: { computerProvider: "daytona", computerSecretArn, computerSnapshot: "computer-snapshot" } }).success, true)
  assert.equal(schema.awsTargetSchema.safeParse({ ...target, runtimeProfile: "gateway", assistants: { computerProvider: "daytona", computerSecretArn } }).success, false)
  assert.equal(schema.awsTargetSchema.safeParse({ ...target, runtimeProfile: "gateway", assistants: { computerProvider: "freestyle", computerSecretArn } }).success, true)
})

test("a profile change is explicit Update input, never Retry", () => {
  assert.equal(schema.managedDeploymentLaunchInputSchema.safeParse({ kind: "update", runtimeProfile: "gateway" }).success, true)
  assert.equal(schema.managedDeploymentLaunchInputSchema.safeParse({ kind: "retry", runtimeProfile: "gateway" }).success, false)
  assert.equal(schema.managedDeploymentLaunchInputSchema.safeParse({ kind: "install", runtimeProfile: "gateway" }).success, false)
  assert.equal(schema.managedDeploymentLaunchInputSchema.safeParse({ kind: "configure" }).success, false)
})

test("gateway handoffs use the exact profile parameter and never direct-model values", () => {
  const launch = { deploymentId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", challenge: "a".repeat(64), target: schema.awsTargetSchema.parse({ ...target, runtimeProfile: "gateway" }), domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small", release: { templateUrl: "https://releases.example.test/template", bundleUrl: "https://releases.example.test/bundle", bundleSha256: "a".repeat(64), version: "1.0.2", apiOrigin: "https://control.example.test" } }
  const parameters = new URLSearchParams(new URL(quickCreateUrl(launch)).hash.split("?")[1])
  assert.equal(parameters.get("param_ManagedRuntimeProfile"), "gateway")
  for (const name of ["HeadlessRunnerEnabled", "WorkbotEnabled", "SlackAssistantEnabled"]) assert.equal(parameters.get(`param_${name}`), "true")
  assert.equal(parameters.get("param_HeadlessModelBaseUrl"), "")
  for (const name of ["HeadlessModel", "HeadlessModelSecretArn"]) assert.equal(parameters.has(`param_${name}`), false)
  assert.ok(updateStackCommand(launch).includes(JSON.stringify({ ParameterKey: "ManagedRuntimeProfile", ParameterValue: "gateway" })))
  const legacy = new URLSearchParams(new URL(quickCreateUrl({ ...launch, target: schema.awsTargetSchema.parse(target) })).hash.split("?")[1])
  assert.equal(legacy.has("param_ManagedRuntimeProfile"), false)
})

test("model gateway failure is critical, while unknown gateway health is degraded", () => {
  const check = schema.healthCheckSchema.parse({ id: "ai_gateway_available", status: "failing", code: "unavailable" })
  assert.equal(summarizeHealth({ checks: [check], reportedAt: new Date(), version: "1.0.2" }).state, "down")
  assert.equal(summarizeHealth({ checks: [{ ...check, status: "unknown" }], reportedAt: new Date(), version: "1.0.2" }).state, "degraded")
})
