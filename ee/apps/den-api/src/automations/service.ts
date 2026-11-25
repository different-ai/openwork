import { randomUUID } from "node:crypto"
import type { AutomationClaimResult, AutomationListItem } from "@openwork/automations"
import { AUTOMATION_MANUAL_CLAIM_WINDOW_MS, calendarTriggerPrompt, desktopRunnerConnected } from "@openwork/automations"
import { AUTOMATION_RUNNER_WORK_RUN_LIMIT, REMOTE_SESSION_ONLY_RUNNER_CAPABILITY, isAutomationCloudDefaultModel } from "@openwork/types/automations"
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
  AutomationRunTriggerContext,
  AutomationSchedule,
  AutomationScheduleKind,
  CreateAutomationDefinition,
  CopySharedAutomation,
  DesktopRunnerInventory,
  UpdateAutomation,
} from "@openwork/types/automations"
import { listSharedAutomations } from "./sharing.js"
import { env } from "../env.js"
import { isActiveAutomationOwner, resolveAutomationModelAccess } from "./authority.js"
import { runnerStanding } from "../computer-disconnect.js"
import { shouldApplyAutomationModelAccessFailure } from "./model-attention-rollout.js"
import { automationDesktopLeaseOwner, automationRepository, runWorkspaceId, type StoredRunnerSessionReport } from "./repository.js"
import { recordAutomationRunCompleted, recordAutomationRunStarted } from "./audit.js"
import { validateWorkflowAutomationAction } from "../workflows.js"
import type { CloudAgentExecution, CloudAgentExecutorInput } from "./cloud-agent-executor.js"
import { cloudAutomationRuntime, HEADLESS_AGENT_ENGINE_KIND, type CloudAutomationRuntime } from "./headless-runtime.js"
import { automationTargetAllowed } from "./organization-availability.js"
import { CalendarTriggerSource, type CalendarTriggerSourceDeps } from "./calendar-trigger-source.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
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
const RUNNER_RETENTION_MS = 30 * DAY_MS
const RUNNER_NOTIFICATION_RETENTION_MS = 7 * DAY_MS
const RUNNER_PRUNE_INTERVAL_MS = 10 * 60_000
const RUNNER_PRUNE_BATCH_SIZE = 1_000
const DESKTOP_TARGET_LIST_LIMIT = 100

type OwnerScope = {
  organizationId: string
  ownerMemberId: string
  modelAttentionCapable?: boolean
  readableScheduleKinds?: ReadonlySet<AutomationScheduleKind> | null
}

function readableBy(scope: OwnerScope, schedule: AutomationSchedule) {
  return !scope.readableScheduleKinds || scope.readableScheduleKinds.has(schedule.kind)
}

export type AutomationPlacementOptions = { agentCaller?: boolean }
export type AutomationRunNowOptions = AutomationPlacementOptions & {
  executionTarget?: AutomationExecutionTarget
}
export type DesktopRunnerScope = OwnerScope & {
  runnerId: string
  capabilities?: readonly AutomationDesktopRunnerCapability[]
}

const desktopLeaseOwner = automationDesktopLeaseOwner

type ModelSelection = { providerId: string; modelId: string; variant?: string | null }

function sameModel(left: ModelSelection, right: ModelSelection) {
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && (left.variant ?? null) === (right.variant ?? null)
}

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

export function configureHeadlessAgentExecutor(execute: (input: CloudAgentExecutorInput) => Promise<CloudAgentExecution>): void {
  headlessAgentExecutor = execute
}

export type AutomationServiceOptions = {
  getOpenWorkWebAccess?: OpenWorkWebRuntimeAccessResolver
  cloudRuntime?: (organizationId: string) => Promise<CloudAutomationRuntime>
  readCalendar?: CalendarTriggerSourceDeps["read"]
}

async function readOwnerCalendar(input: Parameters<CalendarTriggerSourceDeps["read"]>[0]) {
  const { readMemberGoogleCalendar } = await import("../routes/org/google-workspace.js")
  return readMemberGoogleCalendar({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    orgMembershipId: normalizeDenTypeId("member", input.ownerMemberId),
    timeMin: input.timeMin,
    timeMax: input.timeMax,
  })
}

export class AutomationService {
  private readonly cloudExecutions = new Map<string, Promise<void>>()
  private readonly getOpenWorkWebAccess: OpenWorkWebRuntimeAccessResolver
  private readonly cloudRuntime: (organizationId: string) => Promise<CloudAutomationRuntime>
  private readonly calendarTriggers: CalendarTriggerSource
  private runnerPruneDueAt = 0

