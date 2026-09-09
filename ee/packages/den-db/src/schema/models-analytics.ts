import { boolean, double, index, int, json, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../columns"

export const ModelsAnalyticsSettingsTable = mysqlTable("models_analytics_settings", {
  org_id: denTypeIdColumn("organization", "org_id").notNull().primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  consented_at: timestamp("consented_at", { fsp: 3 }),
  consented_by: denTypeIdColumn("member", "consented_by"),
  consent_version: int("consent_version"),
  export_enabled: boolean("export_enabled").notNull().default(false),
  export_enabled_at: timestamp("export_enabled_at", { fsp: 3 }),
  langfuse_host: varchar("langfuse_host", { length: 512 }),
  langfuse_public_key: encryptedTextColumn("langfuse_public_key"),
  langfuse_secret_key: encryptedTextColumn("langfuse_secret_key"),
})

// Immutable events, deduplicated within an authenticated organization/member.
// Multiple values of the same dimension in one task never replace each other.
export const ModelsAnalyticsEventTable = mysqlTable("models_analytics_event", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  event_id: varchar("event_id", { length: 128 }).notNull(),
  org_id: denTypeIdColumn("organization", "org_id").notNull(),
  member_id: denTypeIdColumn("member", "member_id").notNull(),
  source: varchar("source", { length: 16 }).notNull(),
  type: varchar("type", { length: 32 }).notNull(),
  timestamp: timestamp("timestamp", { fsp: 3 }).notNull(),
  session_id: varchar("session_id", { length: 128 }).notNull(),
  task_id: varchar("task_id", { length: 128 }).notNull(),
  model: varchar("model", { length: 255 }),
  provider: varchar("provider", { length: 255 }),
  input_tokens: double("input_tokens"),
  output_tokens: double("output_tokens"),
  cache_read_tokens: double("cache_read_tokens"),
  cost_usd: double("cost_usd"),
  usage_complete: boolean("usage_complete"),
  payload: json("payload").$type<Record<string, unknown>>().notNull(),
  exported_at: timestamp("exported_at", { fsp: 3 }),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("models_analytics_dedup").on(table.org_id, table.member_id, table.source, table.event_id),
  index("models_analytics_activity").on(table.org_id, table.timestamp, table.id),
  index("models_analytics_task").on(table.org_id, table.member_id, table.session_id, table.task_id),
  index("models_analytics_consumption").on(table.org_id, table.type, table.timestamp),
  index("models_analytics_export").on(table.org_id, table.exported_at, table.created_at),
])
