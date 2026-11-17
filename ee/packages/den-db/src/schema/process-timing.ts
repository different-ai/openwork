import { double, index, int, json, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import type { ProcessTimingReport } from "@openwork/types/den/diagnostics"

export const ProcessTimingRunTable = mysqlTable("process_timing_run", {
  runId: varchar("run_id", { length: 36 }).notNull().primaryKey(),
  version: int("version").notNull(),
  process: varchar("process", { length: 8 }).$type<ProcessTimingReport["process"]>().notNull(),
  environment: varchar("environment", { length: 5 }).$type<ProcessTimingReport["environment"]>().notNull(),
  commit: varchar("commit", { length: 40 }),
  startedAt: varchar("started_at", { length: 24 }).notNull(),
  totalSeconds: double("total_seconds").notNull(),
  outcome: varchar("outcome", { length: 4 }).$type<ProcessTimingReport["outcome"]>().notNull(),
  steps: json("steps").$type<ProcessTimingReport["steps"]>().notNull(),
  receivedAt: timestamp("received_at", { fsp: 3 }).notNull().defaultNow(),
}, (table) => [
  index("process_timing_run_started").on(table.startedAt),
  index("process_timing_run_received").on(table.receivedAt),
  index("process_timing_run_filter_started").on(table.process, table.environment, table.startedAt),
])
