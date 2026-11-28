import { createHash } from "node:crypto"
import {
  AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS,
  AUTOMATION_FREE_MODEL,
  AUTOMATION_MAXIMUM_ATTEMPTS,
  automationOccurrenceIdentity,
  automationRevisionDigest,
  computeAutomationClaimDeadline,
  desktopRunnerConnected,
  missedDesktopRunMessage,
  nextAutomationOccurrence,
} from "@openwork/automations"
import type {
  AutomationClaimResult,
  AutomationListItem,
  AutomationRepository,
} from "@openwork/automations"
import { REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY, REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY, REMOTE_SESSION_ONLY_RUNNER_CAPABILITY } from "@openwork/types/automations"
import type {
  Automation,
  AutomationAction,
  AutomationDesktopRunnerCapability,
  AutomationError,
  AutomationExecutionTarget,
  AutomationModel,
  AutomationRevision,
  AutomationRun,
  AutomationRunEvent,
  AutomationRunEventType,
  AutomationRunTriggerContext,
  AutomationSchedule,
  AutomationUsage,
  DesktopRunnerInventory,
  RemoteSessionAccessMode,
  RunnerReportedSession,
} from "@openwork/types/automations"
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  AutomationRevisionTable,
  AutomationRunnerTable,
  AutomationRunnerNotificationTable,
  AutomationRunEventTable,
  AutomationRunTable,
  AutomationTable,
  PersonalAgentTable,
  PersonalAgentShareTable,
  PersonalAgentAudienceTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { automationAffectedRows, automationUpdateChangedRows } from "./update-result.js"
import { cloudArtifactStateUpdate } from "./cloud-artifact-state.js"
import { requireCloudAgentRuntime } from "./runtime-limit.js"

type AutomationRow = typeof AutomationTable.$inferSelect
type AgentRow = typeof PersonalAgentTable.$inferSelect
type RevisionRow = typeof AutomationRevisionTable.$inferSelect
type RunRow = typeof AutomationRunTable.$inferSelect
type EventRow = typeof AutomationRunEventTable.$inferSelect
type DesktopClaim = { automation: Automation; revision: AutomationRevision; run: AutomationRun }

export const AUTOMATION_RUN_RANGE_MAX_ITEMS = 500

const logger = appLogger.child({ component: "automation_repository" })
const emptyUsage: AutomationUsage = { inputTokens: null, outputTokens: null, costMicros: null }
const interruptedDesktopRunMessage = "Run interrupted — the desktop execution lease expired."

const normalizeAutomationId = (value: string) => normalizeDenTypeId("automation", value)
const normalizeRevisionId = (value: string) => normalizeDenTypeId("automationRevision", value)
const normalizeRunId = (value: string) => normalizeDenTypeId("automationRun", value)
const normalizeOrganizationId = (value: string) => normalizeDenTypeId("organization", value)
const normalizeMemberId = (value: string) => normalizeDenTypeId("member", value)

const ms = (value: Date | null): number | null => value?.getTime() ?? null
const date = (value: number | null): Date | null => value === null ? null : new Date(value)
const idPrefix = (value: string) => value.slice(0, 8)

export function automationRunnerRowId(input: { organizationId: string; ownerMemberId: string; runnerId: string }) {
  const scope = `${normalizeOrganizationId(input.organizationId)}\n${normalizeMemberId(input.ownerMemberId)}\n${input.runnerId}`
  return `rnr_${createHash("sha256").update(scope).digest("hex")}`
}

export function automationRunnerComputerIds(input: { organizationId: string; ownerMemberId: string; runnerId: string }) {
  return [automationRunnerRowId(input), input.runnerId]
}

export type StoredRunnerSessionReport = { access: RemoteSessionAccessMode | null; sessions: RunnerReportedSession[] }

export function automationDesktopLeaseOwner(input: { ownerMemberId: string; runnerId: string }) {
  return `desktop:${input.ownerMemberId}:${input.runnerId}`
}

export function runWorkspaceId(
  revision: { executionTarget?: AutomationExecutionTarget | null; workspaceId?: string | null },
  runTarget: AutomationExecutionTarget,
): string | null {
  return (revision.executionTarget ?? "desktop") === runTarget ? revision.workspaceId ?? null : null
}

const pinnedWorkspaceMissedMessage = "Missed — no connected desktop has this Automation's workspace."

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerMemberId: row.owner_member_id,
    name: row.name,
    state: row.state,
    currentRevisionId: row.current_revision_id,
    nextDueAt: ms(row.next_due_at),
    latestRunAt: ms(row.latest_run_at),
    latestSuccessfulRunId: row.latest_successful_run_id,
    latestSuccessfulResult: row.latest_successful_result,
    needsAttentionReason: row.needs_attention_reason ?? null,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    archivedAt: ms(row.archived_at),
  }
}

function mapRevision(row: RevisionRow): AutomationRevision {
  const action: AutomationAction = row.action ?? {
    kind: "agent",
    instructions: row.instructions,
    model: { providerId: row.provider_id, modelId: row.model_id, variant: row.model_variant ?? null },
  }
  return {
    id: row.id,
    automationId: row.automation_id,
    version: row.version,
    instructions: row.instructions,
    schedule: row.schedule_config,
    model: { providerId: row.provider_id, modelId: row.model_id, variant: row.model_variant ?? null },
    action,
    executionTarget: row.execution_target,
    workspaceId: row.workspace_id ?? null,
    ...(row.agent_revision_id ? { agentRevisionId: row.agent_revision_id } : {}),
    maximumRuntimeMs: row.maximum_runtime_ms,
    digest: row.digest,
    createdAt: row.created_at.getTime(),
  }
}

