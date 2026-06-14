import { boolean, index, int, mysqlTable, varchar, timestamp } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

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

export const TelemetryEventTable = mysqlTable(
  "telemetry_event",
  {
    id: denTypeIdColumn("telemetryEvent", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("organization", "org_id").notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    event_type: varchar("event_type", { length: 64 }).notNull(),
    event_timestamp: timestamp("event_timestamp", { fsp: 3 }).notNull(),
    // Where the event came from: "app" (desktop/web) or "worker" (remote runtime).
    source: varchar("source", { length: 32 }),
    // Opaque session correlation id. Never contains user content.
    session_id: varchar("session_id", { length: 128 }),
    duration_ms: int("duration_ms"),
    success: boolean("success"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("telemetry_event_org_id_type_ts").on(table.org_id, table.event_type, table.event_timestamp),
    index("telemetry_event_org_id_member_id").on(table.org_id, table.member_id),
  ],
)
