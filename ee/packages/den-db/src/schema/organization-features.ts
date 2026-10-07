import { sql } from "drizzle-orm"
import { boolean, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Per-organization feature overrides. A row exists only when someone set an
 * override; no row means the registry default (packages/features/src/registry.ts).
 * Better Auth never writes this table, so organization creation cannot turn
 * features on.
 */
export const OrganizationFeatureTable = mysqlTable("organization_feature", {
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  feature_key: varchar("feature_key", { length: 64 }).notNull(),
  enabled: boolean("enabled").notNull(),
  /** "platform" for /admin and the admin MCP tool, "migration" for the backfill. */
  source: varchar("source", { length: 16 }).notNull(),
  set_by_user_id: denTypeIdColumn("user", "set_by_user_id"),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}, (table) => [primaryKey({ name: "organization_feature_pk", columns: [table.organization_id, table.feature_key] })])

/**
 * Deployment-wide state per feature, changed in /admin. No row means the
 * registry default and no kill switch.
 */
export const FeatureRolloutTable = mysqlTable("feature_rollout", {
  feature_key: varchar("feature_key", { length: 64 }).notNull().primaryKey(),
  /** On or off for everyone on this deployment (organization overrides still apply). */
  enabled: boolean("enabled").notNull(),
  /** Off everywhere, outranking locks, overrides and the percentage. */
  killed: boolean("killed").notNull().default(false),
  updated_by_user_id: denTypeIdColumn("user", "updated_by_user_id"),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
})