  constructor(options: AutomationServiceOptions = {}) {
    this.getOpenWorkWebAccess = options.getOpenWorkWebAccess ?? getOpenWorkWebRuntimeAccess
    this.cloudRuntime = options.cloudRuntime ?? cloudAutomationRuntime
    this.calendarTriggers = new CalendarTriggerSource({
      list: (limit) => automationRepository.listActiveCalendarTriggers({ limit }),
      read: options.readCalendar ?? readOwnerCalendar,
      claim: (item, occurrence) => this.claimAndDispatch(item, occurrence, Date.now()),
      needsConnection: async (item, message) => {
        const now = Date.now()
        await automationRepository.markNeedsAttention({
          automationId: item.automation.id,
          expectedRevisionId: item.revision.id,
          reason: { code: "connect_access_unavailable", message, occurredAt: now },
          now,
        })
      },
    })
  }

  private requireScheduleAllowed(
    _scope: OwnerScope,
    schedule: AutomationSchedule | undefined,
    target: AutomationExecutionTarget,
    _current?: AutomationSchedule,
  ) {
    if (schedule?.kind === "calendar" && target !== "cloud") throw new Error("automation_calendar_trigger_cloud_only")
  }

  private async requireTargetAllowed(organizationId: string, target: AutomationExecutionTarget) {
    if (!await automationTargetAllowed(organizationId, target)) throw new Error(target === "cloud" ? "automation_cloud_disabled" : "automation_desktop_disabled")
  }

  private async requireCloudRuntimeAccess(scope: OwnerScope) {
    if (await this.cloudRuntime(scope.organizationId) === "headless") return
    await requireOpenWorkWebRuntimeAccess(scope.organizationId, this.getOpenWorkWebAccess, { memberId: scope.ownerMemberId })
  }

  private async cloudComputerAvailable(scope: OwnerScope) {
    return (await this.getOpenWorkWebAccess(scope.organizationId, { memberId: scope.ownerMemberId })).hasAccess
      && cloudAgentRuntimeAvailable !== null
      && await cloudAgentRuntimeAvailable(scope)
  }

  private async agentEngine(scope: OwnerScope, model: ModelSelection): Promise<typeof HEADLESS_AGENT_ENGINE_KIND | typeof CLOUD_AGENT_ENGINE_KIND> {
    if (await this.cloudRuntime(scope.organizationId) !== "headless") return CLOUD_AGENT_ENGINE_KIND
    if (isAutomationCloudDefaultModel(model)) return HEADLESS_AGENT_ENGINE_KIND
    return await this.cloudComputerAvailable(scope) ? CLOUD_AGENT_ENGINE_KIND : HEADLESS_AGENT_ENGINE_KIND
  }

  private async cloudAgentAvailable(scope: OwnerScope, model: ModelSelection) {
    if (await this.agentEngine(scope, model) === HEADLESS_AGENT_ENGINE_KIND) return headlessAgentExecutor !== null
    return cloudAgentRuntimeAvailable !== null && await cloudAgentRuntimeAvailable(scope)
  }

  private async requireTargetMove(
    scope: OwnerScope,
    action: AutomationAction | undefined,
    target: AutomationExecutionTarget,
    options: AutomationPlacementOptions,
  ) {
    await this.requireTargetAllowed(scope.organizationId, target)
    if (target === "desktop") {
      if (action?.kind === "saved_script") throw new Error("automation_action_target_mismatch")
      if (options.agentCaller) throw new Error("automation_agent_desktop_placement")
      if (action?.kind === "agent" && isAutomationCloudDefaultModel(action.model)) {
        const error = new Error("Choose a model before running this Automation on a desktop.")
        error.name = "model_access_lost"
        throw error
      }
      return
    }
    await this.requireCloudRuntimeAccess(scope)
    if (action?.kind === "agent" && !await this.cloudAgentAvailable(scope, action.model)) {
      throw new Error("automation_cloud_worker_required")
    }
  }

  private async cloudTarget(scope: OwnerScope): Promise<AutomationCloudTarget> {
    if (!await automationTargetAllowed(scope.organizationId, "cloud")) return { kind: "cloud", available: false, runtime: null, cloudComputer: false }
    const runtime = await this.cloudRuntime(scope.organizationId)
    const cloudComputer = await this.cloudComputerAvailable(scope)
    const available = runtime === "headless" ? headlessAgentExecutor !== null || cloudComputer : cloudComputer
    return available
      ? { kind: "cloud", available: true, runtime, cloudComputer }
      : { kind: "cloud", available: false, runtime: null, cloudComputer: false }
  }

