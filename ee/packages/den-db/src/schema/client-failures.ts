import { index, int, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import type { ClientFailureReport } from "@openwork/types/den/diagnostics"
import { denTypeIdColumn } from "../columns"

export const ClientFailureReportTable = mysqlTable("client_failure_report", {
  reportId: varchar("report_id", { length: 36 }).notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
  schemaVersion: int("schema_version").$type<1>().notNull(),
  occurredAt: timestamp("occurred_at", { fsp: 3 }).notNull(),
  component: varchar("component", { length: 20 }).$type<ClientFailureReport["component"]>().notNull(),
  phase: varchar("phase", { length: 10 }).$type<ClientFailureReport["phase"]>().notNull(),
  reason: varchar("reason", { length: 24 }).$type<ClientFailureReport["reason"]>().notNull(),
  appVersion: varchar("app_version", { length: 64 }).notNull(),
  platform: varchar("platform", { length: 8 }).$type<ClientFailureReport["platform"]>().notNull(),
  arch: varchar("arch", { length: 8 }).$type<ClientFailureReport["arch"]>().notNull(),
  exitCode: int("exit_code"),
  httpStatus: int("http_status"),
  count: int("count").notNull(),
  receivedAt: timestamp("received_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  index("client_failure_occurred").on(table.occurredAt),
  index("client_failure_org_occurred").on(table.organizationId, table.occurredAt),
  index("client_failure_class_occurred").on(table.component, table.reason, table.occurredAt),
])
