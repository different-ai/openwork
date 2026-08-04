import {
  AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS,
  AUTOMATION_MAXIMUM_ATTEMPTS,
  automationOccurrenceIdentity,
  automationRevisionDigest,
  nextAutomationOccurrence,
} from "@openwork/automations"
import type {
  AutomationClaimResult,
  AutomationListItem,
  AutomationRepository,
} from "@openwork/automations"
import type {
  Automation,
  AutomationRevision,
  AutomationRun,
  AutomationRunEvent,
  AutomationRunEventType,
  AutomationUsage,
} from "@openwork/types/automations"
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "@openwork-ee/den-db/drizzle"
import {
  AutomationRevisionTable,
  AutomationRunnerTable,
  AutomationRunnerNotificationTable,
  AutomationRunEventTable,
  AutomationRunTable,
  AutomationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { automationUpdateChangedRows } from "./update-result.js"

type AutomationRow = typeof AutomationTable.$inferSelect
type RevisionRow = typeof AutomationRevisionTable.$inferSelect
type RunRow = typeof AutomationRunTable.$inferSelect
type EventRow = typeof AutomationRunEventTable.$inferSelect
type DesktopClaim = { automation: Automation; revision: AutomationRevision; run: AutomationRun }

const emptyUsage: AutomationUsage = { inputTokens: null, outputTokens: null, costMicros: null }

const normalizeAutomationId = (value: string) => normalizeDenTypeId("automation", value)
const normalizeRevisionId = (value: string) => normalizeDenTypeId("automationRevision", value)
const normalizeRunId = (value: string) => normalizeDenTypeId("automationRun", value)
const normalizeOrganizationId = (value: string) => normalizeDenTypeId("organization", value)
const normalizeMemberId = (value: string) => normalizeDenTypeId("member", value)

const ms = (value: Date | null): number | null => value?.getTime() ?? null
const date = (value: number | null): Date | null => value === null ? null : new Date(value)

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
    needsAttentionReason: row.needs_attention_reason ?? null,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    archivedAt: ms(row.archived_at),
  }
}

function mapRevision(row: RevisionRow): AutomationRevision {
  return {
    id: row.id,
    automationId: row.automation_id,
    version: row.version,
    instructions: row.instructions,
    schedule: row.schedule_config,
    model: { providerId: row.provider_id, modelId: row.model_id },
    executionTarget: row.execution_target,
    maximumRuntimeMs: row.maximum_runtime_ms,
    digest: row.digest,
    createdAt: row.created_at.getTime(),
  }
}

function mapRun(row: RunRow): AutomationRun {
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
      executionLocation: "desktop",
      automationId: row.automation_id,
      automationRunId: row.id,
      engineKind: row.engine_kind,
    } : null,
    providerId: row.provider_id,
    modelId: row.model_id,
    startedAt: ms(row.started_at),
    finishedAt: ms(row.finished_at),
    error: row.error ?? null,
    resultSummary: row.result_summary,
    usage: row.usage,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
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

async function latestRun(automationId: AutomationRow["id"]): Promise<AutomationRun | null> {
  const rows = await db.select().from(AutomationRunTable)
    .where(eq(AutomationRunTable.automation_id, automationId))
    .orderBy(desc(AutomationRunTable.created_at), desc(AutomationRunTable.id)).limit(1)
  return rows[0] ? mapRun(rows[0]) : null
}

async function itemFromRows(automation: AutomationRow, revision: RevisionRow): Promise<AutomationListItem> {
  return { automation: mapAutomation(automation), revision: mapRevision(revision), latestRun: await latestRun(automation.id) }
}

