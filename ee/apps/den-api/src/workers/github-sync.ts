import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConnectorAccountTable,
  ConnectorInstanceTable,
  ConnectorSyncEventTable,
  ConnectorTargetReconcileTable,
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
  githubReconcileRevisionAt,
  GithubReconcilePermanentError,
  LEGACY_GITHUB_RECONCILE_STATE_KEY,
  nextGithubReconcileState,
  readLegacyGithubReconcileState,
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
  // Primary: a lagging replica would miss another replica's fresh claim and run
  // a second sync of the same target.
  const events = await db.$primary
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
      // Primary: keeps the summary the failed sync may have just written.
      const [current] = await db.$primary
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
    // Primary: called right after the event was marked terminal.
    const [event] = await db.$primary.select().from(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.id, connectorSyncEventId)).limit(1)
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

// A run claims a due target by moving its next probe this far ahead, so a run
// that stops mid-probe (deploy, crash, timeout) leaves it due again shortly.
export const GITHUB_RECONCILE_PROBE_LEASE_MS = 10 * 60_000
// New targets get a reconcile row in pages of this size.
export const GITHUB_RECONCILE_SEED_LIMIT = 200
const GITHUB_RECONCILE_SEED_MAX_PAGES = 10
const GITHUB_RECONCILE_RESUME_LIMIT = 200

type ConnectorTargetId = (typeof ConnectorTargetTable.$inferSelect)["id"]
type JsonConfigColumn = typeof ConnectorTargetTable.targetConfigJson | typeof ConnectorInstanceTable.instanceConfigJson

function jsonString(column: JsonConfigColumn, path: string) {
  return sql<string | null>`case when json_type(json_extract(${column}, ${path})) = 'STRING' then json_unquote(json_extract(${column}, ${path})) end`
}

function jsonNumberText(column: JsonConfigColumn, path: string) {
  return sql<string | null>`case when json_type(json_extract(${column}, ${path})) in ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL') then cast(json_extract(${column}, ${path}) as char) end`
}

/**
 * Gives GitHub targets without a reconcile row one, in pages read from the
 * (connector_type, created_at, id) index. Only the page's own targets are read
 * for the state earlier releases kept in their config, by primary key, so no
 * query ever sorts target configs.
 */
async function seedGithubReconcileRows(now: Date) {
  let seeded = 0
  for (let page = 0; page < GITHUB_RECONCILE_SEED_MAX_PAGES; page += 1) {
    const missing = await db.$primary
      .select({ id: ConnectorTargetTable.id })
      .from(ConnectorTargetTable)
      .leftJoin(ConnectorTargetReconcileTable, eq(ConnectorTargetReconcileTable.connectorTargetId, ConnectorTargetTable.id))
      .where(and(
        eq(ConnectorTargetTable.connectorType, "github"),
        isNull(ConnectorTargetReconcileTable.connectorTargetId),
      ))
      .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))
      .limit(GITHUB_RECONCILE_SEED_LIMIT)
    if (missing.length === 0) break

    const targets = await db.$primary
      .select({
        id: ConnectorTargetTable.id,
        legacyState: sql<string | null>`cast(json_extract(${ConnectorTargetTable.targetConfigJson}, ${`$.${LEGACY_GITHUB_RECONCILE_STATE_KEY}`}) as char)`,
        organizationId: ConnectorTargetTable.organizationId,
      })
      .from(ConnectorTargetTable)
      .where(inArray(ConnectorTargetTable.id, missing.map((row) => row.id)))
    if (targets.length > 0) {
      await db.insert(ConnectorTargetReconcileTable).values(targets.map((target) => {
        const legacy = readLegacyGithubReconcileState(target.legacyState)
        return {
          connectorTargetId: target.id,
          connectorType: "github" as const,
          error: legacy?.error ?? null,
          failureCount: legacy?.failureCount ?? 0,
          lastProbedAt: legacy?.lastProbedAt ?? null,
          nextProbeAt: legacy ? legacy.nextProbeAt : now,
          organizationId: target.organizationId,
          pausedRevisionAt: legacy?.pausedRevisionAt ?? null,
          status: legacy?.status ?? "ok",
        }
      })).onDuplicateKeyUpdate({ set: { connectorTargetId: sql`${ConnectorTargetReconcileTable.connectorTargetId}` } })
      seeded += targets.length
    }
    if (missing.length < GITHUB_RECONCILE_SEED_LIMIT) break
  }
  return seeded
}

