import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { and, eq, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { AdminMetricRefreshLeaseTable, AdminMetricSnapshotTable } from "@openwork-ee/den-db/schema"
import {
  CONTROL_CENTER_SECTION_KEYS,
  CONTROL_CENTER_SECTIONS,
  type AdminControlCenter,
  type ControlCenterRange,
  type ControlCenterSectionKey,
} from "@openwork/types/den/admin-control-center"
import type { z } from "zod"
import { db } from "../db.js"
import {
  RANGES,
  computeAccounts,
  computeInvitations,
  computeLifecycle,
  computePulse,
  computeRevenue,
  computeSharing,
  type MetricContext,
  type MetricResult,
  type RangeKey,
} from "./metrics.js"

/**
 * Control Center snapshots: a background job recomputes each metric on its
 * tier's interval and the read endpoint only ever reads these rows.
 */

export type MetricTier = "fast" | "heavy"
export type MetricDefinition = { tier: MetricTier; ranges: readonly RangeKey[]; compute: (context: MetricContext) => Promise<MetricResult<ControlCenterSectionKey>> }

export const METRICS: Record<ControlCenterSectionKey, MetricDefinition> = {
  pulse: { tier: "fast", ranges: RANGES, compute: computePulse },
  lifecycle: { tier: "heavy", ranges: RANGES, compute: computeLifecycle },
  invitations: { tier: "heavy", ranges: RANGES, compute: computeInvitations },
  sharing: { tier: "heavy", ranges: RANGES, compute: computeSharing },
  revenue: { tier: "heavy", ranges: ["all"], compute: computeRevenue },
  accounts: { tier: "heavy", ranges: ["all"], compute: computeAccounts },
}

export type Intervals = Record<MetricTier, number>

export type SnapshotRow = { metricKey: string; rangeKey: string; payload: unknown; computedAt: Date | null; durationMs: number | null; error: string | null }

export interface SnapshotStore {
  /** Take the metric's lease. `force` also takes a lease that is only cooling down after a refresh, never a running one. */
  claim(metricKey: string, owner: string, until: Date, now: Date, force: boolean): Promise<boolean>
  /** Give the lease back; nobody refreshes the metric again before `nextDue` unless forced. */
  release(metricKey: string, owner: string, nextDue: Date): Promise<void>
  saveSuccess(metricKey: string, payloads: Partial<Record<RangeKey, unknown>>, durationMs: number, now: Date): Promise<void>
  /** Record the error on the metric's rows without touching their last good payload. */
  saveFailure(metricKey: string, ranges: readonly RangeKey[], error: string, durationMs: number, now: Date): Promise<void>
  read(rangeKeys: readonly RangeKey[]): Promise<SnapshotRow[]>
  /** Record a manual refresh unless one was requested less than `minIntervalMs` ago. */
  requestRefresh(now: Date, minIntervalMs: number): Promise<{ accepted: true } | { accepted: false; retryAfterMs: number }>
  lastRequestedAt(): Promise<Date | null>
}

const MANUAL_REFRESH_KEY = "manual_refresh"
/** A refresh that holds its lease longer than this is presumed dead and can be taken over. */
export const REFRESH_LEASE_MS = 15 * 60_000

export const defaultOwner = () => `${hostname().slice(0, 40)}:${process.pid}:${randomBytes(4).toString("hex")}`

function errorMessage(error: unknown): string {
  // Drizzle wraps driver errors as "Failed query: <sql>"; the cause says what went wrong.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
  const message = cause instanceof Error ? cause.message : String(cause)
  return (message.split("\n")[0] ?? "Refresh failed").slice(0, 500)
}

export type RefreshOutcome = "refreshed" | "skipped" | "failed"

export async function refreshMetric(key: ControlCenterSectionKey, deps: {
  store: SnapshotStore; context: MetricContext; owner: string; intervals: Intervals; force?: boolean; metrics?: Record<ControlCenterSectionKey, MetricDefinition>
}): Promise<RefreshOutcome> {
  const definition = (deps.metrics ?? METRICS)[key]
  const { store, context, owner } = deps
  const started = Date.now()
  if (!await store.claim(key, owner, new Date(context.now.getTime() + REFRESH_LEASE_MS), context.now, deps.force ?? false)) return "skipped"
  let outcome: RefreshOutcome = "failed"
  try {
    const result = await definition.compute(context)
    const schema = CONTROL_CENTER_SECTIONS[key]
    const payloads: Partial<Record<RangeKey, unknown>> = {}
    for (const range of definition.ranges) {
      const parsed = schema.safeParse(result[range])
      if (!parsed.success) throw new Error(`The ${key} metric produced an invalid ${range} snapshot: ${parsed.error.issues[0]?.message ?? "unknown issue"}`)
      payloads[range] = parsed.data
    }
    // The data is as of the context's clock, which every query used for its windows.
    await store.saveSuccess(key, payloads, Date.now() - started, context.now)
    outcome = "refreshed"
  } catch (error) {
    await store.saveFailure(key, definition.ranges, errorMessage(error), Date.now() - started, context.now)
  } finally {
    // Retry a failure on the next tick; otherwise wait out most of the interval.
    const wait = outcome === "refreshed" ? Math.floor(deps.intervals[definition.tier] * 0.9) : 0
    await store.release(key, owner, new Date(Date.now() + wait))
  }
  return outcome
}

/** Refresh metrics one at a time so a refresh never competes with itself for the database. */
export async function refreshMetrics(keys: readonly ControlCenterSectionKey[], deps: Parameters<typeof refreshMetric>[1]) {
  const outcomes: Partial<Record<ControlCenterSectionKey, RefreshOutcome>> = {}
  for (const key of keys) outcomes[key] = await refreshMetric(key, deps)
  return outcomes
}

export const metricsForTier = (tier: MetricTier) => CONTROL_CENTER_SECTION_KEYS.filter((key) => METRICS[key].tier === tier)

export async function readControlCenter(range: ControlCenterRange, deps: { store: SnapshotStore; now: Date; intervals: Intervals }): Promise<AdminControlCenter> {
  const [rows, lastRequestedAt] = await Promise.all([deps.store.read([range, "all"]), deps.store.lastRequestedAt()])
  const section = <T>(key: ControlCenterSectionKey, schema: z.ZodType<T>) => {
    const definition = METRICS[key]
    const rangeKey = definition.ranges.includes(range) ? range : "all"
    const row = rows.find((candidate) => candidate.metricKey === key && candidate.rangeKey === rangeKey)
    // A snapshot written by an older build may no longer match the schema; show it as missing until the next refresh.
    const parsed = row?.payload == null ? null : schema.safeParse(row.payload)
    const computedAt = parsed?.success ? row?.computedAt ?? null : null
    return {
      computedAt: computedAt?.toISOString() ?? null,
      stale: computedAt === null || deps.now.getTime() - computedAt.getTime() > 2 * deps.intervals[definition.tier],
      error: row?.error ?? null,
      durationMs: row?.durationMs ?? null,
      data: parsed?.success ? parsed.data : null,
    }
  }
  return {
    range,
    generatedAt: deps.now.toISOString(),
    sections: {
      pulse: section("pulse", CONTROL_CENTER_SECTIONS.pulse),
      lifecycle: section("lifecycle", CONTROL_CENTER_SECTIONS.lifecycle),
      invitations: section("invitations", CONTROL_CENTER_SECTIONS.invitations),
      sharing: section("sharing", CONTROL_CENTER_SECTIONS.sharing),
      revenue: section("revenue", CONTROL_CENTER_SECTIONS.revenue),
      accounts: section("accounts", CONTROL_CENTER_SECTIONS.accounts),
    },
    refresh: { fastIntervalMs: deps.intervals.fast, heavyIntervalMs: deps.intervals.heavy, lastRequestedAt: lastRequestedAt?.toISOString() ?? null },
  }
}

const toDate = (value: unknown) => {
  if (value instanceof Date) return value
  if (typeof value === "string") return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`)
  return null
}

/** The MySQL store. Claims are a single upsert, so two instances never both win a lease. */
export const dbSnapshotStore: SnapshotStore = {
  async claim(metricKey, owner, until, now, force) {
    const free = force
      ? sql`(${AdminMetricRefreshLeaseTable.lease_until} IS NULL OR ${AdminMetricRefreshLeaseTable.lease_until} < ${now} OR ${AdminMetricRefreshLeaseTable.owner} IS NULL)`
      : sql`(${AdminMetricRefreshLeaseTable.lease_until} IS NULL OR ${AdminMetricRefreshLeaseTable.lease_until} < ${now})`
    // MySQL applies these assignments in order, so lease_until sees the owner just written.
    await db.insert(AdminMetricRefreshLeaseTable).values({ metric_key: metricKey, owner, lease_until: until }).onDuplicateKeyUpdate({
      set: {
        owner: sql`IF(${free}, ${owner}, ${AdminMetricRefreshLeaseTable.owner})`,
        lease_until: sql`IF(${AdminMetricRefreshLeaseTable.owner} <=> ${owner}, ${until}, ${AdminMetricRefreshLeaseTable.lease_until})`,
      },
    })
    const [row] = await db.select({ owner: AdminMetricRefreshLeaseTable.owner }).from(AdminMetricRefreshLeaseTable)
      .where(eq(AdminMetricRefreshLeaseTable.metric_key, metricKey)).limit(1)
    return row?.owner === owner
  },
  async release(metricKey, owner, nextDue) {
    await db.update(AdminMetricRefreshLeaseTable).set({ owner: null, lease_until: nextDue })
      .where(and(eq(AdminMetricRefreshLeaseTable.metric_key, metricKey), eq(AdminMetricRefreshLeaseTable.owner, owner)))
  },
  async saveSuccess(metricKey, payloads, durationMs, now) {
    for (const [rangeKey, payload] of Object.entries(payloads)) {
      const values = { payload, computed_at: now, duration_ms: durationMs, error: null, attempted_at: now }
      await db.insert(AdminMetricSnapshotTable).values({ metric_key: metricKey, range_key: rangeKey, ...values }).onDuplicateKeyUpdate({ set: values })
    }
  },
  async saveFailure(metricKey, ranges, error, durationMs, now) {
    for (const rangeKey of ranges) {
      const values = { error, duration_ms: durationMs, attempted_at: now }
      await db.insert(AdminMetricSnapshotTable).values({ metric_key: metricKey, range_key: rangeKey, ...values }).onDuplicateKeyUpdate({ set: values })
    }
  },
  async read(rangeKeys) {
    const rows = await db.select().from(AdminMetricSnapshotTable).where(inArray(AdminMetricSnapshotTable.range_key, [...rangeKeys]))
    return rows.map((row) => ({
      metricKey: row.metric_key, rangeKey: row.range_key, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      computedAt: toDate(row.computed_at), durationMs: row.duration_ms, error: row.error,
    }))
  },
  async requestRefresh(now, minIntervalMs) {
    const cutoff = new Date(now.getTime() - minIntervalMs)
    const requested = AdminMetricRefreshLeaseTable.requested_at
    await db.insert(AdminMetricRefreshLeaseTable).values({ metric_key: MANUAL_REFRESH_KEY, requested_at: now }).onDuplicateKeyUpdate({
      set: { requested_at: sql`IF(${requested} IS NULL OR ${requested} <= ${cutoff}, ${now}, ${requested})` },
    })
    const last = await dbSnapshotStore.lastRequestedAt()
    if (!last || last.getTime() === now.getTime()) return { accepted: true }
    return { accepted: false, retryAfterMs: Math.max(1_000, last.getTime() + minIntervalMs - now.getTime()) }
  },
  async lastRequestedAt() {
    const [row] = await db.select({ requestedAt: AdminMetricRefreshLeaseTable.requested_at }).from(AdminMetricRefreshLeaseTable)
      .where(eq(AdminMetricRefreshLeaseTable.metric_key, MANUAL_REFRESH_KEY)).limit(1)
    return row?.requestedAt ? toDate(row.requestedAt) : null
  },
}
