import { bigint, int, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
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
 * Self-hosted instance entitlement snapshot (discovery §7.2, the one table
 * exception). Keyed by hex SHA-256 of `licenseKey + "\n" + normalizedBaseUrl`,
 * never the key itself; kept at one row by `writeLicenseSnapshot`.
 */
export const LicenseSnapshotTable = mysqlTable("license_snapshot", {
  fingerprint: varchar("fingerprint", { length: 64 }).notNull().primaryKey(),
  snapshot: json("snapshot").$type<unknown>().notNull(),
})

export const rateLimit = RateLimitTable
