import { int, json, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core"

/**
 * Precomputed platform metrics for the admin Control Center. A background job
 * in den-api recomputes each metric and upserts one row per range, so the
 * page reads cached aggregates and never runs the heavy queries itself.
 * Payloads hold aggregate counts and organization names only, never emails.
 *
 * A failed recompute keeps the last good `payload` and `computed_at` and
 * records `error`, so one broken metric never blanks the others.
 */
export const AdminMetricSnapshotTable = mysqlTable("admin_metric_snapshot", {
  metric_key: varchar("metric_key", { length: 64 }).notNull(),
  range_key: varchar("range_key", { length: 16 }).notNull(),
  payload: json("payload").$type<unknown>(),
  /** When `payload` was last computed successfully; null until the first success. */
  computed_at: timestamp("computed_at", { fsp: 3 }),
  duration_ms: int("duration_ms"),
  error: varchar("error", { length: 500 }),
  attempted_at: timestamp("attempted_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "admin_metric_snapshot_metric_range", columns: [table.metric_key, table.range_key] }),
])

/**
 * One lease per metric so only one den-api instance recomputes it at a time.
 * A claim succeeds when the lease is free or expired; an expired lease lets
 * another instance take over after a crash. The `manual_refresh` row also
 * records the last admin-requested refresh, which rate-limits that endpoint.
 */
export const AdminMetricRefreshLeaseTable = mysqlTable("admin_metric_refresh_lease", {
  metric_key: varchar("metric_key", { length: 64 }).notNull().primaryKey(),
  owner: varchar("owner", { length: 64 }),
  lease_until: timestamp("lease_until", { fsp: 3 }),
  requested_at: timestamp("requested_at", { fsp: 3 }),
})
