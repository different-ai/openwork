import assert from "node:assert/strict"
import { test } from "node:test"
import { quickCreateUrl, updateStackCommand } from "@openwork/managed-deployments/aws"
import { summarizeHealth } from "@openwork/managed-deployments/lifecycle"
import { awsTargetSchema, managedDeploymentLaunchInputSchema, healthReportSchema } from "@openwork/managed-deployments/schema"

const target = { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" }
const modelSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ab12Cd"
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ef34Gh"
const assistants = {
  headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true,
  modelProtocol: "anthropic", modelBaseUrl: "https://model.example.test/v1", model: "customer-model", modelSecretArn,
  computerProvider: "freestyle", computerSecretArn,
}

test("old AWS targets default every assistant capability off", () => {
  assert.deepEqual(awsTargetSchema.parse(target).assistants, {
    headlessRunnerEnabled: false, workbotEnabled: false, slackAssistantEnabled: false, computerProvider: "off",
  })
})

test("runner configuration accepts only customer secret ARNs in this account and region", () => {
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants }).success, true)
  for (const invalid of ["plaintext-api-key", `${modelSecretArn}:apiKey::`, `${modelSecretArn}:AWSCURRENT`, modelSecretArn.replace("123456789012", "210987654321"), modelSecretArn.replace("us-east-1", "us-west-2")]) {
    assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, modelSecretArn: invalid } }).success, false, invalid)
    assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, computerSecretArn: invalid } }).success, false, invalid)
  }
  for (const key of ["modelProtocol", "modelBaseUrl", "model", "modelSecretArn"]) {
    assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, [key]: undefined } }).success, false, key)
  }
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, modelApiKey: "not-accepted" } }).success, false)
})

test("Workbot, Slack and computers require the managed runner and no external URL mode exists", () => {
  for (const enabled of [{ workbotEnabled: true }, { slackAssistantEnabled: true }, { computerProvider: "freestyle", computerSecretArn }]) {
    assert.equal(awsTargetSchema.safeParse({ ...target, assistants: enabled }).success, false)
  }
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, headlessRunnerEnabled: false } }).success, false)
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, runnerMode: "external_url", runnerUrl: "https://runner.example.test" } }).success, false)
  for (const modelBaseUrl of ["not-a-url", "", "http://model.example.test", "https://user:key@model.example.test", "https://model.example.test?key=value", "https://model.example.test#key"]) {
    assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, modelBaseUrl } }).success, false)
  }
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...assistants, computerSecretArn: undefined } }).success, false)
})

test("cloud computers remain optional and Daytona needs only its selected provider dependencies", () => {
  const runnerOnly = { ...assistants, computerProvider: "off", computerSecretArn: undefined }
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: runnerOnly }).success, true)
  const daytona = { ...assistants, computerProvider: "daytona", computerSnapshot: "computer-snapshot" }
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: daytona }).success, true)
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...daytona, computerSnapshot: undefined } }).success, false)
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...daytona, computerSecretArn: undefined } }).success, false)
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...daytona, modelSecretArn: undefined } }).success, false)
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...daytona, daytonaApiUrl: "https://user:key@daytona.example.test/api" } }).success, false)
  assert.equal(awsTargetSchema.safeParse({ ...target, assistants: { ...daytona, daytonaApiUrl: "not-a-url" } }).success, false)
})

test("only an Update can carry changed assistant settings", () => {
  assert.equal(managedDeploymentLaunchInputSchema.safeParse({ kind: "update", assistants }).success, true)
  assert.equal(managedDeploymentLaunchInputSchema.safeParse({ kind: "install", assistants }).success, false)
  assert.equal(managedDeploymentLaunchInputSchema.safeParse({ kind: "retry", assistants }).success, false)
  assert.equal(managedDeploymentLaunchInputSchema.safeParse({ kind: "configure", assistants }).success, false)
})

test("AWS install and update handoffs carry identical explicit assistant parameters", () => {
  const input = {
    deploymentId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", challenge: "a".repeat(64),
    target: awsTargetSchema.parse({ ...target, assistants }), domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small",
    release: { templateUrl: "https://releases.example.test/template", bundleUrl: "https://releases.example.test/bundle", bundleSha256: "a".repeat(64), version: "1.0.1", apiOrigin: "https://control.example.test" },
  }
  const url = new URL(quickCreateUrl(input))
  const params = new URLSearchParams(url.hash.split("?")[1])
  for (const [key, value] of Object.entries({ HeadlessRunnerEnabled: "true", WorkbotEnabled: "true", SlackAssistantEnabled: "true", HeadlessModelProtocol: "anthropic", HeadlessModelBaseUrl: assistants.modelBaseUrl, HeadlessModel: assistants.model, HeadlessModelSecretArn: modelSecretArn, HeadlessComputerProvider: "freestyle", HeadlessComputerSecretArn: computerSecretArn, HeadlessComputerSnapshot: "", DaytonaApiUrl: "https://app.daytona.io/api", DaytonaTarget: "us" })) {
    assert.equal(params.get(`param_${key}`), value)
    assert.ok(updateStackCommand(input).includes(JSON.stringify({ ParameterKey: key, ParameterValue: value })))
  }
  const legacy = new URLSearchParams(new URL(quickCreateUrl({ ...input, target: awsTargetSchema.parse(target) })).hash.split("?")[1])
  assert.equal(legacy.has("param_HeadlessRunnerEnabled"), false, "legacy installer templates receive no new parameters")
  const disabled = new URLSearchParams(new URL(quickCreateUrl({ ...input, includeAssistantParameters: true, target: awsTargetSchema.parse(target) })).hash.split("?")[1])
  assert.equal(disabled.get("param_HeadlessRunnerEnabled"), "false")
  assert.equal(disabled.get("param_HeadlessModelSecretArn"), "")
  const daytona = new URLSearchParams(new URL(quickCreateUrl({ ...input, target: awsTargetSchema.parse({ ...target, assistants: { ...assistants, computerProvider: "daytona", computerSnapshot: "computer-snapshot", daytonaApiUrl: "https://daytona.example.test/api", daytonaTarget: "eu" } }) })).hash.split("?")[1])
  assert.equal(daytona.get("param_HeadlessComputerProvider"), "daytona")
  assert.equal(daytona.get("param_HeadlessComputerSnapshot"), "computer-snapshot")
  assert.equal(daytona.get("param_DaytonaApiUrl"), "https://daytona.example.test/api")
  assert.equal(daytona.get("param_DaytonaTarget"), "eu")
})

test("assistant health checks stay allowlisted and runner failure degrades the deployment", () => {
  const report = healthReportSchema.parse({ checks: [
    { id: "runner_service", status: "failing", code: "not_running" },
    { id: "workbot_available", status: "ok" }, { id: "runner_storage", status: "ok", value: 10 }, { id: "runner_backups", status: "ok", value: 1 },
  ] })
  assert.equal(summarizeHealth({ ...report, reportedAt: new Date(), version: null }).state, "degraded")
  assert.equal(healthReportSchema.safeParse({ checks: [{ id: "runner_secret", status: "ok", value: "credential" }] }).success, false)
})
