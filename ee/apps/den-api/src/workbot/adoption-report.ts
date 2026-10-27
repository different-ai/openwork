import { sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { z } from "zod"

const DAY_MS = 86_400_000
const BREAKDOWN_LIMIT = 1000
const MEMBER_MODEL_LIMIT = 10

const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}, "Expected a real UTC calendar date (YYYY-MM-DD)")

export const workbotAdoptionInputSchema = z.object({
  startDate: utcDate.describe("First sign-in cohort day, inclusive (UTC, YYYY-MM-DD)"),
  endDate: utcDate.describe("Last cohort/observation day, inclusive (UTC); at most 90 days including startDate"),
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/).optional().describe("Optional exact organization id; never a name or email"),
  limit: z.number().int().min(1).max(500).default(100).describe("Member breakdown page size; totals are always for the full cohort"),
  offset: z.number().int().min(0).max(100_000).default(0).describe("Member page offset, ordered by organization id then member id"),
}).refine(({ startDate, endDate }) => {
  const days = (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / DAY_MS + 1
  return days >= 1 && days <= 90
}, "Date range must be ordered and contain at most 90 UTC days")

type Row = Record<string, unknown>
export type WorkbotAdoptionQuery = (query: SQL) => Promise<Row[]>

function count(value: unknown): number {
  const result = Number(value ?? 0)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid adoption count")
  return result
}

function nullableCount(value: unknown): number | null {
  return value === null || value === undefined ? null : count(value)
}

function modelSource(value: unknown): "response" | "configured" | "unknown" {
  return value === "response" || value === "configured" ? value : "unknown"
}

function id(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Missing adoption identifier")
  return value
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function isoSeconds(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) throw new Error("Invalid adoption timestamp")
  return new Date(Math.round(seconds * 1000)).toISOString()
}

/** No identity/profile or conversation tables are read. All timestamps are compared as instants. */
export function buildWorkbotAdoptionQueries(input: z.input<typeof workbotAdoptionInputSchema>) {
  const options = workbotAdoptionInputSchema.parse(input)
  const startSeconds = Date.parse(`${options.startDate}T00:00:00.000Z`) / 1000
  const endSeconds = Date.parse(`${options.endDate}T00:00:00.000Z`) / 1000 + DAY_MS / 1000
  const organization = options.organizationId ? sql`AND s.org_id = ${options.organizationId}` : sql``
  // An older sign-in excludes returning members from a new-user cohort. Matching
  // org + member (not user id) also keeps memberships in different orgs separate.
  const cohort = sql`cohort_members AS (
    SELECT s.org_id, s.member_id, MIN(UNIX_TIMESTAMP(s.event_timestamp)) AS signed_in_seconds
      FROM telemetry_event s
     WHERE s.source = 'workbot' AND s.event_type = 'workbot.signed_in'
       AND s.event_timestamp >= FROM_UNIXTIME(${startSeconds})
       AND s.event_timestamp < FROM_UNIXTIME(${endSeconds})
       ${organization}
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_event prior
          WHERE prior.org_id = s.org_id AND prior.member_id = s.member_id
            AND prior.source = 'workbot' AND prior.event_type = 'workbot.signed_in'
            AND prior.event_timestamp < FROM_UNIXTIME(${startSeconds})
       )
     GROUP BY s.org_id, s.member_id
  )`
  const readyProbe = sql`t.event_type IN ('workbot.signed_in', 'workbot.greeting_started', 'workbot.greeting_completed', 'workbot.greeting_failed')
    AND JSON_TYPE(JSON_EXTRACT(d.metadata, '$.ready_count')) = 'INTEGER'
    AND JSON_EXTRACT(d.metadata, '$.ready_count') >= 0`
  const facts = sql`${cohort}, cohort_greetings AS (
    SELECT c.org_id, c.member_id, c.signed_in_seconds,
           MIN(UNIX_TIMESTAMP(t.event_timestamp)) AS greeting_completed_seconds
      FROM cohort_members c
      LEFT JOIN telemetry_event t
        ON t.org_id = c.org_id AND t.member_id = c.member_id AND t.source = 'workbot'
       AND t.event_type = 'workbot.greeting_completed'
       AND t.event_timestamp >= FROM_UNIXTIME(c.signed_in_seconds)
       AND t.event_timestamp < FROM_UNIXTIME(${endSeconds})
     GROUP BY c.org_id, c.member_id, c.signed_in_seconds
  ), member_facts AS (
    SELECT c.org_id, c.member_id, c.signed_in_seconds, c.greeting_completed_seconds,
           MIN(CASE WHEN t.event_type = 'workbot.greeting_started' THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS greeting_started_seconds,
           MIN(CASE WHEN t.event_type = 'workbot.message_sent' THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS first_message_seconds,
           MIN(CASE WHEN t.event_type = 'workbot.message_sent'
                     AND t.event_timestamp >= FROM_UNIXTIME(c.greeting_completed_seconds)
                    THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS first_message_after_greeting_seconds,
           MIN(CASE WHEN t.event_type = 'connection.connected'
                      OR ((${readyProbe}) AND JSON_EXTRACT(d.metadata, '$.ready_count') > 0)
                    THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS connected_seconds,
           MAX(CASE WHEN ${readyProbe} THEN 1 ELSE 0 END) AS ready_probe_observed,
           MAX(CASE WHEN t.event_type = 'workbot.signed_in'
                     AND t.event_timestamp = FROM_UNIXTIME(c.signed_in_seconds) AND (${readyProbe})
                    THEN JSON_EXTRACT(d.metadata, '$.ready_count') + 0 END) AS ready_count_at_sign_in,
           MAX(CASE WHEN t.event_type = 'workbot.greeting_started' AND (${readyProbe})
                    THEN JSON_EXTRACT(d.metadata, '$.ready_count') + 0 END) AS ready_count_at_greeting,
           SUM(CASE WHEN t.event_type = 'connection.connected' THEN 1 ELSE 0 END) AS connection_count,
           SUM(CASE WHEN t.event_type = 'workbot.greeting_failed' THEN 1 ELSE 0 END) AS greeting_failure_count
      FROM cohort_greetings c
      LEFT JOIN telemetry_event t
        ON t.org_id = c.org_id AND t.member_id = c.member_id AND t.source = 'workbot'
       AND t.event_type IN ('workbot.signed_in', 'workbot.greeting_started', 'workbot.greeting_completed',
                            'workbot.greeting_failed', 'workbot.message_sent', 'connection.connected')
       AND t.event_timestamp >= FROM_UNIXTIME(c.signed_in_seconds)
       AND t.event_timestamp < FROM_UNIXTIME(${endSeconds})
      LEFT JOIN telemetry_session_dimension d
        ON d.org_id = t.org_id AND d.source = t.source AND d.session_id = t.session_id
       AND d.dimension_type = 'workbot'
     GROUP BY c.org_id, c.member_id, c.signed_in_seconds, c.greeting_completed_seconds
  )`
  const counts = sql`COUNT(*) AS signed_in,
    COALESCE(SUM(greeting_completed_seconds IS NOT NULL), 0) AS greeting_completed,
    COALESCE(SUM(first_message_after_greeting_seconds IS NOT NULL), 0) AS first_message_sent,
    COALESCE(SUM(first_message_after_greeting_seconds IS NOT NULL AND connected_seconds IS NOT NULL), 0) AS connected,
    COALESCE(SUM(greeting_started_seconds IS NOT NULL), 0) AS greeting_started,
    COALESCE(SUM(first_message_seconds IS NOT NULL), 0) AS message_observed,
    COALESCE(SUM(connected_seconds IS NOT NULL), 0) AS connection_observed,
    COALESCE(SUM(greeting_failure_count), 0) AS greeting_failed_attempts,
    COALESCE(SUM(greeting_completed_seconds IS NULL AND greeting_failure_count > 0), 0) AS greeting_failed_members,
    COALESCE(SUM(greeting_started_seconds IS NULL AND greeting_completed_seconds IS NULL AND greeting_failure_count = 0), 0) AS greeting_never_started,
    COALESCE(SUM(greeting_started_seconds IS NOT NULL AND greeting_completed_seconds IS NULL AND greeting_failure_count = 0), 0) AS greeting_without_outcome,
    COALESCE(SUM(connected_seconds IS NULL AND ready_probe_observed = 0), 0) AS connection_unknown,
    COALESCE(SUM(connected_seconds IS NULL AND ready_probe_observed = 1), 0) AS connection_zero_observed`
  // DATE_ADD from an epoch produces a UTC wall-clock value even if the DB
  // connection's session timezone is not UTC. FROM_UNIXTIME is only for comparisons.
  const day = sql`DATE_FORMAT(DATE_ADD('1970-01-01', INTERVAL signed_in_seconds SECOND), '%Y-%m-%d')`
  const aggregates = sql`WITH ${facts}, organization_buckets AS (
    SELECT org_id AS bucket, ${counts} FROM member_facts GROUP BY org_id
     ORDER BY org_id LIMIT ${sql.raw(String(BREAKDOWN_LIMIT + 1))}
  )
  SELECT 'total' AS bucket_type, '' AS bucket, ${counts} FROM member_facts
  UNION ALL
  SELECT 'day' AS bucket_type, ${day} AS bucket, ${counts} FROM member_facts GROUP BY ${day}
  UNION ALL
  SELECT 'organization' AS bucket_type, organization_buckets.* FROM organization_buckets
  ORDER BY bucket_type, bucket`
  const members = sql`WITH ${facts}
    SELECT * FROM member_facts ORDER BY org_id, member_id
    LIMIT ${sql.raw(String(options.limit + 1))} OFFSET ${sql.raw(String(options.offset))}`
  const failures = sql`WITH ${cohort}
    SELECT CASE WHEN JSON_TYPE(JSON_EXTRACT(d.metadata, '$.error_code')) = 'STRING'
                THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(d.metadata, '$.error_code')), '') END AS error_code,
           COALESCE(CASE WHEN JSON_TYPE(JSON_EXTRACT(d.metadata, '$.model')) = 'STRING'
                         THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(d.metadata, '$.model')), '') END,
                    md.dimension_value) AS model,
           COUNT(*) AS attempts, COUNT(DISTINCT c.org_id, c.member_id) AS members
      FROM cohort_members c
      JOIN telemetry_event t
        ON t.org_id = c.org_id AND t.member_id = c.member_id AND t.source = 'workbot'
       AND t.event_type = 'workbot.greeting_failed'
       AND t.event_timestamp >= FROM_UNIXTIME(c.signed_in_seconds)
       AND t.event_timestamp < FROM_UNIXTIME(${endSeconds})
      LEFT JOIN telemetry_session_dimension d
        ON d.org_id = t.org_id AND d.source = t.source AND d.session_id = t.session_id
       AND d.dimension_type = 'workbot'
      LEFT JOIN telemetry_session_dimension md
        ON md.org_id = t.org_id AND md.source = t.source AND md.session_id = t.session_id
       AND md.dimension_type = 'model'
     GROUP BY error_code, model ORDER BY attempts DESC, error_code, model
     LIMIT ${sql.raw(String(BREAKDOWN_LIMIT + 1))}`
  const models = sql`WITH ${cohort}, member_page AS (
    SELECT * FROM cohort_members ORDER BY org_id, member_id
     LIMIT ${sql.raw(String(options.limit))} OFFSET ${sql.raw(String(options.offset))}
  ), model_counts AS (
    SELECT c.org_id, c.member_id,
           COALESCE(CASE WHEN JSON_TYPE(JSON_EXTRACT(d.metadata, '$.model')) = 'STRING'
                         THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(d.metadata, '$.model')), '') END,
                    md.dimension_value) AS model,
           CASE JSON_UNQUOTE(JSON_EXTRACT(d.metadata, '$.model_source'))
             WHEN 'response' THEN 'response' WHEN 'configured' THEN 'configured'
             ELSE 'unknown' END AS model_source,
           SUM(t.event_type = 'workbot.greeting_completed') AS greeting_completions,
           SUM(t.event_type = 'workbot.turn_completed') AS user_turn_completions
      FROM member_page c
      JOIN telemetry_event t
        ON t.org_id = c.org_id AND t.member_id = c.member_id AND t.source = 'workbot'
       AND t.event_type IN ('workbot.greeting_completed', 'workbot.turn_completed')
       AND t.event_timestamp >= FROM_UNIXTIME(c.signed_in_seconds)
       AND t.event_timestamp < FROM_UNIXTIME(${endSeconds})
      LEFT JOIN telemetry_session_dimension d
        ON d.org_id = t.org_id AND d.source = t.source AND d.session_id = t.session_id
       AND d.dimension_type = 'workbot'
      LEFT JOIN telemetry_session_dimension md
        ON md.org_id = t.org_id AND md.source = t.source AND md.session_id = t.session_id
       AND md.dimension_type = 'model'
     GROUP BY c.org_id, c.member_id, model, model_source
  ), ranked_models AS (
    SELECT model_counts.*, ROW_NUMBER() OVER (
      PARTITION BY org_id, member_id
      ORDER BY user_turn_completions + greeting_completions DESC, model_source, model
    ) AS model_rank FROM model_counts
  )
  SELECT * FROM ranked_models WHERE model_rank <= ${sql.raw(String(MEMBER_MODEL_LIMIT + 1))}
   ORDER BY org_id, member_id, model_rank LIMIT ${sql.raw(String(options.limit * (MEMBER_MODEL_LIMIT + 1)))}`
  return { options, aggregates, members, failures, models }
}

function summarize(row: Row | undefined) {
  return {
    funnel: {
      signedIn: count(row?.signed_in),
      greetingCompleted: count(row?.greeting_completed),
      firstMessageSent: count(row?.first_message_sent),
      atLeastOneConnected: count(row?.connected),
    },
    observed: {
      greetingStarted: count(row?.greeting_started),
      messageSent: count(row?.message_observed),
      connectionEvidence: count(row?.connection_observed),
      greetingFailedAttempts: count(row?.greeting_failed_attempts),
      greetingFailedMembers: count(row?.greeting_failed_members),
      greetingNeverStarted: count(row?.greeting_never_started),
      greetingWithoutOutcome: count(row?.greeting_without_outcome),
      connectionUnknown: count(row?.connection_unknown),
      connectionZeroObserved: count(row?.connection_zero_observed),
    },
  }
}

function describeMember(row: Row, modelRows: Row[]) {
  const signedInAt = isoSeconds(row.signed_in_seconds)
  if (signedInAt === null) throw new Error("Missing adoption sign-in timestamp")
  const greetingStartedAt = isoSeconds(row.greeting_started_seconds)
  const greetingCompletedAt = isoSeconds(row.greeting_completed_seconds)
  const connectedAt = isoSeconds(row.connected_seconds)
  const greetingFailedAttempts = count(row.greeting_failure_count)
  return {
    organizationId: id(row.org_id),
    memberId: id(row.member_id),
    cohortDay: signedInAt.slice(0, 10),
    signedInAt,
    greetingStartedAt,
    greetingCompletedAt,
    firstMessageSentAt: isoSeconds(row.first_message_seconds),
    firstMessageAfterGreetingAt: isoSeconds(row.first_message_after_greeting_seconds),
    connectedAt,
    readyCountAtSignIn: nullableCount(row.ready_count_at_sign_in),
    readyCountAtGreeting: nullableCount(row.ready_count_at_greeting),
    connectionCount: count(row.connection_count),
    answeringModels: {
      rows: modelRows.slice(0, MEMBER_MODEL_LIMIT).map((model) => ({
        model: nullableText(model.model),
        source: modelSource(model.model_source),
        greetingCompletions: count(model.greeting_completions),
        userTurnCompletions: count(model.user_turn_completions),
      })),
      limit: MEMBER_MODEL_LIMIT,
      truncated: modelRows.length > MEMBER_MODEL_LIMIT,
    },
    greetingFailedAttempts,
    greetingState: greetingCompletedAt !== null ? "completed"
      : greetingFailedAttempts > 0 ? "failed"
      : greetingStartedAt !== null ? "started_without_outcome" : "never_started",
    connectionState: connectedAt !== null ? "connected_observed"
      : count(row.ready_probe_observed) > 0 ? "zero_observed" : "unknown",
  }
}

/** The injected admin rows helper enforces the shared read-query timeout. */
export async function readWorkbotAdoptionReport(
  input: z.input<typeof workbotAdoptionInputSchema>,
  query: WorkbotAdoptionQuery,
) {
  const { options, aggregates, members, failures, models } = buildWorkbotAdoptionQueries(input)
  const [aggregateRows, memberRows, failureRows, modelRows] = await Promise.all([
    query(aggregates), query(members), query(failures), query(models),
  ])
  const modelsByMember = new Map<string, Row[]>()
  for (const row of modelRows) {
    const key = JSON.stringify([id(row.org_id), id(row.member_id)])
    const grouped = modelsByMember.get(key) ?? []
    grouped.push(row)
    modelsByMember.set(key, grouped)
  }
  const describedMembers = memberRows.slice(0, options.limit).map((row) =>
    describeMember(row, modelsByMember.get(JSON.stringify([row.org_id, row.member_id])) ?? []))
  const modelsTruncated = describedMembers.some((row) => row.answeringModels.truncated)
  const organizationRows = aggregateRows.filter((row) => row.bucket_type === "organization")
  const membersHaveMore = memberRows.length > options.limit
  const organizationsTruncated = organizationRows.length > BREAKDOWN_LIMIT
  const failuresTruncated = failureRows.length > BREAKDOWN_LIMIT
  return {
    range: {
      startDate: options.startDate,
      endDate: options.endDate,
      timezone: "UTC",
      organizationId: options.organizationId ?? null,
    },
    scope: "full_cohort",
    ...summarize(aggregateRows.find((row) => row.bucket_type === "total")),
    daily: aggregateRows.filter((row) => row.bucket_type === "day").map((row) => ({
      cohortDay: id(row.bucket), ...summarize(row),
    })),
    organizations: {
      rows: organizationRows.slice(0, BREAKDOWN_LIMIT).map((row) => ({
        organizationId: id(row.bucket), ...summarize(row),
      })),
      limit: BREAKDOWN_LIMIT,
      truncated: organizationsTruncated,
    },
    members: {
      rows: describedMembers,
      limit: options.limit,
      offset: options.offset,
      hasMore: membersHaveMore,
      nextOffset: membersHaveMore && options.offset + options.limit <= 100_000 ? options.offset + options.limit : null,
      truncated: options.offset > 0 || membersHaveMore,
    },
    greetingFailures: {
      rows: failureRows.slice(0, BREAKDOWN_LIMIT).map((row) => ({
        errorCode: nullableText(row.error_code),
        model: nullableText(row.model),
        attempts: count(row.attempts),
        members: count(row.members),
      })),
      limit: BREAKDOWN_LIMIT,
      truncated: failuresTruncated,
    },
    truncated: organizationsTruncated || failuresTruncated || modelsTruncated || options.offset > 0 || membersHaveMore,
    notes: [
      "Cohorts use each org/member's earliest recorded Workbot sign-in day (UTC); returning members are not new cohorts. Zero-sign-in days are omitted.",
      "Observation ends at the exclusive UTC midnight after endDate. Milestones before sign-in, outside this window, in another org, or from another source do not count.",
      "The funnel is cumulative: greeting completed after sign-in, a message at/after completion, then connection evidence at/after sign-in. A ready connection at sign-in can satisfy the last stage.",
      "A connection is evidenced by ready_count > 0 on sign-in/greeting events or a later connection.connected event, not current connection status. Null/missing ready_count means unknown, never zero.",
      "Member ready counts are the first sign-in and greeting_started snapshots, not current inventory. connectionCount counts successful connection.connected events at/after sign-in, not ready services or distinct providers.",
      "answeringModels groups successful greeting/user-turn completions by model and source: response is provider-reported; configured is a requested-model fallback, not proof of the answering id; missing source is unknown. Accepted messages/starts are not answer evidence. Each member caps at 10 model/source groups with explicit truncation.",
      "Failed means at least one recorded failure without completion; never_started means no start, completion, or failure. started_without_outcome is not proof that a greeting is still running.",
      "Totals/daily are full-cohort, unaffected by member pagination or truncated breakdowns. Organization/error-model breakdowns cap at 1000 rows; filter organizationId or narrow dates when truncated.",
      "Telemetry begins at instrumentation deployment; earliest recorded sign-in is not proof of first-ever product use. Missing events are not proof of inactivity.",
    ],
  }
}
