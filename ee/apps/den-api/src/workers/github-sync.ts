import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConnectorAccountTable,
  ConnectorInstanceTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
  MemberTable,
} from "@openwork-ee/den-db/schema"
import type { AuditActor, AuditEventInput } from "@openwork-ee/den-db/audit-log"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { recordAuditJobOutcome } from "../audit/job-capture.js"
import { CONNECTOR_SYNC_JOB_KIND } from "../audit/job-outcomes.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import {
  getGithubConnectorAppConfig,
  getGithubRepositoryHeadSha,
} from "../routes/org/plugin-system/github-app.js"
import { executeGithubConnectorSyncEvent } from "../routes/org/plugin-system/store.js"
import {
  claimGithubReconcileState,
  GITHUB_RECONCILE_STATE_KEY,
  githubReconcileDueAtMs,
  githubReconcileRevision,
  GithubReconcilePermanentError,
  nextGithubReconcileState,
  readGithubReconcileState,
  selectGithubReconcileCandidates,
  type GithubReconcileState,
} from "./github-reconcile-state.js"
import { isTransientGithubSyncError } from "./github-sync-retry.js"

export { isTransientGithubSyncError } from "./github-sync-retry.js"

const logger = appLogger.child({ component: "github_sync_worker" })
const MAX_BACKOFF_MS = 15 * 60_000
const ACTIVE_GITHUB_SYNC_EVENT_STATUSES = ["queued", "running"] as const
// Every replica polls every few seconds, so one poll reads a small page, not the queue.
export const GITHUB_SYNC_POLL_LIMIT = 25
// A claimed event holds its target this long. A replica that stops mid-sync
// (deploy, crash) never finishes it, so the event is put back afterwards.
export const GITHUB_SYNC_RUNNING_LEASE_MS = 30 * 60_000
// Events claimed before leases existed have none; one running this long was abandoned.
const UNLEASED_RUNNING_STALE_MS = 24 * 60 * 60_000
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function affectedRowCount(result: unknown): number {
  if (Array.isArray(result)) {
    return result.reduce((total: number, entry) => total + affectedRowCount(entry), 0)
  }
  if (!isRecord(result)) return 0
  if (typeof result.rowsAffected === "number") return result.rowsAffected
  if (typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

function changedRows(result: unknown): boolean {
  return affectedRowCount(result) > 0
}

async function connectorTargetIdsWithStatuses(
  connectorTargetIds: Array<NonNullable<(typeof ConnectorSyncEventTable.$inferSelect)["connectorTargetId"]>>,
  statuses: readonly (typeof ConnectorSyncEventTable.$inferSelect)["status"][],
) {
  if (connectorTargetIds.length === 0) return new Set<string>()
  const rows = await db
    .select({ connectorTargetId: ConnectorSyncEventTable.connectorTargetId })
    .from(ConnectorSyncEventTable)
    .where(and(
      inArray(ConnectorSyncEventTable.connectorTargetId, connectorTargetIds),
      inArray(ConnectorSyncEventTable.status, statuses),
    ))
    .groupBy(ConnectorSyncEventTable.connectorTargetId)
  return new Set(rows.flatMap((row) => row.connectorTargetId ? [row.connectorTargetId] : []))
}

export function computeGithubSyncBackoffMs(
  attemptCount: number,
  baseMs = env.githubSync.retryBaseMs,
  random = Math.random,
) {
  const exponentialMs = baseMs * (2 ** Math.max(0, attemptCount - 1))
  const jitteredMs = exponentialMs * (0.8 + random() * 0.4)
  return Math.min(MAX_BACKOFF_MS, Math.round(jitteredMs))
}

/**
 * Puts back running events whose replica stopped before finishing them: their
 * lease expired, or they predate leases and have run for a day. Each one counts
 * as an attempt, and one out of attempts fails. Without this, an abandoned event
 * holds its target forever and every queued event behind it waits forever.
 */
export async function reclaimStaleGithubSyncEvents(now = new Date()) {
  const staleWhere = and(
    eq(ConnectorSyncEventTable.status, "running"),
    or(
      lte(ConnectorSyncEventTable.nextAttemptAt, now),
      and(
        isNull(ConnectorSyncEventTable.nextAttemptAt),
        lte(ConnectorSyncEventTable.startedAt, new Date(now.getTime() - UNLEASED_RUNNING_STALE_MS)),
      ),
    ),
  )
  const stale = await db
    .select({ id: ConnectorSyncEventTable.id, attemptCount: ConnectorSyncEventTable.attemptCount })
    .from(ConnectorSyncEventTable)
    .where(staleWhere)
    .limit(GITHUB_SYNC_POLL_LIMIT)

  let requeued = 0
  let failed = 0
  for (const event of stale) {
    const attemptCount = event.attemptCount + 1
    const retry = attemptCount < env.githubSync.maxAttempts
    const result: unknown = await db.update(ConnectorSyncEventTable).set(retry
      ? { attemptCount, nextAttemptAt: null, status: "queued" }
      : { attemptCount, completedAt: now, nextAttemptAt: null, status: "failed" },
    ).where(and(eq(ConnectorSyncEventTable.id, event.id), staleWhere))
    if (!changedRows(result)) continue
    if (retry) requeued += 1
    else failed += 1
    logger.warn("github connector sync reclaimed", { connector_sync_event_id: event.id, attempt_count: attemptCount, retrying: retry })
    if (!retry) await recordConnectorSyncCompleted(event.id)
  }
  return { requeued, failed }
}

export async function processDueGithubSyncEvents(now = new Date()) {
  await reclaimStaleGithubSyncEvents(now)

  // A page of due events whose target is not already syncing. Blocked events
  // stay in the database instead of being read and skipped on every poll.
  const events = await db
    .select({
      attemptCount: ConnectorSyncEventTable.attemptCount,
      connectorTargetId: ConnectorSyncEventTable.connectorTargetId,
      id: ConnectorSyncEventTable.id,
    })
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.status, "queued"),
      or(
        isNull(ConnectorSyncEventTable.nextAttemptAt),
        lte(ConnectorSyncEventTable.nextAttemptAt, now),
      ),
      sql`not exists (select 1 from connector_sync_event as running_event where running_event.connector_target_id = ${ConnectorSyncEventTable.connectorTargetId} and running_event.status = 'running')`,
    ))
    .orderBy(asc(ConnectorSyncEventTable.startedAt), asc(ConnectorSyncEventTable.id))
    .limit(GITHUB_SYNC_POLL_LIMIT)

  const runningTargetIds = new Set<string>()
  let claimed = 0
  let superseded = 0
  for (const event of events) {
    if (event.connectorTargetId && runningTargetIds.has(event.connectorTargetId)) continue

    const claimedAt = new Date()
    const claimResult: unknown = await db
      .update(ConnectorSyncEventTable)
      .set({ nextAttemptAt: new Date(claimedAt.getTime() + GITHUB_SYNC_RUNNING_LEASE_MS), status: "running" })
      .where(and(
        eq(ConnectorSyncEventTable.id, event.id),
        eq(ConnectorSyncEventTable.status, "queued"),
      ))
    if (!changedRows(claimResult)) continue
    claimed += 1
    if (event.connectorTargetId) {
      runningTargetIds.add(event.connectorTargetId)
      superseded += await supersedeQueuedGithubSyncEvents(event.connectorTargetId, event.id, claimedAt)
    }

    try {
      await executeGithubConnectorSyncEvent({ connectorSyncEventId: event.id })
    } catch (error) {
      const failedAt = new Date()
      const message = error instanceof Error ? error.message : String(error)
      const attemptCount = event.attemptCount + 1
      const shouldRetry = isTransientGithubSyncError(error) && attemptCount < env.githubSync.maxAttempts
      const [current] = await db
        .select({ summaryJson: ConnectorSyncEventTable.summaryJson })
        .from(ConnectorSyncEventTable)
        .where(eq(ConnectorSyncEventTable.id, event.id))
        .limit(1)
      const summaryJson = {
        ...(current?.summaryJson ?? {}),
        lastError: message,
        ...(shouldRetry ? {} : { error: message, outcome: "failed" }),
      }

      if (shouldRetry) {
        const backoffMs = computeGithubSyncBackoffMs(attemptCount)
        await db.update(ConnectorSyncEventTable).set({
          attemptCount,
          completedAt: null,
          nextAttemptAt: new Date(failedAt.getTime() + backoffMs),
          status: "queued",
          summaryJson,
        }).where(and(
          eq(ConnectorSyncEventTable.id, event.id),
          eq(ConnectorSyncEventTable.status, "running"),
        ))
      } else {
        await db.update(ConnectorSyncEventTable).set({
          attemptCount,
          completedAt: failedAt,
          nextAttemptAt: null,
          status: "failed",
          summaryJson,
        }).where(and(
          eq(ConnectorSyncEventTable.id, event.id),
          eq(ConnectorSyncEventTable.status, "running"),
        ))
      }

      logger.error("github connector auto-import failed", {
        attempt_count: attemptCount,
        connector_sync_event_id: event.id,
        connector_target_id: event.connectorTargetId,
        error: message,
        retrying: shouldRetry,
      })
    }
    await recordConnectorSyncCompleted(event.id)
  }

  return { checked: events.length, claimed, superseded }
}

