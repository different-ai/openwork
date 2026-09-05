import { sql } from "drizzle-orm"
import { boolean, index, int, json, mysqlTable, uniqueIndex, varchar, timestamp } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Telemetry event vocabulary. Layer 1 answers "who is using AI" (activity
 * pings); Layer 2 answers "how often" (session and task lifecycle). Event
 * type strings are a wire contract with the desktop app and workers.
 */
export const TelemetryEventType = [
  // Layer 1 — who is using AI
  "user.active",
  "session.active",
  // Layer 2 — how often
  "session.started",
  "session.ended",
  "task.started",
  "task.completed",
  "task.failed",
] as const

/**
 * One telemetry event, org-scoped and attributed to a member. Rows carry only
 * identifiers, timings, and outcomes — never user content. `session_id` is an
 * opaque correlation id; `source` distinguishes desktop/web ("app") from
 * remote runtimes ("worker").
 */
export const TelemetryEventTable = mysqlTable(
  "telemetry_event",
  {
    id: denTypeIdColumn("telemetryEvent", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("organization", "org_id").notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    event_type: varchar("event_type", { length: 64 }).notNull(),
    event_timestamp: timestamp("event_timestamp", { fsp: 3 }).notNull(),
    source: varchar("source", { length: 32 }),
    session_id: varchar("session_id", { length: 128 }),
    duration_ms: int("duration_ms"),
    success: boolean("success"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("telemetry_event_org_id_type_ts").on(table.org_id, table.event_type, table.event_timestamp),
    index("telemetry_event_org_id_member_id").on(table.org_id, table.member_id),
    index("telemetry_event_member_ts").on(table.member_id, table.event_timestamp),
    index("telemetry_event_org_session_ts").on(table.org_id, table.session_id, table.event_timestamp),
  ],
)

/**
 * Analytics dimensions attached to a session (for example project or model),
 * upserted per (org, source, session, dimension type). Values are bounded
 * slugs; labels are display text; metadata is a small JSON blob. Sessions are
 * joined back to events per (org, session, source).
 */
export const TelemetrySessionDimensionTable = mysqlTable(
  "telemetry_session_dimension",
  {
    id: denTypeIdColumn("telemetrySessionDimension", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("organization", "org_id").notNull(),
    session_id: varchar("session_id", { length: 128 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    dimension_type: varchar("dimension_type", { length: 64 }).notNull(),
    dimension_value: varchar("dimension_value", { length: 128 }).notNull(),
    dimension_label: varchar("dimension_label", { length: 255 }).notNull(),
    metadata: json("metadata").$type<Record<string, unknown> | null>(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    last_seen_at: timestamp("last_seen_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telemetry_session_dimension_org_source_session_type").on(
      table.org_id,
      table.source,
      table.session_id,
      table.dimension_type,
    ),
    index("telemetry_session_dimension_filter").on(
      table.org_id,
      table.dimension_type,
      table.dimension_value,
      table.session_id,
    ),
  ],
)
