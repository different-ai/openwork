import { randomUUID } from "node:crypto"
import type { AutomationClaimResult, AutomationListItem } from "@openwork/automations"
import type {
  AutomationDesktopRunnerCapability,
  AutomationDesktopRunnerResult,
  AutomationDesktopRunnerRegistration,
  AutomationRunEventType,
  AutomationRun,
  AutomationAction,
  CreateAutomationDefinition,
  UpdateAutomation,
} from "@openwork/types/automations"
import { env } from "../env.js"
import { isActiveAutomationOwner, resolveAutomationModelAccess } from "./authority.js"
import { shouldApplyAutomationModelAccessFailure } from "./model-attention-rollout.js"
import { automationRepository } from "./repository.js"
import { validateSavedScriptAutomationAction } from "../codemode-scripts.js"
import type { CloudAgentExecution, CloudAgentExecutorInput } from "./cloud-agent-executor.js"
import { appLogger } from "../observability/logger.js"

const schedulerOwner = `den:${process.pid}:${randomUUID()}`

type OwnerScope = {
  organizationId: string
  ownerMemberId: string
  modelAttentionCapable?: boolean
}
export type DesktopRunnerScope = OwnerScope & {
  runnerId: string
  capabilities?: readonly AutomationDesktopRunnerCapability[]
}

const desktopLeaseOwner = (scope: DesktopRunnerScope) => `desktop:${scope.ownerMemberId}:${scope.runnerId}`

type ModelSelection = { providerId: string; modelId: string; variant?: string | null }

function sameModel(left: ModelSelection, right: ModelSelection) {
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && (left.variant ?? null) === (right.variant ?? null)
}

function supportsModelAttention(scope: OwnerScope | DesktopRunnerScope) {
  return scope.modelAttentionCapable === true
    || ("capabilities" in scope && scope.capabilities?.includes("model_attention_v1") === true)
}

export type CloudSavedScriptExecution =
  | { ok: true; value: unknown; canonicalResult: string; receiptId: string }
  | { ok: false; message: string; retryable: boolean; receiptId?: string | null }

export type CloudSavedScriptExecutor = (input: {
  organizationId: string
  ownerMemberId: string
  automationRunId: string
  action: Extract<AutomationAction, { kind: "saved_script" }>
}) => Promise<CloudSavedScriptExecution>