/**
 * A sync imports the target's branch as it is when the sync runs, whatever
 * event queued it, so it covers every event queued for that target before it
 * was claimed. Those are closed as ignored instead of each importing again.
 */
async function supersedeQueuedGithubSyncEvents(
  connectorTargetId: NonNullable<(typeof ConnectorSyncEventTable.$inferSelect)["connectorTargetId"]>,
  claimedEventId: (typeof ConnectorSyncEventTable.$inferSelect)["id"],
  claimedAt: Date,
): Promise<number> {
  const covered = await db
    .select({ id: ConnectorSyncEventTable.id })
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.connectorTargetId, connectorTargetId),
      eq(ConnectorSyncEventTable.status, "queued"),
      ne(ConnectorSyncEventTable.id, claimedEventId),
      lte(ConnectorSyncEventTable.startedAt, claimedAt),
    ))
  if (covered.length === 0) return 0
  const coveredIds = covered.map((row) => row.id)
  const result: unknown = await db.update(ConnectorSyncEventTable).set({
    completedAt: claimedAt,
    nextAttemptAt: null,
    status: "ignored",
    summaryJson: sql`json_set(coalesce(${ConnectorSyncEventTable.summaryJson}, json_object()), '$.outcome', 'superseded', '$.supersededBy', ${claimedEventId})`,
  }).where(and(
    inArray(ConnectorSyncEventTable.id, coveredIds),
    eq(ConnectorSyncEventTable.status, "queued"),
  ))
  for (const id of coveredIds) await recordConnectorSyncCompleted(id)
  return affectedRowCount(result)
}