/** Makes paused targets due again once their connector changed after the pause. */
async function resumeEditedGithubReconcileTargets(now: Date) {
  const edited = await db
    .select({ id: ConnectorTargetReconcileTable.connectorTargetId })
    .from(ConnectorTargetReconcileTable)
    .innerJoin(ConnectorTargetTable, eq(ConnectorTargetTable.id, ConnectorTargetReconcileTable.connectorTargetId))
    .innerJoin(ConnectorInstanceTable, eq(ConnectorInstanceTable.id, ConnectorTargetTable.connectorInstanceId))
    .innerJoin(ConnectorAccountTable, eq(ConnectorAccountTable.id, ConnectorInstanceTable.connectorAccountId))
    .where(and(
      eq(ConnectorTargetReconcileTable.connectorType, "github"),
      eq(ConnectorTargetReconcileTable.status, "paused"),
      isNull(ConnectorTargetReconcileTable.nextProbeAt),
      or(
        isNull(ConnectorTargetReconcileTable.pausedRevisionAt),
        gt(ConnectorTargetTable.updatedAt, ConnectorTargetReconcileTable.pausedRevisionAt),
        gt(ConnectorInstanceTable.updatedAt, ConnectorTargetReconcileTable.pausedRevisionAt),
        gt(ConnectorAccountTable.updatedAt, ConnectorTargetReconcileTable.pausedRevisionAt),
      ),
    ))
    .limit(GITHUB_RECONCILE_RESUME_LIMIT)
  if (edited.length === 0) return 0
  const result: unknown = await db.update(ConnectorTargetReconcileTable).set({ nextProbeAt: now }).where(and(
    inArray(ConnectorTargetReconcileTable.connectorTargetId, edited.map((row) => row.id)),
    eq(ConnectorTargetReconcileTable.status, "paused"),
    isNull(ConnectorTargetReconcileTable.nextProbeAt),
  ))
  return affectedRowCount(result)
}

type GithubReconcileTarget = {
  accountUpdatedAt: Date
  branch: string
  cachedSourceRevisionRef: string | null
  createdByOrgMembershipId: (typeof ConnectorInstanceTable.$inferSelect)["createdByOrgMembershipId"]
  installationId: number
  instanceId: (typeof ConnectorInstanceTable.$inferSelect)["id"]
  instanceUpdatedAt: Date
  organizationId: (typeof ConnectorInstanceTable.$inferSelect)["organizationId"]
  remoteId: string
  repositoryFullName: string
  targetId: ConnectorTargetId
  targetUpdatedAt: Date
}

/**
 * The fields a probe needs, for one page of targets: config values are read
 * with json_extract, never whole configs. Targets whose connector is no longer
 * active come back as ineligible; deleted ones do not come back.
 */
