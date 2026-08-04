import { randomUUID } from "node:crypto"
import type {
  AutomationDesktopRunnerResult,
  AutomationDesktopRunnerRegistration,
  AutomationRunEventType,
  AutomationRun,
  CreateAutomation,
  UpdateAutomation,
} from "@openwork/types/automations"
import { env } from "../env.js"
import { isActiveAutomationOwner, resolveAutomationModelAccess } from "./authority.js"
import { automationRepository } from "./repository.js"

const schedulerOwner = `den:${process.pid}:${randomUUID()}`

type OwnerScope = { organizationId: string; ownerMemberId: string }
export type DesktopRunnerScope = OwnerScope & { runnerId: string }

const desktopLeaseOwner = (scope: DesktopRunnerScope) => `desktop:${scope.ownerMemberId}:${scope.runnerId}`

export class AutomationService {
  async list(scope: OwnerScope, input: { cursor?: string; limit?: number }) {
    return automationRepository.list({ ...scope, cursor: input.cursor, limit: input.limit ?? 50 })
  }

  async get(scope: OwnerScope, automationId: string) {
    return automationRepository.get({ ...scope, automationId })
  }

  async create(scope: OwnerScope, definition: CreateAutomation) {
    await this.requireModel(scope, definition.model)
    return automationRepository.create({ ...scope, definition, now: Date.now() })
  }

