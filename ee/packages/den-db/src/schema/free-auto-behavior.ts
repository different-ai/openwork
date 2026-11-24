import { index, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/** Observed personal-limit refusals. Anonymous journeys are client-reported random IDs, never IP matches. */
export const FreeAutoLimitEventTable = mysqlTable("free_auto_limit_events", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  audience: mysqlEnum("audience", ["guest", "member"]).notNull(),
  subject_hash: varchar("subject_hash", { length: 64 }).notNull(),
  user_id: denTypeIdColumn("user", "user_id"),
  organization_id: denTypeIdColumn("organization", "organization_id"),
  window_start_at: timestamp("window_start_at", { fsp: 3 }).notNull(),
  exhausted_at: timestamp("exhausted_at", { fsp: 3 }).notNull(),
  authenticated_at: timestamp("authenticated_at", { fsp: 3 }),
}, (table) => [
  index("free_auto_limit_time").on(table.exhausted_at, table.id),
  index("free_auto_limit_subject").on(table.audience, table.subject_hash, table.exhausted_at),
  index("free_auto_limit_user").on(table.user_id, table.exhausted_at),
  index("free_auto_limit_org").on(table.organization_id),
])

/** Only positive payment evidence; subscription creation, trials and failed checkouts do not qualify. */
export const FreeAutoPurchaseTable = mysqlTable("free_auto_purchases", {
  subscription_id: varchar("subscription_id", { length: 255 }).notNull().primaryKey(),
  user_id: denTypeIdColumn("user", "user_id").notNull(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  type: mysqlEnum("type", ["inference", "seat", "web"]).notNull(),
  started_at: timestamp("started_at", { fsp: 3 }).notNull(),
  paid_at: timestamp("paid_at", { fsp: 3 }).notNull(),
}, (table) => [
  index("free_auto_purchase_user_start").on(table.user_id, table.started_at),
  index("free_auto_purchase_org").on(table.organization_id),
])
