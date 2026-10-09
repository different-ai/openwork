import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

export const capabilityUsageKindValues = ["skill"] as const
export type CapabilityUsageKind = (typeof capabilityUsageKindValues)[number]

/** How the capability reached the agent. */
export const capabilityUsageViaValues = ["get_skill", "skill_resource", "execute_capability", "codemode"] as const
export type CapabilityUsageVia = (typeof capabilityUsageViaValues)[number]

/**
 * One use of an organization capability (today: a skill's SKILL.md served to an
 * agent through the MCP gateway). Product usage for organization admins, not
 * an audit trail: it never counts toward audit allowances and stores no
 * arguments, content, or results.
 *
 * `kind` leaves room for connector tools, Workflows and Apps. `outcome` is
 * reserved for later (did the task that used it succeed) and stays null.
 */
export const CapabilityUsageEventTable = mysqlTable("capability_usage_event", {
  id: denTypeIdColumn("capabilityUsageEvent", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
  kind: varchar("kind", { length: 32 }).$type<CapabilityUsageKind>().notNull(),
  plugin_id: denTypeIdColumn("plugin", "plugin_id"),
  config_object_id: denTypeIdColumn("configObject", "config_object_id"),
  via: varchar("via", { length: 32 }).$type<CapabilityUsageVia>().notNull(),
  /** Collapses repeated loads of the same thing by the same member within a short window. */
  dedupe_key: varchar("dedupe_key", { length: 191 }).notNull(),
  outcome: varchar("outcome", { length: 32 }),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("capability_usage_dedupe").on(table.organization_id, table.dedupe_key),
  index("capability_usage_object").on(table.organization_id, table.kind, table.config_object_id, table.created_at),
  index("capability_usage_recent").on(table.organization_id, table.created_at),
])