const GITHUB_SYNC_ACTOR_ID = "den-api.github-sync"
const GITHUB_SYNC_ACTOR: AuditActor = { type: "system", id: GITHUB_SYNC_ACTOR_ID }
const TERMINAL_SYNC_STATUSES: ReadonlySet<string> = new Set(["completed", "partial", "ignored", "failed"])

function countField(summary: Record<string, unknown> | null, key: string): number | null {
  const value = summary?.[key]
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * `connector_sync.completed` once the event is terminal (job operation, jobRunId
 * = sync event id). Counts and status only: never repository names, paths,
 * file contents, plugin names or error messages. Never throws into the worker.
 */
async function recordConnectorSyncCompleted(connectorSyncEventId: (typeof ConnectorSyncEventTable.$inferSelect)["id"]) {
  if (!env.auditCaptureEnabled) return
  try {
    const [event] = await db.select().from(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.id, connectorSyncEventId)).limit(1)
    if (!event || !TERMINAL_SYNC_STATUSES.has(event.status) || !event.completedAt) return
    const summary = isRecord(event.summaryJson) ? event.summaryJson : null
    const after = {
      status: event.status,
      attemptCount: event.attemptCount,
      discoveredPluginCount: countField(summary, "discoveredPluginCount"),
      createdPluginCount: countField(summary, "createdPluginCount"),
      materializedConfigObjectCount: countField(summary, "materializedConfigObjectCount"),
    }
    const resources: AuditEventInput["resources"] = [
      { type: "connector_sync_event", id: event.id, relationship: "target" },
      { type: "connector_instance", id: event.connectorInstanceId, relationship: "parent" },
      { type: "organization", id: event.organizationId, relationship: "parent" },
    ]
    if (event.connectorTargetId) resources.push({ type: "connector_target", id: event.connectorTargetId, relationship: "related" })
    await recordAuditJobOutcome({
      organizationId: event.organizationId, jobRunId: event.id, kind: CONNECTOR_SYNC_JOB_KIND, action: "connector_sync.completed",
      actor: GITHUB_SYNC_ACTOR, principalKey: `system:${GITHUB_SYNC_ACTOR_ID}`,
      origin: summary?.trigger === "reconcile" ? "scheduler" : event.eventType === "manual_resync" ? "api" : "webhook",
      resources,
      outcome: event.status === "failed" ? "failed" : "succeeded",
      reasonCode: event.status,
      changes: { before: { status: "running" }, after, changedFields: Object.keys(after) },
      idempotencyKey: `connector_sync:${event.id}:completed:${event.completedAt.getTime()}`,
    })
  } catch (error) {
    logger.warn("github connector sync outcome audit skipped", { connector_sync_event_id: connectorSyncEventId, error_name: error instanceof Error ? error.name : typeof error })
  }
}

