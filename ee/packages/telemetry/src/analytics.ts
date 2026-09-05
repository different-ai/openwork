import { eq, gte, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { TelemetryEventTable, TelemetrySessionDimensionTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { deriveDimensionValue } from "./dimension.js"
import type { TelemetryDimensionInput } from "@openwork-ee/telemetry-contracts"

export const ANALYTICS_TREND_WEEKS = 12

export type TelemetryOrgId = (typeof TelemetryEventTable.$inferSelect)["org_id"]

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

/** SQL expression bucketing an event timestamp into a 0-based week index from `start`. */
export function weekIndexExpression(start: Date): SQL<number> {
  return sql<number>`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${start}) / 7)`
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