function mapRun(row: RunRow): AutomationRun {
  const receipt = typeof row.engine_receipt === "object" && row.engine_receipt !== null
    ? row.engine_receipt as Record<string, unknown>
    : null
  const nativeThreadId = typeof receipt?.nativeThreadId === "string" ? receipt.nativeThreadId : null
  const workspaceId = typeof receipt?.workspaceId === "string" ? receipt.workspaceId : null
  return {
    id: row.id,
    automationId: row.automation_id,
    revisionId: row.revision_id,
    trigger: row.trigger,
    scheduledFor: ms(row.scheduled_for),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: ms(row.lease_expires_at),
    heartbeatAt: ms(row.heartbeat_at),
    attemptCount: row.attempt_count,
    executionTarget: row.execution_target,
    executionThread: row.engine_kind ? {
      id: row.cloud_thread_id,
      threadKind: "automation",
      executionLocation: row.execution_target,
      automationId: row.automation_id,
      automationRunId: row.id,
      engineKind: row.engine_kind,
      ...(nativeThreadId ? { nativeThreadId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    } : null,
    providerId: row.provider_id,
    modelId: row.model_id,
    modelVariant: row.model_variant ?? null,
    startedAt: ms(row.started_at),
    finishedAt: ms(row.finished_at),
    error: row.error ?? null,
    resultSummary: row.result_summary,
    codemodeReceiptId: row.codemode_receipt_id,
    validatedResult: row.validated_result,
    ...(row.trigger_context ? { triggerContext: row.trigger_context } : {}),
    usage: row.usage,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}

function normalizedDefinition(definition: Parameters<AutomationRepository["create"]>[0]["definition"]) {
  if ("action" in definition) {
    const model = definition.action.kind === "agent"
      ? definition.action.model
      : { providerId: AUTOMATION_FREE_MODEL.providerId, modelId: AUTOMATION_FREE_MODEL.modelId, variant: null }
    return {
      name: definition.name,
      schedule: definition.schedule,
      action: definition.action,
      executionTarget: definition.executionTarget,
      instructions: definition.action.kind === "agent" ? definition.action.instructions : "Execute the pinned Workflow.",
      model,
      workspaceId: null,
    }
  }
  return {
    name: definition.name,
    schedule: definition.schedule,
    action: { kind: "agent", instructions: definition.instructions, model: definition.model } satisfies AutomationAction,
    executionTarget: "desktop" as const,
    instructions: definition.instructions,
    model: definition.model,
    workspaceId: definition.workspaceId ?? null,
  }
}

function mapEvent(row: EventRow): AutomationRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    attempt: row.attempt,
    sequence: row.sequence,
    type: row.event_type,
    payload: row.payload,
    createdAt: row.created_at.getTime(),
  }
}

type RunAudience = { actingMemberId?: string | null; includeOwnerRuns?: boolean }

function runActorFilter(audience: RunAudience = {}) {
  const ownerRuns = isNull(AutomationRunTable.acting_member_id)
  if (!audience.actingMemberId) return ownerRuns
  const ownRuns = eq(AutomationRunTable.acting_member_id, normalizeMemberId(audience.actingMemberId))
  return audience.includeOwnerRuns ? or(ownRuns, ownerRuns) : ownRuns
}

function personalAgentRunSummaryFilter(audience: RunAudience, agentId: AgentRow["id"]) {
  const scheduled = ne(AutomationRunTable.trigger, "manual")
  if (audience.includeOwnerRuns) return or(runActorFilter(audience), scheduled)
  if (!audience.actingMemberId) return runActorFilter(audience)
  const memberId = normalizeMemberId(audience.actingMemberId)
  const shares = db.$primary.select({ id: PersonalAgentShareTable.id }).from(PersonalAgentShareTable).where(and(
    eq(PersonalAgentShareTable.agent_id, agentId), eq(PersonalAgentShareTable.member_id, memberId),
    lte(PersonalAgentShareTable.created_at, AutomationRunTable.created_at),
  ))
  const audiences = db.$primary.select({ id: PersonalAgentAudienceTable.id }).from(PersonalAgentAudienceTable)
    .leftJoin(TeamTable, and(eq(TeamTable.id, PersonalAgentAudienceTable.team_id), eq(TeamTable.organizationId, PersonalAgentAudienceTable.organization_id)))
    .leftJoin(TeamMemberTable, and(eq(TeamMemberTable.teamId, TeamTable.id), eq(TeamMemberTable.orgMembershipId, memberId)))
    .where(and(eq(PersonalAgentAudienceTable.agent_id, agentId), lte(PersonalAgentAudienceTable.created_at, AutomationRunTable.created_at),
      or(eq(PersonalAgentAudienceTable.audience_key, "organization"), lte(TeamMemberTable.createdAt, AutomationRunTable.created_at))))
  return or(and(eq(AutomationRunTable.trigger, "manual"), runActorFilter(audience)), and(scheduled, or(sql`exists (${shares})`, sql`exists (${audiences})`)))
}

function mapPersonalAgentRunSummary(row: RunRow, audience: RunAudience): AutomationRun {
  const ownRun = row.acting_member_id === null ? audience.includeOwnerRuns
    : audience.actingMemberId && row.acting_member_id === normalizeMemberId(audience.actingMemberId)
  const run = mapRun(row)
  if (ownRun) return run
  const { triggerContext, ...summary } = run
  return { ...summary, executionThread: null, codemodeReceiptId: null, validatedResult: null, error: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null }
}

async function latestRun(automationId: AutomationRow["id"], audience?: RunAudience, agentId?: AgentRow["id"]): Promise<AutomationRun | null> {
  const rows = await db.$primary.select().from(AutomationRunTable)
    .where(and(eq(AutomationRunTable.automation_id, automationId), agentId ? personalAgentRunSummaryFilter(audience ?? {}, agentId) : audience ? runActorFilter(audience) : undefined))
    .orderBy(desc(AutomationRunTable.created_at), desc(AutomationRunTable.id)).limit(1)
  const [run] = rows
  if (!run) return null
  return agentId ? mapPersonalAgentRunSummary(run, audience ?? {}) : mapRun(run)
}

async function itemFromRows(automation: AutomationRow, revision: RevisionRow): Promise<AutomationListItem> {
  const run = await latestRun(automation.id, automation.agent_id ? { actingMemberId: automation.owner_member_id, includeOwnerRuns: true } : undefined)
  const mapped = mapAutomation(automation)
  return { automation: automation.agent_id ? { ...mapped, latestRunAt: run?.createdAt ?? null } : mapped, revision: mapRevision(revision), latestRun: run }
}

async function itemsFromRows(automations: AutomationRow[], memberId?: string): Promise<AutomationListItem[]> {
  if (automations.length === 0) return []

  const latestRunConditions = automations.flatMap((automation) => !automation.agent_id && automation.latest_run_at
    ? [and(
        eq(AutomationRunTable.automation_id, automation.id),
        eq(AutomationRunTable.created_at, automation.latest_run_at),
      )]
    : [])
  const [revisions, latestRuns] = await Promise.all([
    (automations.some((automation) => automation.agent_id) ? db.$primary : db).select().from(AutomationRevisionTable).where(inArray(
      AutomationRevisionTable.id,
      automations.map((automation) => automation.current_revision_id),
    )),
    latestRunConditions.length === 0
      ? Promise.resolve([])
      : db.select().from(AutomationRunTable)
          .where(or(...latestRunConditions))
          .orderBy(desc(AutomationRunTable.created_at), desc(AutomationRunTable.id)),
  ])
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
  const latestRunByAutomationId = new Map<string, RunRow>()
  for (const run of latestRuns) {
    if (!latestRunByAutomationId.has(run.automation_id)) {
      latestRunByAutomationId.set(run.automation_id, run)
    }
  }

  return Promise.all(automations.map(async (automation) => {
    const revision = revisionById.get(automation.current_revision_id)
    if (!revision) throw new Error("automation_revision_not_found")
    const row = latestRunByAutomationId.get(automation.id)
    const run = automation.agent_id
      ? memberId ? await latestRun(automation.id, { actingMemberId: memberId, includeOwnerRuns: memberId === automation.owner_member_id }, automation.agent_id) : null
      : row ? mapRun(row) : null
    return {
      automation: { ...mapAutomation(automation), ...(automation.agent_id ? { latestRunAt: run?.createdAt ?? null } : {}) },
      revision: mapRevision(revision),
      latestRun: run,
    }
  }))
}

function isLockConflict(error: unknown): boolean {
  const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : error
  return typeof cause === "object" && cause !== null && "code" in cause
    && (cause.code === "ER_LOCK_DEADLOCK" || cause.code === "ER_LOCK_WAIT_TIMEOUT")
}

function nextDueForSubmittedSchedule(schedule: AutomationSchedule, now: number) {
  if (schedule.kind !== "once") return nextAutomationOccurrence(schedule, now)
  if (schedule.at < now - 60_000) throw new Error("automation_once_time_in_past")
  return schedule.at
}

function personalAgentQueueHead() {
  return sql`not exists (
    select 1 from ${AutomationRunTable} as sibling
    where sibling.automation_id = ${AutomationRunTable.automation_id}
      and (sibling.status in ('claimed', 'running')
        or (sibling.status = 'queued' and (sibling.created_at, sibling.id) < (${AutomationRunTable.created_at}, ${AutomationRunTable.id})))
  )`
}

export class DenAutomationRepository implements AutomationRepository {
  async listQueuedCloud(input: { limit: number }): Promise<string[]> {
    const queued = and(eq(AutomationRunTable.status, "queued"), eq(AutomationRunTable.execution_target, "cloud"))
    const cloud = env.features.deployment === "cloud"
    const rows = await (cloud
      ? db.select({ id: AutomationRunTable.id }).from(AutomationRunTable)
        .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
        .where(and(queued, or(isNull(AutomationTable.agent_id), personalAgentQueueHead())))
      : db.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(queued)
    ).orderBy(asc(AutomationRunTable.created_at), asc(AutomationRunTable.id)).limit(input.limit)
    return rows.map((row) => row.id)
  }
  async create(input: Parameters<AutomationRepository["create"]>[0] & {
    agent?: { agentId: string }
    tx?: AutomationTransaction
  }): Promise<AutomationListItem> {
    const definition = normalizedDefinition(input.definition)
    const now = new Date(input.now)
    const newAutomationId = createDenTypeId("automation")
    const newRevisionId = createDenTypeId("automationRevision")
    const maximumRuntimeMs = AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS
    const organizationId = normalizeOrganizationId(input.organizationId)
    const ownerMemberId = normalizeMemberId(input.ownerMemberId)
    const nextDueAt = nextDueForSubmittedSchedule(definition.schedule, input.now)
    const write = async (tx: AutomationTransaction) => {
      let agent: { id: AgentRow["id"]; revisionId: AgentRow["current_revision_id"] } | null = null
      if (input.agent) {
        const [owned] = await tx.select().from(PersonalAgentTable).where(and(
          eq(PersonalAgentTable.id, normalizeDenTypeId("personalAgent", input.agent.agentId)),
          eq(PersonalAgentTable.organization_id, organizationId),
          eq(PersonalAgentTable.owner_member_id, ownerMemberId),
          eq(PersonalAgentTable.state, "active"),
        )).limit(1).for("share")
        if (!owned) throw new Error("personal_agent_not_found")
        agent = { id: owned.id, revisionId: owned.current_revision_id }
      }
      await tx.insert(AutomationRevisionTable).values({
        id: newRevisionId,
        automation_id: newAutomationId,
        version: 1,
        instructions: definition.instructions,
        schedule_kind: definition.schedule.kind,
        schedule_config: definition.schedule,
        timezone: definition.schedule.timezone,
        provider_id: definition.model.providerId,
        model_id: definition.model.modelId,
        model_variant: definition.model.variant ?? null,
        action: definition.action,
        execution_target: definition.executionTarget,
        workspace_id: definition.workspaceId,
        agent_revision_id: agent?.revisionId ?? null,
        maximum_runtime_ms: maximumRuntimeMs,
        digest: automationRevisionDigest({
          instructions: definition.instructions,
          schedule: definition.schedule,
          model: definition.model,
          action: definition.action,
          executionTarget: definition.executionTarget,
          maximumRuntimeMs,
          ...(definition.workspaceId ? { workspaceId: definition.workspaceId } : {}),
          ...(agent ? { agentRevisionId: agent.revisionId } : {}),
        }),
        created_at: now,
      })
      await tx.insert(AutomationTable).values({
        id: newAutomationId,
        organization_id: organizationId,
        owner_member_id: ownerMemberId,
        name: definition.name,
        state: input.initialState ?? "active",
        current_revision_id: newRevisionId,
        next_due_at: input.initialState === "inactive" ? null : date(nextDueAt),
        needs_attention_reason: null,
        agent_id: agent?.id ?? null,
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
    }
    await (input.tx ? write(input.tx) : db.transaction(write))
    const created = await this.get({
      organizationId: input.organizationId,
      ownerMemberId: input.ownerMemberId,
      automationId: newAutomationId,
      tx: input.tx,
    })
    if (!created) throw new Error("automation_create_not_durable")
    return created
  }

  async update(input: Parameters<AutomationRepository["update"]>[0] & { tx?: AutomationTransaction }): Promise<AutomationListItem> {
    const write = async (tx: AutomationTransaction) => {
      const automationRows = await tx.select().from(AutomationTable).where(and(
        eq(AutomationTable.id, normalizeAutomationId(input.automationId)),
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      )).limit(1).for("update")
      const automation = automationRows[0]
      if (!automation || automation.state === "archived") throw new Error("automation_not_found")
      const revisionRows = await tx.select().from(AutomationRevisionTable)
        .where(eq(AutomationRevisionTable.id, automation.current_revision_id)).limit(1)
      const current = revisionRows[0]
      if (!current) throw new Error("automation_revision_not_found")
      const currentAction: AutomationAction = current.action ?? {
        kind: "agent",
        instructions: current.instructions,
        model: { providerId: current.provider_id, modelId: current.model_id, variant: current.model_variant ?? null },
      }
      const action = input.changes.action ?? (currentAction.kind === "agent"
        ? {
            ...currentAction,
            instructions: input.changes.instructions ?? currentAction.instructions,
            model: input.changes.model ?? currentAction.model,
          }
        : currentAction)
      const executionTarget = input.changes.executionTarget ?? current.execution_target
      if (executionTarget === "desktop" && action.kind === "saved_script") throw new Error("automation_action_target_mismatch")
      const instructions = action.kind === "agent" ? action.instructions : "Execute the pinned Workflow."
      const schedule = input.changes.schedule ?? current.schedule_config
      const nextDueAt = input.changes.schedule
        ? nextDueForSubmittedSchedule(schedule, input.now)
        : nextAutomationOccurrence(schedule, input.now)
      const model = action.kind === "agent"
        ? action.model
        : { providerId: AUTOMATION_FREE_MODEL.providerId, modelId: AUTOMATION_FREE_MODEL.modelId, variant: null }
      const workspaceId = input.changes.workspaceId !== undefined
        ? input.changes.workspaceId
        : executionTarget === current.execution_target ? current.workspace_id ?? null : null
      const newRevisionId = createDenTypeId("automationRevision")
      const maximumRuntimeMs = input.changes.maximumRuntimeMs ?? current.maximum_runtime_ms
      if (input.changes.maximumRuntimeMs !== undefined || maximumRuntimeMs > AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS) {
        requireCloudAgentRuntime(executionTarget, action)
      }
      const digest = automationRevisionDigest({
        instructions,
        schedule,
        model,
        action,
        executionTarget,
        maximumRuntimeMs,
        ...(workspaceId ? { workspaceId } : {}),
        ...(current.agent_revision_id ? { agentRevisionId: current.agent_revision_id } : {}),
      })
      if (digest === current.digest) {
        await tx.update(AutomationTable).set({
          name: input.changes.name ?? automation.name,
          updated_at: new Date(input.now),
        }).where(eq(AutomationTable.id, automation.id))
        return
      }
      await tx.insert(AutomationRevisionTable).values({
        id: newRevisionId,
        automation_id: automation.id,
        version: current.version + 1,
        instructions,
        schedule_kind: schedule.kind,
        schedule_config: schedule,
        timezone: schedule.timezone,
        provider_id: model.providerId,
        model_id: model.modelId,
        model_variant: model.variant ?? null,
        action,
        execution_target: executionTarget,
        workspace_id: workspaceId,
        agent_revision_id: current.agent_revision_id,
        maximum_runtime_ms: maximumRuntimeMs,
        digest,
        created_at: new Date(input.now),
      })
      await tx.update(AutomationTable).set({
        name: input.changes.name ?? automation.name,
        current_revision_id: newRevisionId,
        next_due_at: date(nextDueAt),
        state: "active",
        needs_attention_reason: null,
        updated_at: new Date(input.now),
      }).where(eq(AutomationTable.id, automation.id))
    }
    await (input.tx ? write(input.tx) : db.transaction(write))
    const updated = await this.get(input)
    if (!updated) throw new Error("automation_update_not_durable")
    return updated
  }

  async list(input: Parameters<AutomationRepository["list"]>[0]): Promise<Awaited<ReturnType<AutomationRepository["list"]>>> {
    const limit = Math.max(1, Math.min(input.limit, 100))
    const conditions = [
      eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    ]
    if (input.cursor) conditions.push(lt(AutomationTable.id, normalizeAutomationId(input.cursor)))
    const rows = await db.select().from(AutomationTable).where(and(...conditions))
      .orderBy(desc(AutomationTable.id)).limit(limit + 1)
    const selected = rows.slice(0, limit)
    return {
      items: await itemsFromRows(selected),
      nextCursor: rows.length > limit ? selected.at(-1)?.id ?? null : null,
    }
  }

  async get(input: Parameters<AutomationRepository["get"]>[0] & { tx?: AutomationTransaction }): Promise<AutomationListItem | null> {
    const rows = await (input.tx ?? db.$primary).select().from(AutomationTable).where(and(
      eq(AutomationTable.id, normalizeAutomationId(input.automationId)),
      eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    )).limit(1)
    if (!rows[0]) return null
    const revisions = await (input.tx ?? db.$primary).select().from(AutomationRevisionTable)
      .where(eq(AutomationRevisionTable.id, rows[0].current_revision_id)).limit(1)
    return revisions[0] ? (input.tx ? { automation: mapAutomation(rows[0]), revision: mapRevision(revisions[0]), latestRun: null } : itemFromRows(rows[0], revisions[0])) : null
  }

  async setState(input: Parameters<AutomationRepository["setState"]>[0] & { tx?: AutomationTransaction; beforeAgentStateChange?: (automation: Automation) => Promise<void> }): Promise<AutomationListItem | null> {
    const current = await this.get(input)
    if (!current) return null
    if (current.automation.agentId) await input.beforeAgentStateChange?.(current.automation)
    const same = current.automation.state === input.state
    if (!same) {
      await (input.tx ?? db).update(AutomationTable).set({
        state: input.state,
        next_due_at: input.state === "active"
          ? date(nextAutomationOccurrence(current.revision.schedule, input.now))
          : null,
        archived_at: input.state === "archived" ? new Date(input.now) : null,
        needs_attention_reason: null,
        updated_at: new Date(input.now),
      }).where(and(
        eq(AutomationTable.id, normalizeAutomationId(current.automation.id)),
        current.automation.agentId && input.state !== "archived" ? and(
          ne(AutomationTable.state, "archived"),
          eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
        ) : undefined,
      ))
    }
    const updated = await this.get(input)
    if (current.automation.agentId && input.state !== "archived" && updated?.automation.state === "archived") return null
    return updated
  }

  async listActiveCalendarTriggers(input: { limit: number }): Promise<AutomationListItem[]> {
    const rows = await db.select({ automation: AutomationTable }).from(AutomationTable)
      .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationTable.current_revision_id))
      .where(and(
        eq(AutomationTable.state, "active"),
        eq(AutomationRevisionTable.schedule_kind, "calendar"),
        eq(AutomationRevisionTable.execution_target, "cloud"),
      ))
      .orderBy(asc(AutomationTable.id)).limit(input.limit)
    return itemsFromRows(rows.map((row) => row.automation))
  }

  async listDue(input: Parameters<AutomationRepository["listDue"]>[0]): Promise<AutomationListItem[]> {
    const rows = await db.select().from(AutomationTable).where(and(
      eq(AutomationTable.state, "active"),
      lte(AutomationTable.next_due_at, new Date(input.now)),
    )).orderBy(asc(AutomationTable.next_due_at), asc(AutomationTable.id)).limit(input.limit)
    return itemsFromRows(rows)
  }

  async claim(input: Parameters<AutomationRepository["claim"]>[0] & {
    triggerContext?: AutomationRunTriggerContext | null
    actingMemberId?: string
  }): Promise<AutomationClaimResult> {
    return db.transaction(async (tx) => {
      const locked = await tx.select().from(AutomationTable)
        .where(eq(AutomationTable.id, normalizeAutomationId(input.automation.id))).limit(1).for("update")
      const [current] = locked
      if (!current) throw new Error("automation_not_active")
      const currentState = current.state
      const canRun = input.trigger === "manual"
        ? currentState === "active" || currentState === "inactive"
        : currentState === "active"
      if (!canRun) throw new Error("automation_not_active")
      const repinned = locked[0]?.agent_id && locked[0].current_revision_id !== input.revision.id
        ? await tx.select().from(AutomationRevisionTable)
            .where(eq(AutomationRevisionTable.id, locked[0].current_revision_id)).limit(1)
        : []
      const revision = repinned[0] ? mapRevision(repinned[0]) : input.revision
      const identity = automationOccurrenceIdentity({
        automationId: input.automation.id,
        scheduledFor: input.scheduledFor,
        nonce: input.nonce,
      })
      const duplicates = await tx.select().from(AutomationRunTable)
        .where(eq(AutomationRunTable.idempotency_key, identity.idempotencyKey)).limit(1)
      if (duplicates[0]) return { kind: "duplicate", run: mapRun(duplicates[0]) }
      const queueManual = current.agent_id !== null && input.trigger === "manual"
      const queued = queueManual ? await tx.select({ createdAt: AutomationRunTable.created_at, trigger: AutomationRunTable.trigger })
        .from(AutomationRunTable).where(and(
          eq(AutomationRunTable.automation_id, current.id), eq(AutomationRunTable.status, "queued"),
        )).orderBy(desc(AutomationRunTable.created_at), desc(AutomationRunTable.id)) : []
      if (queued.filter((run) => run.trigger === "manual").length >= 5) throw new Error("personal_agent_run_queue_full")
      const createdAt = new Date(Math.max(input.now, queued[0] ? queued[0].createdAt.getTime() + 1 : input.now))
      const active = queueManual ? [] : await tx.select().from(AutomationRunTable).where(and(
        eq(AutomationRunTable.automation_id, current.id),
        inArray(AutomationRunTable.status, ["queued", "claimed", "running"]),
      )).limit(1)
      const overlap = active.length > 0
      const newRunId = createDenTypeId("automationRun")
      const newCloudThreadId = createDenTypeId("automationThread")
      const nextDueAt = input.trigger === "manual"
        ? ms(current.next_due_at)
        : nextAutomationOccurrence(revision.schedule, input.scheduledFor ?? input.now)
      const claimDeadlineAt = computeAutomationClaimDeadline({
        trigger: input.trigger,
        now: input.now,
        windowMs: input.claimDeadlineMs ?? input.leaseMs,
        nextDueAt,
      })
      await tx.insert(AutomationRunTable).values({
        id: newRunId,
        acting_member_id: current.agent_id
          ? input.trigger === "manual" && input.actingMemberId ? normalizeMemberId(input.actingMemberId) : current.owner_member_id
          : null,
        automation_id: normalizeAutomationId(input.automation.id),
        revision_id: normalizeRevisionId(revision.id),
        trigger: input.trigger,
        scheduled_for: date(input.scheduledFor),
        idempotency_key: identity.idempotencyKey,
        status: overlap ? "skipped" : "queued",
        execution_target: revision.executionTarget ?? "desktop",
        claim_deadline_at: overlap ? null : new Date(claimDeadlineAt),
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        attempt_count: 0,
        cloud_thread_id: newCloudThreadId,
        engine_kind: null,
        engine_receipt: null,
        engine_sequence: 0,
        engine_admitted_at: null,
        provider_id: revision.model.providerId,
        model_id: revision.model.modelId,
        model_variant: revision.model.variant ?? null,
        finished_at: overlap ? new Date(input.now) : null,
        error: null,
        result_summary: overlap ? "Skipped because another occurrence is already active." : null,
        trigger_context: input.triggerContext ?? null,
        usage: emptyUsage,
        created_at: createdAt,
        updated_at: createdAt,
      })
      if (!overlap && (revision.executionTarget ?? "desktop") === "desktop") {
        await tx.insert(AutomationRunnerNotificationTable).values({
          organization_id: normalizeOrganizationId(input.automation.organizationId),
          owner_member_id: normalizeMemberId(input.automation.ownerMemberId),
          event_type: "work_available",
          run_id: newRunId,
          created_at: new Date(input.now),
        })
      }
      await tx.update(AutomationTable).set({
        ...(input.trigger === "manual" ? {} : { next_due_at: date(nextDueAt) }),
        latest_run_at: new Date(input.now),
        updated_at: input.trigger === "manual" ? current.updated_at : new Date(input.now),
      }).where(eq(AutomationTable.id, normalizeAutomationId(input.automation.id)))
      const runRows = await tx.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, newRunId)).limit(1)
      if (!runRows[0]) throw new Error("automation_run_not_durable")
      return overlap
        ? { kind: "overlap", run: mapRun(runRows[0]) }
        : { kind: "claimed", run: mapRun(runRows[0]), revision }
    })
  }

  async recordSkippedManual(input: {
    organizationId: string
    ownerMemberId: string
    actingMemberId?: string
    automation: Automation
    revision: AutomationRevision
    nonce: string
    code: AutomationError["code"]
    message: string
    now: number
  }): Promise<AutomationRun> {
    return db.transaction(async (tx) => {
      const automationId = normalizeAutomationId(input.automation.id)
      const revisionId = normalizeRevisionId(input.revision.id)
      const locked = await tx.select().from(AutomationTable).where(and(
        eq(AutomationTable.id, automationId),
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      )).limit(1).for("update")
      if (!locked[0] || locked[0].state === "archived") throw new Error("automation_not_found")
      if (locked[0].current_revision_id !== revisionId) throw new Error("automation_revision_changed")

      const identity = automationOccurrenceIdentity({
        automationId: input.automation.id,
        scheduledFor: null,
        nonce: input.nonce,
      })
      const runId = createDenTypeId("automationRun")
      await tx.insert(AutomationRunTable).values({
        id: runId,
        acting_member_id: locked[0].agent_id ? normalizeMemberId(input.actingMemberId ?? input.ownerMemberId) : null,
        automation_id: automationId,
        revision_id: revisionId,
        trigger: "manual",
        scheduled_for: null,
        idempotency_key: identity.idempotencyKey,
        status: "skipped",
        execution_target: input.revision.executionTarget ?? "desktop",
        claim_deadline_at: null,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        attempt_count: 0,
        cloud_thread_id: createDenTypeId("automationThread"),
        engine_kind: null,
        engine_receipt: null,
        engine_sequence: 0,
        engine_admitted_at: null,
        provider_id: input.revision.model.providerId,
        model_id: input.revision.model.modelId,
        model_variant: input.revision.model.variant ?? null,
        finished_at: new Date(input.now),
        error: { code: input.code, message: input.message, retryable: false },
        result_summary: input.message,
        usage: emptyUsage,
        created_at: new Date(input.now),
        updated_at: new Date(input.now),
      })
      await tx.update(AutomationTable).set({
        latest_run_at: new Date(input.now),
        updated_at: locked[0].updated_at,
      }).where(eq(AutomationTable.id, automationId))
      const rows = await tx.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, runId)).limit(1)
      if (!rows[0]) throw new Error("automation_run_not_durable")
      return mapRun(rows[0])
    })
  }

  async cloudRunTarget(runId: string): Promise<{
    organizationId: string
    ownerMemberId: string
    actingMemberId: string | null
    actionKind: "agent" | "saved_script" | null
    engineKind: string | null
    model: { providerId: string; modelId: string }
  } | null> {
    const rows = await db.$primary.select({
      organizationId: AutomationTable.organization_id,
      ownerMemberId: AutomationTable.owner_member_id,
      actingMemberId: AutomationRunTable.acting_member_id,
      engineKind: AutomationRunTable.engine_kind,
      providerId: AutomationRunTable.provider_id,
      modelId: AutomationRunTable.model_id,
      action: AutomationRevisionTable.action,
    }).from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationRunTable.revision_id))
      .where(and(eq(AutomationRunTable.id, normalizeRunId(runId)), eq(AutomationRunTable.execution_target, "cloud")))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      organizationId: row.organizationId,
      ownerMemberId: row.ownerMemberId,
      actingMemberId: row.actingMemberId,
      actionKind: row.action?.kind ?? null,
      engineKind: row.engineKind ?? null,
      model: { providerId: row.providerId, modelId: row.modelId },
    }
  }

  async claimCloud(input: {
    runId: string
    leaseOwner: string
    leaseMs: number
    maxConcurrency: number
    engineKind?: string
    headlessEngineKind?: string
    now: number
  }): Promise<(DesktopClaim & { actingMemberId: string | null }) | null> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.claimCloudOnce(input)
      } catch (error) {
        if (attempt >= 3 || !isLockConflict(error)) throw error
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.random() * 25))
      }
    }
  }

  private async claimCloudOnce(input: Parameters<DenAutomationRepository["claimCloud"]>[0]): Promise<(DesktopClaim & { actingMemberId: string | null }) | null> {
    return db.transaction(async (tx) => {
      const headless = input.headlessEngineKind ?? null
      const pool = headless === null
        ? undefined
        : input.engineKind === headless
          ? eq(AutomationRunTable.engine_kind, headless)
          : or(isNull(AutomationRunTable.engine_kind), ne(AutomationRunTable.engine_kind, headless))
      const active = await tx.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(and(
        eq(AutomationRunTable.execution_target, "cloud"),
        inArray(AutomationRunTable.status, ["claimed", "running"]),
        pool,
      )).limit(input.maxConcurrency).for("update")
      if (active.length >= input.maxConcurrency) return null
      const rows = await tx.select({ run: AutomationRunTable, automation: AutomationTable })
        .from(AutomationRunTable)
        .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
        .where(and(
          eq(AutomationRunTable.id, normalizeRunId(input.runId)),
          eq(AutomationRunTable.status, "queued"),
          eq(AutomationRunTable.execution_target, "cloud"),
        )).limit(1).for("update")
      const selected = rows[0]
      if (!selected) return null
      if (selected.automation.agent_id) {
        const message = selected.automation.state === "archived" ? "This routine was archived, so it did not run."
          : selected.run.trigger !== "manual" && selected.run.acting_member_id !== selected.automation.owner_member_id
            ? "This agent changed owners, so this scheduled run did not start." : null
        if (message) {
          await tx.update(AutomationRunTable).set({ status: "cancelled", finished_at: new Date(input.now), updated_at: new Date(input.now), result_summary: message })
            .where(eq(AutomationRunTable.id, selected.run.id))
          return null
        }
        const blocking = await tx.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(and(
          eq(AutomationRunTable.automation_id, selected.automation.id),
          or(
            inArray(AutomationRunTable.status, ["claimed", "running"]),
            and(eq(AutomationRunTable.status, "queued"), or(
              lt(AutomationRunTable.created_at, selected.run.created_at),
              and(eq(AutomationRunTable.created_at, selected.run.created_at), lt(AutomationRunTable.id, selected.run.id)),
            )),
          ),
        )).limit(1).for("update")
        if (blocking.length) return null
      }
      const revisions = await tx.select().from(AutomationRevisionTable)
        .where(eq(AutomationRevisionTable.id, selected.run.revision_id)).limit(1)
      const revision = revisions[0]
      if (!revision) return null
      const engineKind = revision.action?.kind === "saved_script"
        ? "openwork-cloud-codemode-v1"
        : input.engineKind ?? "openwork-cloud-agent-v1"
      await tx.update(AutomationRunTable).set({
        status: "running",
        lease_owner: input.leaseOwner,
        lease_expires_at: new Date(input.now + input.leaseMs),
        heartbeat_at: new Date(input.now),
        attempt_count: selected.run.attempt_count + 1,
        engine_kind: selected.run.engine_kind ?? engineKind,
        started_at: selected.run.started_at ?? new Date(input.now),
        updated_at: new Date(input.now),
      }).where(and(eq(AutomationRunTable.id, selected.run.id), eq(AutomationRunTable.status, "queued")))
      const currentRuns = await tx.select().from(AutomationRunTable)
        .where(eq(AutomationRunTable.id, selected.run.id)).limit(1)
      if (!currentRuns[0]) return null
      return {
        automation: mapAutomation(selected.automation),
        revision: mapRevision(revision),
        run: mapRun(currentRuns[0]),
        actingMemberId: currentRuns[0].acting_member_id,
      }
    }, { isolationLevel: "serializable", accessMode: "read write" })
  }

  async setCloudExecution(input: {
    runId: string
    leaseOwner: string
    engineKind: string
    receipt: Record<string, unknown>
    now: number
  }): Promise<void> {
    const result: unknown = await db.update(AutomationRunTable).set({
      engine_kind: input.engineKind,
      engine_receipt: input.receipt,
      engine_admitted_at: new Date(input.now),
      updated_at: new Date(input.now),
    }).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      eq(AutomationRunTable.status, "running"),
    ))
    if (!automationUpdateChangedRows(result)) throw new Error("automation_run_lease_lost")
  }

  async heartbeatCloud(input: { runId: string; leaseOwner: string; leaseMs: number; now: number }): Promise<boolean> {
    const result: unknown = await db.update(AutomationRunTable).set({
      heartbeat_at: new Date(input.now),
      lease_expires_at: new Date(input.now + input.leaseMs),
      updated_at: new Date(input.now),
    }).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      eq(AutomationRunTable.status, "running"),
      gt(AutomationRunTable.lease_expires_at, new Date(input.now)),
    ))
    return automationUpdateChangedRows(result)
  }

  async cloudRunState(runId: string): Promise<{ cancelRequested: boolean; receipt: Record<string, unknown> | null } | null> {
    const rows = await db.$primary.select({
      cancelRequestedAt: AutomationRunTable.cancel_requested_at,
      receipt: AutomationRunTable.engine_receipt,
    }).from(AutomationRunTable).where(and(
      eq(AutomationRunTable.id, normalizeRunId(runId)),
      eq(AutomationRunTable.execution_target, "cloud"),
      eq(AutomationRunTable.status, "running"),
    )).limit(1)
    return rows[0] ? { cancelRequested: Boolean(rows[0].cancelRequestedAt), receipt: rows[0].receipt } : null
  }

  async setCloudRunModel(input: { runId: string; leaseOwner: string; model: AutomationModel }): Promise<void> {
    await db.update(AutomationRunTable).set({ provider_id: input.model.providerId, model_id: input.model.modelId }).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      eq(AutomationRunTable.status, "running"),
    ))
  }

  async completeCloud(input: {
    automationId: string
    runId: string
    leaseOwner: string
    status: "succeeded" | "failed" | "cancelled"
    resultSummary: string
    validatedResult?: unknown
    codemodeReceiptId?: string | null
    usage?: AutomationUsage
    updateArtifactState?: boolean
    error: AutomationError | null
    now: number
  }): Promise<AutomationRun> {
    const completed = await this.complete({
      runId: input.runId,
      leaseOwner: input.leaseOwner,
      status: input.status,
      resultSummary: input.resultSummary,
      usage: input.usage ?? emptyUsage,
      error: input.error,
      now: input.now,
    })
    await db.update(AutomationRunTable).set({
      codemode_receipt_id: input.codemodeReceiptId ? normalizeDenTypeId("workflowRun", input.codemodeReceiptId) : null,
      validated_result: input.validatedResult,
      updated_at: new Date(input.now),
    }).where(eq(AutomationRunTable.id, normalizeRunId(input.runId)))
    const artifactState = cloudArtifactStateUpdate({
      runId: input.runId,
      result: input.status === "succeeded"
        ? { ok: true, value: input.validatedResult }
        : { ok: false, message: input.error?.message ?? input.resultSummary },
      now: input.now,
    })
    if (input.updateArtifactState === false) {
      const refreshed = await this.runById(completed.id)
      if (!refreshed) throw new Error("automation_cloud_result_not_durable")
      return refreshed
    }
    if (artifactState.kind === "succeeded") {
      await db.update(AutomationTable).set({
        latest_successful_run_id: normalizeRunId(artifactState.latestSuccessfulRunId),
        latest_successful_result: artifactState.latestSuccessfulResult,
        state: artifactState.state,
        needs_attention_reason: artifactState.needsAttentionReason,
        updated_at: new Date(input.now),
      }).where(eq(AutomationTable.id, normalizeAutomationId(input.automationId)))
    } else {
      await db.update(AutomationTable).set({
        state: artifactState.state,
        needs_attention_reason: artifactState.needsAttentionReason,
        updated_at: new Date(input.now),
      }).where(eq(AutomationTable.id, normalizeAutomationId(input.automationId)))
    }
    const refreshed = await this.runById(completed.id)
    if (!refreshed) throw new Error("automation_cloud_result_not_durable")
    return refreshed
  }

  async heartbeat(input: Parameters<AutomationRepository["heartbeat"]>[0]): Promise<boolean> {
    await db.update(AutomationRunTable).set({
      heartbeat_at: new Date(input.now),
      lease_expires_at: new Date(input.now + input.leaseMs),
      updated_at: new Date(input.now),
    }).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      inArray(AutomationRunTable.status, ["claimed", "running"]),
    ))
    const rows = await db.$primary.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)), eq(AutomationRunTable.lease_owner, input.leaseOwner),
      inArray(AutomationRunTable.status, ["claimed", "running"]),
    )).limit(1)
    return rows.length === 1
  }

  async appendEvent(input: Parameters<AutomationRepository["appendEvent"]>[0]): Promise<AutomationRunEvent> {
    return db.transaction(async (tx) => {
      const runs = await tx.select().from(AutomationRunTable).where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)), eq(AutomationRunTable.lease_owner, input.leaseOwner),
        inArray(AutomationRunTable.status, ["claimed", "running"]),
      )).limit(1).for("update")
      if (!runs[0]) throw new Error("automation_run_lease_lost")
      const attempt = runs[0].attempt_count
      const sequences = await tx.select({ value: sql<number>`coalesce(max(${AutomationRunEventTable.sequence}), 0)` })
        .from(AutomationRunEventTable).where(and(
          eq(AutomationRunEventTable.run_id, normalizeRunId(input.runId)),
          eq(AutomationRunEventTable.attempt, attempt),
        ))
      const id = createDenTypeId("automationRunEvent")
      await tx.insert(AutomationRunEventTable).values({
        id,
        run_id: normalizeRunId(input.runId),
        attempt,
        sequence: Number(sequences[0]?.value ?? 0) + 1,
        event_type: input.type,
        payload: input.payload,
        created_at: new Date(input.now),
      })
      const rows = await tx.select().from(AutomationRunEventTable).where(eq(AutomationRunEventTable.id, id)).limit(1)
      if (!rows[0]) throw new Error("automation_run_event_not_durable")
      return mapEvent(rows[0])
    })
  }

  async complete(input: Parameters<AutomationRepository["complete"]>[0]): Promise<AutomationRun> {
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(AutomationRunTable).where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
        eq(AutomationRunTable.lease_owner, input.leaseOwner),
        ...(input.attempt === undefined ? [] : [eq(AutomationRunTable.attempt_count, input.attempt)]),
      )).limit(1).for("update")
      const current = rows[0]
      if (!current) throw new Error("automation_run_complete_lease_lost")
      if (["succeeded", "failed", "cancelled", "skipped"].includes(current.status)) {
        if (current.status !== input.status) throw new Error("automation_run_terminal_result_conflict")
        return mapRun(current)
      }
      if (current.status !== "running" || !current.lease_expires_at || current.lease_expires_at.getTime() <= input.now) {
        throw new Error("automation_run_complete_lease_lost")
      }
      await tx.update(AutomationRunTable).set({
        status: input.status,
        result_summary: input.resultSummary,
        usage: input.usage,
        error: input.error,
        ...(input.engineReceipt === undefined ? {} : { engine_receipt: input.engineReceipt }),
        finished_at: new Date(input.now),
        lease_expires_at: null,
        heartbeat_at: new Date(input.now),
        mcp_token_hash: null,
        mcp_token_expires_at: null,
        updated_at: new Date(input.now),
      }).where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
        eq(AutomationRunTable.status, "running"),
        eq(AutomationRunTable.lease_owner, input.leaseOwner),
        ...(input.attempt === undefined ? [] : [eq(AutomationRunTable.attempt_count, input.attempt)]),
        gt(AutomationRunTable.lease_expires_at, new Date(input.now)),
      ))
      const completed = await tx.select().from(AutomationRunTable)
        .where(eq(AutomationRunTable.id, normalizeRunId(input.runId))).limit(1)
      if (!completed[0] || completed[0].status !== input.status) throw new Error("automation_run_complete_lease_lost")
      return mapRun(completed[0])
    })
  }

  async recoverExpiredLeases(input: Parameters<AutomationRepository["recoverExpiredLeases"]>[0]): Promise<AutomationRun[]> {
    const rows = await db.$primary.select().from(AutomationRunTable).where(and(
      inArray(AutomationRunTable.status, ["claimed", "running"]),
      lt(AutomationRunTable.lease_expires_at, new Date(input.now)),
    )).orderBy(asc(AutomationRunTable.lease_expires_at)).limit(input.limit)
    for (const run of rows) {
      if (!run.lease_owner) continue
      const retry = run.attempt_count < AUTOMATION_MAXIMUM_ATTEMPTS
      await db.update(AutomationRunTable).set({
        status: retry ? "queued" : "failed",
        lease_owner: null,
        lease_expires_at: null,
        mcp_token_hash: null,
        mcp_token_expires_at: null,
        engine_sequence: retry ? 0 : run.engine_sequence,
        error: retry ? null : {
          code: "lease_lost",
          message: run.execution_target === "desktop" ? interruptedDesktopRunMessage : "The execution lease expired.",
          retryable: false,
        },
        ...(!retry && run.execution_target === "desktop" ? { result_summary: interruptedDesktopRunMessage } : {}),
        finished_at: retry ? null : new Date(input.now),
        updated_at: new Date(input.now),
      }).where(and(
        eq(AutomationRunTable.id, run.id),
        eq(AutomationRunTable.lease_owner, run.lease_owner),
        lt(AutomationRunTable.lease_expires_at, new Date(input.now)),
      ))
    }
    return rows.map(mapRun)
  }

  async requestCancellation(input: Parameters<AutomationRepository["requestCancellation"]>[0]): Promise<AutomationRun | null> {
    const owned = await db.$primary.select({ run: AutomationRunTable }).from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
        or(isNull(AutomationTable.agent_id), runActorFilter({ actingMemberId: input.ownerMemberId, includeOwnerRuns: true })),
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      )).limit(1)
    if (!owned[0]) return null
    const immediate = owned[0].run.status === "queued"
    await db.update(AutomationRunTable).set({
      cancel_requested_at: new Date(input.now),
      status: immediate ? "cancelled" : owned[0].run.status,
      finished_at: immediate ? new Date(input.now) : owned[0].run.finished_at,
      mcp_token_hash: immediate ? null : owned[0].run.mcp_token_hash,
      mcp_token_expires_at: immediate ? null : owned[0].run.mcp_token_expires_at,
      updated_at: new Date(input.now),
    }).where(eq(AutomationRunTable.id, normalizeRunId(input.runId)))
    if (!immediate && owned[0].run.execution_target === "desktop" && ["claimed", "running"].includes(owned[0].run.status)) {
      await db.insert(AutomationRunnerNotificationTable).values({
        organization_id: normalizeOrganizationId(input.organizationId),
        owner_member_id: normalizeMemberId(input.ownerMemberId),
        event_type: "cancellation",
        run_id: normalizeRunId(input.runId),
        created_at: new Date(input.now),
      })
    }
    return (await this.runById(input.runId)) ?? null
  }

  async registerDesktopRunner(input: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    protocolVersion: number
    supportedExecutionTargets: Array<"desktop">
    capabilities: AutomationDesktopRunnerCapability[]
    appVersion: string
    platform: "darwin" | "win32" | "linux"
    concurrency: number
    authSessionId?: string | null
    now: number
  }) {
    const now = new Date(input.now)
    const organizationId = normalizeOrganizationId(input.organizationId)
    const ownerMemberId = normalizeMemberId(input.ownerMemberId)
    const id = automationRunnerRowId(input)
    const signIn = { install_id: input.runnerId, auth_session_id: input.authSessionId ? normalizeDenTypeId("session", input.authSessionId) : null }
    const existing = await db.$primary.select({
      organizationId: AutomationRunnerTable.organization_id, ownerMemberId: AutomationRunnerTable.owner_member_id, capabilities: AutomationRunnerTable.capabilities,
    }).from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, id)).limit(1)
    const choice = input.capabilities.includes(REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY)
    const gainedChoice = choice && existing[0]?.capabilities?.includes(REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY) !== true
    const sessionReport = (input.capabilities.includes(REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY) || choice) && !gainedChoice
      ? {}
      : { session_access: null, sessions: null, sessions_updated_at: null }
    if (existing[0] && (
      existing[0].organizationId !== organizationId
      || existing[0].ownerMemberId !== ownerMemberId
    )) throw new Error("automation_runner_identity_conflict")
    try {
      await db.insert(AutomationRunnerTable).values({
        id,
        organization_id: organizationId,
        owner_member_id: ownerMemberId,
        protocol_version: input.protocolVersion,
        supported_execution_targets: input.supportedExecutionTargets,
        capabilities: input.capabilities,
        app_version: input.appVersion,
        platform: input.platform,
        concurrency: input.concurrency,
        last_seen_at: now,
        ...signIn,
        created_at: now,
        updated_at: now,
      }).onDuplicateKeyUpdate({ set: {
        protocol_version: input.protocolVersion,
        supported_execution_targets: input.supportedExecutionTargets,
        capabilities: input.capabilities,
        app_version: input.appVersion,
        platform: input.platform,
        concurrency: input.concurrency,
        last_seen_at: now,
        updated_at: now,
        ...signIn,
        ...sessionReport,
      } })
    } catch (error) {
      logger.error("automation runner registration upsert failed", {
        error,
        runner_id_prefix: idPrefix(input.runnerId),
        runner_id_length: input.runnerId.length,
        organization_id: organizationId,
        owner_member_id: ownerMemberId,
        existing_runner: existing[0] ? "same_owner" : "none",
        protocol_version: input.protocolVersion,
        supported_execution_targets: input.supportedExecutionTargets.join(","),
        supported_execution_target_count: input.supportedExecutionTargets.length,
        capabilities: input.capabilities.join(","),
        capability_count: input.capabilities.length,
        app_version_length: input.appVersion.length,
        platform: input.platform,
        concurrency: input.concurrency,
      })
      throw error
    }
    await db.delete(AutomationRunnerTable).where(and(
      eq(AutomationRunnerTable.id, input.runnerId),
      eq(AutomationRunnerTable.organization_id, organizationId),
      eq(AutomationRunnerTable.owner_member_id, ownerMemberId),
    ))
  }

  async noteDesktopRunnerSignIn(input: { organizationId: string; ownerMemberId: string; runnerId: string; authSessionId: string }) {
    await db.update(AutomationRunnerTable).set({
      install_id: input.runnerId,
      auth_session_id: normalizeDenTypeId("session", input.authSessionId),
    }).where(and(
      eq(AutomationRunnerTable.id, automationRunnerRowId(input)),
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    ))
  }

  async touchDesktopRunner(input: { organizationId: string; ownerMemberId: string; runnerId: string; now: number }) {
    await db.update(AutomationRunnerTable).set({ last_seen_at: new Date(input.now), updated_at: new Date(input.now) })
      .where(and(
        inArray(AutomationRunnerTable.id, [automationRunnerRowId(input), input.runnerId]),
        eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      ))
  }

  async saveDesktopRunnerInventory(input: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    inventory: DesktopRunnerInventory
    now: number
  }): Promise<boolean> {
    const now = new Date(input.now)
    const result = await db.update(AutomationRunnerTable).set({
      inventory: input.inventory,
      inventory_updated_at: now,
      last_seen_at: now,
      updated_at: now,
    }).where(and(
      inArray(AutomationRunnerTable.id, automationRunnerComputerIds(input)),
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    ))
    return automationAffectedRows(result) > 0
  }

  async saveDesktopRunnerSessions(input: StoredRunnerSessionReport & {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    now: number
  }): Promise<boolean> {
    const now = new Date(input.now)
    const result = await db.update(AutomationRunnerTable).set({
      session_access: input.access,
      sessions: input.sessions,
      sessions_updated_at: now,
      last_seen_at: now,
      updated_at: now,
    }).where(and(
      inArray(AutomationRunnerTable.id, automationRunnerComputerIds(input)),
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    ))
    return automationAffectedRows(result) > 0
  }

  async clearReportedSessions(input: { organizationId: string; now: number }): Promise<void> {
    const now = new Date(input.now)
    await db.update(AutomationRunnerTable).set({ sessions: null, sessions_updated_at: now, updated_at: now }).where(and(
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      isNotNull(AutomationRunnerTable.sessions),
    ))
  }

  async discoverDesktopWork(input: { organizationId: string; ownerMemberId: string; now: number; limit: number }): Promise<Array<{
    runId: string
    executionTarget: "desktop"
    workspaceId?: string
  }>> {
    const rows = await db.$primary.select({
      runId: AutomationRunTable.id,
      revisionTarget: AutomationRevisionTable.execution_target,
      workspaceId: AutomationRevisionTable.workspace_id,
    })
      .from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationRunTable.revision_id))
      .where(and(
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
        eq(AutomationRunTable.status, "queued"),
        eq(AutomationRunTable.execution_target, "desktop"),
        gt(AutomationRunTable.claim_deadline_at, new Date(input.now)),
      )).orderBy(asc(AutomationRunTable.created_at), asc(AutomationRunTable.id)).limit(input.limit)
    return rows.map((row) => {
      const workspaceId = runWorkspaceId({ executionTarget: row.revisionTarget, workspaceId: row.workspaceId }, "desktop")
      return { runId: row.runId, executionTarget: "desktop", ...(workspaceId ? { workspaceId } : {}) }
    })
  }

  async claimDesktop(input: {
    organizationId: string
    ownerMemberId: string
    leaseOwner: string
    leaseMs: number
    runId: string
    now: number
  }): Promise<DesktopClaim | null> {
    return db.transaction(async (tx) => {
      const existing = await tx.select({ run: AutomationRunTable, automation: AutomationTable })
        .from(AutomationRunTable)
        .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
        .where(and(
          eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
          eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
          eq(AutomationRunTable.lease_owner, input.leaseOwner),
          eq(AutomationRunTable.id, normalizeRunId(input.runId)),
          inArray(AutomationRunTable.status, ["claimed", "running"]),
        )).limit(1)

      let selected = existing[0]
      if (!selected) {
        const eligible = await tx.select({ run: AutomationRunTable, automation: AutomationTable })
          .from(AutomationRunTable)
          .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
          .where(and(
            eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
            eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
            eq(AutomationRunTable.status, "queued"),
            eq(AutomationRunTable.id, normalizeRunId(input.runId)),
            eq(AutomationRunTable.execution_target, "desktop"),
            gt(AutomationRunTable.claim_deadline_at, new Date(input.now)),
          ))
          .orderBy(asc(AutomationRunTable.created_at), asc(AutomationRunTable.id))
          .limit(1)
          .for("update")
        selected = eligible[0]
        if (!selected) return null
        await tx.update(AutomationRunTable).set({
          status: "running",
          lease_owner: input.leaseOwner,
          lease_expires_at: new Date(input.now + input.leaseMs),
          heartbeat_at: new Date(input.now),
          attempt_count: selected.run.attempt_count + 1,
          engine_kind: "openwork-desktop-runner-v1",
          started_at: selected.run.started_at ?? new Date(input.now),
          updated_at: new Date(input.now),
        }).where(and(eq(AutomationRunTable.id, selected.run.id), eq(AutomationRunTable.status, "queued")))
      }

      const revisions = await tx.select().from(AutomationRevisionTable)
        .where(eq(AutomationRevisionTable.id, selected.run.revision_id)).limit(1)
      const currentRuns = await tx.select().from(AutomationRunTable)
        .where(eq(AutomationRunTable.id, selected.run.id)).limit(1)
      if (!revisions[0] || !currentRuns[0]) return null
      return {
        automation: mapAutomation(selected.automation),
        revision: mapRevision(revisions[0]),
        run: mapRun(currentRuns[0]),
      }
    })
  }

  async heartbeatDesktop(input: { runId: string; leaseOwner: string; attempt: number; leaseMs: number; now: number }) {
    const renewal: unknown = await db.update(AutomationRunTable).set({
      heartbeat_at: new Date(input.now),
      lease_expires_at: new Date(input.now + input.leaseMs),
      updated_at: new Date(input.now),
    }).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      eq(AutomationRunTable.attempt_count, input.attempt),
      eq(AutomationRunTable.status, "running"),
      gt(AutomationRunTable.lease_expires_at, new Date(input.now)),
    ))
    if (!automationUpdateChangedRows(renewal)) return null
    const rows = await db.$primary.select({
      leaseExpiresAt: AutomationRunTable.lease_expires_at,
      cancelRequestedAt: AutomationRunTable.cancel_requested_at,
    }).from(AutomationRunTable).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      eq(AutomationRunTable.attempt_count, input.attempt),
      eq(AutomationRunTable.status, "running"),
      gt(AutomationRunTable.lease_expires_at, new Date(input.now)),
    )).limit(1)
    return rows[0] ? {
      attempt: input.attempt,
      leaseValid: true as const,
      leaseExpiresAt: ms(rows[0].leaseExpiresAt),
      cancelRequested: Boolean(rows[0].cancelRequestedAt),
    } : null
  }

  async appendDesktopEvent(input: {
    runId: string
    leaseOwner: string
    attempt: number
    sequence: number
    type: AutomationRunEventType
    payload: Record<string, unknown>
    now: number
  }): Promise<AutomationRunEvent> {
    const idempotencyKey = `desktop:${input.runId}:${input.attempt}:${input.sequence}`
    return this.appendClaimedEvent(input, idempotencyKey)
  }

  appendCloudEvent(input: Parameters<DenAutomationRepository["appendDesktopEvent"]>[0]) {
    const idempotencyKey = `${input.leaseOwner}:${input.runId}:${input.attempt}:${input.sequence}`
    return this.appendClaimedEvent(input, idempotencyKey)
  }

  private async appendClaimedEvent(input: {
    runId: string
    leaseOwner: string
    attempt: number
    sequence: number
    type: AutomationRunEventType
    payload: Record<string, unknown>
    now: number
  }, idempotencyKey: string): Promise<AutomationRunEvent> {
    return db.transaction(async (tx) => {
      const runs = await tx.select().from(AutomationRunTable).where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
        eq(AutomationRunTable.lease_owner, input.leaseOwner),
        eq(AutomationRunTable.attempt_count, input.attempt),
        eq(AutomationRunTable.status, "running"),
        gt(AutomationRunTable.lease_expires_at, new Date(input.now)),
      )).limit(1).for("update")
      const run = runs[0]
      if (!run) throw new Error("automation_run_lease_lost")
      const duplicate = await tx.select().from(AutomationRunEventTable).where(and(
        eq(AutomationRunEventTable.run_id, run.id),
        eq(AutomationRunEventTable.attempt, input.attempt),
        eq(AutomationRunEventTable.engine_idempotency_key, idempotencyKey),
      )).limit(1)
      if (duplicate[0]) return mapEvent(duplicate[0])
      if (input.sequence !== run.engine_sequence + 1) throw new Error("automation_runner_event_sequence_gap")
      const id = createDenTypeId("automationRunEvent")
      await tx.insert(AutomationRunEventTable).values({
        id,
        run_id: run.id,
        attempt: input.attempt,
        sequence: input.sequence,
        engine_event_id: idempotencyKey,
        engine_idempotency_key: idempotencyKey,
        engine_execution_id: input.leaseOwner,
        event_type: input.type,
        payload: input.payload,
        created_at: new Date(input.now),
      })
      await tx.update(AutomationRunTable).set({
        engine_sequence: input.sequence,
        updated_at: new Date(input.now),
      }).where(eq(AutomationRunTable.id, run.id))
      const inserted = await tx.select().from(AutomationRunEventTable).where(eq(AutomationRunEventTable.id, id)).limit(1)
      if (!inserted[0]) throw new Error("automation_runner_event_not_durable")
      return mapEvent(inserted[0])
    })
  }

  async listRunnerNotifications(input: { organizationId: string; ownerMemberId: string; after: number; limit: number }) {
    return db.select().from(AutomationRunnerNotificationTable).where(and(
      eq(AutomationRunnerNotificationTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerNotificationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      gt(AutomationRunnerNotificationTable.id, input.after),
    )).orderBy(asc(AutomationRunnerNotificationTable.id)).limit(input.limit)
  }

  async pruneRunnerState(input: { runnersSeenBefore: number; notificationsBefore: number; limit: number }): Promise<{
    runners: number
    notifications: number
  }> {
    const runners = automationAffectedRows(await db.delete(AutomationRunnerTable)
      .where(lt(AutomationRunnerTable.last_seen_at, new Date(input.runnersSeenBefore)))
      .limit(input.limit))
    const oldest = await db.select({ id: AutomationRunnerNotificationTable.id, createdAt: AutomationRunnerNotificationTable.created_at })
      .from(AutomationRunnerNotificationTable)
      .orderBy(asc(AutomationRunnerNotificationTable.id))
      .limit(input.limit)
    const expired = oldest.filter((row) => row.createdAt.getTime() < input.notificationsBefore)
    const lastExpired = expired.at(-1)
    const notifications = lastExpired === undefined ? 0 : automationAffectedRows(await db.delete(AutomationRunnerNotificationTable).where(and(
      lte(AutomationRunnerNotificationTable.id, lastExpired.id),
      lt(AutomationRunnerNotificationTable.created_at, new Date(input.notificationsBefore)),
    )))
    return { runners, notifications }
  }

  async revisionExecutionTarget(revisionId: string): Promise<AutomationExecutionTarget | null> {
    const rows = await db.select({ executionTarget: AutomationRevisionTable.execution_target })
      .from(AutomationRevisionTable).where(eq(AutomationRevisionTable.id, normalizeRevisionId(revisionId))).limit(1)
    return rows[0]?.executionTarget ?? null
  }

  async skipRun(input: {
    runId: string
    code: "owner_membership_lost" | "model_access_lost" | "provider_unavailable" | "openwork_web_access_required" | "execution_runtime_unavailable"
    message: string
    now: number
  }): Promise<void> {
    await db.update(AutomationRunTable).set({
      status: "skipped",
      error: { code: input.code, message: input.message, retryable: false },
      result_summary: input.message,
      lease_owner: null,
      lease_expires_at: null,
      finished_at: new Date(input.now),
      updated_at: new Date(input.now),
    }).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      inArray(AutomationRunTable.status, ["queued", "running"]),
    ))
  }

  async desktopRunnerLastSeenAt(input: { organizationId: string; ownerMemberId: string }): Promise<number | null> {
    const rows = await db.select({ lastSeenAt: AutomationRunnerTable.last_seen_at })
      .from(AutomationRunnerTable)
      .where(and(
        eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
        sql`not coalesce(json_contains(${AutomationRunnerTable.capabilities}, ${JSON.stringify(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)}), false)`,
      )).orderBy(desc(AutomationRunnerTable.last_seen_at)).limit(1)
    return rows[0]?.lastSeenAt?.getTime() ?? null
  }

  async desktopRunnerCapabilityLastSeenAt(input: {
    organizationId: string
    ownerMemberId: string
    capability: AutomationDesktopRunnerCapability
  }): Promise<number | null> {
    const rows = await db.select({ lastSeenAt: AutomationRunnerTable.last_seen_at })
      .from(AutomationRunnerTable).where(and(
        eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
        sql`json_contains(${AutomationRunnerTable.capabilities}, ${JSON.stringify(input.capability)})`,
      )).orderBy(desc(AutomationRunnerTable.last_seen_at)).limit(1)
    return rows[0]?.lastSeenAt.getTime() ?? null
  }

  async listRemoteSessionDesktops(input: {
    organizationId: string
    ownerMemberId: string
    capability: AutomationDesktopRunnerCapability
    limit: number
    sessions?: boolean
  }) {
    const rows = await db.select({
      id: AutomationRunnerTable.id,
      platform: AutomationRunnerTable.platform,
      appVersion: AutomationRunnerTable.app_version,
      lastSeenAt: AutomationRunnerTable.last_seen_at,
      capabilities: AutomationRunnerTable.capabilities,
      inventory: AutomationRunnerTable.inventory,
      sessionAccess: AutomationRunnerTable.session_access,
      sessionsUpdatedAt: AutomationRunnerTable.sessions_updated_at,
      ...(input.sessions ? { sessions: AutomationRunnerTable.sessions } : {}),
    }).from(AutomationRunnerTable).where(and(
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      sql`json_contains(${AutomationRunnerTable.capabilities}, ${JSON.stringify(input.capability)})`,
    )).orderBy(desc(AutomationRunnerTable.last_seen_at)).limit(input.limit)
    return rows.map((row) => ({ ...row, capabilities: row.capabilities ?? [], sessions: row.sessions ?? null }))
  }

  async listDesktopRunners(input: { organizationId: string; ownerMemberId: string; limit: number }) {
    return db.select({
      id: AutomationRunnerTable.id,
      platform: AutomationRunnerTable.platform,
      appVersion: AutomationRunnerTable.app_version,
      lastSeenAt: AutomationRunnerTable.last_seen_at,
    }).from(AutomationRunnerTable).where(and(
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      sql`not coalesce(json_contains(${AutomationRunnerTable.capabilities}, ${JSON.stringify(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)}), false)`,
    )).orderBy(desc(AutomationRunnerTable.last_seen_at)).limit(input.limit)
  }

  async desktopRunnerById(input: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
  }): Promise<{ capabilities: AutomationDesktopRunnerCapability[]; lastSeenAt: number; sessionAccess: RemoteSessionAccessMode | null } | null> {
    const rows = await db.select({
      capabilities: AutomationRunnerTable.capabilities,
      lastSeenAt: AutomationRunnerTable.last_seen_at,
      sessionAccess: AutomationRunnerTable.session_access,
    }).from(AutomationRunnerTable).where(and(
      inArray(AutomationRunnerTable.id, automationRunnerComputerIds(input)),
      eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    )).orderBy(desc(sql`${AutomationRunnerTable.id} = ${automationRunnerRowId(input)}`)).limit(1)
    const row = rows[0]
    return row ? { capabilities: row.capabilities ?? [], lastSeenAt: row.lastSeenAt.getTime(), sessionAccess: row.sessionAccess ?? null } : null
  }

  private async missedDesktopReason(input: {
    organizationId: string
    ownerMemberId: string
    pinnedWorkspace: boolean
    now: number
  }): Promise<string> {
    const busy = await db.select({ id: AutomationRunTable.id })
      .from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
        eq(AutomationRunTable.execution_target, "desktop"),
        eq(AutomationRunTable.status, "running"),
      )).limit(1)
    const lastSeenAt = await this.desktopRunnerLastSeenAt(input)
    if (!busy[0] && input.pinnedWorkspace && desktopRunnerConnected({ lastSeenAt, now: input.now })) {
      return pinnedWorkspaceMissedMessage
    }
    return missedDesktopRunMessage({
      busy: Boolean(busy[0]),
      lastSeenAt,
      now: input.now,
    })
  }

  async expireUnclaimedDesktop(input: { now: number; limit: number }): Promise<string[]> {
    const rows = await db.select({
      run: AutomationRunTable,
      automation: AutomationTable,
      revisionTarget: AutomationRevisionTable.execution_target,
      workspaceId: AutomationRevisionTable.workspace_id,
    })
      .from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationRunTable.revision_id))
      .where(and(
        eq(AutomationRunTable.status, "queued"),
        eq(AutomationRunTable.execution_target, "desktop"),
        lte(AutomationRunTable.claim_deadline_at, new Date(input.now)),
      )).orderBy(asc(AutomationRunTable.claim_deadline_at)).limit(input.limit)
    const expired: string[] = []
    for (const { run, automation, revisionTarget, workspaceId } of rows) {
      const attempted = run.attempt_count > 0 || run.started_at !== null
      const status = attempted ? "failed" : "skipped"
      const code = attempted ? "lease_lost" : "runner_unavailable"
      const message = attempted ? interruptedDesktopRunMessage : await this.missedDesktopReason({
        organizationId: automation.organization_id,
        ownerMemberId: automation.owner_member_id,
        pinnedWorkspace: runWorkspaceId({ executionTarget: revisionTarget, workspaceId }, "desktop") !== null,
        now: input.now,
      })
      await db.update(AutomationRunTable).set({
        status,
        error: {
          code,
          message,
          retryable: false,
        },
        result_summary: message,
        finished_at: new Date(input.now),
        updated_at: new Date(input.now),
      }).where(and(
        eq(AutomationRunTable.id, run.id),
        eq(AutomationRunTable.status, "queued"),
        eq(AutomationRunTable.attempt_count, run.attempt_count),
        lte(AutomationRunTable.claim_deadline_at, new Date(input.now)),
      ))
      const confirmed = await db.$primary.select({ status: AutomationRunTable.status, error: AutomationRunTable.error })
        .from(AutomationRunTable).where(eq(AutomationRunTable.id, run.id)).limit(1)
      if (confirmed[0]?.status === status && confirmed[0].error?.code === code) {
        expired.push(run.id)
      }
    }
    return expired
  }

  async getRunReceipt(input: Parameters<AutomationRepository["getRunReceipt"]>[0] & RunAudience & { agentId?: string }) {
    const audience = { actingMemberId: input.actingMemberId ?? input.ownerMemberId, includeOwnerRuns: input.includeOwnerRuns ?? !input.actingMemberId }
    const owned = await db.$primary.select({ automation: AutomationTable, run: AutomationRunTable })
      .from(AutomationRunTable).innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
        or(isNull(AutomationTable.agent_id), runActorFilter(audience)),
        input.agentId ? eq(AutomationTable.agent_id, normalizeDenTypeId("personalAgent", input.agentId)) : undefined,
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      )).limit(1)
    if (!owned[0]) return null
    const revisions = await db.$primary.select().from(AutomationRevisionTable)
      .where(eq(AutomationRevisionTable.id, owned[0].run.revision_id)).limit(1)
    if (!revisions[0]) return null
    const events = await db.select().from(AutomationRunEventTable)
      .where(eq(AutomationRunEventTable.run_id, normalizeRunId(input.runId)))
      .orderBy(asc(AutomationRunEventTable.attempt), asc(AutomationRunEventTable.sequence))
    return {
      automation: { ...mapAutomation(owned[0].automation), ...(owned[0].automation.agent_id ? { latestRunAt: (await latestRun(owned[0].automation.id, audience))?.createdAt ?? null } : {}) },
      revision: mapRevision(revisions[0]),
      run: mapRun(owned[0].run),
      events: events.map(mapEvent),
    }
  }

  async listRuns(input: Parameters<AutomationRepository["listRuns"]>[0]) {
    const automation = await this.get(input)
    if (!automation) return { items: [], nextCursor: null }
    const limit = Math.max(1, Math.min(input.limit, 100))
    const conditions = [eq(AutomationRunTable.automation_id, normalizeAutomationId(input.automationId))]
    const audience = automation.automation.agentId ? runActorFilter({ actingMemberId: input.ownerMemberId, includeOwnerRuns: true }) : undefined
    if (audience) conditions.push(audience)
    if (input.cursor) conditions.push(lt(AutomationRunTable.id, normalizeRunId(input.cursor)))
    const rows = await db.select().from(AutomationRunTable).where(and(...conditions))
      .orderBy(desc(AutomationRunTable.id)).limit(limit + 1)
    const selected = rows.slice(0, limit)
    return { items: selected.map(mapRun), nextCursor: rows.length > limit ? selected.at(-1)?.id ?? null : null }
  }

  async listRunsInRange(input: { organizationId: string; ownerMemberId: string; from: number; to: number; cursor?: string; limit: number }): Promise<{
    items: AutomationRun[]
    nextCursor: string | null
  }> {
    const pad = 24 * 60 * 60 * 1_000
    const limit = Math.max(1, Math.min(input.limit, AUTOMATION_RUN_RANGE_MAX_ITEMS))
    const conditions = [
      eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      or(isNull(AutomationTable.agent_id), runActorFilter({ actingMemberId: input.ownerMemberId, includeOwnerRuns: true })),
      gte(AutomationRunTable.created_at, new Date(input.from - pad)),
      lt(AutomationRunTable.created_at, new Date(input.to + pad)),
    ]
    if (input.cursor) conditions.push(gt(AutomationRunTable.id, normalizeRunId(input.cursor)))
    const rows = await db.select({ run: AutomationRunTable })
      .from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(...conditions))
      .orderBy(asc(AutomationRunTable.id))
      .limit(limit + 1)
    const scanned = rows.slice(0, limit).map((row) => mapRun(row.run))
    return {
      items: scanned.filter((run) => {
        const at = run.scheduledFor ?? run.startedAt ?? run.createdAt
        return at >= input.from && at < input.to
      }),
      nextCursor: rows.length > limit ? scanned.at(-1)?.id ?? null : null,
    }
  }

  async reclaimQueued(input: { runId: string; leaseOwner: string; leaseMs: number; now: number }): Promise<{
    automation: Automation
    revision: AutomationRevision
    run: AutomationRun
  } | null> {
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(AutomationRunTable)
        .where(and(eq(AutomationRunTable.id, normalizeRunId(input.runId)), eq(AutomationRunTable.status, "queued")))
        .limit(1).for("update")
      const row = rows[0]
      if (!row || row.attempt_count >= AUTOMATION_MAXIMUM_ATTEMPTS) return null
      await tx.update(AutomationRunTable).set({
        status: "claimed",
        lease_owner: input.leaseOwner,
        lease_expires_at: new Date(input.now + input.leaseMs),
        heartbeat_at: new Date(input.now),
        attempt_count: row.attempt_count + 1,
        updated_at: new Date(input.now),
      }).where(eq(AutomationRunTable.id, row.id))
      const automations = await tx.select().from(AutomationTable)
        .where(eq(AutomationTable.id, row.automation_id)).limit(1)
      const revisions = await tx.select().from(AutomationRevisionTable)
        .where(eq(AutomationRevisionTable.id, row.revision_id)).limit(1)
      if (!automations[0] || !revisions[0]) return null
      const updated = await tx.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, row.id)).limit(1)
      if (!updated[0]) return null
      return { automation: mapAutomation(automations[0]), revision: mapRevision(revisions[0]), run: mapRun(updated[0]) }
    })
  }

  async queueRetry(input: { runId: string; leaseOwner: string; now: number }): Promise<boolean> {
    const rows = await db.$primary.select().from(AutomationRunTable).where(and(
      eq(AutomationRunTable.id, normalizeRunId(input.runId)),
      eq(AutomationRunTable.lease_owner, input.leaseOwner),
      eq(AutomationRunTable.status, "running"),
    )).limit(1)
    if (!rows[0] || rows[0].attempt_count >= AUTOMATION_MAXIMUM_ATTEMPTS) return false
    await db.update(AutomationRunTable).set({
      status: "queued",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      mcp_token_hash: null,
      mcp_token_expires_at: null,
      engine_sequence: 0,
      updated_at: new Date(input.now),
    }).where(eq(AutomationRunTable.id, normalizeRunId(input.runId)))
    return true
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    const rows = await db.select({ cancelledAt: AutomationRunTable.cancel_requested_at })
      .from(AutomationRunTable).where(eq(AutomationRunTable.id, normalizeRunId(runId))).limit(1)
    return Boolean(rows[0]?.cancelledAt)
  }

  async markNeedsAttention(input: {
    automationId: string
    expectedRevisionId: string
    reason: NonNullable<Automation["needsAttentionReason"]>
    now: number
  }): Promise<boolean> {
    const result = await db.update(AutomationTable).set({
      state: "needs_attention",
      next_due_at: null,
      needs_attention_reason: input.reason,
      updated_at: new Date(input.now),
    }).where(and(
      eq(AutomationTable.id, normalizeAutomationId(input.automationId)),
      eq(AutomationTable.current_revision_id, normalizeRevisionId(input.expectedRevisionId)),
      eq(AutomationTable.state, "active"),
    ))
    return automationUpdateChangedRows(result)
  }

  private async runById(runId: string): Promise<AutomationRun | null> {
    const rows = await db.$primary.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, normalizeRunId(runId))).limit(1)
    return rows[0] ? mapRun(rows[0]) : null
  }
}

