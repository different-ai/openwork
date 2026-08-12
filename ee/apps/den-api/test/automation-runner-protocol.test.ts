import assert from "node:assert/strict"
import test from "node:test"
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  automationDesktopRunnerAssignmentSchema,
  automationDesktopRunnerRegistrationSchema,
  automationRunnerEventRequestSchema,
  automationRunnerHeartbeatResponseSchema,
  automationRunnerNotificationSchema,
  automationRunnerUnavailableOutcomeSchema,
} from "@openwork/types/automations"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  RUNNER_NOTIFICATION_POLL_MAX_MS,
  RUNNER_NOTIFICATION_POLL_MIN_MS,
  capRunnerNotificationPollDelayForKeepalive,
  nextRunnerNotificationPollDelay,
} from "../src/automations/runner-notification-poll.js"
import { automationUpdateChangedRows } from "../src/automations/update-result.js"
import { isMcpOperationAllowed } from "../src/mcp/policy.js"

const repositorySource = readFileSync(join(import.meta.dir, "../src/automations/repository.ts"), "utf8")

test("runner notifications contain only a resumable cursor and wake-up type", () => {
  assert.deepEqual(automationRunnerNotificationSchema.parse({
    type: "automation_work_available",
    cursor: "42",
  }), { type: "automation_work_available", cursor: "42" })
  assert.equal(automationRunnerNotificationSchema.safeParse({
    type: "automation_work_available",
    cursor: "42",
    runId: "must-not-leak",
  }).success, false)
})

test("runner registration and assignment reject unsupported targets", () => {
  const registration = {
    runnerId: "runner-installation-1",
    protocolVersion: 1,
    supportedExecutionTargets: ["desktop"],
    appVersion: "0.18.13",
    platform: "darwin",
    concurrency: 1,
  }
  expectRegistrationCapabilities(registration, [])
  expectRegistrationCapabilities({
    ...registration,
    capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
  }, [AUTOMATION_MODEL_ATTENTION_CAPABILITY])
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({
    ...registration,
    capabilities: ["unknown_capability"],
  }).success, false)
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({
    ...registration,
    supportedExecutionTargets: ["sandbox"],
  }).success, false)
  assert.equal(automationDesktopRunnerAssignmentSchema.safeParse({
    executionTarget: "sandbox",
    runId: "run-1",
    automationId: "automation-1",
    automationName: "Test",
    instructions: "Return ready",
    model: { providerId: "opencode", modelId: "big-pickle" },
    timeoutMs: 60_000,
    leaseExpiresAt: Date.now() + 60_000,
    attempt: 1,
  }).success, false)
})

function expectRegistrationCapabilities(
  registration: Record<string, unknown>,
  expected: string[],
) {
  const parsed = automationDesktopRunnerRegistrationSchema.parse(registration)
  assert.deepEqual(parsed.capabilities, expected)
}

test("heartbeats and ordered events are bound to the claimed attempt", () => {
  assert.equal(automationRunnerHeartbeatResponseSchema.safeParse({
    attempt: 2,
    leaseValid: true,
    cancelRequested: false,
    leaseExpiresAt: Date.now() + 60_000,
  }).success, true)
  assert.equal(automationRunnerEventRequestSchema.safeParse({
    attempt: 2,
    sequence: 1,
    type: "assistant",
    payload: { text: "ready" },
    createdAt: Date.now(),
  }).success, true)
  assert.equal(automationRunnerEventRequestSchema.safeParse({
    sequence: 1,
    type: "assistant",
    payload: {},
    createdAt: Date.now(),
  }).success, false)
})

test("offline outcome is explicit and target-auditable", () => {
  assert.equal(automationRunnerUnavailableOutcomeSchema.safeParse({
    status: "skipped",
    reason: "runner_unavailable",
    executionTarget: "desktop",
  }).success, true)
})

