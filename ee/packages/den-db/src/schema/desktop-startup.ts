import { boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * One desktop app launch reported by a signed-in member (Settings › Diagnostics).
 * Holds step timings and a fixed failure code only: never hostnames, error
 * text, file paths or device identifiers. Rows older than 30 days are pruned
 * opportunistically on ingest and removed with the organization.
 */
export const DesktopStartupReportTable = mysqlTable(
  "desktop_startup_report",
  {
    id: denTypeIdColumn("desktopStartupReport", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    /** Random per launch (UUID); resending the same launch is idempotent. */
    attemptId: varchar("attempt_id", { length: 36 }).notNull(),
    appVersion: varchar("app_version", { length: 64 }).notNull(),
    platform: varchar("platform", { length: 16 }).notNull(),
    success: boolean("success").notNull(),
    failedStep: varchar("failed_step", { length: 16 }),
    failureReason: varchar("failure_reason", { length: 32 }),
    /** Milliseconds from process start until each step finished; null when not reached. */
    windowMs: int("window_ms"),
    engineMs: int("engine_ms"),
    signedInMs: int("signed_in_ms"),
    orgToolsMs: int("org_tools_ms"),
    /** When the launch happened, as reported by the app (bounded on ingest). */
    observedAt: timestamp("observed_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("desktop_startup_report_org_attempt").on(table.organizationId, table.attemptId),
    index("desktop_startup_report_org_observed").on(table.organizationId, table.observedAt),
  ],
)