export const automationRepository = new DenAutomationRepository()

type AutomationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function listAgentRoutines(input: {
  organizationId: string
  ownerMemberId: string
  agentId: string
  limit: number
  memberId?: string
}): Promise<AutomationListItem[]> {
  const rows = await db.$primary.select().from(AutomationTable).where(and(
    eq(AutomationTable.agent_id, normalizeDenTypeId("personalAgent", input.agentId)),
    eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
    eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    ne(AutomationTable.state, "archived"),
  )).orderBy(desc(AutomationTable.id)).limit(input.limit)
  return itemsFromRows(rows, input.memberId)
}

export async function listAgentRoutineItems(agentIds: readonly string[], memberId?: string): Promise<AutomationListItem[]> {
  if (agentIds.length === 0) return []
  const rows = await db.$primary.select().from(AutomationTable).where(and(
    inArray(AutomationTable.agent_id, agentIds.map((id) => normalizeDenTypeId("personalAgent", id))),
    ne(AutomationTable.state, "archived"),
  )).orderBy(asc(AutomationTable.created_at), asc(AutomationTable.id))
  return itemsFromRows(rows, memberId)
}

export async function listPersonalAgentRuns(input: { organizationId: string; agentId: string; limit: number } & RunAudience) {
  const rows = await db.$primary.select({ run: AutomationRunTable }).from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
    .where(and(
      eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationTable.agent_id, normalizeDenTypeId("personalAgent", input.agentId)),
      personalAgentRunSummaryFilter(input, normalizeDenTypeId("personalAgent", input.agentId)),
    )).orderBy(desc(AutomationRunTable.created_at), desc(AutomationRunTable.id)).limit(input.limit)
  return { items: rows.map(({ run }) => mapPersonalAgentRunSummary(run, input)) }
}

