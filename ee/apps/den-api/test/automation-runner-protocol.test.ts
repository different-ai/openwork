import assert from "node:assert/strict"
import test from "node:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AutomationRevisionTable,
  AutomationRunnerNotificationTable,
  AutomationRunnerTable,
  AutomationRunEventTable,
  AutomationRunTable,
  AutomationTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AUTOMATION_MIN_CLAIM_WINDOW_MS } from "@openwork/automations"
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
const serviceSource = readFileSync(join(import.meta.dir, "../src/automations/service.ts"), "utf8")

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

test("desktop occurrences stay claimable through the recovery window with named missed causes", () => {
  const claim = repositorySource.slice(
    repositorySource.indexOf("async claim("),
    repositorySource.indexOf("async recordSkippedManual"),
  )
  const expire = repositorySource.slice(
    repositorySource.indexOf("async expireUnclaimedDesktop"),
    repositorySource.indexOf("async getRunReceipt"),
  )
  // The recovery window is one policy in @openwork/automations: the claim path
  // clamps it against the occurrence's own next due time, and the expiry path
  // records the cause an operator can act on instead of one generic wording.
  assert.match(claim, /desktopClaimDeadline\(\{[\s\S]*nextDueAt,[\s\S]*\}\)/)
  assert.match(expire, /missedDesktopReason\(/)
  assert.match(expire, /code: "runner_unavailable"/)
})

test("desktop recovery deadlines hold, expire with exact causes, and never invoke a provider", async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DB_MODE ??= "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "runner-recovery-test-encryption-key-123456789"
  process.env.BETTER_AUTH_SECRET ??= "runner-recovery-test-secret-1234567890123"
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS = "1000"

  const [{ db }, { env }, { DenAutomationRepository }] = await Promise.all([
    import("../src/db.js"),
    import("../src/env.js"),
    import("../src/automations/repository.js"),
  ])
  const repository = new DenAutomationRepository()
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const runnerId = "recovery-window-runner"
  const automationIds: string[] = []
  const runIds: string[] = []
  const realFetch = globalThis.fetch
  let providerCompletionCalls = 0
  globalThis.fetch = async () => {
    providerCompletionCalls += 1
    return new Response(null, { status: 503 })
  }

  const cleanup = async () => {
    await db.delete(AutomationRunnerNotificationTable)
      .where(eq(AutomationRunnerNotificationTable.organization_id, organizationId))
    if (runIds.length > 0) {
      await db.delete(AutomationRunEventTable).where(inArray(AutomationRunEventTable.run_id, runIds))
      await db.delete(AutomationRunTable).where(inArray(AutomationRunTable.id, runIds))
    }
    if (automationIds.length > 0) {
      await db.delete(AutomationRevisionTable).where(inArray(AutomationRevisionTable.automation_id, automationIds))
      await db.delete(AutomationTable).where(inArray(AutomationTable.id, automationIds))
    }
    await db.delete(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, runnerId))
    await db.delete(MemberTable).where(eq(MemberTable.id, memberId))
    await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
    await db.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
  }

  try {
    assert.equal(env.automations.runnerClaimDeadlineMs, 1_000)
    await db.insert(AuthUserTable).values({
      id: userId,
      name: "Runner Recovery User",
      email: `${userId}@runner-recovery.test`,
      emailVerified: true,
    })
    await db.insert(OrganizationTable).values({
      id: organizationId,
      name: "Runner Recovery Test",
      slug: `runner-recovery-${organizationId}`,
    })
    await db.insert(MemberTable).values({ id: memberId, organizationId, userId, role: "member" })

    const createAutomation = async (name: string, now: number, dueAt = now) => {
      const item = await repository.create({
        organizationId,
        ownerMemberId: memberId,
        definition: {
          name,
          instructions: `Run ${name}`,
          schedule: { kind: "once", timezone: "UTC", at: dueAt },
          model: { providerId: "opencode", modelId: "big-pickle", variant: null },
        },
        now,
      })
      automationIds.push(item.automation.id)
      return item
    }
    const queueScheduled = async (name: string, now: number) => {
      const item = await createAutomation(name, now - 1, now)
      const queued = await repository.claim({
        automation: item.automation,
        revision: item.revision,
        trigger: "scheduled",
        scheduledFor: now,
        leaseOwner: "scheduler:test",
        leaseMs: 60_000,
        claimDeadlineMs: env.automations.runnerClaimDeadlineMs,
        now,
      })
      assert.equal(queued.kind, "claimed")
      runIds.push(queued.run.id)
      return { item, run: queued.run }
    }
    const receipt = async (runId: string) => {
      const value = await repository.getRunReceipt({ organizationId, ownerMemberId: memberId, runId })
      assert.ok(value)
      return value.run
    }
    const error = async (runId: string) => (await receipt(runId)).error

    const start = Date.UTC(2026, 7, 18, 12)
    const never = await queueScheduled("Never connected", start)
    assert.deepEqual(await repository.expireUnclaimedDesktop({
      now: start + env.automations.runnerClaimDeadlineMs - 1,
      limit: 10,
    }), [])
    assert.equal((await receipt(never.run.id)).status, "queued")
    assert.deepEqual(await repository.expireUnclaimedDesktop({
      now: start + env.automations.runnerClaimDeadlineMs,
      limit: 10,
    }), [never.run.id])
    assert.deepEqual(await error(never.run.id), {
      code: "runner_unavailable",
      message: "Missed — no desktop was connected.",
      retryable: false,
    })

    const recoveryAt = start + 10_000
    const recovered = await queueScheduled("Recovered once", recoveryAt)
    assert.deepEqual(await repository.expireUnclaimedDesktop({
      now: recoveryAt + env.automations.runnerClaimDeadlineMs - 1,
      limit: 10,
    }), [])
    await repository.registerDesktopRunner({
      organizationId,
      ownerMemberId: memberId,
      runnerId,
      protocolVersion: 1,
      supportedExecutionTargets: ["desktop"],
      capabilities: [],
      appVersion: "test",
      platform: "darwin",
      concurrency: 1,
      now: recoveryAt + env.automations.runnerClaimDeadlineMs - 1,
    })
    const work = await repository.discoverDesktopWork({
      organizationId,
      ownerMemberId: memberId,
      now: recoveryAt + env.automations.runnerClaimDeadlineMs - 1,
      limit: 4,
    })
    assert.deepEqual(work, [{ runId: recovered.run.id, executionTarget: "desktop" }])
    const leaseOwner = `desktop:${memberId}:${runnerId}`
    const claimed = await repository.claimDesktop({
      organizationId,
      ownerMemberId: memberId,
      leaseOwner,
      leaseMs: 60_000,
      runId: recovered.run.id,
      now: recoveryAt + env.automations.runnerClaimDeadlineMs - 1,
    })
    assert.equal(claimed?.run.attemptCount, 1)
    await repository.complete({
      runId: recovered.run.id,
      leaseOwner,
      status: "succeeded",
      resultSummary: "Recovered after the desktop returned.",
      usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
      error: null,
      attempt: 1,
      now: recoveryAt + env.automations.runnerClaimDeadlineMs,
    })
    assert.equal((await receipt(recovered.run.id)).attemptCount, 1)
    assert.equal(await repository.claimDesktop({
      organizationId,
      ownerMemberId: memberId,
      leaseOwner,
      leaseMs: 60_000,
      runId: recovered.run.id,
      now: recoveryAt + env.automations.runnerClaimDeadlineMs + 1,
    }), null)

    const silentAt = start + 20_000
    const silent = await queueScheduled("Silent desktop", silentAt)
    await repository.expireUnclaimedDesktop({
      now: silentAt + env.automations.runnerClaimDeadlineMs,
      limit: 10,
    })
    assert.deepEqual(await error(silent.run.id), {
      code: "runner_unavailable",
      message: "Missed — the connected desktop did not pick this up in time.",
      retryable: false,
    })

    const busyAt = start + 30_000
    await repository.touchDesktopRunner({ organizationId, ownerMemberId: memberId, runnerId, now: busyAt })
    const holder = await queueScheduled("Busy holder", busyAt)
    const holderClaim = await repository.claimDesktop({
      organizationId,
      ownerMemberId: memberId,
      leaseOwner,
      leaseMs: 60_000,
      runId: holder.run.id,
      now: busyAt + 100,
    })
    assert.equal(holderClaim?.run.attemptCount, 1)
    const busy = await queueScheduled("Busy victim", busyAt)
    await repository.expireUnclaimedDesktop({
      now: busyAt + env.automations.runnerClaimDeadlineMs,
      limit: 10,
    })
    assert.deepEqual(await error(busy.run.id), {
      code: "runner_unavailable",
      message: "Missed — the desktop was busy with another Automation run.",
      retryable: false,
    })
    await repository.complete({
      runId: holder.run.id,
      leaseOwner,
      status: "succeeded",
      resultSummary: "Busy holder released.",
      usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
      error: null,
      attempt: 1,
      now: busyAt + env.automations.runnerClaimDeadlineMs + 1,
    })

    const manualAt = start + 40_000
    const manualItem = await createAutomation("Manual floor", manualAt, manualAt + 24 * 60 * 60_000)
    const manual = await repository.claim({
      automation: manualItem.automation,
      revision: manualItem.revision,
      trigger: "manual",
      scheduledFor: null,
      nonce: "manual-floor",
      leaseOwner: "scheduler:test",
      leaseMs: 1_000,
      claimDeadlineMs: AUTOMATION_MIN_CLAIM_WINDOW_MS,
      now: manualAt,
    })
    assert.equal(manual.kind, "claimed")
    runIds.push(manual.run.id)
    assert.deepEqual(await repository.expireUnclaimedDesktop({
      now: manualAt + AUTOMATION_MIN_CLAIM_WINDOW_MS - 1,
      limit: 10,
    }), [])
    assert.equal((await receipt(manual.run.id)).status, "queued")
    assert.deepEqual(await repository.expireUnclaimedDesktop({
      now: manualAt + AUTOMATION_MIN_CLAIM_WINDOW_MS,
      limit: 10,
    }), [manual.run.id])
    assert.equal(providerCompletionCalls, 0)
  } finally {
    globalThis.fetch = realFetch
    await cleanup()
  }
})

