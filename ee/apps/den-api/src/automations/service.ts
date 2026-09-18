import { randomUUID } from "node:crypto"
import type { AutomationClaimResult, AutomationListItem } from "@openwork/automations"
import { AUTOMATION_MANUAL_CLAIM_WINDOW_MS, desktopRunnerConnected } from "@openwork/automations"
import { AUTOMATION_RUNNER_WORK_RUN_LIMIT, isAutomationCloudDefaultModel } from "@openwork/types/automations"
import type {
  AutomationCloudTarget,
  AutomationDesktopRunnerCapability,
  AutomationDesktopRunnerPresence,
  AutomationDesktopRunnerResult,
  AutomationDesktopRunnerRegistration,
  AutomationDesktopTarget,
  AutomationExecutionTarget,
  AutomationExecutionTargetList,
  AutomationRunEventType,
  AutomationRun,
  AutomationAction,
  CreateAutomationDefinition,
  DesktopRunnerInventory,
  UpdateAutomation,
} from "@openwork/types/automations"
import { env } from "../env.js"
import { isActiveAutomationOwner, resolveAutomationModelAccess } from "./authority.js"
import { shouldApplyAutomationModelAccessFailure } from "./model-attention-rollout.js"
import { automationRepository, runWorkspaceId } from "./repository.js"
import { recordAutomationRunCompleted, recordAutomationRunStarted } from "./audit.js"
import { validateWorkflowAutomationAction } from "../workflows.js"
import type { CloudAgentExecution, CloudAgentExecutorInput } from "./cloud-agent-executor.js"
import { cloudAutomationRuntime, HEADLESS_AGENT_ENGINE_KIND, type CloudAutomationRuntime } from "./headless-runtime.js"
import { appLogger } from "../observability/logger.js"
import {
  getOpenWorkWebRuntimeAccess,
  OPENWORK_WEB_ACCESS_REQUIRED_CODE,
  OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
  requireOpenWorkWebRuntimeAccess,
  type OpenWorkWebRuntimeAccessResolver,
} from "../openwork-web-runtime-access.js"

const schedulerOwner = `den:${process.pid}:${randomUUID()}`
const logger = appLogger.child({ component: "automations" })
const AUTOMATION_LIST_AUTHORITY_BATCH_SIZE = 4
const DAY_MS = 24 * 60 * 60_000
/** A desktop that has not checked in for this long is forgotten; signing in again registers it anew. */
const RUNNER_RETENTION_MS = 30 * DAY_MS
/** Wake-up notifications are hints; a desktop's work poll finds anything they pointed at. */
const RUNNER_NOTIFICATION_RETENTION_MS = 7 * DAY_MS
const RUNNER_PRUNE_INTERVAL_MS = 10 * 60_000
const RUNNER_PRUNE_BATCH_SIZE = 1_000
/** Desktops listed as targets; every one of them can still claim work. */
const DESKTOP_TARGET_LIST_LIMIT = 100

type OwnerScope = {
  organizationId: string
  ownerMemberId: string
  modelAttentionCapable?: boolean
}

/**
 * `agentCaller`: the request came from an agent through MCP. Agents may move
 * work to the cloud but never onto the owner's desktop, for the same reason
 * they cannot create Desktop Automations.
 */