export class DenAutomationRepository implements AutomationRepository {
  async create(input: Parameters<AutomationRepository["create"]>[0]): Promise<AutomationListItem> {
    const now = new Date(input.now)
    const newAutomationId = createDenTypeId("automation")
    const newRevisionId = createDenTypeId("automationRevision")
    const maximumRuntimeMs = AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS
    const digest = automationRevisionDigest({
      instructions: input.definition.instructions,
      schedule: input.definition.schedule,
      model: input.definition.model,
      maximumRuntimeMs,
    })
    const nextDueAt = nextAutomationOccurrence(input.definition.schedule, input.now)
    await db.transaction(async (tx) => {
      await tx.insert(AutomationRevisionTable).values({
        id: newRevisionId,
        automation_id: newAutomationId,
        version: 1,
        instructions: input.definition.instructions,
        schedule_kind: input.definition.schedule.kind,
        schedule_config: input.definition.schedule,
        timezone: input.definition.schedule.timezone,
        provider_id: input.definition.model.providerId,
        model_id: input.definition.model.modelId,
        execution_target: "desktop",
        maximum_runtime_ms: maximumRuntimeMs,
        digest,
        created_at: now,
      })
      await tx.insert(AutomationTable).values({
        id: newAutomationId,
        organization_id: normalizeOrganizationId(input.organizationId),
        owner_member_id: normalizeMemberId(input.ownerMemberId),
        name: input.definition.name,
        state: "active",
        current_revision_id: newRevisionId,
        next_due_at: date(nextDueAt),
        needs_attention_reason: null,
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
    })
    const created = await this.get({
      organizationId: input.organizationId,
      ownerMemberId: input.ownerMemberId,
      automationId: newAutomationId,
    })
    if (!created) throw new Error("automation_create_not_durable")
    return created
  }

  async update(input: Parameters<AutomationRepository["update"]>[0]): Promise<AutomationListItem> {
    await db.transaction(async (tx) => {
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
      const instructions = input.changes.instructions ?? current.instructions
      const schedule = input.changes.schedule ?? current.schedule_config
      const model = input.changes.model ?? { providerId: current.provider_id, modelId: current.model_id }
      const newRevisionId = createDenTypeId("automationRevision")
      const digest = automationRevisionDigest({
        instructions,
        schedule,
        model,
        maximumRuntimeMs: current.maximum_runtime_ms,
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
        execution_target: "desktop",
        maximum_runtime_ms: current.maximum_runtime_ms,
        digest,
        created_at: new Date(input.now),
      })
      await tx.update(AutomationTable).set({
        name: input.changes.name ?? automation.name,
        current_revision_id: newRevisionId,
        next_due_at: date(nextAutomationOccurrence(schedule, input.now)),
        state: "active",
        needs_attention_reason: null,
        updated_at: new Date(input.now),
      }).where(eq(AutomationTable.id, automation.id))
    })
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
    const items = await Promise.all(selected.map(async (automation) => {
      const revisions = await db.select().from(AutomationRevisionTable)
        .where(eq(AutomationRevisionTable.id, automation.current_revision_id)).limit(1)
      if (!revisions[0]) throw new Error("automation_revision_not_found")
      return itemFromRows(automation, revisions[0])
    }))
    return { items: await Promise.all(items), nextCursor: rows.length > limit ? selected.at(-1)?.id ?? null : null }
  }

  async get(input: Parameters<AutomationRepository["get"]>[0]): Promise<AutomationListItem | null> {
    const rows = await db.select().from(AutomationTable).where(and(
      eq(AutomationTable.id, normalizeAutomationId(input.automationId)),
      eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
      eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
    )).limit(1)
    if (!rows[0]) return null
    const revisions = await db.select().from(AutomationRevisionTable)
      .where(eq(AutomationRevisionTable.id, rows[0].current_revision_id)).limit(1)
    return revisions[0] ? itemFromRows(rows[0], revisions[0]) : null
  }

  async setState(input: Parameters<AutomationRepository["setState"]>[0]): Promise<AutomationListItem | null> {
    const current = await this.get(input)
    if (!current) return null
    const same = current.automation.state === input.state
    if (!same) {
      await db.update(AutomationTable).set({
        state: input.state,
        next_due_at: input.state === "active"
          ? date(nextAutomationOccurrence(current.revision.schedule, input.now))
          : null,
        archived_at: input.state === "archived" ? new Date(input.now) : null,
        needs_attention_reason: null,
        updated_at: new Date(input.now),
      }).where(eq(AutomationTable.id, normalizeAutomationId(current.automation.id)))
    }
    return this.get(input)
  }

  async listDue(input: Parameters<AutomationRepository["listDue"]>[0]): Promise<AutomationListItem[]> {
    const rows = await db.select().from(AutomationTable).where(and(
      eq(AutomationTable.state, "active"),
      lte(AutomationTable.next_due_at, new Date(input.now)),
    )).orderBy(asc(AutomationTable.next_due_at), asc(AutomationTable.id)).limit(input.limit)
    return Promise.all(rows.map(async (automation) => {
      const revisions = await db.select().from(AutomationRevisionTable)
        .where(eq(AutomationRevisionTable.id, automation.current_revision_id)).limit(1)
      if (!revisions[0]) throw new Error("automation_revision_not_found")
      return itemFromRows(automation, revisions[0])
    }))
  }

  async claim(input: Parameters<AutomationRepository["claim"]>[0]): Promise<AutomationClaimResult> {
    return db.transaction(async (tx) => {
      const locked = await tx.select().from(AutomationTable)
        .where(eq(AutomationTable.id, normalizeAutomationId(input.automation.id))).limit(1).for("update")
      if (!locked[0] || locked[0].state !== "active") throw new Error("automation_not_active")
      const identity = automationOccurrenceIdentity({
        automationId: input.automation.id,
        scheduledFor: input.scheduledFor,
        nonce: input.nonce,
      })
      const duplicates = await tx.select().from(AutomationRunTable)
        .where(eq(AutomationRunTable.idempotency_key, identity.idempotencyKey)).limit(1)
      if (duplicates[0]) return { kind: "duplicate", run: mapRun(duplicates[0]) }
      const active = await tx.select().from(AutomationRunTable).where(and(
        eq(AutomationRunTable.automation_id, normalizeAutomationId(input.automation.id)),
        inArray(AutomationRunTable.status, ["queued", "claimed", "running"]),
      )).limit(1)
      const overlap = active.length > 0
      const newRunId = createDenTypeId("automationRun")
      const newCloudThreadId = createDenTypeId("automationThread")
      const nextDueAt = input.trigger === "manual"
        ? input.automation.nextDueAt
        : nextAutomationOccurrence(input.revision.schedule, input.scheduledFor ?? input.now)
      await tx.insert(AutomationRunTable).values({
        id: newRunId,
        automation_id: normalizeAutomationId(input.automation.id),
        revision_id: normalizeRevisionId(input.revision.id),
        trigger: input.trigger,
        scheduled_for: date(input.scheduledFor),
        idempotency_key: identity.idempotencyKey,
        status: overlap ? "skipped" : "queued",
        execution_target: "desktop",
        claim_deadline_at: overlap ? null : new Date(input.now + (input.claimDeadlineMs ?? input.leaseMs)),
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        attempt_count: 0,
        cloud_thread_id: newCloudThreadId,
        engine_kind: null,
        engine_receipt: null,
        engine_sequence: 0,
        engine_admitted_at: null,
        provider_id: input.revision.model.providerId,
        model_id: input.revision.model.modelId,
        finished_at: overlap ? new Date(input.now) : null,
        error: null,
        result_summary: overlap ? "Skipped because another occurrence is already active." : null,
        usage: emptyUsage,
        created_at: new Date(input.now),
        updated_at: new Date(input.now),
      })
      if (!overlap) {
        await tx.insert(AutomationRunnerNotificationTable).values({
          organization_id: normalizeOrganizationId(input.automation.organizationId),
          owner_member_id: normalizeMemberId(input.automation.ownerMemberId),
          event_type: "work_available",
          run_id: newRunId,
          created_at: new Date(input.now),
        })
      }
      await tx.update(AutomationTable).set({
        next_due_at: date(nextDueAt),
        latest_run_at: new Date(input.now),
        updated_at: new Date(input.now),
      }).where(eq(AutomationTable.id, normalizeAutomationId(input.automation.id)))
      const runRows = await tx.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, newRunId)).limit(1)
      if (!runRows[0]) throw new Error("automation_run_not_durable")
      return overlap
        ? { kind: "overlap", run: mapRun(runRows[0]) }
        : { kind: "claimed", run: mapRun(runRows[0]), revision: input.revision }
    })
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
    const rows = await db.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(and(
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
    const rows = await db.select().from(AutomationRunTable).where(and(
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
        error: retry ? null : { code: "lease_lost", message: "The execution lease expired.", retryable: false },
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
    const owned = await db.select({ run: AutomationRunTable }).from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
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
    if (!immediate && ["claimed", "running"].includes(owned[0].run.status)) {
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
    appVersion: string
    platform: "darwin" | "win32" | "linux"
    concurrency: number
    now: number
  }) {
    const now = new Date(input.now)
    const existing = await db.select({ organizationId: AutomationRunnerTable.organization_id, ownerMemberId: AutomationRunnerTable.owner_member_id })
      .from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, input.runnerId)).limit(1)
    if (existing[0] && (
      existing[0].organizationId !== normalizeOrganizationId(input.organizationId)
      || existing[0].ownerMemberId !== normalizeMemberId(input.ownerMemberId)
    )) throw new Error("automation_runner_identity_conflict")
    await db.insert(AutomationRunnerTable).values({
      id: input.runnerId,
      organization_id: normalizeOrganizationId(input.organizationId),
      owner_member_id: normalizeMemberId(input.ownerMemberId),
      protocol_version: input.protocolVersion,
      supported_execution_targets: input.supportedExecutionTargets,
      app_version: input.appVersion,
      platform: input.platform,
      concurrency: input.concurrency,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    }).onDuplicateKeyUpdate({ set: {
      protocol_version: input.protocolVersion,
      supported_execution_targets: input.supportedExecutionTargets,
      app_version: input.appVersion,
      platform: input.platform,
      concurrency: input.concurrency,
      last_seen_at: now,
      updated_at: now,
    } })
  }

  async touchDesktopRunner(input: { organizationId: string; ownerMemberId: string; runnerId: string; now: number }) {
    await db.update(AutomationRunnerTable).set({ last_seen_at: new Date(input.now), updated_at: new Date(input.now) })
      .where(and(
        eq(AutomationRunnerTable.id, input.runnerId),
        eq(AutomationRunnerTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationRunnerTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      ))
  }

  async discoverDesktopWork(input: { organizationId: string; ownerMemberId: string; now: number; limit: number }) {
    const rows = await db.select({ runId: AutomationRunTable.id, executionTarget: AutomationRunTable.execution_target })
      .from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
        eq(AutomationRunTable.status, "queued"),
        eq(AutomationRunTable.execution_target, "desktop"),
        gt(AutomationRunTable.claim_deadline_at, new Date(input.now)),
      )).orderBy(asc(AutomationRunTable.created_at), asc(AutomationRunTable.id)).limit(input.limit)
    return rows
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
    const rows = await db.select({
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
      const idempotencyKey = `desktop:${input.runId}:${input.attempt}:${input.sequence}`
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
        // Server-stamped: runners must not control durable receipt timestamps.
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

  /** Durably skips a run that must not execute (e.g. revoked model access). */
  async skipRun(input: {
    runId: string
    code: "owner_membership_lost" | "model_access_lost" | "provider_unavailable"
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

  async expireUnclaimedDesktop(input: { now: number; limit: number }): Promise<string[]> {
    const rows = await db.select().from(AutomationRunTable).where(and(
      eq(AutomationRunTable.status, "queued"),
      eq(AutomationRunTable.execution_target, "desktop"),
      lte(AutomationRunTable.claim_deadline_at, new Date(input.now)),
    )).orderBy(asc(AutomationRunTable.claim_deadline_at)).limit(input.limit)
    const expired: string[] = []
    for (const run of rows) {
      await db.update(AutomationRunTable).set({
        status: "skipped",
        error: {
          code: "runner_unavailable",
          message: "Missed — desktop runner unavailable.",
          retryable: false,
        },
        result_summary: "Missed — desktop runner unavailable.",
        finished_at: new Date(input.now),
        updated_at: new Date(input.now),
      }).where(and(eq(AutomationRunTable.id, run.id), eq(AutomationRunTable.status, "queued")))
      const confirmed = await db.select({ status: AutomationRunTable.status, error: AutomationRunTable.error })
        .from(AutomationRunTable).where(eq(AutomationRunTable.id, run.id)).limit(1)
      if (confirmed[0]?.status === "skipped" && confirmed[0].error?.code === "runner_unavailable") {
        expired.push(run.id)
      }
    }
    return expired
  }

  async getRunReceipt(input: Parameters<AutomationRepository["getRunReceipt"]>[0]) {
    const owned = await db.select({ automation: AutomationTable, run: AutomationRunTable })
      .from(AutomationRunTable).innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .where(and(
        eq(AutomationRunTable.id, normalizeRunId(input.runId)),
        eq(AutomationTable.organization_id, normalizeOrganizationId(input.organizationId)),
        eq(AutomationTable.owner_member_id, normalizeMemberId(input.ownerMemberId)),
      )).limit(1)
    if (!owned[0]) return null
    const revisions = await db.select().from(AutomationRevisionTable)
      .where(eq(AutomationRevisionTable.id, owned[0].run.revision_id)).limit(1)
    if (!revisions[0]) return null
    const events = await db.select().from(AutomationRunEventTable)
      .where(eq(AutomationRunEventTable.run_id, normalizeRunId(input.runId)))
      .orderBy(asc(AutomationRunEventTable.attempt), asc(AutomationRunEventTable.sequence))
    return {
      automation: mapAutomation(owned[0].automation),
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
    if (input.cursor) conditions.push(lt(AutomationRunTable.id, normalizeRunId(input.cursor)))
    const rows = await db.select().from(AutomationRunTable).where(and(...conditions))
      .orderBy(desc(AutomationRunTable.id)).limit(limit + 1)
    const selected = rows.slice(0, limit)
    return { items: selected.map(mapRun), nextCursor: rows.length > limit ? selected.at(-1)?.id ?? null : null }
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
    const rows = await db.select().from(AutomationRunTable).where(and(
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
      engine_kind: null,
      engine_receipt: null,
      engine_sequence: 0,
      engine_admitted_at: null,
      updated_at: new Date(input.now),
    }).where(eq(AutomationRunTable.id, normalizeRunId(input.runId)))
    return true
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    const rows = await db.select({ cancelledAt: AutomationRunTable.cancel_requested_at })
      .from(AutomationRunTable).where(eq(AutomationRunTable.id, normalizeRunId(runId))).limit(1)
    return Boolean(rows[0]?.cancelledAt)
  }

  async markNeedsAttention(input: { automationId: string; reason: NonNullable<Automation["needsAttentionReason"]>; now: number }): Promise<void> {
    await db.update(AutomationTable).set({
      state: "needs_attention",
      next_due_at: null,
      needs_attention_reason: input.reason,
      updated_at: new Date(input.now),
    }).where(eq(AutomationTable.id, normalizeAutomationId(input.automationId)))
  }

  private async runById(runId: string): Promise<AutomationRun | null> {
    const rows = await db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, normalizeRunId(runId))).limit(1)
    return rows[0] ? mapRun(rows[0]) : null
  }
}

export const automationRepository = new DenAutomationRepository()