async function loadGithubReconcileTargets(targetIds: ConnectorTargetId[]) {
  const rows = await db
    .select({
      accountOrganizationId: ConnectorAccountTable.organizationId,
      accountRemoteId: ConnectorAccountTable.remoteId,
      accountStatus: ConnectorAccountTable.status,
      accountType: ConnectorAccountTable.connectorType,
      accountUpdatedAt: ConnectorAccountTable.updatedAt,
      branch: jsonString(ConnectorTargetTable.targetConfigJson, "$.branch"),
      cachedSourceRevisionRef: jsonString(ConnectorTargetTable.targetConfigJson, "$.githubDiscoveryCache.sourceRevisionRef"),
      createdByOrgMembershipId: ConnectorInstanceTable.createdByOrgMembershipId,
      externalTargetRef: ConnectorTargetTable.externalTargetRef,
      installationId: jsonNumberText(ConnectorInstanceTable.instanceConfigJson, "$.installationId"),
      instanceId: ConnectorInstanceTable.id,
      instanceOrganizationId: ConnectorInstanceTable.organizationId,
      instanceStatus: ConnectorInstanceTable.status,
      instanceType: ConnectorInstanceTable.connectorType,
      instanceUpdatedAt: ConnectorInstanceTable.updatedAt,
      remoteId: ConnectorTargetTable.remoteId,
      repositoryFullName: jsonString(ConnectorTargetTable.targetConfigJson, "$.repositoryFullName"),
      targetId: ConnectorTargetTable.id,
      targetOrganizationId: ConnectorTargetTable.organizationId,
      targetType: ConnectorTargetTable.connectorType,
      targetUpdatedAt: ConnectorTargetTable.updatedAt,
    })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .innerJoin(ConnectorAccountTable, eq(ConnectorInstanceTable.connectorAccountId, ConnectorAccountTable.id))
    .where(inArray(ConnectorTargetTable.id, targetIds))

  const eligible = new Map<ConnectorTargetId, GithubReconcileTarget>()
  const ineligible = new Set<ConnectorTargetId>()
  for (const row of rows) {
    const active = row.targetType === "github"
      && row.instanceType === "github"
      && row.accountType === "github"
      && row.instanceStatus === "active"
      && row.accountStatus === "active"
      && row.targetOrganizationId === row.instanceOrganizationId
      && row.accountOrganizationId === row.instanceOrganizationId
    if (!active) {
      ineligible.add(row.targetId)
      continue
    }
    eligible.set(row.targetId, {
      accountUpdatedAt: row.accountUpdatedAt,
      branch: row.branch !== null ? row.branch.trim() : row.externalTargetRef?.trim() ?? "",
      cachedSourceRevisionRef: row.cachedSourceRevisionRef,
      createdByOrgMembershipId: row.createdByOrgMembershipId,
      installationId: row.installationId !== null ? Number(row.installationId) : Number(row.accountRemoteId),
      instanceId: row.instanceId,
      instanceUpdatedAt: row.instanceUpdatedAt,
      organizationId: row.instanceOrganizationId,
      remoteId: row.remoteId,
      repositoryFullName: row.repositoryFullName !== null ? row.repositoryFullName.trim() : row.remoteId.trim(),
      targetId: row.targetId,
      targetUpdatedAt: row.targetUpdatedAt,
    })
  }
  return { eligible, ineligible }
}

/** Connector creators who are still joined members of the connector's organization. */
async function activeConnectorCreatorKeys(targets: GithubReconcileTarget[]) {
  if (targets.length === 0) return new Set<string>()
  const rows = await db
    .select({ id: MemberTable.id, organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(and(
      inArray(MemberTable.id, targets.map((target) => target.createdByOrgMembershipId)),
      isNull(MemberTable.removedAt),
      isNotNull(MemberTable.userId),
    ))
  return new Set(rows.map((row) => `${row.organizationId}:${row.id}`))
}

async function writeGithubReconcileState(targetId: ConnectorTargetId, state: GithubReconcileState) {
  await db.update(ConnectorTargetReconcileTable).set({
    error: state.error,
    failureCount: state.failureCount,
    lastProbedAt: state.lastProbedAt,
    nextProbeAt: state.nextProbeAt,
    pausedRevisionAt: state.pausedRevisionAt,
    status: state.status,
  }).where(eq(ConnectorTargetReconcileTable.connectorTargetId, targetId))
}

/**
 * Queues a resync when the branch head moved past the last completed sync.
 * When the last sync of that head already failed, its error comes back so the
 * target backs off instead of queueing the same failing sync on every probe.
 */
async function probeGithubConnectorTarget(target: GithubReconcileTarget, activeCreatorKeys: ReadonlySet<string>) {
  if (!target.repositoryFullName || !target.branch || !Number.isFinite(target.installationId) || target.installationId <= 0) {
    throw new GithubReconcilePermanentError("GitHub connector target is missing repository, branch, or installation metadata.")
  }
  // Syncs import as the connector's creator, so without them every sync fails.
  if (!activeCreatorKeys.has(`${target.organizationId}:${target.createdByOrgMembershipId}`)) {
    throw new GithubReconcilePermanentError("Connector creator member not found.")
  }

  const headSha = await getGithubRepositoryHeadSha({
    branch: target.branch,
    config: getGithubConnectorAppConfig(env.githubConnectorApp),
    installationId: target.installationId,
    repositoryFullName: target.repositoryFullName,
  })
  const completedEvents = await db
    .select({ sourceRevisionRef: ConnectorSyncEventTable.sourceRevisionRef })
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.connectorTargetId, target.targetId),
      eq(ConnectorSyncEventTable.status, "completed"),
    ))
    .orderBy(desc(ConnectorSyncEventTable.startedAt), desc(ConnectorSyncEventTable.id))
    .limit(1)
  const previousSourceRevisionRef = completedEvents[0]
    ? completedEvents[0].sourceRevisionRef
    : target.cachedSourceRevisionRef
  if (headSha === previousSourceRevisionRef) return { enqueued: false, failedSyncError: null }

  const [failedAtHead] = await db
    .select({ summaryJson: ConnectorSyncEventTable.summaryJson })
    .from(ConnectorSyncEventTable)
    .where(and(
      eq(ConnectorSyncEventTable.connectorTargetId, target.targetId),
      eq(ConnectorSyncEventTable.status, "failed"),
      eq(ConnectorSyncEventTable.sourceRevisionRef, headSha),
    ))
    .orderBy(desc(ConnectorSyncEventTable.startedAt), desc(ConnectorSyncEventTable.id))
    .limit(1)
  await db.insert(ConnectorSyncEventTable).values({
    connectorInstanceId: target.instanceId,
    connectorTargetId: target.targetId,
    connectorType: "github",
    eventType: "manual_resync",
    externalEventRef: null,
    id: createDenTypeId("connectorSyncEvent"),
    organizationId: target.organizationId,
    remoteId: target.remoteId,
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
  previousStatus: GithubReconcileState["status"],
  next: GithubReconcileState,
) {
  if (next.status === previousStatus && next.status !== "paused") return
  const fields = {
    connector_target_id: connectorTargetId,
    error: next.error,
    failure_count: next.failureCount,
    next_probe_at: next.nextProbeAt?.toISOString() ?? null,
    previous_status: previousStatus,
    status: next.status,
  }
  if (next.status === "ok") logger.info("github connector reconciliation state changed", fields)
  else logger.warn("github connector reconciliation state changed", fields)
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await run(item)
    }
  })
  await Promise.all(workers)
}

