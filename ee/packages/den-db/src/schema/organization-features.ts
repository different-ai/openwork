import { sql } from "drizzle-orm"
import { bigint, boolean, date, index, int, mysqlEnum, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core"
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

/**
 * Append-only history of every feature change made in /admin or by the admin
 * MCP tools: who turned what on or off, for everyone, one organization or one
 * member, and when. Override rows are deleted when cleared, so this is the only
 * record of a reset. Never updated or deleted by den-api.
 */
export const FeatureChangeTable = mysqlTable("feature_change", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  feature_key: varchar("feature_key", { length: 64 }).notNull(),
  /** "everyone" (deployment-wide), "organization" or "member". */
  scope: mysqlEnum("scope", ["everyone", "organization", "member"]).notNull(),
  /** Set for organization and member changes. */
  organization_id: denTypeIdColumn("organization", "organization_id"),
  /** Set for member changes. */
  member_id: denTypeIdColumn("member", "member_id"),
  /** on/off: set; reset: override cleared; killed/restored: kill switch. */
  action: mysqlEnum("action", ["on", "off", "reset", "killed", "restored"]).notNull(),
  changed_by_user_id: denTypeIdColumn("user", "changed_by_user_id"),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  index("feature_change_org_feature_time").on(table.organization_id, table.feature_key, table.created_at),
  index("feature_change_scope_feature_time").on(table.scope, table.feature_key, table.created_at),
])

/** Overrides belong to an organization membership, never to a user globally. */
export const MemberFeatureTable = mysqlTable("member_feature", {
  member_id: denTypeIdColumn("member", "member_id").notNull(),
  feature_key: varchar("feature_key", { length: 64 }).notNull(),
  enabled: boolean("enabled").notNull(),
  set_by_user_id: denTypeIdColumn("user", "set_by_user_id"),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}, (table) => [primaryKey({ name: "member_feature_pk", columns: [table.member_id, table.feature_key] })])

/**
 * Who used which feature, for /admin: one row per member and feature, never
 * per use. A use is a request through a feature-gated route (requireFeature)
 * or a client report from the place the feature is exercised. den-api writes
 * at most once per member, feature and UTC day per replica, so `days_used`
 * counts distinct days. Stores ids and dates only, never content.
 */
export const FeatureUsageTable = mysqlTable("feature_usage", {
  member_id: denTypeIdColumn("member", "member_id").notNull(),
  feature_key: varchar("feature_key", { length: 64 }).notNull(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  first_used_at: timestamp("first_used_at", { fsp: 3 }).notNull().defaultNow(),
  /**
   * Declared before last_used_day on purpose: drizzle writes ON DUPLICATE KEY
   * UPDATE assignments in column order and MySQL applies them left to right,
   * so days_used must be assigned while last_used_day still holds the old day.
   */
  days_used: int("days_used").notNull().default(1),
  last_used_at: timestamp("last_used_at", { fsp: 3 }).notNull().defaultNow(),
  /** UTC day of last_used_at; a write on a later day adds one to days_used. */
  last_used_day: date("last_used_day", { mode: "string" }).notNull(),
}, (table) => [
  primaryKey({ name: "feature_usage_pk", columns: [table.member_id, table.feature_key] }),
  index("feature_usage_org_feature").on(table.organization_id, table.feature_key, table.last_used_at),
])
