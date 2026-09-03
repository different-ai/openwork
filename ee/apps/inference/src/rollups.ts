// Rollup job (plan §4.8): raw request logs older than rawRetention fold into
// hour rollups, hour rollups older than hourlyRetention fold into day rollups.
// One bucket per transaction; work per run is bounded by maxBucketsPerRun.
import { createHash, timingSafeEqual } from "node:crypto"
import { InferenceProviderOauthStateTable, InferenceRequestLogTable, InferenceUsageRollupTable } from "@openwork-ee/den-db"
import { and, eq, gte, lt, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { z } from "zod"

export type RollupRow = typeof InferenceUsageRollupTable.$inferInsert

export type RollupDimensions = Pick<
  RollupRow,
  "organization_id" | "org_membership_id" | "inference_provider_id" | "route" | "protocol" | "upstream_provider_id" | "upstream_model"
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

export type AggregatedRollup = RollupDimensions & RollupSums

// Statements that must run inside one bucket's transaction.
export type RollupStore = {
  aggregateRawHour(bucketStart: Date): Promise<AggregatedRollup[]>
  aggregateHourRollupsToDay(dayStart: Date): Promise<AggregatedRollup[]>
  upsertRollups(rows: RollupRow[]): Promise<void>
  deleteRawInRange(start: Date, end: Date): Promise<number>
  deleteHourRollupsInRange(start: Date, end: Date): Promise<number>
}

export type RollupRepository = RollupStore & {
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

const DIMENSION_SEPARATOR = "\u001f"

export function floorToHour(date: Date) {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
}

export function floorToDay(date: Date) {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS)
}

// sha256 hex of the dimension values joined with U+001F, "" for nulls. MySQL
// unique indexes treat NULLs as distinct, so this is the upsert key.
export function rollupDimensionKey(dimensions: RollupDimensions) {
  const parts = [
    dimensions.organization_id,
    dimensions.org_membership_id,
    dimensions.inference_provider_id ?? "",
    dimensions.route,
    dimensions.protocol,
    dimensions.upstream_provider_id,
    dimensions.upstream_model ?? "",
  ]
  return createHash("sha256").update(parts.join(DIMENSION_SEPARATOR)).digest("hex")
}

export function buildRollupRows(granularity: RollupRow["granularity"], bucketStart: Date, groups: AggregatedRollup[]): RollupRow[] {
  return groups.map((group) => ({
    ...group,
    id: createDenTypeId("inferenceUsageRollup"),
    granularity,
    bucket_start: bucketStart,
    dimension_key: rollupDimensionKey(group),
  }))
}

function affectedRows(result: unknown): number {
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

const raw = InferenceRequestLogTable
const rollup = InferenceUsageRollupTable

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
    async aggregateRawHour(bucketStart) {
      const end = new Date(bucketStart.getTime() + HOUR_MS)
      return executor
        .select({
          organization_id: raw.organization_id,
          org_membership_id: raw.org_membership_id,
          inference_provider_id: raw.inference_provider_id,
          route: raw.route,
          protocol: raw.protocol,
          upstream_provider_id: raw.upstream_provider_id,
          upstream_model: raw.upstream_model,
          ...rawSums,
        })
        .from(raw)
        .where(and(gte(raw.started_at, bucketStart), lt(raw.started_at, end)))
        .groupBy(raw.organization_id, raw.org_membership_id, raw.inference_provider_id, raw.route, raw.protocol, raw.upstream_provider_id, raw.upstream_model)
    },
    async aggregateHourRollupsToDay(dayStart) {
      const end = new Date(dayStart.getTime() + DAY_MS)
      return executor
        .select({
          organization_id: rollup.organization_id,
          org_membership_id: rollup.org_membership_id,
          inference_provider_id: rollup.inference_provider_id,
          route: rollup.route,
          protocol: rollup.protocol,
          upstream_provider_id: rollup.upstream_provider_id,
          upstream_model: rollup.upstream_model,
          ...hourSums,
        })
        .from(rollup)
        .where(and(eq(rollup.granularity, "hour"), gte(rollup.bucket_start, dayStart), lt(rollup.bucket_start, end)))
        .groupBy(rollup.organization_id, rollup.org_membership_id, rollup.inference_provider_id, rollup.route, rollup.protocol, rollup.upstream_provider_id, rollup.upstream_model)
    },
    async upsertRollups(rows) {
      if (rows.length === 0) return
      const set = Object.fromEntries(ROLLUP_SUM_COLUMNS.map((column) => [column, sql`values(${rollup[column]})`]))
      await executor.insert(rollup).values(rows).onDuplicateKeyUpdate({ set })
    },
    async deleteRawInRange(start, end) {
      const result = await executor.delete(raw).where(and(gte(raw.started_at, start), lt(raw.started_at, end)))
      return affectedRows(result)
    },
    async deleteHourRollupsInRange(start, end) {
      const result = await executor
        .delete(rollup)
        .where(and(eq(rollup.granularity, "hour"), gte(rollup.bucket_start, start), lt(rollup.bucket_start, end)))
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
    ...createDbRollupStore(db),
    listCandidateHourBuckets(before, limit) {
      return listBuckets(db, raw.started_at, raw, undefined, before, limit, HOUR_MS)
    },
    listCandidateDayBuckets(before, limit) {
      return listBuckets(db, rollup.bucket_start, rollup, eq(rollup.granularity, "hour"), before, limit, DAY_MS)
    },
    async deleteExpiredOauthStates(now) {
      const result = await db.delete(InferenceProviderOauthStateTable).where(lt(InferenceProviderOauthStateTable.expires_at, now))
      return affectedRows(result)
    },
    transaction(run) {
      return db.transaction((tx) => run(createDbRollupStore(tx)))
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
  const summary: RollupRunSummary = { hourBuckets: 0, dayBuckets: 0, rawRowsDeleted: 0, hourRowsDeleted: 0, oauthStatesDeleted: 0 }

  // Only closed buckets: the whole hour/day must be older than the retention.
  const hourCutoff = floorToHour(new Date(now.getTime() - rawRetentionMs))
  for (const bucketStart of await repository.listCandidateHourBuckets(hourCutoff, maxBucketsPerRun)) {
    const end = new Date(bucketStart.getTime() + HOUR_MS)
    summary.rawRowsDeleted += await repository.transaction(async (store) => {
      const groups = await store.aggregateRawHour(bucketStart)
      await store.upsertRollups(buildRollupRows("hour", bucketStart, groups))
      return store.deleteRawInRange(bucketStart, end)
    })
    summary.hourBuckets += 1
  }

  const dayCutoff = floorToDay(new Date(now.getTime() - hourlyRetentionMs))
  for (const dayStart of await repository.listCandidateDayBuckets(dayCutoff, maxBucketsPerRun)) {
    const end = new Date(dayStart.getTime() + DAY_MS)
    summary.hourRowsDeleted += await repository.transaction(async (store) => {
      const groups = await store.aggregateHourRollupsToDay(dayStart)
      await store.upsertRollups(buildRollupRows("day", dayStart, groups))
      return store.deleteHourRollupsInRange(dayStart, end)
    })
    summary.dayBuckets += 1
  }

  summary.oauthStatesDeleted = await repository.deleteExpiredOauthStates(now)
  return summary
}

const runRollupsBodySchema = z.object({
  now: z.iso.datetime().optional(),
  maxBucketsPerRun: z.number().int().min(1).max(1000).optional(),
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
    const body = runRollupsBodySchema.parse(json)
    const summary = await dependencies.runRollups({
      now: body.now ? new Date(body.now) : undefined,
      maxBucketsPerRun: body.maxBucketsPerRun,
    })
    return c.json(summary)
  })
}
