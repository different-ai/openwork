// Rollup job (plan §4.8): raw request logs older than rawRetention fold into
// hour rollups, hour rollups older than hourlyRetention fold into day rollups.
// One bounded source batch per bucket/transaction. Retried runs consume only
// remaining source IDs; inserting new raw rows is NEW consumption, not replay.
import { timingSafeEqual } from "node:crypto"
import { GatewayProviderOauthStateTable, GatewayRequestLogTable, GatewayUsageRollupTable, GatewayRollupLockTable } from "@openwork-ee/den-db"
import { gatewayRollupDimensionKey } from "@openwork-ee/utils/gateway-rollups"
import { and, eq, gte, inArray, lt, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { z } from "zod"

export type RollupRow = typeof GatewayUsageRollupTable.$inferInsert

export type RollupDimensions = Pick<
  typeof GatewayUsageRollupTable.$inferSelect,
  "organization_id" | "org_membership_id" | "gateway_provider_id" | "model_group_id" | "credential_set_id" | "access_grant_id" | "route" | "protocol" | "upstream_provider_id" | "upstream_model"
>

export const ROLLUP_SUM_COLUMNS = [
  "request_count",
  "ok_count",
  "error_count",
  "aborted_count",
  "stream_count",
  "usage_missing_count",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_micro_usd",
  "latency_ms_sum",
  "ttfb_ms_sum",
  "request_bytes",
  "response_bytes",
  "source_row_count",
] as const

export type RollupSumColumn = (typeof ROLLUP_SUM_COLUMNS)[number]

export type RollupSums = Record<RollupSumColumn, number>

export const ROLLUP_OBSERVATION_COLUMNS = [
  "input_tokens_count", "output_tokens_count", "total_tokens_count",
  "cache_read_tokens_count", "cache_write_tokens_count", "reasoning_tokens_count",
  "cost_count", "latency_count", "ttfb_count", "request_bytes_count", "response_bytes_count",
] as const

export type AggregatedRollup = RollupDimensions & RollupSums & Partial<Record<(typeof ROLLUP_OBSERVATION_COLUMNS)[number], number | null>>

// Statements that must run inside one bucket's transaction.
export type RollupStore = {
  aggregateRawHour(bucketStart: Date, limit: number): Promise<{ ids: (typeof GatewayRequestLogTable.$inferSelect.id)[]; groups: AggregatedRollup[] }>
  aggregateHourRollupsToDay(dayStart: Date, limit: number): Promise<{ ids: RollupRow["id"][]; groups: AggregatedRollup[] }>
  upsertRollups(rows: RollupRow[]): Promise<void>
  deleteRawIds(ids: (typeof GatewayRequestLogTable.$inferSelect.id)[]): Promise<number>
  deleteHourRollupIds(ids: RollupRow["id"][]): Promise<number>
}

export type RollupRepository = {
  listCandidateHourBuckets(before: Date, limit: number): Promise<Date[]>
  listCandidateDayBuckets(before: Date, limit: number): Promise<Date[]>
  deleteExpiredOauthStates(now: Date): Promise<number>
  transaction<T>(run: (store: RollupStore) => Promise<T>): Promise<T>
}

export type RunRollupsInput = {
  repository?: RollupRepository
  now?: Date
  rawRetentionMs?: number
  hourlyRetentionMs?: number
  maxBucketsPerRun?: number
  maxSourceRowsPerBucket?: number
}

export type RollupRunSummary = {
  hourBuckets: number
  dayBuckets: number
  rawRowsDeleted: number
  hourRowsDeleted: number
  oauthStatesDeleted: number
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
const DEFAULT_RAW_RETENTION_MS = 2 * DAY_MS
const DEFAULT_HOURLY_RETENTION_MS = 90 * DAY_MS
const DEFAULT_MAX_BUCKETS_PER_RUN = 48

export function floorToHour(date: Date) {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
}

export function floorToDay(date: Date) {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS)
}

// New aggregations use the shared tuple hash; historical hashes stay untouched.
export const rollupDimensionKey = gatewayRollupDimensionKey

export function buildRollupRows(granularity: RollupRow["granularity"], bucketStart: Date, groups: AggregatedRollup[]): RollupRow[] {
  // Drizzle's numeric bigint mode must not silently round a large SQL sum.
  // Fail before consumption; operators can split the batch or widen handling.
  for (const group of groups) for (const column of [...ROLLUP_SUM_COLUMNS, ...ROLLUP_OBSERVATION_COLUMNS]) {
    const value = group[column]
    if (value != null && !Number.isSafeInteger(value)) throw new Error("Rollup sum exceeds safe integer range")
  }
  return groups.map((group) => ({
    ...group,
    id: createDenTypeId("inferenceUsageRollup"),
    granularity,
    bucket_start: bucketStart,
    dimension_key: rollupDimensionKey(group),
  }))
}

export function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

type DbExecutor = Pick<typeof import("./db.js").db, "select" | "insert" | "delete">

function sum(expression: ReturnType<typeof sql>) {
  return sql<number>`coalesce(sum(${expression}), 0)`.mapWith(Number)
}

const raw = GatewayRequestLogTable
const rollup = GatewayUsageRollupTable

// Rows with completed_at IS NULL (crashed mid-request) count as client_aborted.
const rawSums = {
  request_count: sql<number>`count(*)`.mapWith(Number),
  ok_count: sum(sql`case when ${raw.completed_at} is not null and ${raw.outcome} = 'ok' then 1 else 0 end`),
  error_count: sum(sql`case when ${raw.completed_at} is not null and ${raw.outcome} in ('upstream_error', 'upstream_unreachable', 'rejected') then 1 else 0 end`),
  aborted_count: sum(sql`case when ${raw.completed_at} is null or ${raw.outcome} = 'client_aborted' then 1 else 0 end`),
  stream_count: sum(sql`case when ${raw.stream} then 1 else 0 end`),
  usage_missing_count: sum(sql`case when ${raw.usage_source} = 'missing' then 1 else 0 end`),
  input_tokens: sum(sql`coalesce(${raw.input_tokens}, 0)`),
  output_tokens: sum(sql`coalesce(${raw.output_tokens}, 0)`),
  total_tokens: sum(sql`coalesce(${raw.total_tokens}, 0)`),
  cache_read_tokens: sum(sql`coalesce(${raw.cache_read_tokens}, 0)`),
  cache_write_tokens: sum(sql`coalesce(${raw.cache_write_tokens}, 0)`),
  reasoning_tokens: sum(sql`coalesce(${raw.reasoning_tokens}, 0)`),
  cost_micro_usd: sum(sql`coalesce(${raw.cost_micro_usd}, 0)`),
  latency_ms_sum: sql<number>`coalesce(round(sum(timestampdiff(microsecond, ${raw.started_at}, coalesce(${raw.completed_at}, ${raw.started_at}))) / 1000), 0)`.mapWith(Number),
  ttfb_ms_sum: sql<number>`coalesce(round(sum(timestampdiff(microsecond, ${raw.started_at}, coalesce(${raw.first_byte_at}, ${raw.started_at}))) / 1000), 0)`.mapWith(Number),
  request_bytes: sum(sql`coalesce(${raw.request_bytes}, 0)`),
  response_bytes: sum(sql`coalesce(${raw.response_bytes}, 0)`),
  source_row_count: sql<number>`count(*)`.mapWith(Number),
  input_tokens_count: sql<number>`count(${raw.input_tokens})`.mapWith(Number),
  output_tokens_count: sql<number>`count(${raw.output_tokens})`.mapWith(Number),
  total_tokens_count: sql<number>`count(${raw.total_tokens})`.mapWith(Number),
  cache_read_tokens_count: sql<number>`count(${raw.cache_read_tokens})`.mapWith(Number),
  cache_write_tokens_count: sql<number>`count(${raw.cache_write_tokens})`.mapWith(Number),
  reasoning_tokens_count: sql<number>`count(${raw.reasoning_tokens})`.mapWith(Number),
  cost_count: sql<number>`count(${raw.cost_micro_usd})`.mapWith(Number),
  latency_count: sql<number>`count(${raw.completed_at})`.mapWith(Number),
  ttfb_count: sql<number>`count(${raw.first_byte_at})`.mapWith(Number),
  request_bytes_count: sql<number>`count(${raw.request_bytes})`.mapWith(Number),
  response_bytes_count: sql<number>`count(${raw.response_bytes})`.mapWith(Number),
}

const hourSums = {
  request_count: sum(sql`${rollup.request_count}`),
  ok_count: sum(sql`${rollup.ok_count}`),
  error_count: sum(sql`${rollup.error_count}`),
  aborted_count: sum(sql`${rollup.aborted_count}`),
  stream_count: sum(sql`${rollup.stream_count}`),
  usage_missing_count: sum(sql`${rollup.usage_missing_count}`),
  input_tokens: sum(sql`${rollup.input_tokens}`),
  output_tokens: sum(sql`${rollup.output_tokens}`),
  total_tokens: sum(sql`${rollup.total_tokens}`),
  cache_read_tokens: sum(sql`${rollup.cache_read_tokens}`),
  cache_write_tokens: sum(sql`${rollup.cache_write_tokens}`),
  reasoning_tokens: sum(sql`${rollup.reasoning_tokens}`),
  cost_micro_usd: sum(sql`${rollup.cost_micro_usd}`),
  latency_ms_sum: sum(sql`${rollup.latency_ms_sum}`),
  ttfb_ms_sum: sum(sql`${rollup.ttfb_ms_sum}`),
  request_bytes: sum(sql`${rollup.request_bytes}`),
  response_bytes: sum(sql`${rollup.response_bytes}`),
  source_row_count: sum(sql`${rollup.source_row_count}`),
}

function createDbRollupStore(executor: DbExecutor): RollupStore {
  return {
    async aggregateRawHour(bucketStart, limit) {
      const end = new Date(bucketStart.getTime() + HOUR_MS)
      const claimed = await executor.select({ id: raw.id }).from(raw)
        .where(and(gte(raw.started_at, bucketStart), lt(raw.started_at, end)))
        .orderBy(raw.started_at, raw.id).limit(limit).for("update")
      const ids = claimed.map((row) => row.id)
      if (!ids.length) return { ids, groups: [] }
      const groups = await executor
        .select({
          organization_id: raw.organization_id,
          org_membership_id: raw.org_membership_id,
          gateway_provider_id: raw.gateway_provider_id,
          model_group_id: raw.model_group_id,
          credential_set_id: raw.credential_set_id,
          access_grant_id: raw.access_grant_id,
          route: raw.route,
          protocol: raw.protocol,
          upstream_provider_id: raw.upstream_provider_id,
          upstream_model: raw.upstream_model,
          ...rawSums,
        })
        .from(raw)
        .where(inArray(raw.id, ids))
        .groupBy(raw.organization_id, raw.org_membership_id, raw.gateway_provider_id, raw.model_group_id, raw.credential_set_id, raw.access_grant_id, raw.route, raw.protocol, raw.upstream_provider_id, raw.upstream_model)
      return { ids, groups }
    },
    async aggregateHourRollupsToDay(dayStart, limit) {
      const end = new Date(dayStart.getTime() + DAY_MS)
      const claimed = await executor.select({ id: rollup.id }).from(rollup)
        .where(and(eq(rollup.granularity, "hour"), gte(rollup.bucket_start, dayStart), lt(rollup.bucket_start, end)))
        .orderBy(rollup.bucket_start, rollup.dimension_key).limit(limit).for("update")
      const ids = claimed.map((row) => row.id)
      if (!ids.length) return { ids, groups: [] }
      const observations = Object.fromEntries(ROLLUP_OBSERVATION_COLUMNS.map((column) => [column,
        sql<number | null>`case when count(${rollup[column]}) = count(*) then sum(${rollup[column]}) else null end`.mapWith((value) => value === null ? null : Number(value)),
      ]))
      const groups = await executor
        .select({
          organization_id: rollup.organization_id,
          org_membership_id: rollup.org_membership_id,
          gateway_provider_id: rollup.gateway_provider_id,
          model_group_id: rollup.model_group_id,
          credential_set_id: rollup.credential_set_id,
          access_grant_id: rollup.access_grant_id,
          route: rollup.route,
          protocol: rollup.protocol,
          upstream_provider_id: rollup.upstream_provider_id,
          upstream_model: rollup.upstream_model,
          ...hourSums,
          ...observations,
        })
        .from(rollup)
        .where(inArray(rollup.id, ids))
        .groupBy(rollup.organization_id, rollup.org_membership_id, rollup.gateway_provider_id, rollup.model_group_id, rollup.credential_set_id, rollup.access_grant_id, rollup.route, rollup.protocol, rollup.upstream_provider_id, rollup.upstream_model)
      return { ids, groups }
    },
    async upsertRollups(rows) {
      if (rows.length === 0) return
      // NULL + n remains NULL for legacy observation counts. Never manufacture
      // a completeness claim for already-compacted historical data.
      const set = Object.fromEntries([...ROLLUP_SUM_COLUMNS, ...ROLLUP_OBSERVATION_COLUMNS].map((column) => [column, sql`${rollup[column]} + values(${sql.identifier(column)})`]))
      await executor.insert(rollup).values(rows).onDuplicateKeyUpdate({ set })
    },
    async deleteRawIds(ids) {
      if (!ids.length) return 0
      const result = await executor.delete(raw).where(inArray(raw.id, ids))
      return affectedRows(result)
    },
    async deleteHourRollupIds(ids) {
      if (!ids.length) return 0
      const result = await executor
        .delete(rollup)
        .where(and(eq(rollup.granularity, "hour"), inArray(rollup.id, ids)))
      return affectedRows(result)
    },
  }
}

// Bucket starts are derived server-side via UNIX_TIMESTAMP, which matches the
// JS epoch under the UTC session assumption drizzle's timestamp mapping makes.
async function listBuckets(executor: DbExecutor, column: typeof raw.started_at | typeof rollup.bucket_start, from: typeof raw | typeof rollup, extra: ReturnType<typeof sql> | undefined, before: Date, limit: number, sizeMs: number) {
  const seconds = sizeMs / 1000
  const bucket = sql<number>`floor(unix_timestamp(${column}) / ${seconds})`.mapWith(Number)
  const rows = await executor
    .select({ bucket })
    .from(from)
    .where(extra ? and(lt(column, before), extra) : lt(column, before))
    .groupBy(bucket)
    .orderBy(bucket)
    .limit(limit)
  return rows.map((row) => new Date(row.bucket * sizeMs))
}

export function createDbRollupRepository(db: typeof import("./db.js").db): RollupRepository {
  return {
    listCandidateHourBuckets(before, limit) {
      return listBuckets(db, raw.started_at, raw, undefined, before, limit, HOUR_MS)
    },
    listCandidateDayBuckets(before, limit) {
      return listBuckets(db, rollup.bucket_start, rollup, eq(rollup.granularity, "hour"), before, limit, DAY_MS)
    },
    async deleteExpiredOauthStates(now) {
      const result = await db.delete(GatewayProviderOauthStateTable).where(lt(GatewayProviderOauthStateTable.expires_at, now)).limit(1000)
      return affectedRows(result)
    },
    transaction(run) {
      return db.transaction(async (tx) => {
        // No snapshot reads precede this exclusive record lock. InnoDB RR's
        // first consistent read (aggregation) therefore sees the claimed rows.
        // Daily consumers cannot delete an hour while another worker adds to
        // it; all paths acquire this same permanent row before any source lock.
        await tx.insert(GatewayRollupLockTable).values({ id: 1 })
          .onDuplicateKeyUpdate({ set: { id: 1 } })
        return run(createDbRollupStore(tx))
      })
    },
  }
}

async function defaultRepository() {
  const { db } = await import("./db.js")
  return createDbRollupRepository(db)
}

export async function runRollups(input: RunRollupsInput = {}): Promise<RollupRunSummary> {
  const repository = input.repository ?? (await defaultRepository())
  const now = input.now ?? new Date()
  const rawRetentionMs = input.rawRetentionMs ?? DEFAULT_RAW_RETENTION_MS
  const hourlyRetentionMs = input.hourlyRetentionMs ?? DEFAULT_HOURLY_RETENTION_MS
  const maxBucketsPerRun = input.maxBucketsPerRun ?? DEFAULT_MAX_BUCKETS_PER_RUN
  const maxSourceRowsPerBucket = input.maxSourceRowsPerBucket ?? 1000
  if (!Number.isInteger(maxBucketsPerRun) || maxBucketsPerRun < 1 || maxBucketsPerRun > 1000
    || !Number.isInteger(maxSourceRowsPerBucket) || maxSourceRowsPerBucket < 1 || maxSourceRowsPerBucket > 5000
    || !Number.isFinite(now.getTime()) || !Number.isFinite(rawRetentionMs) || rawRetentionMs < 0
    || !Number.isFinite(hourlyRetentionMs) || hourlyRetentionMs < rawRetentionMs) throw new Error("Invalid rollup bounds")
  const summary: RollupRunSummary = { hourBuckets: 0, dayBuckets: 0, rawRowsDeleted: 0, hourRowsDeleted: 0, oauthStatesDeleted: 0 }

  // Only closed buckets: the whole hour/day must be older than the retention.
  const hourCutoff = floorToHour(new Date(now.getTime() - rawRetentionMs))
  for (const bucketStart of await repository.listCandidateHourBuckets(hourCutoff, maxBucketsPerRun)) {
    summary.rawRowsDeleted += await repository.transaction(async (store) => {
      const { ids, groups } = await store.aggregateRawHour(bucketStart, maxSourceRowsPerBucket)
      await store.upsertRollups(buildRollupRows("hour", bucketStart, groups))
      return store.deleteRawIds(ids)
    })
    summary.hourBuckets += 1
  }

  const dayCutoff = floorToDay(new Date(now.getTime() - hourlyRetentionMs))
  for (const dayStart of await repository.listCandidateDayBuckets(dayCutoff, maxBucketsPerRun)) {
    summary.hourRowsDeleted += await repository.transaction(async (store) => {
      const { ids, groups } = await store.aggregateHourRollupsToDay(dayStart, maxSourceRowsPerBucket)
      await store.upsertRollups(buildRollupRows("day", dayStart, groups))
      return store.deleteHourRollupIds(ids)
    })
    summary.dayBuckets += 1
  }

  summary.oauthStatesDeleted = await repository.deleteExpiredOauthStates(now)
  return summary
}

const runRollupsBodySchema = z.object({
  now: z.iso.datetime().optional(),
  maxBucketsPerRun: z.number().int().min(1).max(1000).optional(),
  maxSourceRowsPerBucket: z.number().int().min(1).max(5000).optional(),
})

export type RollupRouteDependencies = {
  adminToken: string | undefined
  runRollups: (input: RunRollupsInput) => Promise<RollupRunSummary>
}

// Same shape as keys.ts constantTimeEquals; kept local so this module (and its
// tests) do not pull in the database client.
function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function isAuthorized(request: Request, adminToken: string) {
  const auth = request.headers.get("authorization")
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  return bearer !== null && constantTimeEquals(bearer, adminToken)
}

export function registerRollupRoutes(app: Hono, dependencies: RollupRouteDependencies) {
  app.post("/internal/rollups/run", async (c) => {
    if (!dependencies.adminToken) {
      return c.json({ error: "not_found" }, 404)
    }
    if (!isAuthorized(c.req.raw, dependencies.adminToken)) {
      return c.json({ error: "unauthorized" }, 401)
    }
    const text = await c.req.text()
    let json: unknown = {}
    if (text.trim()) {
      try {
        json = JSON.parse(text)
      } catch {
        return c.json({ error: "invalid_json" }, 400)
      }
    }
    const parsed = runRollupsBodySchema.safeParse(json)
    if (!parsed.success) return c.json({ error: "invalid_rollup_bounds" }, 400)
    const body = parsed.data
    const summary = await dependencies.runRollups({
      now: body.now ? new Date(body.now) : undefined,
      maxBucketsPerRun: body.maxBucketsPerRun,
      maxSourceRowsPerBucket: body.maxSourceRowsPerBucket,
    })
    return c.json(summary)
  })
}