export type GithubReconcileRunOptions = {
  batchSize?: number
  maxBatches?: number
  /** Stops starting new batches after this long; a batch already started finishes. */
  budgetMs?: number
  probeConcurrency?: number
}

export type GithubReconcileRunSummary = {
  seeded: number
  resumed: number
  batches: number
  claimed: number
  probed: number
  enqueued: number
  skippedSyncing: number
  removed: number
  hasMore: boolean
}

type GithubReconcileBatchTotals = Pick<GithubReconcileRunSummary, "claimed" | "probed" | "enqueued" | "skippedSyncing" | "removed">

/**
 * One page of due targets: read from the (connector_type, next_probe_at)
 * index, claimed, and probed a few at a time. Every row read is moved out of
 * the due range, whether it is probed, skipped or removed, so the next page
 * reads the next targets.
 */
async function reconcileGithubBatch(now: Date, batchSize: number, probeConcurrency: number, totals: GithubReconcileBatchTotals) {
  // Primary: a lagging replica would hand back rows this run already claimed.
  const due = await db.$primary
    .select({
      failureCount: ConnectorTargetReconcileTable.failureCount,
      id: ConnectorTargetReconcileTable.connectorTargetId,
      nextProbeAt: ConnectorTargetReconcileTable.nextProbeAt,
      status: ConnectorTargetReconcileTable.status,
    })
    .from(ConnectorTargetReconcileTable)
    .where(and(
      eq(ConnectorTargetReconcileTable.connectorType, "github"),
      lte(ConnectorTargetReconcileTable.nextProbeAt, now),
    ))
    .orderBy(asc(ConnectorTargetReconcileTable.nextProbeAt), asc(ConnectorTargetReconcileTable.connectorTargetId))
    .limit(batchSize)

  const leaseUntil = new Date(now.getTime() + GITHUB_RECONCILE_PROBE_LEASE_MS)
  const claimed: typeof due = []
  for (const row of due) {
    if (!row.nextProbeAt) continue
    const result: unknown = await db.update(ConnectorTargetReconcileTable).set({ nextProbeAt: leaseUntil }).where(and(
      eq(ConnectorTargetReconcileTable.connectorTargetId, row.id),
      eq(ConnectorTargetReconcileTable.nextProbeAt, row.nextProbeAt),
    ))
    if (changedRows(result)) claimed.push(row)
  }
  totals.claimed += claimed.length
  if (claimed.length === 0) return due.length

  const claimedIds = claimed.map((row) => row.id)
  const [{ eligible, ineligible }, syncingIds] = await Promise.all([
    loadGithubReconcileTargets(claimedIds),
    connectorTargetIdsWithStatuses(claimedIds, ACTIVE_GITHUB_SYNC_EVENT_STATUSES),
  ])

  const gone = claimedIds.filter((id) => !eligible.has(id) && !ineligible.has(id))
  if (gone.length > 0) {
    await db.delete(ConnectorTargetReconcileTable).where(inArray(ConnectorTargetReconcileTable.connectorTargetId, gone))
    totals.removed += gone.length
  }
  // An inactive connector is checked again after the usual interval.
  const minAgeMs = env.githubSync.reconcileMinAgeMs
  if (ineligible.size > 0) {
    await db.update(ConnectorTargetReconcileTable)
      .set({ nextProbeAt: new Date(now.getTime() + minAgeMs) })
      .where(inArray(ConnectorTargetReconcileTable.connectorTargetId, [...ineligible]))
  }

  // A target that is already syncing keeps its lease and is checked once it passes.
  totals.skippedSyncing += claimed.filter((row) => eligible.has(row.id) && syncingIds.has(row.id)).length
  const toProbe = claimed.flatMap((row) => {
    const target = eligible.get(row.id)
    return target && !syncingIds.has(row.id) ? [{ previous: row, target }] : []
  })
  const activeCreatorKeys = await activeConnectorCreatorKeys(toProbe.map((entry) => entry.target))

  await forEachWithConcurrency(toProbe, probeConcurrency, async ({ previous, target }) => {
    totals.probed += 1
    let failure: { error: unknown } | undefined
    try {
      const probe = await probeGithubConnectorTarget(target, activeCreatorKeys)
      if (probe.enqueued) totals.enqueued += 1
      if (probe.failedSyncError) failure = { error: new Error(probe.failedSyncError) }
    } catch (error) {
      failure = { error }
    }
    const next = nextGithubReconcileState({
      failure,
      minAgeMs,
      now,
      previous,
      revisionAt: githubReconcileRevisionAt(target),
    })
    await writeGithubReconcileState(target.targetId, next)
    logGithubReconcileChange(target.targetId, previous.status, next)
  })
  return due.length
}