export async function repinAgentRoutines(tx: AutomationTransaction, input: {
  agentId: string
  agentRevisionId: string
  now: number
}): Promise<number> {
  const agentRevisionId = normalizeDenTypeId("personalAgentRevision", input.agentRevisionId)
  const routines = await tx.select().from(AutomationTable)
    .where(eq(AutomationTable.agent_id, normalizeDenTypeId("personalAgent", input.agentId)))
    .orderBy(asc(AutomationTable.id)).for("update")
  for (const routine of routines) {
    const [current] = await tx.select().from(AutomationRevisionTable)
      .where(eq(AutomationRevisionTable.id, routine.current_revision_id)).limit(1)
    if (!current) throw new Error("automation_revision_not_found")
    const mapped = mapRevision(current)
    const newRevisionId = createDenTypeId("automationRevision")
    await tx.insert(AutomationRevisionTable).values({
      ...current,
      id: newRevisionId,
      version: current.version + 1,
      agent_revision_id: agentRevisionId,
      digest: automationRevisionDigest({
        instructions: mapped.instructions,
        schedule: mapped.schedule,
        model: mapped.model,
        action: mapped.action,
        executionTarget: current.execution_target,
        maximumRuntimeMs: current.maximum_runtime_ms,
        ...(current.workspace_id ? { workspaceId: current.workspace_id } : {}),
        agentRevisionId,
      }),
      created_at: new Date(input.now),
    })
    await tx.update(AutomationTable).set({
      current_revision_id: newRevisionId,
      updated_at: new Date(input.now),
    }).where(eq(AutomationTable.id, routine.id))
  }
  return routines.length
}

export async function archiveAgentRoutines(tx: AutomationTransaction, input: { agentId: string; now: number }): Promise<void> {
  await tx.update(AutomationTable).set({
    state: "archived",
    next_due_at: null,
    archived_at: new Date(input.now),
    needs_attention_reason: null,
    updated_at: new Date(input.now),
  }).where(and(
    eq(AutomationTable.agent_id, normalizeDenTypeId("personalAgent", input.agentId)),
    ne(AutomationTable.state, "archived"),
  ))
}