function githubTargetConfig(target: typeof ConnectorTargetTable.$inferSelect) {
  const targetConfig = isRecord(target.targetConfigJson) ? target.targetConfigJson : {}
  const repositoryFullName = typeof targetConfig.repositoryFullName === "string"
    ? targetConfig.repositoryFullName.trim()
    : target.remoteId.trim()
  const branch = typeof targetConfig.branch === "string"
    ? targetConfig.branch.trim()
    : target.externalTargetRef?.trim() ?? ""
  const discoveryCache = isRecord(targetConfig.githubDiscoveryCache)
    ? targetConfig.githubDiscoveryCache
    : null
  const cachedSourceRevisionRef = discoveryCache && typeof discoveryCache.sourceRevisionRef === "string"
    ? discoveryCache.sourceRevisionRef
    : null
  return { branch, cachedSourceRevisionRef, repositoryFullName }
}

function githubInstallationId(
  instance: typeof ConnectorInstanceTable.$inferSelect,
  account: typeof ConnectorAccountTable.$inferSelect,
) {
  const instanceConfig = isRecord(instance.instanceConfigJson) ? instance.instanceConfigJson : null
  return instanceConfig && typeof instanceConfig.installationId === "number"
    ? instanceConfig.installationId
    : Number(account.remoteId)
}

type GithubReconcileRow = {
  account: typeof ConnectorAccountTable.$inferSelect
  instance: typeof ConnectorInstanceTable.$inferSelect
  target: typeof ConnectorTargetTable.$inferSelect
}

