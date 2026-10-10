import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

export const capabilityUsageKindValues = ["skill", "connector_tool"] as const
export type CapabilityUsageKind = (typeof capabilityUsageKindValues)[number]

/** How the capability reached the agent. */
export const capabilityUsageViaValues = [
  "get_skill", "skill_resource", "execute_capability", "codemode",
  "gateway", "connection_proxy", "native",
] as const
export type CapabilityUsageVia = (typeof capabilityUsageViaValues)[number]

export const capabilityUsageOutcomeValues = ["ok", "error"] as const
export type CapabilityUsageOutcome = (typeof capabilityUsageOutcomeValues)[number]

/**
 * One use of an organization capability, for the admins' Library usage view:
 * a skill's SKILL.md served to an agent, or one connector tool call made
 * through OpenWork. Product usage, not an audit trail: it never counts toward
 * audit allowances and stores no arguments, content, or results.
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
  tool_name: varchar("tool_name", { length: 255 }),
  via: varchar("via", { length: 32 }).$type<CapabilityUsageVia>().notNull(),
  /** Collapses repeated loads of the same skill by the same member within a short window; unique per connector call. */
  dedupe_key: varchar("dedupe_key", { length: 191 }).notNull(),
  outcome: varchar("outcome", { length: 32 }).$type<CapabilityUsageOutcome>(),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("capability_usage_dedupe").on(table.organization_id, table.dedupe_key),
  index("capability_usage_object").on(table.organization_id, table.kind, table.config_object_id, table.created_at),
  index("capability_usage_recent").on(table.organization_id, table.created_at),
  index("capability_usage_connection").on(table.organization_id, table.kind, table.connection_id, table.created_at),
  index("capability_usage_plugin").on(table.organization_id, table.plugin_id, table.created_at),
])