  async executionTargets(scope: OwnerScope): Promise<AutomationExecutionTargetList> {
    const now = Date.now()
    const [desktops, cloud, desktopAllowed] = await Promise.all([
      automationRepository.listDesktopRunners({ ...scope, limit: DESKTOP_TARGET_LIST_LIMIT }),
      this.cloudTarget(scope),
      automationTargetAllowed(scope.organizationId, "desktop"),
    ])
    return {
      items: [
        ...(desktopAllowed ? desktops : []).map((desktop): AutomationDesktopTarget => ({
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
    const listed = await automationRepository.list({ ...scope, cursor: input.cursor, limit: input.limit ?? 50 })
    const page = { ...listed, items: listed.items.filter((item) => readableBy(scope, item.revision.schedule)) }
    const modelAccessBySelection = new Map<string, ReturnType<typeof resolveAutomationModelAccess>>()
    const resolveModelAccess = (item: AutomationListItem) => {
      const executionTarget = item.revision.executionTarget ?? "desktop"
      const key = JSON.stringify([item.revision.model.providerId, item.revision.model.modelId, executionTarget])
      const existing = modelAccessBySelection.get(key)
      if (existing) return existing
      const access = resolveAutomationModelAccess({
        organizationId: item.automation.organizationId,
        ownerMemberId: item.automation.ownerMemberId,
        ...item.revision.model,
        executionTarget,
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
    return item && readableBy(scope, item.revision.schedule) ? this.reconcileModelAttention(item, scope) : null
  }

  async copyShared(scope: OwnerScope, id: string, options: CopySharedAutomation) {
    const [source] = (await listSharedAutomations(scope, { automationId: id, limit: 1 })).items
    if (!source) throw new Error("automation_not_found")
    const action = source.action.kind === "agent" && options.model
      ? { ...source.action, model: options.model } : source.action
    const common = { name: options.name ?? source.name, schedule: source.schedule }
    const definition: CreateAutomationDefinition = source.executionTarget === "desktop" && action.kind === "agent"
      ? { ...common, instructions: action.instructions, model: action.model }
      : { ...common, action, executionTarget: "cloud" }
    return this.create({ ...scope, modelAttentionCapable: true }, definition, { initialState: "inactive" })
  }

  async create(scope: OwnerScope, definition: CreateAutomationDefinition, options: { initialState?: "inactive" } = {}) {
    this.requireScheduleAllowed(scope, definition.schedule, "action" in definition ? definition.executionTarget : "desktop")
    await this.requireTargetAllowed(scope.organizationId, "action" in definition ? "cloud" : "desktop")
    if ("action" in definition) {
      if (definition.executionTarget !== "cloud") {
        throw new Error("automation_action_target_mismatch")
      }
      await this.requireCloudRuntimeAccess(scope)
      if (definition.action.kind === "agent") {
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
    const created = await automationRepository.create({ ...scope, definition, initialState: options.initialState, now: Date.now() })
    return this.reconcileModelAttention(created, scope)
  }

  async update(scope: OwnerScope, automationId: string, changes: UpdateAutomation, options: AutomationPlacementOptions = {}) {
    const current = await this.get(scope, automationId)
    if (!current) return null
    const currentTarget = current.revision.executionTarget ?? "desktop"
    const nextTarget = changes.executionTarget ?? currentTarget
    this.requireScheduleAllowed(scope, changes.schedule ?? current.revision.schedule, nextTarget, current.revision.schedule)
    const moved = nextTarget !== currentTarget
    const nextAction = changes.action ?? current.revision.action
    if (nextTarget === "desktop" && nextAction?.kind === "saved_script") {
      throw new Error("automation_action_target_mismatch")
    }
    if (moved) await this.requireTargetMove(scope, nextAction, nextTarget, options)
    else if (currentTarget === "cloud") await this.requireCloudRuntimeAccess(scope)
    if (nextAction?.kind === "saved_script") {
      await validateWorkflowAutomationAction({ ...scope, action: nextAction })
    } else if (nextAction?.kind === "agent") {
      const requestedModel = changes.action?.kind === "agent"
        ? changes.action.model
        : changes.model ?? nextAction.model
      if (!moved && nextTarget === "cloud" && !await this.cloudAgentAvailable(scope, requestedModel)) {
        throw new Error("automation_cloud_worker_required")
      }
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
      await this.requireCloudRuntimeAccess(scope)
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
    if (target !== savedTarget) await this.requireTargetMove(scope, current.revision.action, target, options)
    else {
      await this.requireTargetAllowed(scope.organizationId, target)
      if (target === "cloud") await this.requireCloudRuntimeAccess(scope)
    }
    const revision = { ...current.revision, executionTarget: target }
    let blocked = current.automation.needsAttentionReason
    if (current.revision.action?.kind === "saved_script") {
      if (!await isActiveAutomationOwner(scope)) throw new Error("automation_owner_inactive")
    } else if (!blocked) {
      const access = await resolveAutomationModelAccess({ ...scope, ...current.revision.model, executionTarget: target })
      if (!access.ok && shouldApplyAutomationModelAccessFailure({
        model: current.revision.model,
        failure: access,
        executionTarget: target,
        modelAttentionCapable: target === "cloud" || supportsModelAttention(scope),
      })) blocked = { code: access.code, message: access.message, occurredAt: Date.now() }
    }
    if (blocked) {
      const now = Date.now()
      if (ownPlacement(current.revision, target)) await automationRepository.markNeedsAttention({
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
    if (run?.status === "cancelled") await recordAutomationRunCompleted({ runId: run.id, terminalAt: now, actor: { kind: "owner" } })
    return run
  }

  async tick(input: { now?: number; batchSize?: number } = {}): Promise<string[]> {
    const now = input.now ?? Date.now()
    const started: string[] = []
    const recovered = await automationRepository.recoverExpiredLeases({ now, limit: input.batchSize ?? env.automations.batchSize })
    const expired = await automationRepository.expireUnclaimedDesktop({ now, limit: input.batchSize ?? env.automations.batchSize })
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
      const runId = await this.claimAndDispatch(item, { scheduledFor }, now)
      if (runId) started.push(runId)
    }
    try {
      started.push(...await this.calendarTriggers.tick(now))
    } catch (error) {
      logger.error("Calendar triggers failed", { error })
    }
    return started
  }

  private async claimAndDispatch(
    item: AutomationListItem,
    occurrence: { scheduledFor: number; nonce?: string; triggerContext?: AutomationRunTriggerContext },
    now: number,
  ): Promise<string | null> {
    const access = item.revision.action?.kind === "saved_script"
      ? (await isActiveAutomationOwner(item.automation)
          ? { ok: true as const }
          : { ok: false as const, code: "owner_membership_lost" as const, message: "The Automation owner is no longer active." })
      : await resolveAutomationModelAccess({
          organizationId: item.automation.organizationId,
          ownerMemberId: item.automation.ownerMemberId,
          ...item.revision.model,
          executionTarget: item.revision.executionTarget ?? "desktop",
        })
    let claim: AutomationClaimResult
    try {
      claim = await automationRepository.claim({
        automation: item.automation,
        revision: item.revision,
        trigger: "scheduled",
        scheduledFor: occurrence.scheduledFor,
        ...(occurrence.nonce ? { nonce: occurrence.nonce } : {}),
        ...(occurrence.triggerContext ? { triggerContext: occurrence.triggerContext } : {}),
        leaseOwner: schedulerOwner,
        leaseMs: env.automations.leaseMs,
        claimDeadlineMs: env.automations.runnerClaimDeadlineMs,
        now,
      })
    } catch (error) {
      if (error instanceof Error && error.message === "automation_not_active") return null
      throw error
    }
    if (claim.kind !== "duplicate") await recordAutomationRunStarted(claim.run.id)
    if (claim.kind === "overlap") await recordAutomationRunCompleted({ runId: claim.run.id, terminalAt: now })
    if (claim.kind !== "claimed") return null
    const target = item.revision.executionTarget ?? "desktop"
    if (!await automationTargetAllowed(item.automation.organizationId, target)) {
      await this.skipRun({ runId: claim.run.id, code: "execution_runtime_unavailable", message: `${target === "cloud" ? "Cloud" : "Desktop"} Automations are turned off for this organization.`, now })
      return null
    }
    if (!access.ok && shouldApplyAutomationModelAccessFailure({
      model: item.revision.model,
      failure: access,
      executionTarget: item.revision.executionTarget ?? "desktop",
      modelAttentionCapable: (item.revision.executionTarget ?? "desktop") === "cloud",
    })) {
      await this.skipRun({ runId: claim.run.id, code: access.code, message: access.message, now })
      await automationRepository.markNeedsAttention({
        automationId: item.automation.id,
        expectedRevisionId: item.revision.id,
        reason: { code: access.code, message: access.message, occurredAt: now },
        now,
      })
      return null
    }
    if (claim.run.executionTarget === "cloud") this.startCloudRun(claim.run.id)
    return claim.run.id
  }

  async stop(): Promise<void> {
  }

  registerDesktopRunner(scope: OwnerScope, registration: AutomationDesktopRunnerRegistration, authSessionId: string | null = null) {
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
      authSessionId,
      now: Date.now(),
    })
  }

  runnerStanding(scope: DesktopRunnerScope) {
    return runnerStanding(scope)
  }

  saveDesktopRunnerInventory(scope: DesktopRunnerScope, inventory: DesktopRunnerInventory) {
    return automationRepository.saveDesktopRunnerInventory({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      runnerId: scope.runnerId,
      inventory,
      now: Date.now(),
    })
  }

  saveDesktopRunnerSessions(scope: DesktopRunnerScope, report: StoredRunnerSessionReport) {
    return automationRepository.saveDesktopRunnerSessions({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      runnerId: scope.runnerId,
      access: report.access,
      sessions: report.sessions,
      now: Date.now(),
    })
  }

  touchDesktopRunner(scope: DesktopRunnerScope) {
    return automationRepository.touchDesktopRunner({ ...scope, now: Date.now() })
  }

  async desktopRunnerPresence(scope: OwnerScope): Promise<AutomationDesktopRunnerPresence> {
    const lastSeenAt = await automationRepository.desktopRunnerLastSeenAt(scope)
    return { connected: desktopRunnerConnected({ lastSeenAt, now: Date.now() }), lastSeenAt }
  }

  private async canRunScheduledAutomations(scope: DesktopRunnerScope) {
    if (scope.capabilities?.includes(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)) return false
    const registration = await automationRepository.desktopRunnerById(scope)
    return !registration?.capabilities.includes(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)
  }

  async discoverDesktopRunnerWork(scope: DesktopRunnerScope) {
    if (!await this.canRunScheduledAutomations(scope)) return []
    if (!await automationTargetAllowed(scope.organizationId, "desktop")) return []
    return automationRepository.discoverDesktopWork({ ...scope, now: Date.now(), limit: AUTOMATION_RUNNER_WORK_RUN_LIMIT })
  }

  async claimDesktopRunner(scope: DesktopRunnerScope, runId: string) {
    if (!await this.canRunScheduledAutomations(scope)) return null
    if (!await automationTargetAllowed(scope.organizationId, "desktop")) return null
    const claimed = await automationRepository.claimDesktop({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      leaseOwner: desktopLeaseOwner(scope),
      runId,
      leaseMs: env.automations.leaseMs,
      now: Date.now(),
    })
    if (!claimed?.run.leaseExpiresAt) return null
    const access = await resolveAutomationModelAccess({
      organizationId: scope.organizationId,
      ownerMemberId: scope.ownerMemberId,
      ...claimed.revision.model,
      executionTarget: "desktop",
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
    await recordAutomationRunCompleted({ runId, terminalAt: now, actor: { kind: "runner", runnerId: scope.runnerId, ownerMemberId: scope.ownerMemberId } })
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

  private async requireNewModel(scope: OwnerScope, model: ModelSelection, target: "desktop" | "cloud") {
    if (isAutomationCloudDefaultModel(model)
      && (target !== "cloud" || await this.cloudRuntime(scope.organizationId) !== "headless")) {
      const error = new Error("The cloud default model runs only cloud Automations on the headless runtime.")
      error.name = "model_access_lost"
      throw error
    }
    const result = await resolveAutomationModelAccess({ ...scope, ...model, executionTarget: target })
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
      executionTarget: item.revision.executionTarget ?? "desktop",
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
    if (!await automationTargetAllowed(target.organizationId, "cloud")) {
      await this.skipRun({ runId, code: "execution_runtime_unavailable", message: "Cloud Automations are turned off for this organization.", now: Date.now() })
      return
    }
    const runtime = await this.cloudRuntime(target.organizationId)
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
    const webAccess = headlessEngine || (runtime === "headless" && claimed.revision.action?.kind === "saved_script")
      ? { hasAccess: true }
      : await this.getOpenWorkWebAccess(claimed.automation.organizationId, { memberId: claimed.automation.ownerMemberId })
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
    const meeting = claimed.run.triggerContext
    const schedule = claimed.revision.schedule
    const runAction = meeting?.kind === "calendar_meeting" && schedule.kind === "calendar"
      ? { ...action, instructions: calendarTriggerPrompt({ instructions: action.instructions, trigger: schedule, meeting }) }
      : action
    let result: CloudAgentExecution
    try {
      const state = await automationRepository.cloudRunState(claimed.run.id)
      result = await executor({
        organizationId: claimed.automation.organizationId,
        ownerMemberId: claimed.automation.ownerMemberId,
        automationRunId: claimed.run.id,
        automationName: claimed.automation.name,
        action: runAction,
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
      resultSummary: result.ok ? result.resultSummary : result.resultSummary ?? result.message,
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