/** Connector creators who are still joined members of the connector's organization. */
async function activeConnectorCreatorKeys(instances: Array<typeof ConnectorInstanceTable.$inferSelect>) {
  if (instances.length === 0) return new Set<string>()
  const rows = await db
    .select({ id: MemberTable.id, organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(and(
      inArray(MemberTable.id, instances.map((instance) => instance.createdByOrgMembershipId)),
      isNull(MemberTable.removedAt),
      isNotNull(MemberTable.userId),
    ))
  return new Set(rows.map((row) => `${row.organizationId}:${row.id}`))
}

/**
 * Stores a target's reconcile state without moving updated_at, which keeps
 * marking a person's edit. With expectedLastProbedAt the write lands only if no
 * other replica has probed the target since this one read it.
 */
async function writeGithubReconcileState(input: {
  expectedLastProbedAt?: string | null
  state: GithubReconcileState
  targetId: (typeof ConnectorTargetTable.$inferSelect)["id"]
}) {
  const storedLastProbedAt = sql`json_unquote(json_extract(${ConnectorTargetTable.targetConfigJson}, ${sql.raw(`'$.${GITHUB_RECONCILE_STATE_KEY}.lastProbedAt'`)}))`
  const result: unknown = await db.update(ConnectorTargetTable).set({
    targetConfigJson: sql`json_set(${ConnectorTargetTable.targetConfigJson}, ${sql.raw(`'$.${GITHUB_RECONCILE_STATE_KEY}'`)}, cast(${JSON.stringify(input.state)} as json))`,
    updatedAt: sql`${ConnectorTargetTable.updatedAt}`,
  }).where(and(
    eq(ConnectorTargetTable.id, input.targetId),
    input.expectedLastProbedAt === undefined
      ? undefined
      : input.expectedLastProbedAt === null
        ? sql`${storedLastProbedAt} is null`
        : sql`${storedLastProbedAt} = ${input.expectedLastProbedAt}`,
  ))
  return changedRows(result)
}

/**
 * Queues a resync when the branch head moved past the last completed sync.
 * When the last sync of that head already failed, its error comes back so the
 * target backs off instead of queueing the same failing sync on every probe.
 */
async function probeGithubConnectorTarget(row: GithubReconcileRow, activeCreatorKeys: ReadonlySet<string>) {
  const targetConfig = githubTargetConfig(row.target)
  const installationId = githubInstallationId(row.instance, row.account)
  if (!targetConfig.repositoryFullName || !targetConfig.branch || !Number.isFinite(installationId) || installationId <= 0) {
    throw new GithubReconcilePermanentError("GitHub connector target is missing repository, branch, or installation metadata.")
  }
  // Syncs import as the connector's creator, so without them every sync fails.
  if (!activeCreatorKeys.has(`${row.instance.organizationId}:${row.instance.createdByOrgMembershipId}`)) {
    throw new GithubReconcilePermanentError("Connector creator member not found.")
  }

  const headSha = await getGithubRepositoryHeadSha({
    branch: targetConfig.branch,
    config: getGithubConnectorAppConfig(env.githubConnectorApp),
    installationId,
    repositoryFullName: targetConfig.repositoryFullName,
  })
  const completedEvents = await db
    .select({ sourceRevisionRef: ConnectorSyncEventTable.sourceRevisionRef })
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.connectorTargetId, row.target.id),
      eq(ConnectorSyncEventTable.status, "completed"),
    ))
    .orderBy(desc(ConnectorSyncEventTable.startedAt), desc(ConnectorSyncEventTable.id))
    .limit(1)
  const previousSourceRevisionRef = completedEvents[0]
    ? completedEvents[0].sourceRevisionRef
    : targetConfig.cachedSourceRevisionRef
  if (headSha === previousSourceRevisionRef) return { enqueued: false, failedSyncError: null }

  const [failedAtHead] = await db
    .select({ summaryJson: ConnectorSyncEventTable.summaryJson })
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.connectorTargetId, row.target.id),
      eq(ConnectorSyncEventTable.status, "failed"),
      eq(ConnectorSyncEventTable.sourceRevisionRef, headSha),
    ))
    .orderBy(desc(ConnectorSyncEventTable.startedAt), desc(ConnectorSyncEventTable.id))
    .limit(1)
  await db.insert(ConnectorSyncEventTable).values({
    connectorInstanceId: row.instance.id,
    connectorTargetId: row.target.id,
    connectorType: "github",
    eventType: "manual_resync",
    externalEventRef: null,
    id: createDenTypeId("connectorSyncEvent"),
    organizationId: row.instance.organizationId,
    remoteId: row.target.remoteId,
    sourceRevisionRef: headSha,
    startedAt: new Date(),
    status: "queued",
    summaryJson: { trigger: "reconcile" },
  })
  const failedSyncError = failedAtHead
    ? typeof failedAtHead.summaryJson?.error === "string" ? failedAtHead.summaryJson.error : "The last sync of this commit failed."
    : null
  return { enqueued: true, failedSyncError }
}

/** One log line when a target starts failing, is paused again after an edit, or recovers. */
function logGithubReconcileChange(
  connectorTargetId: string,
  previous: GithubReconcileState | null,
  next: GithubReconcileState,
) {
  const previousStatus = previous?.status ?? "ok"
  if (next.status === previousStatus && next.pausedRevision === (previous?.pausedRevision ?? null)) return
  const fields = {
    connector_target_id: connectorTargetId,
    error: next.error,
    failure_count: next.failureCount,
    next_probe_at: next.status === "paused" ? null : next.nextProbeAt,
    previous_status: previousStatus,
    status: next.status,
  }
  if (next.status === "ok") logger.info("github connector reconciliation state changed", fields)
  else logger.warn("github connector reconciliation state changed", fields)
}

/**
 * Every replica runs this loop, so the probe state lives on the target (see
 * github-reconcile-state.ts): a target is probed once per min-age across the
 * fleet, failures back off, and permanent failures wait for an edit.
 */
