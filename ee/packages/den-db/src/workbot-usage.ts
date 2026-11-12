import { and, inArray, sql } from "drizzle-orm"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { parseHeadlessSessionHeader, workbotUsageSurfaceOfSession } from "@openwork/types/den/workbot-usage"
import type { createDenDb } from "./client"
import { GatewayRequestLogTable as raw } from "./schema/inference"
import { WorkbotUsageDayTable as day } from "./schema/workbot-usage"

// How a gateway request log counts as Workbot usage (packages/types/src/den/workbot-usage.ts): the fold the
// gateway's rollup runs into workbot_usage_day, and the sums Den's read applies to the logs not folded yet.

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

export type WorkbotUsageDayRow = typeof day.$inferInsert

/** Tagged request logs of one batch, grouped by organization, member, conversation and model. */
export type WorkbotUsageAggregate = Pick<WorkbotUsageDayRow, "organization_id" | "org_membership_id"> & {
  session: string
  model: string | null
} & Record<WorkbotUsageSumColumn, number>

/** One row per organization, member, surface and model for the day; conversations of one surface are summed. */
export function buildWorkbotUsageDayRows(dayStart: Date, groups: readonly WorkbotUsageAggregate[]): WorkbotUsageDayRow[] {
  const rows = new Map<string, WorkbotUsageDayRow & Record<WorkbotUsageSumColumn, number>>()
  for (const group of groups) {
    // Only what the gateway accepted as a conversation id at request time counts as Workbot.
    if (!parseHeadlessSessionHeader(group.session)) continue
    for (const column of WORKBOT_USAGE_SUM_COLUMNS) {
      if (!Number.isSafeInteger(group[column]) || group[column] < 0) throw new Error("Workbot usage sum is out of range")
    }
    if (group.request_count === 0) continue
    const surface = workbotUsageSurfaceOfSession(group.session)
    const model = (group.model ?? "").slice(0, 255)
    const key = JSON.stringify([group.organization_id, group.org_membership_id, surface, model])
    const row = rows.get(key) ?? {
      id: createDenTypeId("workbotUsageDay"),
      organization_id: group.organization_id,
      org_membership_id: group.org_membership_id,
      day_start: dayStart,
      surface,
      model,
      request_count: 0, unpriced_request_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_micro_usd: 0,
    }
    for (const column of WORKBOT_USAGE_SUM_COLUMNS) row[column] += group[column]
    rows.set(key, row)
  }
  return [...rows.values()]
}

type DbTransaction = Parameters<Parameters<ReturnType<typeof createDenDb>["db"]["transaction"]>[0]>[0]

/**
 * Adds the tagged rows among `ids` (one hour bucket's claimed batch, so one UTC day) to workbot_usage_day. The
 * gateway's rollup (ee/apps/gateway/src/rollups.ts) calls it in the transaction that folds those logs into the hour
 * rollups and deletes them, so a request is counted once and its conversation id is not kept.
 */
export async function foldWorkbotUsage(executor: DbTransaction, dayStart: Date, ids: (typeof raw.$inferSelect.id)[]): Promise<void> {
  if (!ids.length) return
  const groups = await executor
    .select({
      organization_id: raw.organization_id,
      org_membership_id: raw.org_membership_id,
      session: workbotRawSession,
      upstream_model: raw.upstream_model,
      requested_model: raw.requested_model,
      ...workbotRawSums,
    })
    .from(raw)
    .where(and(inArray(raw.id, ids), sql`${workbotRawSession} is not null`))
    .groupBy(raw.organization_id, raw.org_membership_id, workbotRawSession, raw.upstream_model, raw.requested_model)
  const rows = buildWorkbotUsageDayRows(dayStart, groups.map(({ upstream_model, requested_model, ...group }) => ({ ...group, model: upstream_model ?? requested_model })))
  if (!rows.length) return
  const set = Object.fromEntries(WORKBOT_USAGE_SUM_COLUMNS.map((column) => [column, sql`${day[column]} + values(${sql.identifier(column)})`]))
  await executor.insert(day).values(rows).onDuplicateKeyUpdate({ set })
}