let cloudSavedScriptExecutor: CloudSavedScriptExecutor | null = null
let cloudAgentExecutor: ((input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>) | null = null
let cloudAgentRuntimeAvailable: ((scope: OwnerScope) => Promise<boolean>) | null = null

export function configureCloudSavedScriptExecutor(executor: CloudSavedScriptExecutor): void {
  cloudSavedScriptExecutor = executor
}

export function configureCloudAgentExecutor(input: {
  execute: (input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>
  runtimeAvailable: (scope: OwnerScope) => Promise<boolean>
}): void {
  cloudAgentExecutor = input.execute
  cloudAgentRuntimeAvailable = input.runtimeAvailable
}

export class AutomationService {
  private readonly cloudExecutions = new Map<string, Promise<void>>()

  async list(scope: OwnerScope, input: { cursor?: string; limit?: number }) {
    const page = await automationRepository.list({ ...scope, cursor: input.cursor, limit: input.limit ?? 50 })
    return {
      ...page,
      items: await Promise.all(page.items.map((item) => this.reconcileModelAttention(item, scope))),
    }
  }

  async get(scope: OwnerScope, automationId: string) {
    const item = await automationRepository.get({ ...scope, automationId })
    return item ? this.reconcileModelAttention(item, scope) : null
  }

  async create(scope: OwnerScope, definition: CreateAutomationDefinition) {
    if ("action" in definition) {
      if (definition.executionTarget !== "cloud") {
        throw new Error("automation_action_target_mismatch")
      }
      if (definition.action.kind === "agent") {
        // Action-based creation is Cloud placement. The legacy Zen exception
        // exists only for already-published Desktop clients.
        await this.requireNewModel({ ...scope, modelAttentionCapable: true }, definition.action.model)
      }
      else {
        if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
        await validateSavedScriptAutomationAction({ ...scope, action: definition.action })
      }
      if (definition.action.kind === "agent" && (!cloudAgentRuntimeAvailable || !await cloudAgentRuntimeAvailable(scope))) {
        throw new Error("automation_cloud_worker_required")
      }
    } else {
      await this.requireNewModel(scope, definition.model)
    }
    const created = await automationRepository.create({ ...scope, definition, now: Date.now() })
    return this.reconcileModelAttention(created, scope)
  }

  async update(scope: OwnerScope, automationId: string, changes: UpdateAutomation) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    if (changes.executionTarget !== undefined
      && changes.executionTarget !== (current.revision.executionTarget ?? "desktop")) {
      throw new Error("automation_action_target_mismatch")
    }
    const nextAction = changes.action ?? current.revision.action
    if ((current.revision.executionTarget ?? "desktop") === "desktop" && nextAction?.kind === "saved_script") {
      throw new Error("automation_action_target_mismatch")
    }
    if (nextAction?.kind === "saved_script") {
      await validateSavedScriptAutomationAction({ ...scope, action: nextAction })
    } else if (nextAction?.kind === "agent") {
      if ((current.revision.executionTarget ?? "desktop") === "cloud"
        && (!cloudAgentRuntimeAvailable || !await cloudAgentRuntimeAvailable(scope))) {
        throw new Error("automation_cloud_worker_required")
      }
      const requestedModel = changes.action?.kind === "agent"
        ? changes.action.model
        : changes.model ?? nextAction.model
      if (!sameModel(requestedModel, current.revision.model)) {
        await this.requireNewModel(
          (current.revision.executionTarget ?? "desktop") === "cloud"
            ? { ...scope, modelAttentionCapable: true }
            : scope,
          requestedModel,
        )
      }
    }
    const updated = await automationRepository.update({ ...scope, automationId, changes, now: Date.now() })
    return this.reconcileModelAttention(updated, scope)
  }

  async activate(scope: OwnerScope, automationId: string) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    if (current.revision.action?.kind === "saved_script") {
      if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
    } else {
      if ((current.revision.executionTarget ?? "desktop") === "cloud"
        && (!cloudAgentRuntimeAvailable || !await cloudAgentRuntimeAvailable(scope))) {
        throw new Error("automation_cloud_worker_required")
      }
      await this.requireNewModel(
        (current.revision.executionTarget ?? "desktop") === "cloud"
          ? { ...scope, modelAttentionCapable: true }
          : scope,
        current.revision.model,
      )
    }
    const activated = await automationRepository.setState({ ...scope, automationId, state: "active", now: Date.now() })
    return activated ? this.reconcileModelAttention(activated, scope) : null
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
    let blocked = current.automation.needsAttentionReason
    if (current.revision.action?.kind === "saved_script") {
      if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
    } else if (!blocked) {
      const access = await resolveAutomationModelAccess({ ...scope, ...current.revision.model })
      if (!access.ok && shouldApplyAutomationModelAccessFailure({
        model: current.revision.model,
        failure: access,
        modelAttentionCapable: (current.revision.executionTarget ?? "desktop") === "cloud"
          || supportsModelAttention(scope),
      })) blocked = { code: access.code, message: access.message, occurredAt: Date.now() }
    }
    if (blocked) {
      const now = Date.now()
      await automationRepository.markNeedsAttention({
        automationId: current.automation.id,
        expectedRevisionId: current.revision.id,
        reason: { ...blocked, occurredAt: now },
        now,
      })
      return automationRepository.recordSkippedManual({
        ...scope,
        automation: current.automation,
        revision: current.revision,
        nonce: randomUUID(),
        code: blocked.code,
        message: blocked.message,
        now,
      })
    }
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
    if (claim.kind === "claimed" && claim.run.executionTarget === "cloud") {
      this.startCloudRun(claim.run.id)
    }
    return (await automationRepository.getRunReceipt({ ...scope, runId: claim.run.id }))?.run ?? claim.run
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

    const queuedCloud = await automationRepository.listQueuedCloud({ limit: input.batchSize ?? env.automations.batchSize })
    for (const runId of queuedCloud) {
      if (this.startCloudRun(runId)) started.push(runId)
    }

    const due = await automationRepository.listDue({ now, limit: input.batchSize ?? env.automations.batchSize })
    for (const item of due) {
      const scheduledFor = item.automation.nextDueAt
      if (scheduledFor === null) continue
      // Revalidate the owner's model access at dispatch time. The occurrence is
      // still claimed either way so the schedule advances durably; a failed
      // check becomes a skipped receipt instead of work for the runner.
      const access = item.revision.action?.kind === "saved_script"
        ? (await isActiveAutomationOwner(item.automation)
            ? { ok: true as const }
            : { ok: false as const, code: "owner_membership_lost" as const, message: "The Automation owner is no longer active." })
        : await resolveAutomationModelAccess({
            organizationId: item.automation.organizationId,
            ownerMemberId: item.automation.ownerMemberId,
            ...item.revision.model,
          })
      let claim: AutomationClaimResult
      try {
        claim = await automationRepository.claim({
          automation: item.automation,
          revision: item.revision,
          trigger: "scheduled",
          scheduledFor,
          leaseOwner: schedulerOwner,
          leaseMs: env.automations.leaseMs,
          claimDeadlineMs: env.automations.runnerClaimDeadlineMs,
          now,
        })
      } catch (error) {
        if (error instanceof Error && error.message === "automation_not_active") continue
        throw error
      }
      if (claim.kind !== "claimed") continue
      if (!access.ok && shouldApplyAutomationModelAccessFailure({
        model: item.revision.model,
        failure: access,
        // Scheduling must remain compatible until a capable desktop claims
        // the work or a capable management client reconciles the Automation.
        modelAttentionCapable: (item.revision.executionTarget ?? "desktop") === "cloud",
      })) {
        await automationRepository.skipRun({ runId: claim.run.id, code: access.code, message: access.message, now })
        await automationRepository.markNeedsAttention({
          automationId: item.automation.id,
          expectedRevisionId: item.revision.id,
          reason: { code: access.code, message: access.message, occurredAt: now },
          now,
        })
        continue
      }
      started.push(claim.run.id)
      if (claim.run.executionTarget === "cloud") this.startCloudRun(claim.run.id)
    }
    return started
  }

  async stop(): Promise<void> {
    // Cloud run leases are durable. Shutdown must not wait for a user thread's
    // full runtime; an interrupted run is recovered after its lease expires.
  }

  registerDesktopRunner(scope: OwnerScope, registration: AutomationDesktopRunnerRegistration) {
    return automationRepository.registerDesktopRunner({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      runnerId: registration.runnerId,
      protocolVersion: registration.protocolVersion,
      supportedExecutionTargets: registration.supportedExecutionTargets,
      appVersion: registration.appVersion,
      platform: registration.platform,
      concurrency: registration.concurrency,
      now: Date.now(),
    })
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
    if (!access.ok && shouldApplyAutomationModelAccessFailure({
      model: claimed.revision.model,
      failure: access,
      modelAttentionCapable: supportsModelAttention(scope),
    })) {
      const now = Date.now()
      await automationRepository.skipRun({
        runId: claimed.run.id,
        code: access.code,
        message: access.message,
        now,
      })
      await automationRepository.markNeedsAttention({
        automationId: claimed.automation.id,
        expectedRevisionId: claimed.revision.id,
        reason: { code: access.code, message: access.message, occurredAt: now },
        now,
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

  async completeDesktopRunner(scope: DesktopRunnerScope, runId: string, result: AutomationDesktopRunnerResult) {
    const now = Date.now()
    const completed = await automationRepository.complete({
      runId,
      leaseOwner: desktopLeaseOwner(scope),
      status: result.status,
      resultSummary: result.resultSummary,
      usage: result.usage,
      error: result.error,
      attempt: result.attempt,
      now,
    })
    if (result.error?.code === "model_access_lost" || result.error?.code === "provider_unavailable") {
      await automationRepository.markNeedsAttention({
        automationId: completed.automationId,
        expectedRevisionId: completed.revisionId,
        reason: {
          code: result.error.code,
          message: result.error.message,
          occurredAt: now,
        },
        now,
      })
    }
    return completed
  }

  runnerNotifications(scope: DesktopRunnerScope, after: number) {
    return automationRepository.listRunnerNotifications({ ...scope, after, limit: 100 })
  }

  /**
   * New capable clients require current authority. Published clients may
   * continue submitting the exact legacy Zen selection until they advertise
   * support for the repairable attention state.
   */
  private async requireNewModel(scope: OwnerScope, model: ModelSelection) {
    const result = await resolveAutomationModelAccess({ ...scope, ...model })
    if (!result.ok && shouldApplyAutomationModelAccessFailure({
      model,
      failure: result,
      modelAttentionCapable: supportsModelAttention(scope),
    })) {
      const error = new Error(result.message)
      error.name = result.code
      throw error
    }
  }

  private async reconcileModelAttention(item: AutomationListItem, scope: OwnerScope): Promise<AutomationListItem> {
    if (item.automation.state !== "active" || item.revision.action?.kind === "saved_script") return item
    const access = await resolveAutomationModelAccess({
      organizationId: item.automation.organizationId,
      ownerMemberId: item.automation.ownerMemberId,
      ...item.revision.model,
    })
    if (access.ok || !shouldApplyAutomationModelAccessFailure({
      model: item.revision.model,
      failure: access,
      modelAttentionCapable: (item.revision.executionTarget ?? "desktop") === "cloud"
        || supportsModelAttention(scope),
    })) return item
    const now = Date.now()
    await automationRepository.markNeedsAttention({
      automationId: item.automation.id,
      expectedRevisionId: item.revision.id,
      reason: { code: access.code, message: access.message, occurredAt: now },
      now,
    })
    return await automationRepository.get({
      organizationId: item.automation.organizationId,
      ownerMemberId: item.automation.ownerMemberId,
      automationId: item.automation.id,
    }) ?? item
  }

  private async executeCloudRun(runId: string): Promise<void> {
    const leaseOwner = `${schedulerOwner}:cloud:${runId}`
    const claimed = await automationRepository.claimCloud({
      runId,
      leaseOwner,
      leaseMs: env.automations.leaseMs,
      maxConcurrency: env.automations.maxConcurrency,
      now: Date.now(),
    })
    if (!claimed) return
    if (claimed.revision.action?.kind === "agent") {
      await this.executeCloudAgentRun(claimed, leaseOwner)
      return
    }
    if (claimed.revision.action?.kind !== "saved_script") return
    const executor = cloudSavedScriptExecutor
    if (!executor) {
      await automationRepository.completeCloud({
        automationId: claimed.automation.id,
        runId,
        leaseOwner,
        status: "failed",
        resultSummary: "OpenWork Cloud script execution is unavailable.",
        error: { code: "execution_runtime_unavailable", message: "OpenWork Cloud script execution is unavailable.", retryable: true },
        now: Date.now(),
      })
      return
    }
    const result = await executor({
      organizationId: claimed.automation.organizationId,
      ownerMemberId: claimed.automation.ownerMemberId,
      automationRunId: runId,
      action: claimed.revision.action,
    }).catch((error): CloudSavedScriptExecution => ({
      ok: false,
      message: error instanceof Error ? error.message : "Saved script execution failed.",
      retryable: true,
    }))
    await automationRepository.completeCloud({
      automationId: claimed.automation.id,
      runId,
      leaseOwner,
      status: result.ok ? "succeeded" : "failed",
      resultSummary: result.ok ? result.canonicalResult : result.message,
      ...(result.ok ? { validatedResult: result.value, codemodeReceiptId: result.receiptId } : {}),
      ...(!result.ok && result.receiptId ? { codemodeReceiptId: result.receiptId } : {}),
      error: result.ok ? null : { code: "execution_failed", message: result.message, retryable: result.retryable },
      now: Date.now(),
    })
  }

  private startCloudRun(runId: string): boolean {
    if (this.cloudExecutions.has(runId)) return true
    if (this.cloudExecutions.size >= env.automations.maxConcurrency) return false
    const task = this.executeCloudRun(runId)
      .catch((error) => {
        appLogger.error("Cloud Automation dispatch failed", {
          component: "automation_scheduler",
          run_id: runId,
          error,
        })
      })
      .finally(() => this.cloudExecutions.delete(runId))
    this.cloudExecutions.set(runId, task)
    return true
  }

  private async executeCloudAgentRun(
    claimed: NonNullable<Awaited<ReturnType<typeof automationRepository.claimCloud>>>,
    leaseOwner: string,
  ): Promise<void> {
    const action = claimed.revision.action
    if (action?.kind !== "agent") return
    const executor = cloudAgentExecutor
    if (!executor) {
      await automationRepository.completeCloud({
        automationId: claimed.automation.id,
        runId: claimed.run.id,
        leaseOwner,
        status: "failed",
        resultSummary: "OpenWork Cloud agent execution is unavailable.",
        updateArtifactState: false,
        error: { code: "execution_runtime_unavailable", message: "OpenWork Cloud agent execution is unavailable.", retryable: true },
        now: Date.now(),
      })
      return
    }

    const controller = new AbortController()
    let monitoring = false
    const monitor = async () => {
      if (monitoring) return
      monitoring = true
      try {
        const state = await automationRepository.cloudRunState(claimed.run.id)
        if (!state || state.cancelRequested) controller.abort()
        else if (!await automationRepository.heartbeatCloud({
          runId: claimed.run.id,
          leaseOwner,
          leaseMs: env.automations.leaseMs,
          now: Date.now(),
        })) controller.abort()
      } finally {
        monitoring = false
      }
    }
    const heartbeatIntervalMs = Math.max(1_000, Math.min(10_000, Math.floor(env.automations.leaseMs / 3)))
    await monitor()
    if (controller.signal.aborted) {
      await automationRepository.completeCloud({
        automationId: claimed.automation.id,
        runId: claimed.run.id,
        leaseOwner,
        status: "cancelled",
        resultSummary: "The Automation run was cancelled.",
        updateArtifactState: false,
        error: { code: "cancelled", message: "The Automation run was cancelled.", retryable: false },
        now: Date.now(),
      })
      return
    }
    const interval = setInterval(() => void monitor(), heartbeatIntervalMs)
    const state = await automationRepository.cloudRunState(claimed.run.id)
    const result = await executor({
      organizationId: claimed.automation.organizationId,
      ownerMemberId: claimed.automation.ownerMemberId,
      automationRunId: claimed.run.id,
      automationName: claimed.automation.name,
      action,
      maximumRuntimeMs: claimed.revision.maximumRuntimeMs,
      previousReceipt: state?.receipt ?? null,
      signal: controller.signal,
      onAdmitted: async (receipt) => automationRepository.setCloudExecution({
        runId: claimed.run.id,
        leaseOwner,
        engineKind: "openwork-cloud-agent-v1",
        receipt,
        now: Date.now(),
      }),
    }).catch((error): CloudAgentExecution => ({
      ok: false,
      status: controller.signal.aborted ? "cancelled" : "failed",
      code: controller.signal.aborted ? "cancelled" : "execution_failed",
      message: controller.signal.aborted ? "The Automation run was cancelled." : error instanceof Error ? error.message : "Cloud agent execution failed.",
      // The executor may have admitted a deterministic native turn before an
      // unexpected exception escaped. A person must inspect that run instead
      // of risking a second set of external side effects.
      retryable: false,
    })).finally(() => clearInterval(interval))

    if (!result.ok && result.retryable && await automationRepository.queueRetry({
      runId: claimed.run.id,
      leaseOwner,
      now: Date.now(),
    })) return

    const events = result.ok ? result.events : result.events ?? [{
      type: "terminal" as const,
      payload: { status: result.status, code: result.code, message: result.message },
    }]
    for (const [index, event] of events.entries()) {
      await monitor()
      if (controller.signal.aborted) throw new Error("automation_run_lease_lost")
      await automationRepository.appendCloudEvent({
        runId: claimed.run.id,
        leaseOwner,
        attempt: claimed.run.attemptCount,
        sequence: index + 1,
        type: event.type,
        payload: event.payload,
        now: Date.now(),
      })
    }

    await automationRepository.completeCloud({
      automationId: claimed.automation.id,
      runId: claimed.run.id,
      leaseOwner,
      status: result.ok ? "succeeded" : result.status,
      resultSummary: result.ok ? result.resultSummary : result.message,
      usage: result.usage,
      updateArtifactState: false,
      error: result.ok ? null : { code: result.code, message: result.message, retryable: result.retryable },
      now: Date.now(),
    })
    if (!result.ok && result.needsAttention) {
      const attentionCode = [
        "owner_membership_lost",
        "model_access_lost",
        "provider_unavailable",
        "connect_access_unavailable",
        "execution_runtime_unavailable",
      ].includes(result.code) ? result.code as "owner_membership_lost" | "model_access_lost" | "provider_unavailable" | "connect_access_unavailable" | "execution_runtime_unavailable" : "execution_runtime_unavailable"
      await automationRepository.markNeedsAttention({
        automationId: claimed.automation.id,
        expectedRevisionId: claimed.revision.id,
        reason: { code: attentionCode, message: result.message, occurredAt: Date.now() },
        now: Date.now(),
      })
    }
  }

}

export const automationService = new AutomationService()
