import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { updateStackCommand } from "@openwork/managed-deployments/aws"
import {
  deploymentConfigurationRejectionMessage, planDeploymentConfigurationChange,
  type DeploymentConfiguration, type DeploymentConfigurationPlan,
} from "@openwork/managed-deployments/configuration"
import {
  awsAssistantsSchema, awsManagedDeploymentInputSchema, awsTargetSchema, deploymentConfigurationChangeInputSchema, deploymentConfigurationChangeRecordSchema,
  deploymentConfigurationChangeResultSchema, deploymentConfigurationViewSchema, deploymentRunKindSchema, managedDeploymentLaunchInputSchema,
  managedDeploymentLaunchSchema, managedDeploymentSchema, type AwsManagedDeploymentInput,
} from "@openwork/managed-deployments/schema"

const identity = { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", network: { mode: "dedicated" } }
const existingNetwork = { mode: "existing", vpcId: "vpc-0abc12345", serviceSubnetIds: ["subnet-0aaa11111", "subnet-0bbb22222"], loadBalancerSubnetIds: ["subnet-0ccc33333", "subnet-0ddd44444"] }
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd"
const modelSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh"
const daytona = { computerProvider: "daytona", computerSecretArn, computerSnapshot: "computer-snapshot" }
const ownRunner = { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: false, modelProtocol: "anthropic", modelBaseUrl: "https://model.example.com/v1", model: "customer-model", modelSecretArn }

function recorded(target: Record<string, unknown>): DeploymentConfiguration {
  return { name: "Production", domainName: "openwork.example.com", ownerEmail: "admin@example.com", size: "small", target: awsTargetSchema.parse(target) }
}
const legacy = recorded(identity)
const legacyWithRunner = recorded({ ...identity, assistants: ownRunner })
const gateway = recorded({ ...identity, runtimeProfile: "gateway" })
const gatewayWithDaytona = recorded({ ...identity, runtimeProfile: "gateway", assistants: daytona })

type Edits = Partial<Omit<AwsManagedDeploymentInput, "target">> & { target?: Partial<AwsManagedDeploymentInput["target"]> }
/** The complete document a client sends: the recorded configuration with its edits. */
function request(current: DeploymentConfiguration, { target, ...edits }: Edits = {}): AwsManagedDeploymentInput {
  return { provider: "aws", name: current.name, domainName: current.domainName, ownerEmail: current.ownerEmail, size: current.size, ...edits, target: { ...current.target, ...target } }
}
function assistants(current: DeploymentConfiguration, edits: Record<string, unknown>) {
  return awsAssistantsSchema.parse({ ...current.target.assistants, ...edits })
}
function accepted(plan: DeploymentConfigurationPlan) {
  if (!plan.ok) throw new Error(`Refused: ${plan.rejection.code}`)
  return plan
}
function refused(plan: DeploymentConfigurationPlan) {
  if (plan.ok) throw new Error("Expected a refusal")
  return plan.rejection
}

test("the recorded configuration sent back unchanged is no change", () => {
  for (const current of [legacy, legacyWithRunner, gateway, gatewayWithDaytona]) {
    assert.equal(awsManagedDeploymentInputSchema.safeParse(request(current)).success, true)
    const plan = accepted(planDeploymentConfigurationChange(current, request(current)))
    assert.deepEqual(plan.changes, [])
    assert.deepEqual(plan.next, current)
    assert.deepEqual([plan.requiresApproval, plan.targetChanged, plan.enablesGateway], [false, false, false])
  }
  const kept = accepted(planDeploymentConfigurationChange(gatewayWithDaytona, request(gatewayWithDaytona, { target: { runtimeProfile: undefined } })))
  assert.deepEqual(kept.changes, [], "an omitted runtime profile keeps the recorded one")
  assert.equal(kept.next.target.runtimeProfile, "gateway")
  assert.equal(accepted(planDeploymentConfigurationChange(legacy, request(legacy))).needsAssistantsFeature, false)
  assert.equal(accepted(planDeploymentConfigurationChange(legacyWithRunner, request(legacyWithRunner))).needsAssistantsFeature, true)
  assert.equal(accepted(planDeploymentConfigurationChange(gateway, request(gateway))).needsAssistantsFeature, true)
})

test("a rename is saved at once and needs no approval", () => {
  const plan = accepted(planDeploymentConfigurationChange(legacy, request(legacy, { name: "  Production EU " })))
  assert.deepEqual(plan.changes, [{ field: "name", before: "Production", after: "Production EU", effect: "saved_immediately" }])
  assert.equal(plan.next.name, "Production EU")
  assert.deepEqual([plan.requiresApproval, plan.targetChanged], [false, false])
})

test("a new first administrator email restarts Den; a case-only difference is no change", () => {
  const plan = accepted(planDeploymentConfigurationChange(legacy, request(legacy, { ownerEmail: "owner@example.com" })))
  assert.deepEqual(plan.changes, [{ field: "ownerEmail", before: "admin@example.com", after: "owner@example.com", effect: "restarts_den" }])
  assert.equal(plan.next.ownerEmail, "owner@example.com")
  assert.deepEqual([plan.requiresApproval, plan.targetChanged, plan.needsAssistantsFeature], [true, false, false])
  assert.deepEqual(plan.next.target, legacy.target)
  const sameAddress = accepted(planDeploymentConfigurationChange(legacy, request(legacy, { ownerEmail: "Admin@Example.com" })))
  assert.deepEqual(sameAddress.changes, [])
  assert.equal(sameAddress.next.ownerEmail, "admin@example.com")
  const both = accepted(planDeploymentConfigurationChange(legacy, request(legacy, { name: "Renamed", ownerEmail: "owner@example.com" })))
  assert.deepEqual(both.changes.map((change) => change.field), ["name", "ownerEmail"])
  assert.equal(both.requiresApproval, true)
})

test("turning on the gateway runtime with Daytona is one runtime entry plus the computer fields", () => {
  for (const current of [legacy, legacyWithRunner]) {
    const plan = accepted(planDeploymentConfigurationChange(current, request(current, { target: { runtimeProfile: "gateway", assistants: assistants(current, daytona) } })))
    assert.deepEqual(plan.changes, [
      { field: "target.runtimeProfile", before: "legacy", after: "gateway", effect: "adds_gateway_runtime" },
      { field: "target.assistants.computerProvider", before: "off", after: "daytona", effect: "restarts_runner" },
      { field: "target.assistants.computerSecretArn", before: null, after: computerSecretArn, effect: "restarts_runner" },
      { field: "target.assistants.computerSnapshot", before: null, after: "computer-snapshot", effect: "restarts_runner" },
    ])
    assert.equal(plan.next.target.runtimeProfile, "gateway")
    assert.deepEqual(plan.next.target.assistants, { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true, ...daytona })
    assert.deepEqual([plan.requiresApproval, plan.targetChanged, plan.enablesGateway, plan.needsAssistantsFeature], [true, true, true, true])
  }
  const runtimeOnly = accepted(planDeploymentConfigurationChange(legacy, request(legacy, { target: { runtimeProfile: "gateway" } })))
  assert.deepEqual(runtimeOnly.changes.map((change) => change.effect), ["adds_gateway_runtime"])
  assert.deepEqual([runtimeOnly.targetChanged, runtimeOnly.enablesGateway], [true, true])
})

test("computers change on a gateway deployment and restart only the runner", () => {
  const off = accepted(planDeploymentConfigurationChange(gatewayWithDaytona, request(gatewayWithDaytona, { target: { assistants: assistants(gatewayWithDaytona, { computerProvider: "off" }) } })))
  assert.deepEqual(off.changes, [
    { field: "target.assistants.computerProvider", before: "daytona", after: "off", effect: "restarts_runner" },
    { field: "target.assistants.computerSecretArn", before: computerSecretArn, after: null, effect: "restarts_runner" },
    { field: "target.assistants.computerSnapshot", before: "computer-snapshot", after: null, effect: "restarts_runner" },
  ])
  assert.deepEqual(off.next.target.assistants, { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true, computerProvider: "off" })
  assert.deepEqual([off.requiresApproval, off.targetChanged, off.enablesGateway, off.needsAssistantsFeature], [true, true, false, true])
  const moved = accepted(planDeploymentConfigurationChange(gatewayWithDaytona, request(gatewayWithDaytona, { target: { assistants: assistants(gatewayWithDaytona, { daytonaApiUrl: "https://daytona.example.com/api", daytonaTarget: "eu" }) } })))
  assert.deepEqual(moved.changes.map((change) => [change.field, change.before, change.after]), [
    ["target.assistants.daytonaApiUrl", null, "https://daytona.example.com/api"], ["target.assistants.daytonaTarget", null, "eu"],
  ])
  const switches = accepted(planDeploymentConfigurationChange(gateway, request(gateway, { target: { assistants: assistants(gateway, { ...ownRunner, headlessRunnerEnabled: false, workbotEnabled: false }) } })))
  assert.deepEqual(switches.changes, [], "under gateway the service switches and model fields are not settings")
  assert.deepEqual(switches.next.target, gateway.target)
})

test("values fixed at installation are refused by name", () => {
  const existing = recorded({ ...identity, network: existingNetwork })
  const fixed = [
    [request(legacy, { domainName: "other.example.com" }), "domainName", "The address can't be changed after installation. Create a new deployment to use a different one."],
    [request(legacy, { target: { accountId: "210987654321" } }), "target.accountId", "The AWS account can't be changed after installation. Create a new deployment to use a different one."],
    [request(legacy, { target: { region: "eu-west-1" } }), "target.region", "The region can't be changed after installation. Create a new deployment to use a different one."],
    [request(legacy, { target: { route53ZoneId: "ZOTHER" } }), "target.route53ZoneId", "The hosted zone can't be changed after installation. Create a new deployment to use a different one."],
    [request(legacy, { target: { network: existing.target.network } }), "target.network", "The network can't be changed after installation. Create a new deployment to use a different one."],
  ] satisfies [AwsManagedDeploymentInput, string, string][]
  for (const [requested, field, message] of fixed) {
    assert.deepEqual(refused(planDeploymentConfigurationChange(legacy, requested)), { code: "field_not_editable", field, message })
  }
  assert.equal(refused(planDeploymentConfigurationChange(existing, request(existing, { target: { network: { mode: "dedicated" } } }))).field, "target.network")
  assert.equal(refused(planDeploymentConfigurationChange(existing, request(existing, { target: { network: { ...existingNetwork, mode: "existing", serviceSubnetIds: ["subnet-0aaa11111", "subnet-0eee55555"] } } }))).field, "target.network")
  assert.equal(refused(planDeploymentConfigurationChange(legacy, request(legacy, { domainName: "other.example.com", ownerEmail: "owner@example.com" }))).code, "field_not_editable", "nothing is planned when any fixed value differs")
  const reordered = { loadBalancerSubnetIds: existingNetwork.loadBalancerSubnetIds, ecsClusterArn: "", serviceSubnetIds: existingNetwork.serviceSubnetIds, vpcId: existingNetwork.vpcId, mode: "existing" } satisfies AwsManagedDeploymentInput["target"]["network"]
  assert.deepEqual(accepted(planDeploymentConfigurationChange(existing, request(existing, { target: { network: reordered } }))).changes, [], "key order and an empty cluster ARN are not a different network")
})

test("the gateway runtime cannot be removed, and a legacy runtime is not edited here", () => {
  assert.deepEqual(refused(planDeploymentConfigurationChange(gatewayWithDaytona, request(gatewayWithDaytona, { target: { runtimeProfile: "legacy" } }))), {
    code: "gateway_cannot_be_removed", field: "target.runtimeProfile", message: "The gateway runtime can't be turned off. Removing it would delete the runner's files, secrets and backups.",
  })
  for (const current of [legacy, legacyWithRunner]) {
    assert.deepEqual(refused(planDeploymentConfigurationChange(current, request(current, { target: { assistants: assistants(current, daytona) } }))), {
      code: "computers_need_gateway", field: "target.assistants.computerProvider", message: "Cloud computers need the gateway runtime. Turn it on to change them.",
    })
  }
  assert.deepEqual(refused(planDeploymentConfigurationChange(legacyWithRunner, request(legacyWithRunner, { target: { assistants: assistants(legacyWithRunner, { model: "another-model" }) } }))), {
    code: "legacy_runtime_not_editable", field: "target.assistants.model", message: "This deployment's own runner settings can't be edited here. Turn on the gateway runtime instead.",
  })
  assert.equal(refused(planDeploymentConfigurationChange(legacy, request(legacy, { target: { assistants: assistants(legacy, ownRunner) } }))).code, "legacy_runtime_not_editable")
  assert.equal(refused(planDeploymentConfigurationChange(legacyWithRunner, request(legacyWithRunner, { target: { assistants: assistants(legacyWithRunner, { workbotEnabled: false }) } }))).field, "target.assistants.workbotEnabled")
})

test("an invalid computer setting names its field with the schema's own sentence", () => {
  for (const foreign of [computerSecretArn.replace("123456789012", "210987654321"), computerSecretArn.replace("us-east-1", "us-west-2")]) {
    assert.deepEqual(refused(planDeploymentConfigurationChange(gateway, request(gateway, { target: { assistants: assistants(gateway, { ...daytona, computerSecretArn: foreign }) } }))), {
      code: "invalid_configuration", field: "target.assistants.computerSecretArn", message: "Use a Secrets Manager secret in this deployment's AWS account and region.",
    })
  }
  const withoutSnapshot = { ...gateway.target.assistants, computerProvider: "daytona", computerSecretArn } satisfies AwsManagedDeploymentInput["target"]["assistants"]
  for (const current of [gateway, legacy]) {
    assert.deepEqual(refused(planDeploymentConfigurationChange(current, request(current, { target: { runtimeProfile: "gateway", assistants: withoutSnapshot } }))), {
      code: "invalid_configuration", field: "target.assistants.computerSnapshot", message: "Choose a Daytona computer snapshot before enabling Daytona computers.",
    })
  }
  assert.equal(deploymentConfigurationRejectionMessage("field_not_editable", null), "This value can't be changed after installation. Create a new deployment to use a different one.")
  assert.equal(deploymentConfigurationRejectionMessage("invalid_configuration", "target.assistants.computerSnapshot"), "Check this value and try again.")
})

// ---- Handoff: the command a configure run gives the customer ----

const deploymentId = "00000000-0000-4000-8000-000000000001"
const installed = { runId: "00000000-0000-4000-8000-000000000002", challenge: "a".repeat(64) }
const change = { runId: "00000000-0000-4000-8000-000000000003", challenge: "c".repeat(64) }
const release = {
  templateUrl: "https://releases.example.com/aws/template.json?versionId=template-1", bundleUrl: "https://releases.example.com/aws/bundle.tar.gz?versionId=bundle-1",
  bundleSha256: "b".repeat(64), version: "1.0.2", apiOrigin: "https://control.example.com",
}

/** Which optional parameters are sent follows the keys the stored target has, as the API's handoff decides it. */
function command(stored: Record<string, unknown>, ownerEmail: string, run: typeof installed) {
  return updateStackCommand({
    deploymentId, ...run, target: awsTargetSchema.parse(stored), includeAssistantParameters: Object.hasOwn(stored, "assistants"),
    includeRuntimeProfileParameter: Object.hasOwn(stored, "runtimeProfile"), domainName: "openwork.example.com", ownerEmail, size: "small", release,
  })
}
function parameters(text: string) {
  const json = /--parameters '(.+)'$/.exec(text)?.[1]
  if (!json) throw new Error("The command has no parameters")
  return new Map(z.array(z.object({ ParameterKey: z.string(), ParameterValue: z.string() })).parse(JSON.parse(json)).map((entry) => [entry.ParameterKey, entry.ParameterValue]))
}
/** The record a configure run stores: an unchanged target stays exactly as it was stored. */
function snapshot(stored: Record<string, unknown>, current: DeploymentConfiguration, requested: AwsManagedDeploymentInput) {
  const plan = accepted(planDeploymentConfigurationChange(current, requested))
  return deploymentConfigurationChangeRecordSchema.parse({
    version: 1, requestedBy: { memberId: "member_1", userId: "user_1" }, baseRunId: installed.runId, restoresRunId: installed.runId,
    previous: { ownerEmail: current.ownerEmail, target: stored },
    requested: { ownerEmail: plan.next.ownerEmail, target: plan.targetChanged ? plan.next.target : stored },
    changes: plan.changes.filter((entry) => entry.field !== "name"),
  })
}

test("a configure handoff re-runs the installed release with only the changed parameters", () => {
  const stored = { ...gateway.target }
  const record = snapshot(stored, gateway, request(gateway, { name: "Renamed", ownerEmail: "owner@example.com", target: { assistants: assistants(gateway, daytona) } }))
  assert.deepEqual(record.changes.map((entry) => entry.field), ["ownerEmail", "target.assistants.computerProvider", "target.assistants.computerSecretArn", "target.assistants.computerSnapshot"])
  const before = command(stored, gateway.ownerEmail, installed)
  const after = command(record.requested.target, record.requested.ownerEmail, change)
  assert.ok(after.includes(`--template-url '${release.templateUrl}'`))
  assert.ok(after.startsWith(`[ "$(aws sts get-caller-identity --query Account --output text)" = '123456789012' ]`))
  const was = parameters(before)
  const now = parameters(after)
  assert.deepEqual([now.get("OpenWorkVersion"), now.get("BundleSha256"), now.get("BundleUrl")], [release.version, release.bundleSha256, release.bundleUrl])
  assert.deepEqual([now.get("RunId"), now.get("Challenge")], [change.runId, change.challenge])
  assert.equal(now.get("OwnerEmail"), "owner@example.com")
  assert.deepEqual([now.get("HeadlessComputerProvider"), now.get("HeadlessComputerSecretArn"), now.get("HeadlessComputerSnapshot")], ["daytona", computerSecretArn, "computer-snapshot"])
  assert.deepEqual([...now.keys()], [...was.keys()], "the installed template receives the same parameter names")
  assert.deepEqual([...now.keys()].filter((key) => now.get(key) !== was.get(key)).sort(), ["Challenge", "HeadlessComputerProvider", "HeadlessComputerSecretArn", "HeadlessComputerSnapshot", "OwnerEmail", "RunId"])
})

test("an email change on a historical legacy record sends no runtime parameters", () => {
  const stored = { accountId: identity.accountId, region: identity.region, route53ZoneId: identity.route53ZoneId, network: identity.network }
  const current = recorded(stored)
  const record = snapshot(stored, current, request(current, { ownerEmail: "owner@example.com" }))
  assert.deepEqual(record.requested, { ownerEmail: "owner@example.com", target: stored })
  const now = parameters(command(record.requested.target, record.requested.ownerEmail, change))
  assert.equal(now.get("OwnerEmail"), "owner@example.com")
  assert.equal(now.get("OpenWorkVersion"), release.version)
  for (const name of ["ManagedRuntimeProfile", "HeadlessRunnerEnabled", "WorkbotEnabled", "SlackAssistantEnabled", "HeadlessComputerProvider", "HeadlessModelSecretArn", "DaytonaApiUrl"]) {
    assert.equal(now.has(name), false, `${name} is not a parameter of a template that predates runtime profiles`)
  }
  const normalized = parameters(command({ ...current.target }, record.requested.ownerEmail, change))
  assert.equal(normalized.get("ManagedRuntimeProfile"), "legacy", "the normalized target is not the stored one: it would send parameters the installed template lacks")

  const enabled = snapshot(stored, current, request(current, { target: { runtimeProfile: "gateway", assistants: assistants(current, daytona) } }))
  const gatewayParameters = parameters(command(enabled.requested.target, enabled.requested.ownerEmail, change))
  assert.deepEqual(["ManagedRuntimeProfile", "HeadlessRunnerEnabled", "HeadlessComputerProvider", "HeadlessModelSecretArn", "OwnerEmail"].map((name) => gatewayParameters.get(name)), ["gateway", "true", "daytona", "", "admin@example.com"])
})

// ---- Contract ----

test("configure is a run kind the launch route can never prepare", () => {
  assert.equal(deploymentRunKindSchema.safeParse("configure").success, true)
  assert.equal(managedDeploymentLaunchInputSchema.safeParse({ kind: "configure" }).success, false)
  assert.equal(managedDeploymentLaunchInputSchema.safeParse({ kind: "configure", runtimeProfile: "gateway" }).success, false)
  assert.equal(managedDeploymentLaunchInputSchema.parse({}).kind, "install")
})

test("views carry the configuration block only when it is sent, and an approval is also a launch", () => {
  const view = {
    id: deploymentId, name: gateway.name, provider: "aws", target: gateway.target, domainName: gateway.domainName, ownerEmail: gateway.ownerEmail, size: "small",
    updateMode: "approval", createdAt: "2026-10-01T00:00:00.000Z", webUrl: "https://openwork.example.com", consoleUrl: "https://console.example.com",
    installedVersion: "1.0.2", availableVersion: "1.0.2", updateAvailable: false,
    health: { state: "operational", reportedAt: "2026-10-01T00:00:00.000Z", version: "1.0.2", checks: [] },
    run: { id: change.runId, kind: "configure", version: "1.0.2", state: "awaiting_approval", createdAt: "2026-10-01T00:00:00.000Z", lastSeenAt: null, expiresAt: "2026-10-01T03:00:00.000Z", expired: false, events: [] },
  }
  assert.equal("configuration" in managedDeploymentSchema.parse(view), false)
  const requested = request(gateway, { ownerEmail: "owner@example.com" })
  const plan = accepted(planDeploymentConfigurationChange(gateway, requested))
  const configuration = deploymentConfigurationViewSchema.parse({
    revision: "d".repeat(64), lock: null, gatewayAvailable: true,
    change: { runId: change.runId, state: "awaiting_approval", requestedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T03:00:00.000Z", changes: plan.changes, requested },
  })
  const deployment = managedDeploymentSchema.parse({ ...view, configuration })
  assert.equal(deployment.configuration?.change?.requested.ownerEmail, "owner@example.com")
  assert.equal(deploymentConfigurationChangeInputSchema.safeParse({ expectedRevision: configuration.revision, configuration: deployment.configuration?.change?.requested }).success, true)
  assert.equal(deploymentConfigurationChangeInputSchema.safeParse({ expectedRevision: "stale", configuration: requested }).success, false)
  assert.equal(deploymentConfigurationChangeInputSchema.safeParse({ expectedRevision: configuration.revision, configuration: { ...requested, provider: "gcp" } }).success, false)

  const text = command(gateway.target, "owner@example.com", change)
  const result = deploymentConfigurationChangeResultSchema.parse({
    outcome: "approval_required", deployment, kind: "configure", approvalUrl: null, command: text,
    handoff: { action: "run_in_cloud_shell", url: "https://us-east-1.console.aws.amazon.com/cloudshell/home?region=us-east-1", command: text, instructions: "Open AWS CloudShell, then paste and run the command." },
    expiresAt: "2026-10-01T03:00:00.000Z", changes: plan.changes,
  })
  if (result.outcome !== "approval_required") throw new Error("Expected an approval")
  const launch: z.infer<typeof managedDeploymentLaunchSchema> = result
  assert.deepEqual(managedDeploymentLaunchSchema.parse(result), { deployment: launch.deployment, kind: "configure", approvalUrl: null, command: text, handoff: launch.handoff, expiresAt: launch.expiresAt })
  assert.equal(deploymentConfigurationChangeResultSchema.parse({ outcome: "saved", deployment }).outcome, "saved")
  assert.equal(deploymentConfigurationChangeResultSchema.parse({ outcome: "withdrawn", deployment }).outcome, "withdrawn")
})