export type AutomationPlacementOptions = { agentCaller?: boolean }
export type AutomationRunNowOptions = AutomationPlacementOptions & {
  /** Run this one occurrence here instead of on the Automation's own target. */
  executionTarget?: AutomationExecutionTarget
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

/**
 * Whether a run executed where its Automation runs. A failure of a one-off run
 * on the other target is recorded on that run only; it never pauses the
 * Automation's own schedule.
 */
function ownPlacement(revision: { executionTarget?: AutomationExecutionTarget | null }, runTarget: AutomationExecutionTarget) {
  return (revision.executionTarget ?? "desktop") === runTarget
}

function supportsModelAttention(scope: OwnerScope | DesktopRunnerScope) {
  return scope.modelAttentionCapable === true
    || ("capabilities" in scope && scope.capabilities?.includes("model_attention_v1") === true)
}

export type CloudWorkflowExecution =
  | { ok: true; value: unknown; canonicalResult: string; receiptId: string }
  | { ok: false; message: string; retryable: boolean; receiptId?: string | null }

export type CloudWorkflowExecutor = (input: {
  organizationId: string
  ownerMemberId: string
  automationRunId: string
  action: Extract<AutomationAction, { kind: "saved_script" }>
}) => Promise<CloudWorkflowExecution>

let cloudWorkflowExecutor: CloudWorkflowExecutor | null = null
let cloudAgentExecutor: ((input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>) | null = null
let cloudAgentRuntimeAvailable: ((scope: OwnerScope) => Promise<boolean>) | null = null
let headlessAgentExecutor: ((input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>) | null = null

const CLOUD_AGENT_ENGINE_KIND = "openwork-cloud-agent-v1"
const CLOUD_CODEMODE_ENGINE_KIND = "openwork-cloud-codemode-v1"

export function configureCloudWorkflowExecutor(executor: CloudWorkflowExecutor): void {
  cloudWorkflowExecutor = executor
}

export function configureCloudAgentExecutor(input: {
  execute: (input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>
  runtimeAvailable: (scope: OwnerScope) => Promise<boolean>
}): void {
  cloudAgentExecutor = input.execute
  cloudAgentRuntimeAvailable = input.runtimeAvailable
}

/** Cloud agent runs for organizations on the headless runtime execute here instead of an OpenWork Web computer. */
export function configureHeadlessAgentExecutor(execute: (input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>): void {
  headlessAgentExecutor = execute
}

export type AutomationServiceOptions = {
  getOpenWorkWebAccess?: OpenWorkWebRuntimeAccessResolver
  cloudRuntime?: (organizationId: string) => Promise<CloudAutomationRuntime>
}

export class AutomationService {
  private readonly cloudExecutions = new Map<string, Promise<void>>()
  private readonly getOpenWorkWebAccess: OpenWorkWebRuntimeAccessResolver
  private readonly cloudRuntime: (organizationId: string) => Promise<CloudAutomationRuntime>
  private runnerPruneDueAt = 0

  constructor(options: AutomationServiceOptions = {}) {
    this.getOpenWorkWebAccess = options.getOpenWorkWebAccess ?? getOpenWorkWebRuntimeAccess
    this.cloudRuntime = options.cloudRuntime ?? cloudAutomationRuntime
  }

  /**
   * Cloud placement needs somewhere to run: the headless runner (included in
   * Team, no Web seat) or, as before, the owner's OpenWork Web computer.
   */
  private async requireCloudRuntimeAccess(organizationId: string) {
    if (await this.cloudRuntime(organizationId) === "headless") return
    await requireOpenWorkWebRuntimeAccess(organizationId, this.getOpenWorkWebAccess)
  }

  /** Whether the owner has an OpenWork Web computer that can run agent Automations, with its files. */
  private async cloudComputerAvailable(scope: OwnerScope) {
    return (await this.getOpenWorkWebAccess(scope.organizationId)).hasAccess
      && cloudAgentRuntimeAvailable !== null
      && await cloudAgentRuntimeAvailable(scope)
  }

  /**
   * Which engine runs a cloud agent Automation. Off the headless runtime it is
   * always the owner's OpenWork Web computer. On it, the cloud default model
   * ("only connected accounts") runs headless, and a chosen model runs on the
   * owner's cloud computer when they have one, because it may need that
   * computer's files; without one it runs headless too.
   */
  private async agentEngine(scope: OwnerScope, model: ModelSelection): Promise<typeof HEADLESS_AGENT_ENGINE_KIND | typeof CLOUD_AGENT_ENGINE_KIND> {
    if (await this.cloudRuntime(scope.organizationId) !== "headless") return CLOUD_AGENT_ENGINE_KIND
    if (isAutomationCloudDefaultModel(model)) return HEADLESS_AGENT_ENGINE_KIND
    return await this.cloudComputerAvailable(scope) ? CLOUD_AGENT_ENGINE_KIND : HEADLESS_AGENT_ENGINE_KIND
  }

  private async cloudAgentAvailable(scope: OwnerScope, model: ModelSelection) {
    if (await this.agentEngine(scope, model) === HEADLESS_AGENT_ENGINE_KIND) return headlessAgentExecutor !== null
    return cloudAgentRuntimeAvailable !== null && await cloudAgentRuntimeAvailable(scope)
  }

  /**
   * Moving an Automation, or one run of it, to the other target. The cloud
   * needs exactly what creating a Cloud Automation needs; the desktop never
   * runs Workflows, and agents never put work there.
   */
  private async requireTargetMove(
    scope: OwnerScope,
    action: AutomationAction | undefined,
    target: AutomationExecutionTarget,
    options: AutomationPlacementOptions,
  ) {
    if (target === "desktop") {
      if (action?.kind === "saved_script") throw new Error("automation_action_target_mismatch")
      if (options.agentCaller) throw new Error("automation_agent_desktop_placement")
      // Only the headless runner can run the cloud default; a desktop needs a model it has.
      if (action?.kind === "agent" && isAutomationCloudDefaultModel(action.model)) {
        const error = new Error("Choose a model before running this Automation on a desktop.")
        error.name = "model_access_lost"
        throw error
      }
      return
    }
    await this.requireCloudRuntimeAccess(scope.organizationId)
    if (action?.kind === "agent" && !await this.cloudAgentAvailable(scope, action.model)) {
      throw new Error("automation_cloud_worker_required")
    }
  }

  /**
   * Whether Cloud can run this owner's agent Automations now, as creation
   * would decide, and on what: `runtime: "headless"` reaches only connected
   * accounts; `cloudComputer` says the owner also has an OpenWork Web
   * computer whose files a run can use.
   */
  private async cloudTarget(scope: OwnerScope): Promise<AutomationCloudTarget> {
    const runtime = await this.cloudRuntime(scope.organizationId)
    const cloudComputer = await this.cloudComputerAvailable(scope)
    const available = runtime === "headless" ? headlessAgentExecutor !== null || cloudComputer : cloudComputer
    return available
      ? { kind: "cloud", available: true, runtime, cloudComputer }
      : { kind: "cloud", available: false, runtime: null, cloudComputer: false }
  }

  /** Every place this owner's Automations can run: their registered desktops, then Cloud. */
  async executionTargets(scope: OwnerScope): Promise<AutomationExecutionTargetList> {
    const now = Date.now()
    const [desktops, cloud] = await Promise.all([
      automationRepository.listDesktopRunners({ ...scope, limit: DESKTOP_TARGET_LIST_LIMIT }),
      this.cloudTarget(scope),
    ])
    return {
      items: [
        ...desktops.map((desktop): AutomationDesktopTarget => ({
          kind: "desktop",
          id: desktop.id,
          platform: desktop.platform,
          appVersion: desktop.appVersion,
          lastSeenAt: desktop.lastSeenAt.getTime(),
          connected: desktopRunnerConnected({ lastSeenAt: desktop.lastSeenAt.getTime(), now }),
        })),
        cloud,
      ],
    }
  }

  /**
   * Runner rows and wake-up notifications only ever accumulate. Prune at most
   * every few minutes per process, and on the next tick again while a full
   * batch says more is waiting. A failure only delays the next attempt.
   */
  private async pruneRunnerState(now: number) {
    if (now < this.runnerPruneDueAt) return
    this.runnerPruneDueAt = now + RUNNER_PRUNE_INTERVAL_MS
    try {
      const pruned = await automationRepository.pruneRunnerState({
        runnersSeenBefore: now - RUNNER_RETENTION_MS,
        notificationsBefore: now - RUNNER_NOTIFICATION_RETENTION_MS,
        limit: RUNNER_PRUNE_BATCH_SIZE,
      })
      if (pruned.runners >= RUNNER_PRUNE_BATCH_SIZE || pruned.notifications >= RUNNER_PRUNE_BATCH_SIZE) {
        this.runnerPruneDueAt = now
      }
    } catch (error) {
      logger.warn("automation runner pruning failed", { error })
    }
  }

  async list(scope: OwnerScope, input: { cursor?: string; limit?: number }) {
    const page = await automationRepository.list({ ...scope, cursor: input.cursor, limit: input.limit ?? 50 })
    const modelAccessBySelection = new Map<string, ReturnType<typeof resolveAutomationModelAccess>>()
    const resolveModelAccess = (item: AutomationListItem) => {
      const key = JSON.stringify([item.revision.model.providerId, item.revision.model.modelId])
      const existing = modelAccessBySelection.get(key)
      if (existing) return existing
      const access = resolveAutomationModelAccess({
        organizationId: item.automation.organizationId,
        ownerMemberId: item.automation.ownerMemberId,
        ...item.revision.model,
      })
      modelAccessBySelection.set(key, access)
      return access
    }
    const items: AutomationListItem[] = []
    for (let offset = 0; offset < page.items.length; offset += AUTOMATION_LIST_AUTHORITY_BATCH_SIZE) {
      items.push(...await Promise.all(
        page.items.slice(offset, offset + AUTOMATION_LIST_AUTHORITY_BATCH_SIZE).map((item) => this.reconcileModelAttention(
          item,
          scope,
          () => resolveModelAccess(item),
        )),
      ))
    }
    return { ...page, items }
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
      await this.requireCloudRuntimeAccess(scope.organizationId)
      if (definition.action.kind === "agent") {
        // Action-based creation is Cloud placement. The legacy Zen exception
        // exists only for already-published Desktop clients.
        await this.requireNewModel({ ...scope, modelAttentionCapable: true }, definition.action.model, "cloud")
      }
      else {
        if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
        await validateWorkflowAutomationAction({ ...scope, action: definition.action })
      }
      if (definition.action.kind === "agent" && !await this.cloudAgentAvailable(scope, definition.action.model)) {
        throw new Error("automation_cloud_worker_required")
      }
    } else {
      await this.requireNewModel(scope, definition.model, "desktop")
    }
    const created = await automationRepository.create({ ...scope, definition, now: Date.now() })
    return this.reconcileModelAttention(created, scope)
  }

  async update(scope: OwnerScope, automationId: string, changes: UpdateAutomation, options: AutomationPlacementOptions = {}) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    const currentTarget = current.revision.executionTarget ?? "desktop"
    const nextTarget = changes.executionTarget ?? currentTarget
    const moved = nextTarget !== currentTarget
    const nextAction = changes.action ?? current.revision.action
    if (nextTarget === "desktop" && nextAction?.kind === "saved_script") {
      throw new Error("automation_action_target_mismatch")
    }
    // Moving off the cloud needs no cloud access; moving onto it needs what creation needs.
    if (moved) await this.requireTargetMove(scope, nextAction, nextTarget, options)
    else if (currentTarget === "cloud") await this.requireCloudRuntimeAccess(scope.organizationId)
    if (nextAction?.kind === "saved_script") {
      await validateWorkflowAutomationAction({ ...scope, action: nextAction })
    } else if (nextAction?.kind === "agent") {
      const requestedModel = changes.action?.kind === "agent"
        ? changes.action.model
        : changes.model ?? nextAction.model
      if (!moved && nextTarget === "cloud" && !await this.cloudAgentAvailable(scope, requestedModel)) {
        throw new Error("automation_cloud_worker_required")
      }
      // Cloud placement never inherits the legacy Desktop model exception, so
      // a move to the cloud revalidates even an unchanged model.
      if (moved || !sameModel(requestedModel, current.revision.model)) {
        await this.requireNewModel(
          nextTarget === "cloud" ? { ...scope, modelAttentionCapable: true } : scope,
          requestedModel,
          nextTarget,
        )
      }
    }
    const updated = await automationRepository.update({ ...scope, automationId, changes, now: Date.now() })
    return this.reconcileModelAttention(updated, scope)
  }

  async activate(scope: OwnerScope, automationId: string) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    if ((current.revision.executionTarget ?? "desktop") === "cloud") {
      await this.requireCloudRuntimeAccess(scope.organizationId)
    }
    if (current.revision.action?.kind === "saved_script") {
      if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
    } else {
      if ((current.revision.executionTarget ?? "desktop") === "cloud" && !await this.cloudAgentAvailable(scope, current.revision.model)) {
        throw new Error("automation_cloud_worker_required")
      }
      await this.requireNewModel(
        (current.revision.executionTarget ?? "desktop") === "cloud"
          ? { ...scope, modelAttentionCapable: true }
          : scope,
        current.revision.model,
        current.revision.executionTarget ?? "desktop",
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

  async runNow(scope: OwnerScope, automationId: string, options: AutomationRunNowOptions = {}): Promise<AutomationRun | null> {
    const current = await this.get(scope, automationId)
    if (!current || current.automation.state === "archived") return null
    const savedTarget = current.revision.executionTarget ?? "desktop"
    const target = options.executionTarget ?? savedTarget
    // Cloud Automations execute on the headless runner or an OpenWork VM, so a
    // manual run is gated like every other cloud boundary. Desktop-target
    // Automations are untouched. openwork_web_access_required is already part
    // of the shared Automation contract (packages/types/src/automations.ts) and
    // published desktops surface the returned message in the action toast.
    // Running once on the other target is checked like moving there.
    if (target !== savedTarget) await this.requireTargetMove(scope, current.revision.action, target, options)
    else if (target === "cloud") await this.requireCloudRuntimeAccess(scope.organizationId)
    // This one occurrence runs on `target`; the Automation keeps its own.
    const revision = { ...current.revision, executionTarget: target }
    let blocked = current.automation.needsAttentionReason
    if (current.revision.action?.kind === "saved_script") {
      if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
    } else if (!blocked) {
      const access = await resolveAutomationModelAccess({ ...scope, ...current.revision.model })
      if (!access.ok && shouldApplyAutomationModelAccessFailure({
        model: current.revision.model,
        failure: access,
        executionTarget: target,
        modelAttentionCapable: target === "cloud" || supportsModelAttention(scope),
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
      const skipped = await automationRepository.recordSkippedManual({
        ...scope,
        automation: current.automation,
        revision,
        nonce: randomUUID(),
        code: blocked.code,
        message: blocked.message,
        now,
      })
      await recordAutomationRunCompleted({ runId: skipped.id, terminalAt: now })
      return skipped
    }
    const claimedAt = Date.now()
    const claim = await automationRepository.claim({
      automation: { ...current.automation, state: "active" },
      revision,
      trigger: "manual",
      scheduledFor: null,
      nonce: randomUUID(),
      leaseOwner: schedulerOwner,
      leaseMs: env.automations.leaseMs,
      claimDeadlineMs: AUTOMATION_MANUAL_CLAIM_WINDOW_MS,
      now: claimedAt,
    })
    if (claim.kind === "overlap") await recordAutomationRunCompleted({ runId: claim.run.id, terminalAt: claimedAt })
    if (claim.kind === "claimed" && claim.run.executionTarget === "cloud") {
      this.startCloudRun(claim.run.id)
    }
    return (await automationRepository.getRunReceipt({ ...scope, runId: claim.run.id }))?.run ?? claim.run
  }

  listRuns(scope: OwnerScope, automationId: string, input: { cursor?: string; limit?: number }) {
    return automationRepository.listRuns({ ...scope, automationId, cursor: input.cursor, limit: input.limit ?? 50 })
  }

  listRunsInRange(scope: OwnerScope, input: { from: number; to: number; cursor?: string; limit?: number }) {
    return automationRepository.listRunsInRange({ ...scope, from: input.from, to: input.to, cursor: input.cursor, limit: input.limit ?? 200 })
  }

  getRun(scope: OwnerScope, runId: string) {
    return automationRepository.getRunReceipt({ ...scope, runId })
  }

  async cancelRun(scope: OwnerScope, runId: string): Promise<AutomationRun | null> {
    const now = Date.now()
    const run = await automationRepository.requestCancellation({ ...scope, runId, now })
    // A queued run is cancelled right here; running ones finish through their executor.
    if (run?.status === "cancelled") await recordAutomationRunCompleted({ runId: run.id, terminalAt: now, actor: { kind: "owner" } })
    return run
  }

  async tick(input: { now?: number; batchSize?: number } = {}): Promise<string[]> {
    const now = input.now ?? Date.now()
    const started: string[] = []
    const recovered = await automationRepository.recoverExpiredLeases({ now, limit: input.batchSize ?? env.automations.batchSize })
    const expired = await automationRepository.expireUnclaimedDesktop({ now, limit: input.batchSize ?? env.automations.batchSize })
    // Only runs that ran out of attempts became terminal at `now`; re-queued ones record nothing.
    for (const runId of [...recovered.map((run) => run.id), ...expired]) await recordAutomationRunCompleted({ runId, terminalAt: now })
    await this.pruneRunnerState(now)

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
      // Scheduler-initiated work has no HTTP request: its start is service-layer evidence.
      if (claim.kind !== "duplicate") await recordAutomationRunStarted(claim.run.id)
      if (claim.kind === "overlap") await recordAutomationRunCompleted({ runId: claim.run.id, terminalAt: now })
      if (claim.kind !== "claimed") continue
      if (!access.ok && shouldApplyAutomationModelAccessFailure({
        model: item.revision.model,
        failure: access,
        executionTarget: item.revision.executionTarget ?? "desktop",
        // Scheduling must remain compatible until a capable desktop claims
        // the work or a capable management client reconciles the Automation.
        modelAttentionCapable: (item.revision.executionTarget ?? "desktop") === "cloud",
      })) {
        await this.skipRun({ runId: claim.run.id, code: access.code, message: access.message, now })
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
      capabilities: registration.capabilities,
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

  /** False when the runner has no registration to attach the report to. */
  saveDesktopRunnerInventory(scope: DesktopRunnerScope, inventory: DesktopRunnerInventory) {
    return automationRepository.saveDesktopRunnerInventory({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      runnerId: scope.runnerId,
      inventory,
      now: Date.now(),
    })
  }

  touchDesktopRunner(scope: DesktopRunnerScope) {
    return automationRepository.touchDesktopRunner({ ...scope, now: Date.now() })
  }

  /** Lets a management client warn before a due occurrence instead of after it. */
  async desktopRunnerPresence(scope: OwnerScope): Promise<AutomationDesktopRunnerPresence> {
    const lastSeenAt = await automationRepository.desktopRunnerLastSeenAt(scope)
    return { connected: desktopRunnerConnected({ lastSeenAt, now: Date.now() }), lastSeenAt }
  }

  async discoverDesktopRunnerWork(scope: DesktopRunnerScope) {
    try {
      await this.touchDesktopRunner(scope)
    } catch (error) {
      logger.warn("automation desktop runner touch failed", {
        organization_id: scope.organizationId,
        owner_member_id: scope.ownerMemberId,
        runner_id: scope.runnerId,
        error,
      })
    }
    // Every desktop sees all of the owner's queued runs and skips the ones
    // pinned to a workspace it lacks, so the window must reach past them.
    return automationRepository.discoverDesktopWork({ ...scope, now: Date.now(), limit: AUTOMATION_RUNNER_WORK_RUN_LIMIT })
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
      await this.skipRun({
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
      workspaceId: runWorkspaceId(claimed.revision, "desktop"),
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
      engineReceipt: {
        ...(result.sessionId ? { nativeThreadId: result.sessionId } : {}),
        ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
      },
      attempt: result.attempt,
      now,
    })
    // A retried callback returns the stored terminal run (older finished_at): no second event.
    await recordAutomationRunCompleted({ runId, terminalAt: now, actor: { kind: "runner", runnerId: scope.runnerId, ownerMemberId: scope.ownerMemberId } })
    // A Cloud Automation run once on a desktop that lacks its model says
    // nothing about the cloud, so only the Automation's own placement pauses.
    if ((result.error?.code === "model_access_lost" || result.error?.code === "provider_unavailable")
      && await automationRepository.revisionExecutionTarget(completed.revisionId) !== "cloud") {
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
   * Published Desktop admission remains compatible, including model-attention
   * v1 clients. Cloud enforces provider filters here; updated Desktop runners
   * check their effective workspace model catalog before creating a thread.
   */
  private async requireNewModel(scope: OwnerScope, model: ModelSelection, target: "desktop" | "cloud") {
    // The cloud default only means something where the runner picks the model.
    if (isAutomationCloudDefaultModel(model)
      && (target !== "cloud" || await this.cloudRuntime(scope.organizationId) !== "headless")) {
      const error = new Error("The cloud default model runs only cloud Automations on the headless runtime.")
      error.name = "model_access_lost"
      throw error
    }
    const result = await resolveAutomationModelAccess({ ...scope, ...model })
    if (!result.ok && shouldApplyAutomationModelAccessFailure({
      model,
      failure: result,
      executionTarget: target,
      modelAttentionCapable: supportsModelAttention(scope),
    })) {
      const error = new Error(result.message)
      error.name = result.code
      throw error
    }
  }

  private async reconcileModelAttention(
    item: AutomationListItem,
    scope: OwnerScope,
    resolveModelAccess: () => ReturnType<typeof resolveAutomationModelAccess> = () => resolveAutomationModelAccess({
      organizationId: item.automation.organizationId,
      ownerMemberId: item.automation.ownerMemberId,
      ...item.revision.model,
    }),
  ): Promise<AutomationListItem> {
    if (item.automation.state !== "active" || item.revision.action?.kind === "saved_script") return item
    const access = await resolveModelAccess()
    if (access.ok || !shouldApplyAutomationModelAccessFailure({
      model: item.revision.model,
      failure: access,
      executionTarget: item.revision.executionTarget ?? "desktop",
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

  /** completeCloud plus the run's single terminal audit outcome (only when this call made the transition). */
  private async completeCloud(input: Parameters<typeof automationRepository.completeCloud>[0]) {
    const completed = await automationRepository.completeCloud(input)
    await recordAutomationRunCompleted({ runId: input.runId, terminalAt: input.now })
    return completed
  }

  private async skipRun(input: Parameters<typeof automationRepository.skipRun>[0]) {
    await automationRepository.skipRun(input)
    await recordAutomationRunCompleted({ runId: input.runId, terminalAt: input.now })
  }

  private async executeCloudRun(runId: string): Promise<void> {
    const leaseOwner = `${schedulerOwner}:cloud:${runId}`
    const target = await automationRepository.cloudRunTarget(runId)
    if (!target) return
    const runtime = await this.cloudRuntime(target.organizationId)
    // A run keeps the engine it started on, so recovery never switches runtimes mid-run.
    const engineKind = target.engineKind
      ?? (target.actionKind === "saved_script"
        ? CLOUD_CODEMODE_ENGINE_KIND
        : await this.agentEngine({ organizationId: target.organizationId, ownerMemberId: target.ownerMemberId }, target.model))
    const headlessEngine = engineKind === HEADLESS_AGENT_ENGINE_KIND
    const claimed = await automationRepository.claimCloud({
      runId,
      leaseOwner,
      leaseMs: env.automations.leaseMs,
      maxConcurrency: headlessEngine ? env.automations.headlessMaxConcurrency : env.automations.maxConcurrency,
      engineKind,
      headlessEngineKind: HEADLESS_AGENT_ENGINE_KIND,
      now: Date.now(),
    })
    if (!claimed) return
    // Headless runs and in-Den Workflows need no OpenWork Web computer, so the
    // Web seat gates only work that executes on one.
    const webAccess = headlessEngine || (runtime === "headless" && claimed.revision.action?.kind === "saved_script")
      ? { hasAccess: true }
      : await this.getOpenWorkWebAccess(claimed.automation.organizationId)
    if (!webAccess.hasAccess) {
      const now = Date.now()
      await this.skipRun({
        runId: claimed.run.id,
        code: OPENWORK_WEB_ACCESS_REQUIRED_CODE,
        message: OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
        now,
      })
      if (ownPlacement(claimed.revision, "cloud")) await automationRepository.markNeedsAttention({
        automationId: claimed.automation.id,
        expectedRevisionId: claimed.revision.id,
        reason: {
          code: OPENWORK_WEB_ACCESS_REQUIRED_CODE,
          message: OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
          occurredAt: now,
        },
        now,
      })
      return
    }
    if (claimed.revision.action?.kind === "agent") {
      await this.executeCloudAgentRun(claimed, leaseOwner, headlessEngine ? HEADLESS_AGENT_ENGINE_KIND : CLOUD_AGENT_ENGINE_KIND)
      return
    }
    if (claimed.revision.action?.kind !== "saved_script") return
    const executor = cloudWorkflowExecutor
    if (!executor) {
      await this.completeCloud({
        automationId: claimed.automation.id,
        runId,
        leaseOwner,
        status: "failed",
        resultSummary: "OpenWork Cloud Workflow execution is unavailable.",
        error: { code: "execution_runtime_unavailable", message: "OpenWork Cloud Workflow execution is unavailable.", retryable: true },
        now: Date.now(),
      })
      return
    }
    const result = await executor({
      organizationId: claimed.automation.organizationId,
      ownerMemberId: claimed.automation.ownerMemberId,
      automationRunId: runId,
      action: claimed.revision.action,
    }).catch((error): CloudWorkflowExecution => ({
      ok: false,
      message: error instanceof Error ? error.message : "Workflow execution failed.",
      retryable: true,
    }))
    await this.completeCloud({
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
    // Each pool's own limit is enforced durably at claim time; this only bounds one process.
    if (this.cloudExecutions.size >= env.automations.maxConcurrency + env.automations.headlessMaxConcurrency) return false
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
    engineKind: typeof HEADLESS_AGENT_ENGINE_KIND | typeof CLOUD_AGENT_ENGINE_KIND,
  ): Promise<void> {
    const action = claimed.revision.action
    if (action?.kind !== "agent") return
    const executor = engineKind === HEADLESS_AGENT_ENGINE_KIND ? headlessAgentExecutor : cloudAgentExecutor
    if (!executor) {
      await this.completeCloud({
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
      await this.completeCloud({
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
    const interval = setInterval(() => {
      if (controller.signal.aborted) return
      void monitor().catch((error) => {
        logger.error("Cloud Automation heartbeat monitor failed", {
          run_id: claimed.run.id,
          error,
        })
        controller.abort(error)
      })
    }, heartbeatIntervalMs)
    interval.unref()
    let result: CloudAgentExecution
    try {
      const state = await automationRepository.cloudRunState(claimed.run.id)
      result = await executor({
        organizationId: claimed.automation.organizationId,
        ownerMemberId: claimed.automation.ownerMemberId,
        automationRunId: claimed.run.id,
        automationName: claimed.automation.name,
        action,
        maximumRuntimeMs: claimed.revision.maximumRuntimeMs,
        previousReceipt: state?.receipt ?? null,
        workspaceId: runWorkspaceId(claimed.revision, "cloud"),
        signal: controller.signal,
        onAdmitted: async (receipt) => automationRepository.setCloudExecution({
          runId: claimed.run.id,
          leaseOwner,
          engineKind,
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
      }))
    } finally {
      clearInterval(interval)
    }

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

    await this.completeCloud({
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
    if (!result.ok && result.needsAttention && ownPlacement(claimed.revision, "cloud")) {
      const attentionCode = [
        "owner_membership_lost",
        "model_access_lost",
        "provider_unavailable",
        "connect_access_unavailable",
        "openwork_web_access_required",
        "execution_runtime_unavailable",
      ].includes(result.code) ? result.code as "owner_membership_lost" | "model_access_lost" | "provider_unavailable" | "connect_access_unavailable" | "openwork_web_access_required" | "execution_runtime_unavailable" : "execution_runtime_unavailable"
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
