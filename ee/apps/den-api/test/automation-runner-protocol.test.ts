import assert from "node:assert/strict"
import test from "node:test"
import {
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
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse(registration).success, true)
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

test("retried runner events remain ordered within their claimed attempt", () => {
  assert.match(repositorySource, /desktop:\$\{input\.runId\}:\$\{input\.attempt\}:\$\{input\.sequence\}/)
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

test("manual runs use durable runner presence across Den API replicas", () => {
  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  const serviceSource = readFileSync(join(import.meta.dir, "../src/automations/service.ts"), "utf8")
  const repositorySource = readFileSync(join(import.meta.dir, "../src/automations/repository.ts"), "utf8")
  const runnerAuthSource = readFileSync(join(import.meta.dir, "../src/automations/runner-auth.ts"), "utf8")

  assert.match(routesSource, /await service\.hasOnlineDesktopRunner\(owner\)/)
  assert.doesNotMatch(routesSource, /automationRunnerAuth\.hasConnected/)
  assert.doesNotMatch(runnerAuthSource, /connections = new Map/)
  assert.match(serviceSource, /DESKTOP_RUNNER_ONLINE_WINDOW_MS = 45_000/)
  assert.match(serviceSource, /automationRepository\.hasRecentDesktopRunner\(/)
  assert.match(repositorySource, /gt\(AutomationRunnerTable\.last_seen_at, new Date\(input\.seenAfter\)\)/)
})

test("every dispatch path revalidates the owner's model access", () => {
  const serviceSource = readFileSync(join(import.meta.dir, "../src/automations/service.ts"), "utf8")
  const tick = serviceSource.slice(serviceSource.indexOf("async tick"), serviceSource.indexOf("async stop"))
  assert.match(tick, /resolveAutomationModelAccess\(\{\s*organizationId: item\.automation\.organizationId/)
  assert.match(tick, /if \(!access\.ok\) \{\s*await automationRepository\.skipRun\(/)
  const claim = serviceSource.slice(
    serviceSource.indexOf("async claimDesktopRunner"),
    serviceSource.indexOf("heartbeatDesktopRunner"),
  )
  assert.match(claim, /resolveAutomationModelAccess\(\{\s*organizationId: scope\.organizationId/)
  assert.match(claim, /if \(!access\.ok\) \{[\s\S]*skipRun\([\s\S]*return null/)
  const runNow = serviceSource.slice(serviceSource.indexOf("async runNow"), serviceSource.indexOf("listRuns"))
  assert.match(runNow, /await this\.requireModel\(scope, current\.revision\.model\)/)
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
