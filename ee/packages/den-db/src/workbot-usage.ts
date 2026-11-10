import { sql } from "drizzle-orm"
import { GatewayRequestLogTable as raw } from "./schema/inference"

// How a gateway request log counts as Workbot usage (packages/types/src/den/workbot-usage.ts), shared by the
// gateway's fold into workbot_usage_day and Den's read of the logs that are not folded yet.

function sum(expression: ReturnType<typeof sql>) {
  return sql<number>`coalesce(sum(${expression}), 0)`.mapWith(Number)
}

/** The headless runner conversation a request log was tagged with; SQL NULL when it was not. */
export const workbotRawSession = sql<string>`json_unquote(json_extract(${raw.metadata}, '$.headless_session'))`

export const workbotRawSums = {
  request_count: sql<number>`count(*)`.mapWith(Number),
  // A finished request the gateway could not price. Refused and aborted requests cost nothing and are not "unpriced".
  unpriced_request_count: sum(sql`case when ${raw.completed_at} is not null and ${raw.outcome} = 'ok' and ${raw.cost_micro_usd} is null then 1 else 0 end`),
  input_tokens: sum(sql`coalesce(${raw.input_tokens}, 0)`),
  output_tokens: sum(sql`coalesce(${raw.output_tokens}, 0)`),
  cache_read_tokens: sum(sql`coalesce(${raw.cache_read_tokens}, 0)`),
  cost_micro_usd: sum(sql`coalesce(${raw.cost_micro_usd}, 0)`),
}

export const WORKBOT_USAGE_SUM_COLUMNS = [
  "request_count", "unpriced_request_count", "input_tokens", "output_tokens", "cache_read_tokens", "cost_micro_usd",
] as const
export type WorkbotUsageSumColumn = (typeof WORKBOT_USAGE_SUM_COLUMNS)[number]
