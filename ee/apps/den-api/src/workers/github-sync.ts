import { and, asc, desc, eq, inArray, isNull, lte, or } from "@openwork-ee/den-db/drizzle"
import {
  ConnectorAccountTable,
  ConnectorInstanceTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import {
  getGithubConnectorAppConfig,
  getGithubRepositoryHeadSha,
} from "../routes/org/plugin-system/github-app.js"
import { executeGithubConnectorSyncEvent } from "../routes/org/plugin-system/store.js"
import { isTransientGithubSyncError } from "./github-sync-retry.js"

export { isTransientGithubSyncError } from "./github-sync-retry.js"

const logger = appLogger.child({ component: "github_sync_worker" })
const MAX_BACKOFF_MS = 15 * 60_000
const ACTIVE_GITHUB_SYNC_EVENT_STATUSES = ["queued", "running"] as const
// This bounds one process; multi-replica dedup/leadership is deliberately deferred to #3568.
const githubReconcileLastProbedAtMs = new Map<string, number>()

export function resetGithubReconcileProbeStateForTests() {
  githubReconcileLastProbedAtMs.clear()
}

export function selectGithubReconcileCandidates(input: {
  batchSize: number
  minAgeMs: number
  now: Date
  targets: Array<{ targetId: string; createdAtMs: number }>
  lastProbedAtMs: ReadonlyMap<string, number>
}): string[] {
  const nowMs = input.now.getTime()
  return [...input.targets]
    .filter((target) => {
      const lastProbedAtMs = input.lastProbedAtMs.get(target.targetId)
      return lastProbedAtMs === undefined || nowMs - lastProbedAtMs >= input.minAgeMs
    })
    .sort((left, right) => {
      const leftLastProbedAtMs = input.lastProbedAtMs.get(left.targetId)
      const rightLastProbedAtMs = input.lastProbedAtMs.get(right.targetId)
      if (leftLastProbedAtMs === undefined && rightLastProbedAtMs !== undefined) return -1
      if (leftLastProbedAtMs !== undefined && rightLastProbedAtMs === undefined) return 1
      if (leftLastProbedAtMs !== undefined && rightLastProbedAtMs !== undefined) {
        const probedAtOrder = leftLastProbedAtMs - rightLastProbedAtMs
        if (probedAtOrder !== 0) return probedAtOrder
      }
      const createdAtOrder = left.createdAtMs - right.createdAtMs
      return createdAtOrder || left.targetId.localeCompare(right.targetId)
    })
    .slice(0, Math.max(0, Math.floor(input.batchSize)))
    .map((target) => target.targetId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function changedRows(result: unknown): boolean {
  if (Array.isArray(result)) {
    return result.some((entry) => changedRows(entry))
  }
  if (!isRecord(result)) return false
  if (typeof result.rowsAffected === "number") return result.rowsAffected > 0
  if (typeof result.affectedRows === "number") return result.affectedRows > 0
  return false
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

export async function processDueGithubSyncEvents(now = new Date()) {
  const events = await db
    .select()
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.status, "queued"),
      or(
        isNull(ConnectorSyncEventTable.nextAttemptAt),
        lte(ConnectorSyncEventTable.nextAttemptAt, now),
      ),
    ))
    .orderBy(asc(ConnectorSyncEventTable.startedAt), asc(ConnectorSyncEventTable.id))

  const eventTargetIds = [...new Set(events.flatMap((event) => event.connectorTargetId ? [event.connectorTargetId] : []))]
  const runningTargetIds = await connectorTargetIdsWithStatuses(eventTargetIds, ["running"])

  let claimed = 0
  for (const event of events) {
    if (event.connectorTargetId && runningTargetIds.has(event.connectorTargetId)) continue

    const claimResult: unknown = await db
      .update(ConnectorSyncEventTable)
      .set({ status: "running" })
      .where(and(
        eq(ConnectorSyncEventTable.id, event.id),
        eq(ConnectorSyncEventTable.status, "queued"),
      ))
    if (!changedRows(claimResult)) continue
    claimed += 1
    if (event.connectorTargetId) runningTargetIds.add(event.connectorTargetId)

    try {
      await executeGithubConnectorSyncEvent({ connectorSyncEventId: event.id })
    } catch (error) {
      const failedAt = new Date()
      const message = error instanceof Error ? error.message : String(error)
      const attemptCount = event.attemptCount + 1
      const shouldRetry = isTransientGithubSyncError(error) && attemptCount < env.githubSync.maxAttempts
      const summaryJson = {
        ...(event.summaryJson ?? {}),
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
  }

  return { checked: events.length, claimed }
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

export async function reconcileGithubConnectorTargets() {
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
  const candidateTargets = targets.filter((row) => !activeTargetIds.has(row.target.id))

  const now = new Date()
  const selectedTargetIds = selectGithubReconcileCandidates({
    batchSize: env.githubSync.reconcileBatchSize,
    lastProbedAtMs: githubReconcileLastProbedAtMs,
    minAgeMs: env.githubSync.reconcileMinAgeMs,
    now,
    targets: candidateTargets.map((row) => ({
      createdAtMs: row.target.createdAt.getTime(),
      targetId: row.target.id,
    })),
  })

  let enqueued = 0
  for (const targetId of selectedTargetIds) {
    const row = candidateTargets.find((candidate) => candidate.target.id === targetId)
    if (!row) continue
    githubReconcileLastProbedAtMs.set(row.target.id, now.getTime())
    try {
      const targetConfig = githubTargetConfig(row.target)
      const installationId = githubInstallationId(row.instance, row.account)
      if (!targetConfig.repositoryFullName || !targetConfig.branch || !Number.isFinite(installationId) || installationId <= 0) {
        throw new Error("GitHub connector target is missing repository, branch, or installation metadata.")
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
      if (headSha === previousSourceRevisionRef) continue

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
      enqueued += 1
    } catch (error) {
      logger.error("github connector reconciliation failed", {
        connector_target_id: row.target.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { checked: selectedTargetIds.length, enqueued }
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