/**
 * Checks due GitHub targets against their branch heads and queues a resync for
 * the ones that moved. Run by a scheduled caller of POST
 * /internal/github/reconcile/run; overlapping runs are safe, since each target
 * is claimed by one run. Reads due targets in pages from connector_target_reconcile until
 * none are due, maxBatches pages were read, or budgetMs passed.
 */
export async function reconcileGithubConnectorTargets(now = new Date(), options: GithubReconcileRunOptions = {}): Promise<GithubReconcileRunSummary> {
  const startedAtMs = Date.now()
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? env.githubSync.reconcileBatchSize))
  const maxBatches = Math.max(1, Math.floor(options.maxBatches ?? env.githubSync.reconcileMaxBatches))
  const budgetMs = options.budgetMs ?? env.githubSync.reconcileRunBudgetMs
  const probeConcurrency = Math.max(1, Math.floor(options.probeConcurrency ?? env.githubSync.reconcileProbeConcurrency))

  const seeded = await seedGithubReconcileRows(now)
  const resumed = await resumeEditedGithubReconcileTargets(now)

  const totals: GithubReconcileBatchTotals = { claimed: 0, enqueued: 0, probed: 0, removed: 0, skippedSyncing: 0 }
  let batches = 0
  let hasMore = false
  while (true) {
    const read = await reconcileGithubBatch(now, batchSize, probeConcurrency, totals)
    batches += 1
    hasMore = read === batchSize
    if (!hasMore || batches >= maxBatches || Date.now() - startedAtMs >= budgetMs) break
  }

  const summary = { seeded, resumed, batches, ...totals, hasMore }
  if (summary.claimed > 0 || seeded > 0 || resumed > 0 || hasMore) {
    logger.info("github connector reconciliation run", { ...summary, duration_ms: Date.now() - startedAtMs })
  }
  return summary
}

let workerTickRunning = false
let workerTickPromise: Promise<void> | null = null

/**
 * Polls the sync queue every few seconds on every replica. The reconcile does
 * not run here: a scheduled caller runs it through POST /internal/github/reconcile/run.
 */
export function startGithubSyncWorker(workerIntervalMs = env.githubSync.workerIntervalMs) {
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

  const workerTimer = Number.isFinite(workerIntervalMs) && workerIntervalMs > 0
    ? setInterval(runWorkerTick, workerIntervalMs)
    : null
  workerTimer?.unref()
  if (workerTimer) runWorkerTick()

  return async () => {
    if (workerTimer) clearInterval(workerTimer)
    await workerTickPromise
  }
}
