import { bigint, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type { WorkbotUsageSurface } from "@openwork/types/den/workbot-usage"
import { denTypeIdColumn, timestamps } from "../columns"

/**
 * What Workbot spent on models, one row per UTC day, member, surface and model
 * (packages/types/src/den/workbot-usage.ts). The gateway's rollup job
 * (ee/apps/gateway/src/rollups.ts) adds to it from the request logs the
 * headless runner tagged with its conversation, in the same transaction that
 * consumes those logs, so a request is counted once. Requests still in
 * gateway_request_logs are not here yet; readers add them.
 *
 * Ids and sums only: never a conversation id, a title or any content.
 */
export const WorkbotUsageDayTable = mysqlTable("workbot_usage_day", {
  id: denTypeIdColumn("workbotUsageDay", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  day_start: timestamp("day_start", { fsp: 3 }).notNull(),
  org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
  surface: varchar("surface", { length: 32 }).$type<WorkbotUsageSurface>().notNull(),
  /** The model that answered, as the gateway logged it; empty when it never learned one. */
  model: varchar("model", { length: 255 }).notNull().default(""),
  request_count: int("request_count").notNull().default(0),
  /** Requests with no known cost; they add nothing to cost_micro_usd. */
  unpriced_request_count: int("unpriced_request_count").notNull().default(0),
  input_tokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  output_tokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  cache_read_tokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
  cost_micro_usd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  ...timestamps,
}, (table) => [
  // Also the read path: one organization's days in a range.
  uniqueIndex("workbot_usage_day_dimension").on(table.organization_id, table.day_start, table.org_membership_id, table.surface, table.model),
])
