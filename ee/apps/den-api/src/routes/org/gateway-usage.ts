import { and, asc, eq, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayProviderModelTable, GatewayProviderTable, GatewayRequestLogTable, GatewayUsageRollupTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayUsageDay, GatewayUsageOption, GatewayUsageResponse } from "@openwork/types/den/gateway-usage"
import { INFERENCE_FREE_MODEL_ID, INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { gatewayManagementUnavailable, gatewayManagementUnavailableSchema } from "../../gateway-deployment.js"
import { getModelsDevProviders } from "../../llm/models-dev.js"
import { orgMemberRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { ensureOrganizationAdminRole, orgAccessFailureStatus, type OrgRouteVariables } from "./shared.js"

const DAY_MS = 86_400_000
const MAX_SERIES = 10_000
const MAX_OPTIONS = 20_000
const groupBySchema = z.enum(["model", "team", "person"])
const querySchema = z.object({
  groupBy: groupBySchema.default("model"),
  days: z.string().max(3).regex(/^[1-9]\d*$/).default("31").transform(Number).pipe(z.number().int().min(1).max(366)),
  filterIds: z.string().max(6500).default("").transform((value) => value === "" ? [] : value.split(",").map((id) => id.trim()))
    .pipe(z.array(z.string().min(1).max(64)).max(100)),
}).strict().superRefine((query, ctx) => {
  for (const id of query.filterIds) {
    const valid = query.groupBy === "model" ? id === OPENWORK_MODELS_OPTION_ID || isDenTypeId("inferenceProvider", id)
      : query.groupBy === "person" ? isDenTypeId("member", id)
      : isDenTypeId("team", id)
    if (!valid) ctx.addIssue({ code: "custom", path: ["filterIds"], message: "Filter IDs must match the selected grouping." })
  }
})
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const optionSchema = z.object({ id: z.string(), label: z.string() })
const responseSchema: z.ZodType<GatewayUsageResponse> = z.object({
  usage: z.object({
    groupBy: groupBySchema, days: z.number().int().min(1).max(366),
    from: z.iso.date(), to: z.iso.date(), timezone: z.literal("UTC"),
    emptyReason: z.literal("no_teams").optional(),
    requestCount: countSchema, uncountableRequests: z.object({ ok: countSchema.nullable(), upstream_error: countSchema.nullable(), upstream_unreachable: countSchema.nullable(), client_aborted: countSchema.nullable(), rejected: countSchema.nullable() }), totalTokens: countSchema, unreportedRequests: countSchema.nullable(),
    totalCostMicroUsd: countSchema, unpricedRequests: countSchema.nullable(),
    series: z.array(optionSchema),
    daily: z.array(z.object({
      date: z.iso.date(), totalTokens: countSchema, values: z.record(z.string(), countSchema),
      totalCostMicroUsd: countSchema, costValues: z.record(z.string(), countSchema.nullable()),
    })),
    filterOptions: z.array(optionSchema),
  }),
})
const bucketsSchema = z.array(z.object({
  date: z.iso.date(), requestCount: z.string(), successfulUnreportedRequests: z.string().nullable(), upstreamErrorUnreportedRequests: z.string().nullable(), unreachableUnreportedRequests: z.string().nullable(), abortedUnreportedRequests: z.string().nullable(), rejectedUnreportedRequests: z.string().nullable(), totalTokens: z.string(), unreportedRequests: z.string().nullable(),
  totalCostMicroUsd: z.string(), unpricedRequests: z.string().nullable(),
})).max(366)

class UsageReadError extends Error {
  constructor(readonly code: "gateway_usage_too_large" | "gateway_usage_invalid_totals", message: string) { super(message) }
}

function safeCount(value: string | number): number {
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new UsageReadError("gateway_usage_invalid_totals", "Usage contains an invalid count.")
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new UsageReadError("gateway_usage_invalid_totals", "Usage exceeds the safe integer range.")
  return count
}

function addNullableCount(total: number | null, value: string | null): number | null {
  return total === null || value === null ? null : safeCount(total + safeCount(value))
}

function checkCardinality(size: number, limit: number) {
  if (size > limit) throw new UsageReadError("gateway_usage_too_large", "Usage has too many categories. Narrow the date range or filters; no categories have been truncated or combined.")
}

/** OpenWork Models (hosted models and free Auto) reports alongside the organization's own Gateway providers (Paper: Gateway grid). */
const OPENWORK_MODELS_OPTION_ID = "openwork"
const OPENWORK_MODELS_LABEL = "OpenWork Models"
const USAGE_ROUTES = ["org_provider", "openwork_openrouter", "openwork_free"] as const

const labelOrder = (left: GatewayUsageOption, right: GatewayUsageOption) => left.label.localeCompare(right.label, "en") || left.id.localeCompare(right.id, "en")

function modelIdentityParts(id: string) {
  const [, familyHex, modelHex] = id.split(":")
  return {
    family: Buffer.from(familyHex, "hex").toString("utf8"),
    model: modelHex === "~" ? null : Buffer.from(modelHex, "hex").toString("utf8"),
  }
}

function modelIdentity(family: string, model: string) {
  return `model:${Buffer.from(family).toString("hex").toUpperCase()}:${Buffer.from(model).toString("hex").toUpperCase()}`
}

function datedModelAlias(model: string) {
  const match = /^(.*)-(\d{4}-\d{2}-\d{2})$/.exec(model)
  if (!match) return null
  const date = Date.parse(`${match[2]}T00:00:00Z`)
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === match[2] ? match[1] : null
}

function usageModelLabel(id: string, labels: Map<string, string>) {
  const exact = labels.get(id)
  const { family, model } = modelIdentityParts(id)
  if (model === null) return "Unreported model"
  if (exact && exact !== model) return exact
  const alias = datedModelAlias(model)
  // Only resolve a revision when its base model actually exists in this
  // provider's catalog. Never manufacture a display name from an unknown ID.
  return (alias ? labels.get(modelIdentity(family, alias)) : undefined) ?? exact
}

function disambiguateUsageLabels(labels: Map<string, string>, models = false) {
  let detail = models ? 0 : 1
  for (;;) {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const label of labels.values()) {
      if (seen.has(label)) duplicates.add(label)
      seen.add(label)
    }
    if (!duplicates.size) return
    for (const [id, label] of labels) {
      if (!duplicates.has(label)) continue
      const model = models ? modelIdentityParts(id) : null
      const suffix = detail === 0 && model ? model.family
        : model && detail === 1 ? (/\d{4}-\d{2}-\d{2}$/.exec(model.model ?? "")?.[0] ?? model.model ?? "Unreported model")
        : model ? `${model.family}/${model.model ?? "Unreported model"}`
        : detail === 1 ? id.slice(-8) : id
      labels.set(id, `${label} (${suffix})`)
    }
    // Recheck generated labels too: short suffixes or existing names can collide.
    detail += 1
  }
}

export async function readGatewayUsage(organizationId: typeof GatewayProviderTable.$inferSelect.organization_id, query: z.infer<typeof querySchema>, now = new Date()): Promise<GatewayUsageResponse> {
  const toMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const fromMs = toMs - (query.days - 1) * DAY_MS
  const endSeconds = (toMs + DAY_MS) / 1000
  const fromSeconds = fromMs / 1000
  const raw = GatewayRequestLogTable
  const rollup = GatewayUsageRollupTable
  const teams: GatewayUsageOption[] = []
  if (query.groupBy === "team") {
    teams.push(...await db.select({ id: TeamTable.id, label: TeamTable.name }).from(TeamTable)
      .where(eq(TeamTable.organizationId, organizationId)).limit(MAX_OPTIONS + 1))
    checkCardinality(teams.length, MAX_OPTIONS)
    // No team grouping exists yet. Do not query usage or imply
    // that the organization's model/person usage is zero.
    if (!teams.length) return { usage: {
      groupBy: "team", days: query.days, timezone: "UTC", emptyReason: "no_teams",
      from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs).toISOString().slice(0, 10),
      requestCount: 0, uncountableRequests: { ok: 0, upstream_error: 0, upstream_unreachable: 0, client_aborted: 0, rejected: 0 }, totalTokens: 0, unreportedRequests: 0, totalCostMicroUsd: 0, unpricedRequests: 0, series: [], filterOptions: [],
      daily: Array.from({ length: query.days }, (_, offset) => ({
        date: new Date(fromMs + offset * DAY_MS).toISOString().slice(0, 10), totalTokens: 0, values: {}, totalCostMicroUsd: 0, costValues: {},
      })),
    } }
  }

  function dimensions(table: typeof raw | typeof rollup, timestamp: typeof raw.started_at | typeof rollup.bucket_start) {
    // Epoch arithmetic gives UTC calendar dates even if a DB session is not UTC.
    const date = sql<string>`date_format(timestampadd(day, floor(unix_timestamp(${timestamp}) / 86400), '1970-01-01'), '%Y-%m-%d')`.as("usage_date")
    const filterId = (query.groupBy === "model" ? sql<string | null>`coalesce(${table.gateway_provider_id}, case when ${table.route} in ('openwork_openrouter', 'openwork_free') then ${OPENWORK_MODELS_OPTION_ID} end)`
      : sql<string | null>`${table.org_membership_id}`).as("filter_id")
    // Hex encodes the exact family/model tuple, independent of DB collation,
    // configured instances, request aliases, model groups and credential sets.
    // OpenWork Models (paid and free Auto) is its own family so it never merges with an organization's own providers.
    const family = sql<string>`case when ${table.route} in ('openwork_openrouter', 'openwork_free') then ${OPENWORK_MODELS_OPTION_ID} else ${table.upstream_provider_id} end`
    const seriesId = (query.groupBy === "model"
      ? sql<string>`concat('model:', hex(${family}), ':', coalesce(hex(${table.upstream_model}), '~'))`
      : sql<string>`${table.org_membership_id}`).as("series_id")
    return { date, seriesId, filterId }
  }

  // Older summaries lack the outcome/coverage intersection. Only infer a
  // count when their existing counters determine it exactly.
  const legacyMissing = (outcomeCount: typeof rollup.ok_count | typeof rollup.aborted_count) => sql<number | null>`case
    when ${outcomeCount} = 0 then 0
    when ${rollup.total_tokens_count} is null then null
    when ${rollup.total_tokens_count} = ${rollup.request_count} then 0
    when ${rollup.total_tokens_count} = 0 then ${outcomeCount}
    when ${outcomeCount} = ${rollup.request_count} then ${rollup.request_count} - ${rollup.total_tokens_count}
    else null end`
  const legacyErrorMissing = sql<number | null>`case when ${rollup.error_count} = 0 or ${rollup.total_tokens_count} = ${rollup.request_count} then 0 else null end`
  const successfulUnreportedRequestsRollup = sql<number | null>`coalesce(${rollup.uncountable_ok_count}, ${legacyMissing(rollup.ok_count)})`
  const upstreamErrorUnreportedRequestsRollup = sql<number | null>`coalesce(${rollup.uncountable_upstream_error_count}, ${legacyErrorMissing})`
  const unreachableUnreportedRequestsRollup = sql<number | null>`coalesce(${rollup.uncountable_upstream_unreachable_count}, ${legacyErrorMissing})`
  const abortedUnreportedRequestsRollup = sql<number | null>`coalesce(${rollup.uncountable_client_aborted_count}, ${legacyMissing(rollup.aborted_count)})`
  const rejectedUnreportedRequestsRollup = sql<number | null>`coalesce(${rollup.uncountable_rejected_count}, ${legacyErrorMissing})`
  const rawDimensions = dimensions(raw, raw.started_at)
  const rollupDimensions = dimensions(rollup, rollup.bucket_start)
  const sources = db.select({
    ...rawDimensions,
    requestCount: sql<string>`count(*)`.as("request_count"),
    successfulUnreportedRequests: sql<string | null>`sum(case when ${raw.outcome} = 'ok' and ${raw.total_tokens} is null then 1 else 0 end)`.as("uncountable_ok"),
    upstreamErrorUnreportedRequests: sql<string | null>`sum(case when ${raw.outcome} = 'upstream_error' and ${raw.total_tokens} is null then 1 else 0 end)`.as("uncountable_upstream_error"),
    unreachableUnreportedRequests: sql<string | null>`sum(case when ${raw.outcome} = 'upstream_unreachable' and ${raw.total_tokens} is null then 1 else 0 end)`.as("uncountable_upstream_unreachable"),
    abortedUnreportedRequests: sql<string | null>`sum(case when ${raw.outcome} = 'client_aborted' and ${raw.total_tokens} is null then 1 else 0 end)`.as("uncountable_client_aborted"),
    rejectedUnreportedRequests: sql<string | null>`sum(case when ${raw.outcome} = 'rejected' and ${raw.total_tokens} is null then 1 else 0 end)`.as("uncountable_rejected"),
    totalTokens: sql<string>`coalesce(sum(${raw.total_tokens}), 0)`.as("total_tokens"),
    unreportedRequests: sql<string | null>`count(*) - count(${raw.total_tokens})`.as("unreported_requests"),
    totalCostMicroUsd: sql<string>`coalesce(sum(${raw.cost_micro_usd}), 0)`.as("total_cost_micro_usd"),
    unpricedRequests: sql<string | null>`count(*) - count(${raw.cost_micro_usd})`.as("unpriced_requests"),
  }).from(raw).where(and(
    eq(raw.organization_id, organizationId), inArray(raw.route, [...USAGE_ROUTES]), isNotNull(raw.completed_at),
    sql`${raw.started_at} >= from_unixtime(${fromSeconds}) and ${raw.started_at} < from_unixtime(${endSeconds})`,
  )).groupBy(rawDimensions.date, rawDimensions.seriesId, rawDimensions.filterId).unionAll(db.select({
    ...rollupDimensions,
    requestCount: sql<string>`sum(${rollup.request_count})`.as("request_count"),
    successfulUnreportedRequests: sql<string | null>`case when count(${successfulUnreportedRequestsRollup}) = count(*) then sum(${successfulUnreportedRequestsRollup}) else null end`.as("uncountable_ok"),
    upstreamErrorUnreportedRequests: sql<string | null>`case when count(${upstreamErrorUnreportedRequestsRollup}) = count(*) then sum(${upstreamErrorUnreportedRequestsRollup}) else null end`.as("uncountable_upstream_error"),
    unreachableUnreportedRequests: sql<string | null>`case when count(${unreachableUnreportedRequestsRollup}) = count(*) then sum(${unreachableUnreportedRequestsRollup}) else null end`.as("uncountable_upstream_unreachable"),
    abortedUnreportedRequests: sql<string | null>`case when count(${abortedUnreportedRequestsRollup}) = count(*) then sum(${abortedUnreportedRequestsRollup}) else null end`.as("uncountable_client_aborted"),
    rejectedUnreportedRequests: sql<string | null>`case when count(${rejectedUnreportedRequestsRollup}) = count(*) then sum(${rejectedUnreportedRequestsRollup}) else null end`.as("uncountable_rejected"),
    totalTokens: sql<string>`sum(${rollup.total_tokens})`.as("total_tokens"),
    unreportedRequests: sql<string | null>`case when count(${rollup.total_tokens_count}) = count(*) then sum(${rollup.request_count}) - sum(${rollup.total_tokens_count}) else null end`.as("unreported_requests"),
    totalCostMicroUsd: sql<string>`coalesce(sum(${rollup.cost_micro_usd}), 0)`.as("total_cost_micro_usd"),
    unpricedRequests: sql<string | null>`case when count(${rollup.cost_count}) = count(*) then sum(${rollup.request_count}) - sum(${rollup.cost_count}) else null end`.as("unpriced_requests"),
  }).from(rollup).where(and(
    eq(rollup.organization_id, organizationId), inArray(rollup.route, [...USAGE_ROUTES]), inArray(rollup.granularity, ["hour", "day"]),
    sql`${rollup.bucket_start} >= from_unixtime(${fromSeconds}) and ${rollup.bucket_start} < from_unixtime(${endSeconds})`,
  )).groupBy(rollupDimensions.date, rollupDimensions.seriesId, rollupDimensions.filterId)).as("usage_sources")

  const groupedUsage = db.select({
    date: sources.date, seriesId: sources.seriesId,
    requestCount: sql<string>`cast(sum(${sources.requestCount}) as char)`.as("request_count"),
    successfulUnreportedRequests: sql<string | null>`case when count(${sources.successfulUnreportedRequests}) = count(*) then cast(sum(${sources.successfulUnreportedRequests}) as char) else null end`.as("uncountable_ok"),
    upstreamErrorUnreportedRequests: sql<string | null>`case when count(${sources.upstreamErrorUnreportedRequests}) = count(*) then cast(sum(${sources.upstreamErrorUnreportedRequests}) as char) else null end`.as("uncountable_upstream_error"),
    unreachableUnreportedRequests: sql<string | null>`case when count(${sources.unreachableUnreportedRequests}) = count(*) then cast(sum(${sources.unreachableUnreportedRequests}) as char) else null end`.as("uncountable_upstream_unreachable"),
    abortedUnreportedRequests: sql<string | null>`case when count(${sources.abortedUnreportedRequests}) = count(*) then cast(sum(${sources.abortedUnreportedRequests}) as char) else null end`.as("uncountable_client_aborted"),
    rejectedUnreportedRequests: sql<string | null>`case when count(${sources.rejectedUnreportedRequests}) = count(*) then cast(sum(${sources.rejectedUnreportedRequests}) as char) else null end`.as("uncountable_rejected"),
    totalTokens: sql<string>`cast(sum(${sources.totalTokens}) as char)`.as("total_tokens"),
    unreportedRequests: sql<string | null>`case when count(${sources.unreportedRequests}) = count(*) then cast(sum(${sources.unreportedRequests}) as char) else null end`.as("unreported_requests"),
    totalCostMicroUsd: sql<string>`cast(sum(${sources.totalCostMicroUsd}) as char)`.as("total_cost_micro_usd"),
    unpricedRequests: sql<string | null>`case when count(${sources.unpricedRequests}) = count(*) then cast(sum(${sources.unpricedRequests}) as char) else null end`.as("unpriced_requests"),
  }).from(sources).where(query.groupBy !== "team" && query.filterIds.length ? inArray(sources.filterId, query.filterIds) : undefined)
    .groupBy(sources.date, sources.seriesId)
  let daily = groupedUsage.as("usage_daily")
  if (query.groupBy === "team") {
    const memberDaily = groupedUsage.as("usage_member_daily")
    // Deduplicate current pairs before attribution; never expand raw requests
    // or infer membership from the historical authorizing grant.
    const memberships = db.select({
      memberId: sql<string>`${MemberTable.id}`.as("attribution_member_id"),
      teamId: sql<string>`${TeamTable.id}`.as("attribution_team_id"),
    }).from(TeamMemberTable)
      .innerJoin(TeamTable, and(eq(TeamTable.id, TeamMemberTable.teamId), eq(TeamTable.organizationId, organizationId)))
      .innerJoin(MemberTable, and(
        eq(MemberTable.id, TeamMemberTable.orgMembershipId), eq(MemberTable.organizationId, organizationId),
        eq(MemberTable.organizationId, TeamTable.organizationId), isNull(MemberTable.removedAt), isNotNull(MemberTable.userId),
      )).groupBy(MemberTable.id, TeamTable.id).as("usage_team_memberships")
    daily = db.select({
      date: memberDaily.date,
      seriesId: sql<string>`${memberships.teamId}`.as("series_id"),
      requestCount: sql<string>`cast(sum(${memberDaily.requestCount}) as char)`.as("request_count"),
      successfulUnreportedRequests: sql<string | null>`case when count(${memberDaily.successfulUnreportedRequests}) = count(*) then cast(sum(${memberDaily.successfulUnreportedRequests}) as char) else null end`.as("uncountable_ok"),
      upstreamErrorUnreportedRequests: sql<string | null>`case when count(${memberDaily.upstreamErrorUnreportedRequests}) = count(*) then cast(sum(${memberDaily.upstreamErrorUnreportedRequests}) as char) else null end`.as("uncountable_upstream_error"),
      unreachableUnreportedRequests: sql<string | null>`case when count(${memberDaily.unreachableUnreportedRequests}) = count(*) then cast(sum(${memberDaily.unreachableUnreportedRequests}) as char) else null end`.as("uncountable_upstream_unreachable"),
      abortedUnreportedRequests: sql<string | null>`case when count(${memberDaily.abortedUnreportedRequests}) = count(*) then cast(sum(${memberDaily.abortedUnreportedRequests}) as char) else null end`.as("uncountable_client_aborted"),
      rejectedUnreportedRequests: sql<string | null>`case when count(${memberDaily.rejectedUnreportedRequests}) = count(*) then cast(sum(${memberDaily.rejectedUnreportedRequests}) as char) else null end`.as("uncountable_rejected"),
      totalTokens: sql<string>`cast(sum(${memberDaily.totalTokens}) as char)`.as("total_tokens"),
      unreportedRequests: sql<string | null>`case when count(${memberDaily.unreportedRequests}) = count(*) then cast(sum(${memberDaily.unreportedRequests}) as char) else null end`.as("unreported_requests"),
      totalCostMicroUsd: sql<string>`cast(sum(${memberDaily.totalCostMicroUsd}) as char)`.as("total_cost_micro_usd"),
      unpricedRequests: sql<string | null>`case when count(${memberDaily.unpricedRequests}) = count(*) then cast(sum(${memberDaily.unpricedRequests}) as char) else null end`.as("unpriced_requests"),
    }).from(memberDaily).innerJoin(memberships, eq(memberDaily.seriesId, memberships.memberId))
      .where(query.filterIds.length ? inArray(memberships.teamId, query.filterIds) : undefined)
      .groupBy(memberDaily.date, memberships.teamId).as("usage_daily")
  }

  // One snapshot includes usage, current team membership and unfiltered options.
  // Retention inserts and deletes in one transaction, so a request is visible
  // in exactly one store. Team totals intentionally sum attributions: members
  // in multiple teams contribute once to each. Model/person totals do not overlap.
  // SQL compacts to at most 366 buckets per series; limit+1 fails explicitly.
  const seriesRows = db.select({
    kind: sql<string>`'series'`.as("kind"), id: daily.seriesId,
    buckets: sql<z.infer<typeof bucketsSchema>>`json_arrayagg(json_object('date', ${daily.date}, 'requestCount', ${daily.requestCount}, 'successfulUnreportedRequests', ${daily.successfulUnreportedRequests}, 'upstreamErrorUnreportedRequests', ${daily.upstreamErrorUnreportedRequests}, 'unreachableUnreportedRequests', ${daily.unreachableUnreportedRequests}, 'abortedUnreportedRequests', ${daily.abortedUnreportedRequests}, 'rejectedUnreportedRequests', ${daily.rejectedUnreportedRequests}, 'totalTokens', ${daily.totalTokens}, 'unreportedRequests', ${daily.unreportedRequests}, 'totalCostMicroUsd', ${daily.totalCostMicroUsd}, 'unpricedRequests', ${daily.unpricedRequests}))`
      .mapWith((value: unknown) => bucketsSchema.parse(typeof value === "string" ? JSON.parse(value) : value)).as("buckets"),
    label: sql<string | null>`null`.as("option_label"),
  }).from(daily).groupBy(daily.seriesId).limit(MAX_SERIES + 1).as("usage_series")
  const optionRows = (query.groupBy === "team" ? db.select({
    kind: sql<string>`'option'`.as("kind"), id: sql<string>`${TeamTable.id}`.as("option_id"),
    buckets: sql<z.infer<typeof bucketsSchema>>`json_array()`.as("buckets"),
    label: sql<string | null>`${TeamTable.name}`.as("option_label"),
  }).from(TeamTable).where(eq(TeamTable.organizationId, organizationId)).limit(MAX_OPTIONS + 1) : db.select({
    kind: sql<string>`'option'`.as("kind"), id: sql<string>`${sources.filterId}`.as("option_id"),
    buckets: sql<z.infer<typeof bucketsSchema>>`json_array()`.as("buckets"),
    label: sql<string | null>`null`.as("option_label"),
  }).from(sources).where(isNotNull(sources.filterId)).groupBy(sources.filterId).limit(MAX_OPTIONS + 1)).as("usage_options")
  const rows = await db.select({ kind: seriesRows.kind, id: seriesRows.id, buckets: seriesRows.buckets, label: seriesRows.label }).from(seriesRows)
    .unionAll(db.select({ kind: optionRows.kind, id: optionRows.id, buckets: optionRows.buckets, label: optionRows.label }).from(optionRows))
  const series = rows.filter((row) => row.kind === "series")
  const optionIdentities = rows.filter((row) => row.kind === "option")
  checkCardinality(series.length, MAX_SERIES)
  checkCardinality(optionIdentities.length, MAX_OPTIONS)

  const options = new Map<string, string>()
  const modelLabels = new Map<string, string>()
  if (query.groupBy === "model") {
    const providers = await db.select({ id: GatewayProviderTable.id, label: GatewayProviderTable.name }).from(GatewayProviderTable)
      .where(eq(GatewayProviderTable.organization_id, organizationId)).limit(MAX_OPTIONS + 1)
    checkCardinality(providers.length, MAX_OPTIONS)
    for (const provider of providers) options.set(provider.id, provider.label)
    options.set(OPENWORK_MODELS_OPTION_ID, OPENWORK_MODELS_LABEL)
    for (const row of series) {
      const { family, model } = modelIdentityParts(row.id)
      if (family !== OPENWORK_MODELS_OPTION_ID || model === null) continue
      const alias = Object.entries(INFERENCE_MODEL_ALIASES).find(([id]) => id === model)?.[1]
      modelLabels.set(row.id, model === INFERENCE_FREE_MODEL_ID ? "Auto" : alias?.displayName ?? model)
    }
    // These are saved catalog names, not the decorated usable-model aliases.
    const modelSeriesId = sql<string>`concat('model:', hex(${GatewayProviderTable.provider_id}), ':', hex(${GatewayProviderModelTable.model_id}))`.as("model_series_id")
    const models = await db.select({ id: modelSeriesId,
      label: sql<string>`min(convert(${GatewayProviderModelTable.name} using utf8mb4) collate utf8mb4_bin)`.as("model_label"),
    }).from(GatewayProviderModelTable).innerJoin(GatewayProviderTable, eq(GatewayProviderTable.id, GatewayProviderModelTable.gateway_provider_id))
      .where(eq(GatewayProviderTable.organization_id, organizationId))
      .groupBy(modelSeriesId).limit(MAX_OPTIONS + 1)
    checkCardinality(models.length, MAX_OPTIONS)
    for (const model of models) modelLabels.set(model.id, model.label)
    const unresolved = series.filter((row) => {
      const label = usageModelLabel(row.id, modelLabels)
      return !label || label === modelIdentityParts(row.id).model
    })
    if (unresolved.length) {
      const identities = unresolved.map((row) => modelIdentityParts(row.id))
      const needed = new Set(unresolved.map((row) => row.id))
      for (const { family, model } of identities) {
        const alias = model === null ? null : datedModelAlias(model)
        if (alias) needed.add(modelIdentity(family, alias))
      }
      // Historical models may no longer be in the configured universe. The
      // cached catalog supplies their labels without changing usage or access.
      // A catalog outage must not make the recorded usage chart unavailable.
      const catalogs = await getModelsDevProviders(identities.map((entry) => entry.family)).catch(() => [])
      for (const catalog of catalogs) for (const model of catalog.models) {
        const id = modelIdentity(catalog.id, model.id)
        if (needed.has(id) && (!modelLabels.has(id) || modelLabels.get(id) === model.id)) modelLabels.set(id, model.name)
      }
    }
  } else if (query.groupBy === "team") {
    // Use teams/names from the usage snapshot, not the earlier empty-state check.
    for (const team of optionIdentities) {
      if (team.label === null) throw new Error("Current Gateway usage team has no label")
      options.set(team.id, team.label)
    }
  } else {
    const members = await db.select({ id: MemberTable.id, name: AuthUserTable.name }).from(MemberTable)
      .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt))).orderBy(asc(MemberTable.id)).limit(MAX_OPTIONS + 1)
    checkCardinality(members.length, MAX_OPTIONS)
    for (const member of members) options.set(member.id, member.name || member.id)
  }
  const removedLabel = query.groupBy === "model" ? "Removed provider" : "Removed member"
  if (query.groupBy !== "team") for (const row of optionIdentities) if (!options.has(row.id)) options.set(row.id, removedLabel)
  checkCardinality(options.size, MAX_OPTIONS)
  disambiguateUsageLabels(options)

  const days = new Map<string, GatewayUsageDay>()
  for (let offset = 0; offset < query.days; offset += 1) {
    const date = new Date(fromMs + offset * DAY_MS).toISOString().slice(0, 10)
    days.set(date, { date, totalTokens: 0, values: {}, totalCostMicroUsd: 0, costValues: {} })
  }
  let requestCount = 0
  const uncountableRequests: Record<"ok" | "upstream_error" | "upstream_unreachable" | "client_aborted" | "rejected", number | null> = { ok: 0, upstream_error: 0, upstream_unreachable: 0, client_aborted: 0, rejected: 0 }
  let totalTokens = 0
  let unreportedRequests: number | null = 0
  let totalCostMicroUsd = 0
  let unpricedRequests: number | null = 0
  const seriesLabels = new Map<string, string>()
  for (const row of series) {
    if (query.groupBy === "team" && !options.has(row.id)) throw new Error("Gateway usage team missing from current snapshot")
    const modelHex = row.id.split(":")[2]
    const label = query.groupBy === "model"
      ? usageModelLabel(row.id, modelLabels) ?? (modelHex === "~" ? "Unreported model" : Buffer.from(modelHex, "hex").toString("utf8"))
      : options.get(row.id) ?? removedLabel
    if (row.buckets.some((bucket) => safeCount(bucket.totalTokens) > 0 || safeCount(bucket.totalCostMicroUsd) > 0)) seriesLabels.set(row.id, label)
    for (const bucket of row.buckets) {
      const day = days.get(bucket.date)
      if (!day) throw new Error("Gateway usage date outside requested UTC range")
      requestCount = safeCount(requestCount + safeCount(bucket.requestCount))
      uncountableRequests.ok = addNullableCount(uncountableRequests.ok, bucket.successfulUnreportedRequests)
      uncountableRequests.upstream_error = addNullableCount(uncountableRequests.upstream_error, bucket.upstreamErrorUnreportedRequests)
      uncountableRequests.upstream_unreachable = addNullableCount(uncountableRequests.upstream_unreachable, bucket.unreachableUnreportedRequests)
      uncountableRequests.client_aborted = addNullableCount(uncountableRequests.client_aborted, bucket.abortedUnreportedRequests)
      uncountableRequests.rejected = addNullableCount(uncountableRequests.rejected, bucket.rejectedUnreportedRequests)
      const tokens = safeCount(bucket.totalTokens)
      const missing = bucket.unreportedRequests === null ? null : safeCount(bucket.unreportedRequests)
      const cost = safeCount(bucket.totalCostMicroUsd)
      const unpriced = bucket.unpricedRequests === null ? null : safeCount(bucket.unpricedRequests)
      if (tokens > 0) day.values[row.id] = tokens
      day.totalTokens = safeCount(day.totalTokens + tokens)
      totalTokens = safeCount(totalTokens + tokens)
      unreportedRequests = unreportedRequests === null || missing === null ? null : safeCount(unreportedRequests + missing)
      // Keep recorded positive subtotals, but never present unobserved cost as free.
      if (seriesLabels.has(row.id)) day.costValues[row.id] = cost === 0 && unpriced !== 0 ? null : cost
      day.totalCostMicroUsd = safeCount(day.totalCostMicroUsd + cost)
      totalCostMicroUsd = safeCount(totalCostMicroUsd + cost)
      unpricedRequests = unpricedRequests === null || unpriced === null ? null : safeCount(unpricedRequests + unpriced)
    }
  }
  if (query.groupBy === "model") disambiguateUsageLabels(seriesLabels, true)
  return { usage: {
    groupBy: query.groupBy, days: query.days, from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs).toISOString().slice(0, 10), timezone: "UTC",
    requestCount, uncountableRequests, totalTokens, unreportedRequests, totalCostMicroUsd, unpricedRequests,
    series: [...seriesLabels].map(([id, label]) => ({ id, label })).sort(labelOrder), daily: [...days.values()],
    filterOptions: [...options].map(([id, label]) => ({ id, label })).sort(labelOrder),
  } }
}

