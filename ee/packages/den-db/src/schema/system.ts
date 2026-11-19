import { bigint, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

export const RateLimitTable = mysqlTable(
  "rate_limit",
  {
    id: denTypeIdColumn("rateLimit", "id").notNull().primaryKey(),
    key: varchar("key", { length: 512 }).notNull(),
    count: int("count").notNull().default(0),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("rate_limit_key").on(table.key)],
)

export const AdminAllowlistTable = mysqlTable(
  "admin_allowlist",
  {
    id: denTypeIdColumn("adminAllowlist", "id").notNull().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    note: varchar("note", { length: 255 }),
    ...timestamps,
  },
  (table) => [uniqueIndex("admin_allowlist_email").on(table.email)],
)

/**
 * This Den installation's stable identity (one row, `singleton = "den"`),
 * created on first use. Config blob exports carry it as `source.instanceId`
 * so imports can tell "same instance" from "another instance".
 */
export const DenInstanceTable = mysqlTable("den_instance", {
  singleton: varchar("singleton", { length: 16 }).notNull().primaryKey(),
  instanceId: denTypeIdColumn("denInstance", "instance_id").notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
})

export const rateLimit = RateLimitTable
