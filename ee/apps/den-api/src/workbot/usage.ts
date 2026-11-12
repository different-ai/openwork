import { WORKBOT_USAGE_SUM_COLUMNS, workbotRawSession, workbotRawSums } from "@openwork-ee/den-db"
import { and, eq, gte, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayRequestLogTable as raw, MemberTable, WorkbotUsageDayTable as day } from "@openwork-ee/den-db/schema"
import {
  parseHeadlessSessionHeader,
  WORKBOT_USAGE_DAYS,
  workbotUsageSurface,
  workbotUsageSurfaceOfSession,
  type WorkbotUsageResponse,
  type WorkbotUsageSums,
} from "@openwork/types/den/workbot-usage"
import { db } from "../db.js"
import {
  mergeWorkbotUsageMembers,
  summarizeWorkbotUsage,
  WORKBOT_USAGE_DAY_MS,
  WORKBOT_USAGE_MEMBER_LIMIT,
  workbotUsageDay,
  workbotUsageWindowStart,
  type WorkbotUsageMemberSums,
  type WorkbotUsageSlice,
} from "./usage-rows.js"

type OrganizationId = typeof day.$inferSelect.organization_id
type SumRow = Record<(typeof WORKBOT_USAGE_SUM_COLUMNS)[number], number>

function sums(row: SumRow): WorkbotUsageSums {
  return {
    costMicroUsd: row.cost_micro_usd,
    requests: row.request_count,
    unpricedRequests: row.unpriced_request_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
  }
}

function total(column: (typeof WORKBOT_USAGE_SUM_COLUMNS)[number]) {
  return sql<number>`coalesce(sum(${day[column]}), 0)`.mapWith(Number)
}

const foldedSums = {
  request_count: total("request_count"),
  unpriced_request_count: total("unpriced_request_count"),
  input_tokens: total("input_tokens"),
  output_tokens: total("output_tokens"),
  cache_read_tokens: total("cache_read_tokens"),
  cost_micro_usd: total("cost_micro_usd"),
}

// The UTC day as days since the epoch, matching the JS epoch under the UTC session drizzle's timestamps assume.
const rawDay = sql<number>`floor(unix_timestamp(${raw.started_at}) / 86400)`.mapWith(Number)

/**
 * What Workbot spent on models over the last 30 UTC days (packages/types/src/den/workbot-usage.ts): the days the
 * gateway's rollup already folded (workbot_usage_day) plus the tagged request logs it has not consumed yet. The
 * rollup deletes a log in the transaction that folds it, so a request is in exactly one of the two.
 */
export async function readWorkbotUsage(organizationId: OrganizationId, now = new Date()): Promise<WorkbotUsageResponse> {
  const start = workbotUsageWindowStart(now, WORKBOT_USAGE_DAYS)
  const folded = and(eq(day.organization_id, organizationId), gte(day.day_start, start))
  const tagged = and(eq(raw.organization_id, organizationId), gte(raw.started_at, start), sql`${workbotRawSession} is not null`)

  const [foldedSlices, foldedMembers, rawSlices, rawMembers, [first]] = await Promise.all([
    db.select({ day: day.day_start, surface: day.surface, model: day.model, ...foldedSums }).from(day).where(folded)
      .groupBy(day.day_start, day.surface, day.model),
    db.select({ memberId: day.org_membership_id, ...foldedSums }).from(day).where(folded).groupBy(day.org_membership_id),
    db.select({ day: rawDay, session: workbotRawSession, upstream_model: raw.upstream_model, requested_model: raw.requested_model, ...workbotRawSums })
      .from(raw).where(tagged).groupBy(rawDay, workbotRawSession, raw.upstream_model, raw.requested_model),
    db.select({ memberId: raw.org_membership_id, ...workbotRawSums }).from(raw).where(tagged).groupBy(raw.org_membership_id),
    db.select({ day: sql<Date | null>`min(${day.day_start})`.mapWith(day.day_start) })
      .from(day).where(eq(day.organization_id, organizationId)),
  ])

  const slices: WorkbotUsageSlice[] = [
    ...foldedSlices.map((row) => ({ day: workbotUsageDay(row.day), surface: workbotUsageSurface(row.surface), model: row.model, ...sums(row) })),
    // The same rule the fold applies: only an accepted conversation id counts, and the surface comes from it.
    ...rawSlices.flatMap((row) => parseHeadlessSessionHeader(row.session) ? [{
      day: workbotUsageDay(new Date(row.day * WORKBOT_USAGE_DAY_MS)),
      surface: workbotUsageSurfaceOfSession(row.session),
      model: row.upstream_model ?? row.requested_model ?? "",
      ...sums(row),
    }] : []),
  ]
  const members = mergeWorkbotUsageMembers([...foldedMembers, ...rawMembers].map((row): WorkbotUsageMemberSums => ({ memberId: row.memberId, ...sums(row) })))
  const listed = members.slice(0, WORKBOT_USAGE_MEMBER_LIMIT).map((member) => member.memberId)
  const people = listed.length
    ? await db.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email, removedAt: MemberTable.removedAt })
      .from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, listed as (typeof MemberTable.$inferSelect.id)[])))
    : []
  // A member who left keeps their spend in the totals but is no longer named.
  const names = new Map(people.filter((person) => !person.removedAt).map((person) => [person.id as string, { name: person.name, email: person.email }]))

  const firstRaw = slices.reduce<string | null>((earliest, slice) => earliest === null || slice.day < earliest ? slice.day : earliest, null)
  const firstFolded = first?.day ? workbotUsageDay(first.day) : null
  return summarizeWorkbotUsage({ now, days: WORKBOT_USAGE_DAYS, since: firstFolded ?? firstRaw, slices, members, names })
}
