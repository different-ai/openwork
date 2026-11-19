// Library usage rollups: the same fold as the gateway request logs (rollups.ts),
// for capability_usage_event. Raw rows in closed UTC days older than the raw
// retention fold straight into day rows (no hour tier) and are deleted in the
// same transaction, so each use is visible in exactly one store. Retried runs
// consume only remaining source ids.
import { createHash } from "node:crypto"
import {
  CapabilityUsageEventTable,
  CapabilityUsageRollupLockTable,
  CapabilityUsageRollupTable,
  capabilityUsageSourceValues,
  type CapabilityUsageSource,
  type CapabilityUsageSourceCounts,
} from "@openwork-ee/den-db"
import { and, gte, inArray, lt, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

export type CapabilityUsageRollupRow = typeof CapabilityUsageRollupTable.$inferInsert

export type CapabilityUsageRollupDimensions = Pick<
  typeof CapabilityUsageRollupTable.$inferSelect,
  "organization_id" | "org_membership_id" | "kind" | "plugin_id" | "config_object_id" | "connection_id"
>

/** One (dimensions, source) group of claimed raw rows. */
export type CapabilityUsageAggregate = CapabilityUsageRollupDimensions & {
  source: CapabilityUsageSource
  use_count: number
  ok_count: number
  error_count: number
  last_used_at: Date
}

// Statements that must run inside one batch's transaction.
export type CapabilityUsageRollupStore = {
  aggregateRawDay(dayStart: Date, limit: number): Promise<{ ids: (typeof CapabilityUsageEventTable.$inferSelect.id)[]; groups: CapabilityUsageAggregate[] }>
  upsertRollups(rows: CapabilityUsageRollupRow[]): Promise<void>
  deleteRawIds(ids: (typeof CapabilityUsageEventTable.$inferSelect.id)[]): Promise<number>
}

export type CapabilityUsageRollupRepository = {
  listCandidateDayBuckets(before: Date, limit: number): Promise<Date[]>
  transaction<T>(run: (store: CapabilityUsageRollupStore) => Promise<T>): Promise<T>
}

export type RunCapabilityUsageRollupsInput = {
  repository?: CapabilityUsageRollupRepository
  now?: Date
  rawRetentionMs?: number
  maxBucketsPerRun?: number
  maxSourceRowsPerBucket?: number
  maxBatchesPerRun?: number
}

export type CapabilityUsageRollupRunSummary = {
  dayBuckets: number
  batches: number
  rawRowsDeleted: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RAW_RETENTION_MS = 2 * DAY_MS
const DEFAULT_MAX_BUCKETS_PER_RUN = 48
const DEFAULT_MAX_SOURCE_ROWS_PER_BUCKET = 1000
// A day bucket spans every organization, so one day can hold far more than one
// batch. Keep consuming it, bounded per run; a later run picks up the rest.
const DEFAULT_MAX_BATCHES_PER_RUN = 200

function floorToDay(date: Date) {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS)
}

/** Stable hash of the rollup dimensions; JSON keeps null distinct from empty strings. */
export function capabilityUsageRollupDimensionKey(dimensions: CapabilityUsageRollupDimensions): string {
  return createHash("sha256").update(JSON.stringify([
    "openwork-capability-usage-rollup-dimensions-v1",
    dimensions.organization_id,
    dimensions.org_membership_id,
    dimensions.kind,
    dimensions.plugin_id,
    dimensions.config_object_id,
    dimensions.connection_id,
  ])).digest("hex")
}

/** Collapses per-source groups into one row per dimension combination, with uses per source in source_counts. */
export function buildCapabilityUsageRollupRows(bucketStart: Date, groups: readonly CapabilityUsageAggregate[]): CapabilityUsageRollupRow[] {
  const rows = new Map<string, CapabilityUsageRollupRow & { source_counts: CapabilityUsageSourceCounts }>()
  for (const group of groups) {
    for (const value of [group.use_count, group.ok_count, group.error_count]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Capability usage rollup count is out of range")
    }
    if (group.use_count === 0) continue
    const dimensions: CapabilityUsageRollupDimensions = {
      organization_id: group.organization_id,
      org_membership_id: group.org_membership_id,
      kind: group.kind,
      plugin_id: group.plugin_id,
      config_object_id: group.config_object_id,
      connection_id: group.connection_id,
    }
    const dimensionKey = capabilityUsageRollupDimensionKey(dimensions)
    const row = rows.get(dimensionKey) ?? {
      ...dimensions,
      id: createDenTypeId("capabilityUsageRollup"),
      bucket_start: bucketStart,
      dimension_key: dimensionKey,
      use_count: 0,
      ok_count: 0,
      error_count: 0,
      source_row_count: 0,
      source_counts: {},
      last_used_at: group.last_used_at,
    }
    row.use_count = (row.use_count ?? 0) + group.use_count
    row.ok_count = (row.ok_count ?? 0) + group.ok_count
    row.error_count = (row.error_count ?? 0) + group.error_count
    row.source_row_count = (row.source_row_count ?? 0) + group.use_count
    row.source_counts[group.source] = (row.source_counts[group.source] ?? 0) + group.use_count
    if (group.last_used_at > row.last_used_at) row.last_used_at = group.last_used_at
    rows.set(dimensionKey, row)
  }
  return [...rows.values()]
}

export function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

function isCapabilityUsageSource(value: string): value is CapabilityUsageSource {
  return capabilityUsageSourceValues.some((source) => source === value)
}

const raw = CapabilityUsageEventTable
const rollup = CapabilityUsageRollupTable

/**
 * MySQL cannot add two JSON objects, so a duplicate bucket sums each known
 * source key. A key missing on either side counts as zero.
 */
const mergeSourceCounts = sql`json_set(coalesce(${rollup.source_counts}, json_object()), ${sql.join(capabilityUsageSourceValues.map((source) =>
  sql`${`$.${source}`}, coalesce(json_extract(${rollup.source_counts}, ${`$.${source}`}), 0) + coalesce(json_extract(values(${sql.identifier("source_counts")}), ${`$.${source}`}), 0)`), sql`, `)})`

type DbTransaction = Parameters<Parameters<typeof import("./db.js").db.transaction>[0]>[0]

function createDbCapabilityUsageRollupStore(executor: DbTransaction): CapabilityUsageRollupStore {
  return {
    async aggregateRawDay(dayStart, limit) {
      const end = new Date(dayStart.getTime() + DAY_MS)
      const claimed = await executor.select({ id: raw.id }).from(raw)
        .where(and(gte(raw.created_at, dayStart), lt(raw.created_at, end)))
        .orderBy(raw.created_at, raw.id).limit(limit).for("update")
      const ids = claimed.map((row) => row.id)
      if (!ids.length) return { ids, groups: [] }
      const rows = await executor
        .select({
          organization_id: raw.organization_id,
          org_membership_id: raw.org_membership_id,
          kind: raw.kind,
          plugin_id: raw.plugin_id,
          config_object_id: raw.config_object_id,
          connection_id: raw.connection_id,
          source: raw.source,
          use_count: sql<number>`count(*)`.mapWith(Number),
          ok_count: sql<number>`coalesce(sum(case when ${raw.outcome} = 'ok' then 1 else 0 end), 0)`.mapWith(Number),
          error_count: sql<number>`coalesce(sum(case when ${raw.outcome} = 'error' then 1 else 0 end), 0)`.mapWith(Number),
          last_used_at: sql<Date>`max(${raw.created_at})`.mapWith(raw.created_at),
        })
        .from(raw)
        .where(inArray(raw.id, ids))
        .groupBy(raw.organization_id, raw.org_membership_id, raw.kind, raw.plugin_id, raw.config_object_id, raw.connection_id, raw.source)
      // An unknown source (a newer writer) still counts as use, credited to the agent.
      const groups = rows.map((row) => ({ ...row, source: isCapabilityUsageSource(row.source) ? row.source : "agent" as const }))
      return { ids, groups }
    },
    async upsertRollups(rows) {
      if (rows.length === 0) return
      await executor.insert(rollup).values(rows).onDuplicateKeyUpdate({
        set: {
          use_count: sql`${rollup.use_count} + values(${sql.identifier("use_count")})`,
          ok_count: sql`${rollup.ok_count} + values(${sql.identifier("ok_count")})`,
          error_count: sql`${rollup.error_count} + values(${sql.identifier("error_count")})`,
          source_row_count: sql`${rollup.source_row_count} + values(${sql.identifier("source_row_count")})`,
          source_counts: mergeSourceCounts,
          last_used_at: sql`greatest(${rollup.last_used_at}, values(${sql.identifier("last_used_at")}))`,
        },
      })
    },
    async deleteRawIds(ids) {
      if (!ids.length) return 0
      const result = await executor.delete(raw).where(inArray(raw.id, ids))
      return affectedRows(result)
    },
  }
}

export function createDbCapabilityUsageRollupRepository(db: typeof import("./db.js").db): CapabilityUsageRollupRepository {
  return {
    async listCandidateDayBuckets(before, limit) {
      // Bucket starts are derived server-side via UNIX_TIMESTAMP, which matches
      // the JS epoch under the UTC session assumption drizzle's timestamp mapping makes.
      const bucket = sql<number>`floor(unix_timestamp(${raw.created_at}) / 86400)`.mapWith(Number)
      const rows = await db.select({ bucket }).from(raw).where(lt(raw.created_at, before)).groupBy(bucket).orderBy(bucket).limit(limit)
      return rows.map((row) => new Date(row.bucket * DAY_MS))
    },
    transaction(run) {
      return db.transaction(async (tx) => {
        // Taken before any source lock, like gateway_rollup_lock: two runs never
        // fold the same rows, and upserts never race a concurrent fold.
        await tx.insert(CapabilityUsageRollupLockTable).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } })
        return run(createDbCapabilityUsageRollupStore(tx))
      })
    },
  }
}

