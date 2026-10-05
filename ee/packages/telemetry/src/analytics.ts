import type { createDenDb } from "@openwork-ee/den-db"
import { and, desc, eq, gte, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import {
  TELEMETRY_EVENT_ORG_WINDOW_INDEX,
  TelemetryEventTable,
  TelemetrySessionDimensionTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { deriveDimensionValue } from "./dimension.js"
import type { TelemetryDimensionInput } from "@openwork-ee/telemetry-contracts"

export const ANALYTICS_TREND_WEEKS = 12

const WEEK_SECONDS = 7 * 24 * 60 * 60

type Db = ReturnType<typeof createDenDb>["db"]

export type TelemetryOrgId = (typeof TelemetryEventTable.$inferSelect)["org_id"]

/**
 * Index hint for an org window scan of `telemetry_event`.
 *
 * Unfiltered, the scan must use the org window index: MySQL otherwise prefers
 * `(org_id, event_type, event_timestamp)`, which can only narrow by org, so the
 * scan walks the org's entire event history and looks up every matching row.
 *
 * With a session dimension filter, the cheaper plan starts from the filter's
 * sessions and probes `(org_id, session_id, event_timestamp)` per session. The
 * window index is hidden there, because MySQL picks it over that plan and then
 * runs the dimension check against every event in the window.
 */
function orgWindowScan(filter: DimensionFilter | null) {
  return filter
    ? { ignoreIndex: TELEMETRY_EVENT_ORG_WINDOW_INDEX }
    : { forceIndex: TELEMETRY_EVENT_ORG_WINDOW_INDEX }
}

export type DimensionFilter = {
  type: string
  value: string
}

export type WindowMetrics = {
  activeMembers: number
  sessions: number
  tasksCompleted: number
  tasksFailed: number
  avgTaskDurationMs: number | null
}

/**
 * SQL predicate restricting telemetry events to sessions that carry the given
 * dimension. Sessions are correlated per (org, session, source), where a
 * missing event source is treated as the "unknown" source bucket.
 */
export function sessionDimensionPredicate(filter: DimensionFilter): SQL {
  return sql`exists (
    select 1
    from ${TelemetrySessionDimensionTable}
    where ${TelemetrySessionDimensionTable.org_id} = ${TelemetryEventTable.org_id}
      and ${TelemetrySessionDimensionTable.session_id} = ${TelemetryEventTable.session_id}
      and ${TelemetrySessionDimensionTable.source} = coalesce(${TelemetryEventTable.source}, 'unknown')
      and ${TelemetrySessionDimensionTable.dimension_type} = ${filter.type}
      and ${TelemetrySessionDimensionTable.dimension_value} = ${filter.value}
  )`
}

/** Conditions for one org-scoped time window, with an optional dimension filter. */
export function telemetryWindowConditions(orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null): SQL[] {
  const conditions: SQL[] = [
    eq(TelemetryEventTable.org_id, orgId),
    gte(TelemetryEventTable.event_timestamp, since),
  ]
  if (filter) {
    conditions.push(sessionDimensionPredicate(filter))
  }
  return conditions
}

/** Select shape computing the per-window activity metrics in one aggregate pass. */
export function windowMetricsSelection() {
  return {
    activeMembers: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
    sessions: sql<number>`count(distinct ${TelemetryEventTable.session_id})`,
    tasksCompleted: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.completed'), 0)`,
    tasksFailed: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.failed'), 0)`,
    avgTaskDurationMs: sql<number | null>`avg(case when ${TelemetryEventTable.event_type} = 'task.completed' then ${TelemetryEventTable.duration_ms} end)`,
  }
}

/** Normalize a raw window-metrics row into plain numbers. */
export function readWindowMetrics(row: {
  activeMembers: unknown
  sessions: unknown
  tasksCompleted: unknown
  tasksFailed: unknown
  avgTaskDurationMs: unknown
} | undefined): WindowMetrics {
  const avg = row?.avgTaskDurationMs
  return {
    activeMembers: Number(row?.activeMembers ?? 0),
    sessions: Number(row?.sessions ?? 0),
    tasksCompleted: Number(row?.tasksCompleted ?? 0),
    tasksFailed: Number(row?.tasksFailed ?? 0),
    avgTaskDurationMs: avg == null ? null : Math.round(Number(avg)),
  }
}

/**
 * SQL expression bucketing an event timestamp into a 0-based week index from
 * `start`, where the trend covers the `ANALYTICS_TREND_WEEKS` full 7-day spans
 * that end now. Buckets are measured in elapsed seconds, matching the
 * `weekStart` labels: a calendar-day difference puts today's events in an
 * extra 13th bucket that the response drops. Events stamped after `now` by a
 * skewed client clock count in the latest week.
 */
export function weekIndexExpression(
  start: Date,
  eventTimestamp: SQL | SQL.Aliased | typeof TelemetryEventTable.event_timestamp = TelemetryEventTable.event_timestamp,
): SQL<number> {
  // Bind `start` exactly as the window's `event_timestamp >= ?` condition does.
  const startParam = sql.param(start, TelemetryEventTable.event_timestamp)
  const elapsedSeconds = sql`TIMESTAMPDIFF(SECOND, ${startParam}, ${eventTimestamp})`
  return sql<number>`LEAST(FLOOR(${elapsedSeconds} / ${sql.raw(String(WEEK_SECONDS))}), ${sql.raw(String(ANALYTICS_TREND_WEEKS - 1))})`
}

/** Org activity metrics since `since`, optionally narrowed to one session dimension. */
export async function queryWindowMetrics(db: Db, orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null): Promise<WindowMetrics> {
  const rows = await selectWindowMetrics(db, orgId, since, filter)
  return readWindowMetrics(rows[0])
}

export function selectWindowMetrics(db: Db, orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null) {
  return db
    .select(windowMetricsSelection())
    .from(TelemetryEventTable, orgWindowScan(filter))
    .where(and(...telemetryWindowConditions(orgId, since, filter)))
}

/**
 * Per-week active members, sessions and task outcomes since `start` (see
 * `weekIndexExpression`).
 *
 * The window's events are selected in a derived table that MySQL cannot merge
 * (it has a LIMIT), and grouped outside it. Grouped in place, MySQL charges a
 * plan that starts from the dimension filter's sessions for sorting the joined
 * rows, so it starts from the events instead and runs the filter's lookup
 * against every event in the window — about 9x slower for one project.
 */
export function selectWeeklyActivity(db: Db, orgId: TelemetryOrgId, start: Date, filter: DimensionFilter | null) {
  const windowEvents = db
    .select({
      eventTimestamp: sql<Date>`${TelemetryEventTable.event_timestamp}`.as("window_event_timestamp"),
      memberId: sql<string>`${TelemetryEventTable.member_id}`.as("window_member_id"),
      sessionId: sql<string | null>`${TelemetryEventTable.session_id}`.as("window_session_id"),
      eventType: sql<string>`${TelemetryEventTable.event_type}`.as("window_event_type"),
    })
    .from(TelemetryEventTable, orgWindowScan(filter))
    .where(and(...telemetryWindowConditions(orgId, start, filter)))
    .limit(Number.MAX_SAFE_INTEGER)
    .as("window_events")

  const week = weekIndexExpression(start, windowEvents.eventTimestamp)
  return db
    .select({
      week,
      activeMembers: sql<number>`count(distinct ${windowEvents.memberId})`,
      sessions: sql<number>`count(distinct ${windowEvents.sessionId})`,
      tasksCompleted: sql<number>`coalesce(sum(${windowEvents.eventType} = 'task.completed'), 0)`,
      tasksFailed: sql<number>`coalesce(sum(${windowEvents.eventType} = 'task.failed'), 0)`,
    })
    .from(windowEvents)
    .groupBy(week)
    .orderBy(week)
}

/** Per-week active members since `start` (see `weekIndexExpression`). */
export function selectWeeklyActiveMembers(db: Db, orgId: TelemetryOrgId, start: Date) {
  const week = weekIndexExpression(start)
  return db
    .select({
      week,
      count: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
    })
    .from(TelemetryEventTable, orgWindowScan(null))
    .where(and(...telemetryWindowConditions(orgId, start, null)))
    .groupBy(week)
    .orderBy(week)
}

/**
 * Sessions per model and model-selection dimension value, counting sessions
 * with any event since `since`. The window's distinct sessions are found first
 * and then matched to their dimensions, so each session is joined once rather
 * than once per event.
 */
export function selectModelDimensionUsage(db: Db, orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null) {
  // Aliases are unique across the join: drizzle renders a subquery's aliased
  // fields without the subquery name.
  const windowSessions = db
    .selectDistinct({
      sessionId: sql<string | null>`${TelemetryEventTable.session_id}`.as("window_session_id"),
      source: sql<string>`coalesce(${TelemetryEventTable.source}, 'unknown')`.as("window_source"),
    })
    .from(TelemetryEventTable, orgWindowScan(filter))
    .where(and(...telemetryWindowConditions(orgId, since, filter)))
    .as("window_sessions")

  return db
    .select({
      type: TelemetrySessionDimensionTable.dimension_type,
      value: TelemetrySessionDimensionTable.dimension_value,
      label: sql<string>`max(${TelemetrySessionDimensionTable.dimension_label})`,
      sessions: sql<number>`count(distinct ${TelemetrySessionDimensionTable.session_id})`,
    })
    .from(windowSessions)
    .innerJoin(TelemetrySessionDimensionTable, and(
      eq(TelemetrySessionDimensionTable.org_id, orgId),
      eq(TelemetrySessionDimensionTable.source, windowSessions.source),
      eq(TelemetrySessionDimensionTable.session_id, windowSessions.sessionId),
      sql`${TelemetrySessionDimensionTable.dimension_type} in ('model', 'model_selection')`,
    ))
    .groupBy(
      TelemetrySessionDimensionTable.dimension_type,
      TelemetrySessionDimensionTable.dimension_value,
    )
    .orderBy(desc(sql`count(distinct ${TelemetrySessionDimensionTable.session_id})`))
}

export type SessionDimensionUpsert = {
  values: typeof TelemetrySessionDimensionTable.$inferInsert
  update: Partial<typeof TelemetrySessionDimensionTable.$inferInsert>
}

/**
 * Build the insert/update halves of the per-session dimension upsert. A row is
 * unique per (org, source, session, dimension type); repeat sightings refresh
 * the label, metadata, and last-seen timestamp, and only overwrite the stored
 * value when the client supplied one explicitly (derived values stay stable).
 */
export function buildSessionDimensionUpsert(params: {
  orgId: TelemetryOrgId
  sessionId: string
  source: string
  dimension: TelemetryDimensionInput
  seenAt: Date
}): SessionDimensionUpsert {
  const explicitValue = params.dimension.value
  const value = explicitValue ?? deriveDimensionValue(params.dimension.type, params.dimension.label)
  const metadata = params.dimension.metadata ?? null

  return {
    values: {
      id: createDenTypeId("telemetrySessionDimension"),
      org_id: params.orgId,
      session_id: params.sessionId,
      source: params.source,
      dimension_type: params.dimension.type,
      dimension_value: value,
      dimension_label: params.dimension.label,
      metadata,
      created_at: params.seenAt,
      updated_at: params.seenAt,
      last_seen_at: params.seenAt,
    },
    update: {
      ...(explicitValue ? { dimension_value: explicitValue } : {}),
      dimension_label: params.dimension.label,
      metadata,
      updated_at: params.seenAt,
      last_seen_at: params.seenAt,
    },
  }
}

/** Key identifying one pending dimension upsert within an ingest batch. */
export function sessionDimensionKey(source: string, sessionId: string, dimensionType: string): string {
  return [source, sessionId, dimensionType].join("\u0000")
}