test("runner presence is a read-only view of existing liveness data", () => {
  const presence = serviceSource.slice(
    serviceSource.indexOf("async desktopRunnerPresence"),
    serviceSource.indexOf("async discoverDesktopRunnerWork"),
  )
  const reader = repositorySource.slice(
    repositorySource.indexOf("async desktopRunnerLastSeenAt"),
    repositorySource.indexOf("private async missedDesktopReason"),
  )
  // Presence answers from the liveness the work poll already records; adding
  // writes here would reintroduce the idle database traffic the bounded work
  // poll was introduced to remove.
  assert.match(presence, /desktopRunnerLastSeenAt/)
  assert.doesNotMatch(presence, /update|insert|touchDesktopRunner/i)
  assert.match(reader, /db\.select\(/)
  assert.doesNotMatch(reader, /db\.(update|insert)/)
})

test("Desktop completion durably exposes its native local thread", () => {
  const completion = serviceSource.slice(
    serviceSource.indexOf("async completeDesktopRunner"),
    serviceSource.indexOf("runnerNotifications"),
  )
  const mapRun = repositorySource.slice(
    repositorySource.indexOf("function mapRun"),
    repositorySource.indexOf("function normalizedDefinition"),
  )
  const persist = repositorySource.slice(
    repositorySource.indexOf("async complete(input"),
    repositorySource.indexOf("async recoverExpiredLeases"),
  )

  assert.match(completion, /engineReceipt:[\s\S]*nativeThreadId: result\.sessionId[\s\S]*workspaceId: result\.workspaceId/)
  assert.match(persist, /engine_receipt: input\.engineReceipt/)
  assert.match(mapRun, /receipt\?\.nativeThreadId[\s\S]*receipt\?\.workspaceId/)
  assert.doesNotMatch(mapRun, /row\.execution_target === "cloud"/)
})

test("expired lease recovery cannot clobber a concurrently renewed lease", () => {
  const recovery = repositorySource.slice(
    repositorySource.indexOf("async recoverExpiredLeases"),
    repositorySource.indexOf("async requestCancellation"),
  )
  assert.match(recovery, /where\(and\([\s\S]*eq\(AutomationRunTable\.id, run\.id\)[\s\S]*eq\(AutomationRunTable\.lease_owner, run\.lease_owner\)[\s\S]*lt\(AutomationRunTable\.lease_expires_at, new Date\(input\.now\)\)/)
  assert.match(recovery, /engine_sequence:\s*retry \? 0 : run\.engine_sequence/)
})

test("Desktop runner claims are idempotent for one owner and exclude competing runners", () => {
  const claim = repositorySource.slice(
    repositorySource.indexOf("async claimDesktop"),
    repositorySource.indexOf("async heartbeatDesktop"),
  )
  assert.match(claim, /eq\(AutomationRunTable\.lease_owner, input\.leaseOwner\)[\s\S]*inArray\(AutomationRunTable\.status, \["claimed", "running"\]\)/)
  assert.match(claim, /if \(!selected\) \{[\s\S]*eq\(AutomationRunTable\.status, "queued"\)[\s\S]*attempt_count: selected\.run\.attempt_count \+ 1/)
  assert.match(claim, /if \(!selected\) return null/)
  assert.match(claim, /run: mapRun\(currentRuns\[0\]\)/)
})

test("expired attempts reject stale completion and stop after the bounded retry", () => {
  const completion = repositorySource.slice(
    repositorySource.indexOf("async complete(input"),
    repositorySource.indexOf("async recoverExpiredLeases"),
  )
  const recovery = repositorySource.slice(
    repositorySource.indexOf("async recoverExpiredLeases"),
    repositorySource.indexOf("async requestCancellation"),
  )
  const routesSource = readFileSync(join(import.meta.dir, "../src/routes/automations/index.ts"), "utf8")
  assert.match(completion, /eq\(AutomationRunTable\.attempt_count, input\.attempt\)/)
  assert.match(completion, /current\.lease_expires_at\.getTime\(\) <= input\.now[\s\S]*automation_run_complete_lease_lost/)
  assert.match(routesSource, /automation_run_complete_lease_lost[\s\S]*runner_lease_lost[\s\S]*409/)
  assert.match(recovery, /run\.attempt_count < AUTOMATION_MAXIMUM_ATTEMPTS/)
  assert.match(recovery, /status: retry \? "queued" : "failed"/)
  assert.match(recovery, /code: "lease_lost"[\s\S]*retryable: false/)
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
  assert.match(routesSource, /automation_runner_identity_conflict/)
  assert.match(routesSource, /await service\.registerDesktopRunner\(scope\(c\), registration\)[\s\S]*const mapped = failure\(error\)/)
})

test("runner registration upsert failures include non-secret diagnostics", () => {
  const registration = repositorySource.slice(
    repositorySource.indexOf("async registerDesktopRunner"),
    repositorySource.indexOf("async touchDesktopRunner"),
  )
  assert.match(registration, /logger\.error\("automation runner registration upsert failed"/)
  assert.match(registration, /runner_id_prefix/)
  assert.match(registration, /runner_id_length/)
  assert.doesNotMatch(registration, /token/)
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

test("work polling tolerates non-critical runner presence touch failures", () => {
  const discover = serviceSource.slice(
    serviceSource.indexOf("async discoverDesktopRunnerWork"),
    serviceSource.indexOf("async claimDesktopRunner"),
  )

  assert.match(discover, /try \{\s*await this\.touchDesktopRunner\(scope\)/)
  assert.match(discover, /catch \(error\) \{[\s\S]*logger\.warn\("automation desktop runner touch failed"/)
  assert.match(discover, /return automationRepository\.discoverDesktopWork/)
})

test("Automation list and scheduler reads batch revision and latest-run loading", () => {
  const batch = repositorySource.slice(
    repositorySource.indexOf("async function itemsFromRows"),
    repositorySource.indexOf("export class DenAutomationRepository"),
  )
  const list = repositorySource.slice(
    repositorySource.indexOf("async list(input"),
    repositorySource.indexOf("async get(input"),
  )
  const listDue = repositorySource.slice(
    repositorySource.indexOf("async listDue"),
    repositorySource.indexOf("async claim(input"),
  )
  const serviceList = serviceSource.slice(
    serviceSource.indexOf("async list(scope"),
    serviceSource.indexOf("async get(scope"),
  )

  assert.match(batch, /inArray\([\s\S]*AutomationRevisionTable\.id/)
  assert.match(batch, /where\(or\(\.\.\.latestRunConditions\)\)/)
  assert.match(list, /items: await itemsFromRows\(selected\)/)
  assert.doesNotMatch(list, /selected\.map\(async/)
  assert.match(listDue, /return itemsFromRows\(rows\)/)
  assert.doesNotMatch(listDue, /rows\.map\(async/)
  assert.match(serviceList, /modelAccessBySelection/)
  assert.match(serviceList, /modelAccessBySelection\.set\(key, access\)/)
  assert.match(serviceList, /offset \+= AUTOMATION_LIST_AUTHORITY_BATCH_SIZE/)
  assert.match(serviceList, /slice\(offset, offset \+ AUTOMATION_LIST_AUTHORITY_BATCH_SIZE\)/)
})

test("Cloud heartbeat monitor failures stay inside the execution task", () => {
  const execution = serviceSource.slice(
    serviceSource.indexOf("private async executeCloudAgentRun"),
    serviceSource.indexOf("export const automationService"),
  )

  assert.match(execution, /void monitor\(\)\.catch\(\(error\) =>/)
  assert.match(execution, /Cloud Automation heartbeat monitor failed/)
  assert.match(execution, /controller\.abort\(error\)/)
  assert.match(execution, /interval\.unref\(\)/)
  assert.match(execution, /finally \{\s*clearInterval\(interval\)/)
})

test("every dispatch path revalidates the owner's model access", () => {
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
  assert.match(executorSource, /currentAgentAuthority[\s\S]*getOpenWorkWebRuntimeAccess\(input\.organizationId\)/)
  assert.match(execution, /currentAgentAuthority\(input\)[\s\S]*resolveCloudAgentReadyWorker/)
  assert.match(execution, /currentAgentAuthority\(input\)[\s\S]*createThread/)
  assert.match(execution, /currentAgentAuthority\(input\)[\s\S]*abortAndObserve\(client, nativeThreadId\)[\s\S]*sendTurn/)
  assert.match(serviceSource, /"owner_membership_lost",[\s\S]*markNeedsAttention/)
})

test("Cloud placement never inherits the legacy Desktop model exception", () => {
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