async function defaultRepository() {
  const { db } = await import("./db.js")
  return createDbCapabilityUsageRollupRepository(db)
}

export async function runCapabilityUsageRollups(input: RunCapabilityUsageRollupsInput = {}): Promise<CapabilityUsageRollupRunSummary> {
  const now = input.now ?? new Date()
  const rawRetentionMs = input.rawRetentionMs ?? DEFAULT_RAW_RETENTION_MS
  const maxBucketsPerRun = input.maxBucketsPerRun ?? DEFAULT_MAX_BUCKETS_PER_RUN
  const maxSourceRowsPerBucket = input.maxSourceRowsPerBucket ?? DEFAULT_MAX_SOURCE_ROWS_PER_BUCKET
  const maxBatchesPerRun = input.maxBatchesPerRun ?? DEFAULT_MAX_BATCHES_PER_RUN
  if (!Number.isInteger(maxBucketsPerRun) || maxBucketsPerRun < 1 || maxBucketsPerRun > 1000
    || !Number.isInteger(maxSourceRowsPerBucket) || maxSourceRowsPerBucket < 1 || maxSourceRowsPerBucket > 5000
    || !Number.isInteger(maxBatchesPerRun) || maxBatchesPerRun < 1 || maxBatchesPerRun > 10_000
    || !Number.isFinite(now.getTime()) || !Number.isFinite(rawRetentionMs) || rawRetentionMs < 0) throw new Error("Invalid capability usage rollup bounds")
  const repository = input.repository ?? (await defaultRepository())
  const summary: CapabilityUsageRollupRunSummary = { dayBuckets: 0, batches: 0, rawRowsDeleted: 0 }

  // Only closed days: the whole day must be older than the raw retention.
  const dayCutoff = floorToDay(new Date(now.getTime() - rawRetentionMs))
  for (const dayStart of await repository.listCandidateDayBuckets(dayCutoff, maxBucketsPerRun)) {
    if (summary.batches >= maxBatchesPerRun) break
    summary.dayBuckets += 1
    while (summary.batches < maxBatchesPerRun) {
      const { claimed, deleted } = await repository.transaction(async (store) => {
        const { ids, groups } = await store.aggregateRawDay(dayStart, maxSourceRowsPerBucket)
        await store.upsertRollups(buildCapabilityUsageRollupRows(dayStart, groups))
        return { claimed: ids.length, deleted: await store.deleteRawIds(ids) }
      })
      summary.batches += 1
      summary.rawRowsDeleted += deleted
      if (claimed < maxSourceRowsPerBucket) break
    }
  }
  return summary
}