test("Desktop and Cloud events remain ordered within their claimed attempt", () => {
  const desktopEvents = repositorySource.slice(
    repositorySource.indexOf("async appendDesktopEvent"),
    repositorySource.indexOf("appendCloudEvent"),
  )
  const cloudEvents = repositorySource.slice(
    repositorySource.indexOf("appendCloudEvent"),
    repositorySource.indexOf("private async appendClaimedEvent"),
  )
  assert.match(desktopEvents, /desktop:\$\{input\.runId\}:\$\{input\.attempt\}:\$\{input\.sequence\}/)
  assert.doesNotMatch(desktopEvents, /input\.leaseOwner/)
  assert.match(cloudEvents, /\$\{input\.leaseOwner\}:\$\{input\.runId\}:\$\{input\.attempt\}:\$\{input\.sequence\}/)
  assert.match(repositorySource, /attempt:\s*input\.attempt,[\s\S]*sequence:\s*input\.sequence/)
  assert.match(repositorySource, /orderBy\(asc\(AutomationRunEventTable\.attempt\), asc\(AutomationRunEventTable\.sequence\)\)/)
})

test("expired lease recovery cannot clobber a concurrently renewed lease", () => {
  const recovery = repositorySource.slice(
    repositorySource.indexOf("async recoverExpiredLeases"),
    repositorySource.indexOf("async requestCancellation"),
  )
  assert.match(recovery, /where\(and\([\s\S]*eq\(AutomationRunTable\.id, run\.id\)[\s\S]*eq\(AutomationRunTable\.lease_owner, run\.lease_owner\)[\s\S]*lt\(AutomationRunTable\.lease_expires_at, new Date\(input\.now\)\)/)
  assert.match(recovery, /engine_sequence:\s*retry \? 0 : run\.engine_sequence/)
})

test("a no-op heartbeat renewal is reported as a lost lease", () => {
  assert.equal(automationUpdateChangedRows([{ affectedRows: 0 }]), false)
  assert.equal(automationUpdateChangedRows({ rowsAffected: 0 }), false)
  assert.equal(automationUpdateChangedRows([{ affectedRows: 1 }]), true)
  const heartbeat = repositorySource.slice(
    repositorySource.indexOf("async heartbeatDesktop"),
    repositorySource.indexOf("async appendDesktopEvent"),
  )
  assert.match(heartbeat, /if \(!automationUpdateChangedRows\(renewal\)\) return null/)
  assert.match(heartbeat, /gt\(AutomationRunTable\.lease_expires_at, new Date\(input\.now\)\)/)
})

test("runner credential minting is never exposed as an MCP tool", () => {
  const operation = { operationId: "mintAutomationRunnerToken", tags: ["Automations"] }
  assert.equal(isMcpOperationAllowed({ method: "POST", path: "/v1/automation-runners/token", operation }), false)
  assert.equal(isMcpOperationAllowed({
    method: "POST",
    path: "/v1/automation-runners/token",
    operation: { ...operation, "x-mcp": true },
  }), false, "the operation-id blocklist must override an explicit x-mcp opt-in")
  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  assert.match(routesSource, /operationId: "mintAutomationRunnerToken", "x-mcp": false/)
  assert.match(routesSource, /capabilities: registration\.capabilities/)
  assert.match(routesSource, /AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER/)
})

test("every runner endpoint re-checks that the token owner is still an active member", () => {
  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  assert.match(routesSource, /service\.isActiveRunnerOwner\(identity\)/)
  const directAuthenticateCalls = routesSource.match(/automationRunnerAuth\.authenticate\(/g) ?? []
  assert.equal(
    directAuthenticateCalls.length,
    1,
    "runner endpoints must authorize through authenticateRunner (token + live membership), not the raw token check",
  )
  const sse = routesSource.slice(
    routesSource.indexOf("/v1/automation-runners/events\", async"),
    routesSource.indexOf("/v1/automation-runner/work"),
  )
  assert.match(sse, /Date\.now\(\) >= identity\.expiresAt\) break/)
  assert.match(sse, /if \(!\(await service\.isActiveRunnerOwner\(identity\)\)\) break/)
})

test("idle runner notification polling backs off without delaying keepalives", () => {
  let delay = RUNNER_NOTIFICATION_POLL_MIN_MS
  delay = nextRunnerNotificationPollDelay(delay, false)
  assert.equal(delay, 2_000)
  delay = nextRunnerNotificationPollDelay(delay, false)
  assert.equal(delay, 4_000)
  delay = nextRunnerNotificationPollDelay(delay, false)
  assert.equal(delay, 8_000)
  delay = nextRunnerNotificationPollDelay(delay, false)
  assert.equal(delay, RUNNER_NOTIFICATION_POLL_MAX_MS)
  assert.equal(nextRunnerNotificationPollDelay(delay, false), RUNNER_NOTIFICATION_POLL_MAX_MS)

  assert.equal(
    capRunnerNotificationPollDelayForKeepalive(delay, 14_000),
    RUNNER_NOTIFICATION_POLL_MIN_MS,
  )
  assert.equal(nextRunnerNotificationPollDelay(delay, true), RUNNER_NOTIFICATION_POLL_MIN_MS)
})

test("idle runner keepalives do not persist liveness in the database", () => {
  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  const serviceSource = readFileSync(join(import.meta.dir, "../src/automations/service.ts"), "utf8")
  const repositorySource = readFileSync(join(import.meta.dir, "../src/automations/repository.ts"), "utf8")
  const sse = routesSource.slice(
    routesSource.indexOf("/v1/automation-runners/events\", async"),
    routesSource.indexOf("/v1/automation-runner/work"),
  )
  const manualRun = routesSource.slice(
    routesSource.indexOf("/v1/automations/:id/run"),
    routesSource.indexOf("/v1/automations/:id/runs"),
  )

  assert.match(sse, /stream\.writeSSE\(\{ event: "keepalive"/)
  assert.doesNotMatch(sse, /touchDesktopRunner/)
  assert.doesNotMatch(manualRun, /hasOnlineDesktopRunner/)
  assert.match(serviceSource, /claimDeadlineMs: env\.automations\.runnerClaimDeadlineMs/)
  assert.doesNotMatch(serviceSource, /hasRecentDesktopRunner/)
  assert.doesNotMatch(repositorySource, /AutomationRunnerTable\.last_seen_at, new Date\(input\.seenAfter\)/)
})

test("every dispatch path revalidates the owner's model access", () => {
  const serviceSource = readFileSync(join(import.meta.dir, "../src/automations/service.ts"), "utf8")
  const tick = serviceSource.slice(serviceSource.indexOf("async tick"), serviceSource.indexOf("async stop"))
  assert.match(tick, /resolveAutomationModelAccess\(\{\s*organizationId: item\.automation\.organizationId/)
  assert.match(tick, /shouldApplyAutomationModelAccessFailure\(\{[\s\S]*modelAttentionCapable: \(item\.revision\.executionTarget \?\? "desktop"\) === "cloud"/)
  assert.match(tick, /await automationRepository\.skipRun\(/)
  const claim = serviceSource.slice(
    serviceSource.indexOf("async claimDesktopRunner"),
    serviceSource.indexOf("heartbeatDesktopRunner"),
  )
  assert.match(claim, /resolveAutomationModelAccess\(\{\s*organizationId: scope\.organizationId/)
  assert.match(claim, /shouldApplyAutomationModelAccessFailure\(\{[\s\S]*supportsModelAttention\(scope\)/)
  assert.match(claim, /skipRun\([\s\S]*return null/)
  const runNow = serviceSource.slice(serviceSource.indexOf("async runNow"), serviceSource.indexOf("listRuns"))
  assert.match(runNow, /resolveAutomationModelAccess\(\{ \.\.\.scope, \.\.\.current\.revision\.model \}\)/)
  assert.match(runNow, /shouldApplyAutomationModelAccessFailure\(\{[\s\S]*supportsModelAttention\(scope\)/)

  const executorSource = readFileSync(join(import.meta.dir, "../src/automations/cloud-agent-executor.ts"), "utf8")
  const execution = executorSource.slice(executorSource.indexOf("export async function executeCloudAgent"))
  assert.match(executorSource, /currentAgentAuthority[\s\S]*resolveAutomationModelAccess\(/)
  assert.match(execution, /currentAgentAuthority\(input\)[\s\S]*readyWorker/)
  assert.match(execution, /currentAgentAuthority\(input\)[\s\S]*createThread/)
  assert.match(execution, /currentAgentAuthority\(input\)[\s\S]*abortAndObserve\(client, nativeThreadId\)[\s\S]*sendTurn/)
  assert.match(serviceSource, /"owner_membership_lost",[\s\S]*markNeedsAttention/)
})

test("Cloud placement never inherits the legacy Desktop model exception", () => {
  const serviceSource = readFileSync(join(import.meta.dir, "../src/automations/service.ts"), "utf8")
  const create = serviceSource.slice(serviceSource.indexOf("async create"), serviceSource.indexOf("async update"))
  const update = serviceSource.slice(serviceSource.indexOf("async update"), serviceSource.indexOf("async activate"))
  const reconcile = serviceSource.slice(serviceSource.indexOf("private async reconcileModelAttention"))
  assert.match(create, /requireNewModel\(\{ \.\.\.scope, modelAttentionCapable: true \}/)
  assert.match(update, /executionTarget \?\? "desktop"\) === "cloud"[\s\S]*modelAttentionCapable: true/)
  assert.match(reconcile, /executionTarget \?\? "desktop"\) === "cloud"[\s\S]*supportsModelAttention/)
})

test("Cloud admission serializes the global concurrency check across replicas", () => {
  const claim = repositorySource.slice(
    repositorySource.indexOf("async claimCloud"),
    repositorySource.indexOf("async setCloudExecution"),
  )
  assert.match(claim, /inArray\(AutomationRunTable\.status, \["claimed", "running"\]\)/)
  assert.match(claim, /active\.length >= input\.maxConcurrency/)
  assert.match(claim, /for\("update"\)/)
  assert.match(claim, /isolationLevel: "serializable"/)
})

test("manual runs allow inactive Automations without reopening scheduled dispatch", () => {
  const claim = repositorySource.slice(
    repositorySource.indexOf("async claim(input"),
    repositorySource.indexOf("async recordSkippedManual"),
  )
  assert.match(claim, /input\.trigger === "manual"[\s\S]*currentState === "active" \|\| currentState === "inactive"/)
  assert.match(claim, /: currentState === "active"/)
})

test("runner protocol endpoints carry no operation id and stay out of the MCP catalog", () => {
  for (const path of [
    "/v1/automation-runners/events",
    "/v1/automation-runner/work",
    "/v1/automation-runs/:id/claim",
    "/v1/automation-runs/:id/heartbeat",
  ]) {
    assert.equal(isMcpOperationAllowed({ method: "POST", path, operation: { tags: ["Automations"] } }), false)
  }
  assert.equal(isMcpOperationAllowed({
    method: "GET",
    path: "/v1/automations",
    operation: { operationId: "listAutomations", tags: ["Automations"], "x-mcp": true },
  }), true, "Automation management operations remain available to MCP")
})

test("agents can create only Cloud Automations, never Desktop Automations", () => {
  assert.equal(isMcpOperationAllowed({
    method: "POST",
    path: "/v1/automations",
    operation: { operationId: "createAutomation", tags: ["Automations"], "x-mcp": false },
  }), false)
  assert.equal(isMcpOperationAllowed({
    method: "POST",
    path: "/v1/cloud-automations",
    operation: { operationId: "createCloudAutomation", tags: ["Automations"], "x-mcp": true },
  }), true)

  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  assert.match(routesSource, /operationId: "createAutomation", "x-mcp": false/)
  assert.match(routesSource, /operationId: "createCloudAutomation", "x-mcp": true/)
  assert.match(routesSource, /jsonValidator\(createCloudAutomationSchema\)/)
})