  async update(scope: OwnerScope, automationId: string, changes: UpdateAutomation) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    await this.requireModel(scope, changes.model ?? current.revision.model)
    return automationRepository.update({ ...scope, automationId, changes, now: Date.now() })
  }

  async activate(scope: OwnerScope, automationId: string) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    await this.requireModel(scope, current.revision.model)
    return automationRepository.setState({ ...scope, automationId, state: "active", now: Date.now() })
  }

  deactivate(scope: OwnerScope, automationId: string) {
    return automationRepository.setState({ ...scope, automationId, state: "inactive", now: Date.now() })
  }

  archive(scope: OwnerScope, automationId: string) {
    return automationRepository.setState({ ...scope, automationId, state: "archived", now: Date.now() })
  }

  async runNow(scope: OwnerScope, automationId: string): Promise<AutomationRun | null> {
    const current = await this.get(scope, automationId)
    if (!current || current.automation.state === "archived") return null
    // The persisted model selection is only as good as the owner's current
    // access; a revoked grant must fail the manual run, not dispatch it.
    await this.requireModel(scope, current.revision.model)
    const claim = await automationRepository.claim({
      automation: { ...current.automation, state: "active" },
      revision: current.revision,
      trigger: "manual",
      scheduledFor: null,
      nonce: randomUUID(),
      leaseOwner: schedulerOwner,
      leaseMs: env.automations.leaseMs,
      claimDeadlineMs: env.automations.runnerClaimDeadlineMs,
      now: Date.now(),
    })
    return claim.run
  }

  listRuns(scope: OwnerScope, automationId: string, input: { cursor?: string; limit?: number }) {
    return automationRepository.listRuns({ ...scope, automationId, cursor: input.cursor, limit: input.limit ?? 50 })
  }

  getRun(scope: OwnerScope, runId: string) {
    return automationRepository.getRunReceipt({ ...scope, runId })
  }

  async cancelRun(scope: OwnerScope, runId: string): Promise<AutomationRun | null> {
    return automationRepository.requestCancellation({ ...scope, runId, now: Date.now() })
  }

  async tick(input: { now?: number; batchSize?: number } = {}): Promise<string[]> {
    const now = input.now ?? Date.now()
    const started: string[] = []
    await automationRepository.recoverExpiredLeases({ now, limit: input.batchSize ?? env.automations.batchSize })
    await automationRepository.expireUnclaimedDesktop({ now, limit: input.batchSize ?? env.automations.batchSize })

    const due = await automationRepository.listDue({ now, limit: input.batchSize ?? env.automations.batchSize })
    for (const item of due) {
      const scheduledFor = item.automation.nextDueAt
      if (scheduledFor === null) continue
      // Revalidate the owner's model access at dispatch time. The occurrence is
      // still claimed either way so the schedule advances durably; a failed
      // check becomes a skipped receipt instead of work for the runner.
      const access = await resolveAutomationModelAccess({
        organizationId: item.automation.organizationId,
        ownerMemberId: item.automation.ownerMemberId,
        ...item.revision.model,
      })
      const claim = await automationRepository.claim({
        automation: item.automation,
        revision: item.revision,
        trigger: "scheduled",
        scheduledFor,
        leaseOwner: schedulerOwner,
        leaseMs: env.automations.leaseMs,
        claimDeadlineMs: env.automations.runnerClaimDeadlineMs,
        now,
      })
      if (claim.kind !== "claimed") continue
      if (!access.ok) {
        await automationRepository.skipRun({ runId: claim.run.id, code: access.code, message: access.message, now })
        continue
      }
      started.push(claim.run.id)
    }
    return started
  }

  async stop(): Promise<void> {}

  registerDesktopRunner(scope: OwnerScope, registration: AutomationDesktopRunnerRegistration) {
    return automationRepository.registerDesktopRunner({ ...scope, ...registration, now: Date.now() })
  }

  /** Runner tokens are revoked in effect the moment the owner leaves the org. */
  isActiveRunnerOwner(scope: OwnerScope) {
    return isActiveAutomationOwner(scope)
  }

  touchDesktopRunner(scope: DesktopRunnerScope) {
    return automationRepository.touchDesktopRunner({ ...scope, now: Date.now() })
  }

  async discoverDesktopRunnerWork(scope: DesktopRunnerScope) {
    await this.touchDesktopRunner(scope)
    return automationRepository.discoverDesktopWork({ ...scope, now: Date.now(), limit: 4 })
  }

  async claimDesktopRunner(scope: DesktopRunnerScope, runId: string) {
    const claimed = await automationRepository.claimDesktop({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      leaseOwner: desktopLeaseOwner(scope),
      runId,
      leaseMs: env.automations.leaseMs,
      now: Date.now(),
    })
    if (!claimed?.run.leaseExpiresAt) return null
    // Last gate before the assignment leaves Den: access revoked after the run
    // was queued must not reach the runner with the stale model selection.
    const access = await resolveAutomationModelAccess({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      ...claimed.revision.model,
    })
    if (!access.ok) {
      await automationRepository.skipRun({
        runId: claimed.run.id,
        code: access.code,
        message: access.message,
        now: Date.now(),
      })
      return null
    }
    return {
      executionTarget: "desktop" as const,
      runId: claimed.run.id,
      automationId: claimed.automation.id,
      automationName: claimed.automation.name,
      instructions: claimed.revision.instructions,
      model: claimed.revision.model,
      timeoutMs: claimed.revision.maximumRuntimeMs,
      leaseExpiresAt: claimed.run.leaseExpiresAt,
      attempt: claimed.run.attemptCount,
    }
  }

  heartbeatDesktopRunner(scope: DesktopRunnerScope, runId: string, attempt: number) {
    return automationRepository.heartbeatDesktop({
      runId,
      leaseOwner: desktopLeaseOwner(scope),
      attempt,
      leaseMs: env.automations.leaseMs,
      now: Date.now(),
    })
  }

  appendDesktopRunnerEvent(scope: DesktopRunnerScope, runId: string, event: {
    sequence: number
    attempt: number
    type: AutomationRunEventType
    payload: Record<string, unknown>
  }) {
    return automationRepository.appendDesktopEvent({
      runId,
      leaseOwner: desktopLeaseOwner(scope),
      sequence: event.sequence,
      attempt: event.attempt,
      type: event.type,
      payload: event.payload,
      now: Date.now(),
    })
  }

  completeDesktopRunner(scope: DesktopRunnerScope, runId: string, result: AutomationDesktopRunnerResult) {
    return automationRepository.complete({
      runId,
      leaseOwner: desktopLeaseOwner(scope),
      status: result.status,
      resultSummary: result.resultSummary,
      usage: result.usage,
      error: result.error,
      attempt: result.attempt,
      now: Date.now(),
    })
  }

  runnerNotifications(scope: DesktopRunnerScope, after: number) {
    return automationRepository.listRunnerNotifications({ ...scope, after, limit: 100 })
  }

  private async requireModel(scope: OwnerScope, model: { providerId: string; modelId: string }) {
    const result = await resolveAutomationModelAccess({ ...scope, ...model })
    if (!result.ok) {
      const error = new Error(result.message)
      error.name = result.code
      throw error
    }
  }

}

export const automationService = new AutomationService()