export function registerOrgGatewayUsageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/inference-providers/usage", describeRoute({
    tags: ["Inference Providers"], summary: "Read organization Gateway usage by UTC day",
    description: "Defaults to model grouping and the last 31 UTC calendar days including today. Empty filters mean all. Counts only org_provider traffic. requestCount includes completed request records of all outcomes, including gateway rejections and interrupted requests; unreportedRequests counts records without total tokens, not just successful generations with missing usage. uncountableRequests breaks missing token totals down by outcome (ok, upstream_error, upstream_unreachable, client_aborted, rejected); individual counts are null when historical summaries cannot separate them. These diagnostic counts are separate from plotted usage. Team requestCount and uncountableRequests sum current team attributions like the other totals. Token values omit zero subtotals, and series with neither positive tokens nor positive cost are omitted. Returns tokens and stored approximate cost in integer micro-USD in the same snapshot, without repricing historical requests. totalTokens, unreportedRequests and daily values remain token-only. totalCostMicroUsd sums known stored costs; unpricedRequests counts missing cost observations, or is null when legacy rollup observation counts leave coverage unknown. Daily costValues use the same stable series IDs: zero subtotals with missing or unknown cost coverage are null, fully observed zero costs are 0, and positive recorded subtotals remain numeric even with incomplete coverage indicated by unpricedRequests. Team view attributes each active org member's usage to every distinct current team membership; members without a team are omitted. Team token, cost and missing-observation totals sum these attributions and may exceed model/person totals; cost coverage is evaluated per team/day. No teams returns emptyReason=no_teams, zero totals and missing counts, and empty daily maps without querying usage. Absent keys in a day's sparse values and costValues maps mean no usage and are zero. Limits: 100 filter IDs, 366 days, 10,000 series and 20,000 filter options; oversized results fail without truncation.",
    responses: {
      200: jsonResponse("Gateway usage", responseSchema),
      400: jsonResponse("Invalid query", invalidRequestSchema),
      401: jsonResponse("Sign-in required", unauthorizedSchema),
      403: jsonResponse("Owner/admin permission required or Gateway management disabled", z.union([forbiddenSchema, gatewayManagementUnavailableSchema])),
      422: jsonResponse("Usage cannot be represented safely", z.object({ error: z.string(), message: z.string() })),
    },
  }), orgMemberRoute(), queryValidator(querySchema), async (c) => {
    const permission = ensureOrganizationAdminRole(c, "Only workspace owners and admins can read organization Gateway usage.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    const unavailable = gatewayManagementUnavailable()
    if (unavailable) return c.json(unavailable, 403)
    c.header("cache-control", "no-store")
    try {
      return c.json(await readGatewayUsage(c.get("organizationContext").organization.id, c.req.valid("query")))
    } catch (error) {
      if (error instanceof UsageReadError) return c.json({ error: error.code, message: error.message }, 422)
      throw error
    }
  })
}
