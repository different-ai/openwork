import { bigint, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
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

/**
 * One row per running process with read replica credentials. The process
 * writes its own beat on the primary and reads it back through the replica,
 * so a replica that lags, or that is a different database, is noticed.
 */
export const DbReplicaHeartbeatTable = mysqlTable(
  "db_replica_heartbeat",
  {
    id: varchar("id", { length: 64 }).notNull().primaryKey(),
    beatAt: timestamp("beat_at", { fsp: 3 }).notNull(),
  },
  (table) => [index("db_replica_heartbeat_beat_at").on(table.beatAt)],
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

export const rateLimit = RateLimitTable
