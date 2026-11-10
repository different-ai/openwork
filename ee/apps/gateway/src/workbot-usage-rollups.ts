// Workbot usage (packages/types/src/den/workbot-usage.ts): request logs the
// headless runner tagged with its conversation (metadata.headless_session)
// also add to workbot_usage_day, in the transaction that folds them into the
// hour rollups and deletes them (rollups.ts). A request is counted once, and
// the conversation id is not kept: only where the conversation ran.
import { GatewayRequestLogTable, WORKBOT_USAGE_SUM_COLUMNS, WorkbotUsageDayTable, workbotRawSession, workbotRawSums, type WorkbotUsageSumColumn } from "@openwork-ee/den-db"
import { and, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { parseHeadlessSessionHeader, workbotUsageSurfaceOfSession } from "@openwork/types/den/workbot-usage"

export type WorkbotUsageDayRow = typeof WorkbotUsageDayTable.$inferInsert

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

const raw = GatewayRequestLogTable
const day = WorkbotUsageDayTable

type DbTransaction = Parameters<Parameters<typeof import("./db.js").db.transaction>[0]>[0]

/** Adds the tagged rows among `ids` (one hour bucket's claimed batch, so one UTC day) to workbot_usage_day. */
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