export async function reconcileGithubConnectorTargets(now = new Date()) {
  const targets = await db
    .select({
      account: ConnectorAccountTable,
      instance: ConnectorInstanceTable,
      target: ConnectorTargetTable,
    })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .innerJoin(ConnectorAccountTable, eq(ConnectorInstanceTable.connectorAccountId, ConnectorAccountTable.id))
    .where(and(
      eq(ConnectorTargetTable.connectorType, "github"),
      eq(ConnectorTargetTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorInstanceTable.connectorType, "github"),
      eq(ConnectorInstanceTable.status, "active"),
      eq(ConnectorAccountTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.status, "active"),
    ))
    .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))

  const activeTargetIds = await connectorTargetIdsWithStatuses(
    targets.map((row) => row.target.id),
    ACTIVE_GITHUB_SYNC_EVENT_STATUSES,
  )
  const candidates = targets
    .filter((row) => !activeTargetIds.has(row.target.id))
    .map((row) => ({
      ...row,
      revision: githubReconcileRevision({
        accountUpdatedAt: row.account.updatedAt,
        instanceUpdatedAt: row.instance.updatedAt,
        targetUpdatedAt: row.target.updatedAt,
      }),
      state: readGithubReconcileState(row.target.targetConfigJson),
    }))

  const minAgeMs = env.githubSync.reconcileMinAgeMs
  const selectedTargetIds = selectGithubReconcileCandidates({
    batchSize: env.githubSync.reconcileBatchSize,
    now,
    targets: candidates.map((candidate) => ({
      createdAtMs: candidate.target.createdAt.getTime(),
      dueAtMs: githubReconcileDueAtMs(candidate.state, candidate.revision),
      targetId: candidate.target.id,
    })),
  })
  const selected = selectedTargetIds.flatMap((targetId) => candidates.filter((candidate) => candidate.target.id === targetId))
  const activeCreatorKeys = await activeConnectorCreatorKeys(selected.map((candidate) => candidate.instance))

  let enqueued = 0
  let probed = 0
  for (const candidate of selected) {
    const claimed = await writeGithubReconcileState({
      expectedLastProbedAt: candidate.state?.lastProbedAt ?? null,
      state: claimGithubReconcileState({ minAgeMs, now, previous: candidate.state }),
      targetId: candidate.target.id,
    })
    if (!claimed) continue
    probed += 1

    let failure: { error: unknown } | undefined
    try {
      const probe = await probeGithubConnectorTarget(candidate, activeCreatorKeys)
      if (probe.enqueued) enqueued += 1
      if (probe.failedSyncError) failure = { error: new Error(probe.failedSyncError) }
    } catch (error) {
      failure = { error }
    }
    const next = nextGithubReconcileState({ failure, minAgeMs, now, previous: candidate.state, revision: candidate.revision })
    await writeGithubReconcileState({ state: next, targetId: candidate.target.id })
    logGithubReconcileChange(candidate.target.id, candidate.state, next)
  }

  return { checked: selectedTargetIds.length, enqueued, probed }
}

let workerTickRunning = false
let workerTickPromise: Promise<void> | null = null
let reconcileRunning = false
let reconcilePromise: Promise<void> | null = null

export function startGithubSyncWorker(
  workerIntervalMs = env.githubSync.workerIntervalMs,
  reconcileIntervalMs = env.githubSync.reconcileIntervalMs,
) {
  const runWorkerTick = () => {
    if (workerTickRunning) return
    workerTickRunning = true
    workerTickPromise = processDueGithubSyncEvents()
      .then(() => undefined)
      .catch((error) => {
        logger.error("github sync worker tick failed", { error })
        captureException(error, { component: "github_sync_worker" })
      })
      .finally(() => {
        workerTickRunning = false
        workerTickPromise = null
      })
  }
  const runReconcile = () => {
    if (reconcileRunning) return
    reconcileRunning = true
    reconcilePromise = reconcileGithubConnectorTargets()
      .then(() => undefined)
      .catch((error) => {
        logger.error("github sync reconciliation loop failed", { error })
        captureException(error, { component: "github_sync_worker_reconcile" })
      })
      .finally(() => {
        reconcileRunning = false
        reconcilePromise = null
      })
  }

  const workerTimer = Number.isFinite(workerIntervalMs) && workerIntervalMs > 0
    ? setInterval(runWorkerTick, workerIntervalMs)
    : null
  const reconcileTimer = Number.isFinite(reconcileIntervalMs) && reconcileIntervalMs > 0
    ? setInterval(runReconcile, reconcileIntervalMs)
    : null
  const reconcileInitialTimer = reconcileTimer
    ? setTimeout(runReconcile, Math.floor(Math.random() * Math.min(reconcileIntervalMs, 60_000)))
    : null
  workerTimer?.unref()
  reconcileTimer?.unref()
  reconcileInitialTimer?.unref()
  if (workerTimer) runWorkerTick()

  return async () => {
    if (workerTimer) clearInterval(workerTimer)
    if (reconcileTimer) clearInterval(reconcileTimer)
    if (reconcileInitialTimer) clearTimeout(reconcileInitialTimer)
    await Promise.all([workerTickPromise, reconcilePromise])
  }
}
