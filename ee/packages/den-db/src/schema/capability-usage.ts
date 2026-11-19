import { index, int, json, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

export const capabilityUsageKindValues = ["skill", "connector_tool"] as const
export type CapabilityUsageKind = (typeof capabilityUsageKindValues)[number]

/**
 * What started the use: the member's agent, a saved Workflow run, a scheduled
 * Automation, an App, or a live artifact render. Every source counts as usage.
 */
export const capabilityUsageSourceValues = ["agent", "workflow", "automation", "app", "artifact"] as const
export type CapabilityUsageSource = (typeof capabilityUsageSourceValues)[number]

/** Uses per source in a rollup bucket; a missing key is zero. */
export type CapabilityUsageSourceCounts = Partial<Record<CapabilityUsageSource, number>>

export const capabilityUsageOutcomeValues = ["ok", "error"] as const
export type CapabilityUsageOutcome = (typeof capabilityUsageOutcomeValues)[number]

/**
 * One use of an organization capability, for the admins' Library usage view:
 * a skill's SKILL.md served to an agent, or one connector tool call made
 * through OpenWork. Product usage, not an audit trail: it never counts toward
 * audit allowances and stores ids only, never arguments, content, results or
 * tool names.
 *
 * Raw rows are kept for about two days. The gateway's rollup job
 * (ee/apps/gateway/src/rollups.ts) folds each closed UTC day older than that
 * into capability_usage_rollups and deletes the rows it consumed.
 *
 * `outcome` is ok/error for connector calls. For skills it stays null until
 * OpenWork can tell whether the task that used it succeeded.
 */
export const CapabilityUsageEventTable = mysqlTable("capability_usage_event", {
  id: denTypeIdColumn("capabilityUsageEvent", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
  kind: varchar("kind", { length: 32 }).$type<CapabilityUsageKind>().notNull(),
  plugin_id: denTypeIdColumn("plugin", "plugin_id"),
  config_object_id: denTypeIdColumn("configObject", "config_object_id"),
  /** An external_mcp_connection id, or a provider key for legacy Google Workspace / Microsoft 365 connections. */
  connection_id: varchar("connection_id", { length: 64 }),
  source: varchar("source", { length: 32 }).$type<CapabilityUsageSource>().notNull().default("agent"),
  outcome: varchar("outcome", { length: 32 }).$type<CapabilityUsageOutcome>(),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  index("capability_usage_created").on(table.created_at),
  index("capability_usage_object").on(table.organization_id, table.kind, table.config_object_id, table.created_at),
  index("capability_usage_recent").on(table.organization_id, table.created_at),
  index("capability_usage_member").on(table.organization_id, table.org_membership_id, table.created_at),
  index("capability_usage_connection").on(table.organization_id, table.kind, table.connection_id, table.created_at),
  index("capability_usage_plugin").on(table.organization_id, table.plugin_id, table.created_at),
])

// A permanent singleton record: INSERT ... ON DUPLICATE KEY UPDATE holds an
// InnoDB exclusive lock through commit, so two rollup runs never fold the same day.
export const CapabilityUsageRollupLockTable = mysqlTable("capability_usage_rollup_lock", {
  id: int("id").notNull().primaryKey(),
})

/**
 * Daily (UTC) aggregates of capability_usage_event, one row per dimension
 * combination per day. Dimensions are ids only; names are looked up when read.
 */
export const CapabilityUsageRollupTable = mysqlTable("capability_usage_rollups", {
  id: denTypeIdColumn("capabilityUsageRollup", "id").notNull().primaryKey(),
  bucket_start: timestamp("bucket_start", { fsp: 3 }).notNull(),
  /** capabilityUsageRollupDimensionKey of the dimensions below. */
  dimension_key: varchar("dimension_key", { length: 64 }).notNull(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
  kind: varchar("kind", { length: 32 }).$type<CapabilityUsageKind>().notNull(),
  plugin_id: denTypeIdColumn("plugin", "plugin_id"),
  config_object_id: denTypeIdColumn("configObject", "config_object_id"),
  connection_id: varchar("connection_id", { length: 64 }),
  use_count: int("use_count").notNull().default(0),
  ok_count: int("ok_count").notNull().default(0),
  error_count: int("error_count").notNull().default(0),
  source_row_count: int("source_row_count").notNull().default(0),
  source_counts: json("source_counts").$type<CapabilityUsageSourceCounts>().notNull(),
  last_used_at: timestamp("last_used_at", { fsp: 3 }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("capability_usage_rollups_bucket_dimension").on(table.bucket_start, table.dimension_key),
  index("capability_usage_rollups_org_bucket").on(table.organization_id, table.bucket_start),
  index("capability_usage_rollups_member").on(table.organization_id, table.org_membership_id, table.bucket_start),
  index("capability_usage_rollups_object").on(table.organization_id, table.kind, table.config_object_id, table.bucket_start),
  index("capability_usage_rollups_connection").on(table.organization_id, table.kind, table.connection_id, table.bucket_start),
  index("capability_usage_rollups_plugin").on(table.organization_id, table.plugin_id, table.bucket_start),
])
