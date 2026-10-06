import { and, count, eq, gte, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AnonymousInferenceUsageTable,
  InferenceFreeUsageBucketTable,
  InferenceFreeUsageTable,
  MemberTable,
  OrganizationTable,
  OrgSubscriptionTable,
} from "@openwork-ee/den-db/schema"
import {
  freeInferenceWindow,
  inferenceSubscribed,
  inferenceSubscriptionLive,
  INFERENCE_USAGE_CONVERSION_FACTOR,
} from "@openwork/types/den/inference"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const DAY_MS = 86_400_000
/** Organizations listed in full; the rest are summed into one row so totals always add up. */
export const FREE_AUTO_USAGE_ORGANIZATION_LIMIT = 200

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })

const usageSchema = z.object({
  costMicroUsd: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  estimatedRequests: z.number().int().nonnegative().describe("Requests charged the fixed estimate because OpenAI reported no usage."),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})

const organizationSchema = usageSchema.extend({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  subscribed: z.boolean().describe("Pays for OpenWork Models, so its members use paid Models rather than free Auto."),
  memberCount: z.number().int().nonnegative(),
  activePeople: z.number().int().nonnegative(),
  peopleAtWeeklyLimit: z.number().int().nonnegative().describe("People in this organization who used free Auto this week and have reached their weekly allowance."),
  lastUsedAt: z.string().datetime().nullable(),
})

export const freeAutoUsageResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  range: z.object({ days: z.number().int(), from: z.string().datetime(), to: z.string().datetime(), timezone: z.literal("UTC") }),
  settings: z.object({
    membersEnabled: z.boolean(),
    weeklyLimitMicroUsd: z.number().int().nonnegative(),
  }),
  totals: usageSchema.extend({ activePeople: z.number().int().nonnegative(), activeOrganizations: z.number().int().nonnegative() }),
  members: usageSchema.extend({ activePeople: z.number().int().nonnegative() }),
  guests: usageSchema,
  week: z.object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    activePeople: z.number().int().nonnegative(),
    peopleAtWeeklyLimit: z.number().int().nonnegative(),
  }),
  daily: z.array(z.object({
    date: z.string(),
    membersMicroUsd: z.number().int().nonnegative(),
    guestsMicroUsd: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
  })),
  organizations: z.array(organizationSchema),
  otherOrganizations: usageSchema.extend({ organizations: z.number().int().nonnegative() }).nullable()
    .describe("Organizations past the listed limit, summed so the table always adds up to the members total."),
}).meta({ ref: "AdminFreeAutoUsageResponse" })

export type FreeAutoUsageReport = z.infer<typeof freeAutoUsageResponseSchema>
type Usage = z.infer<typeof usageSchema>

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("free_auto_usage_invalid_totals")
  return parsed
}
/** Allowance amounts are stored at INFERENCE_USAGE_CONVERSION_FACTOR units per USD; reports use micro-USD. */
function microUsd(amount: number): number {
  return Math.round(amount * 1_000_000 / INFERENCE_USAGE_CONVERSION_FACTOR)
}
function emptyUsage(): Usage {
  return { costMicroUsd: 0, requests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0 }
}
function addUsage(target: Usage, source: Usage) {
  target.costMicroUsd += source.costMicroUsd
  target.requests += source.requests
  target.estimatedRequests += source.estimatedRequests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
}
/** The driver returns an aggregated TIMESTAMP as a Date or as a "YYYY-MM-DD HH:MM:SS" string. */
function timestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value !== "string" || !value) return null
  const parsed = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}
function utcDayStart(time: number) {
  return Math.floor(time / DAY_MS) * DAY_MS
}

/**
 * Free Auto usage across all of OpenWork Cloud: members per organization and guests in aggregate.
 * Guests have no organization or account, so they are only ever reported as totals.
 */
export async function readFreeAutoUsage(input: { days: number; now?: Date }): Promise<FreeAutoUsageReport> {
  const now = input.now ?? new Date()
  const from = new Date(utcDayStart(now.getTime()) - (input.days - 1) * DAY_MS)
  const week = freeInferenceWindow(now)
  const members = InferenceFreeUsageTable
  const guests = AnonymousInferenceUsageTable
  // UNIX_TIMESTAMP on a TIMESTAMP column is UTC whatever the session time zone is.
  const memberDay = sql<number>`floor(unix_timestamp(${members.created_at}) / 86400)`
  const guestDay = sql<number>`floor(unix_timestamp(${guests.created_at}) / 86400)`
  const usageColumns = (table: typeof members | typeof guests) => ({
    requests: count(),
    estimatedRequests: sql<number>`coalesce(sum(case when ${table.estimated} then 1 else 0 end), 0)`,
    inputTokens: sql<number>`coalesce(sum(${table.input_tokens}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${table.output_tokens}), 0)`,
    amount: sql<number>`coalesce(sum(${table.amount}), 0)`,
  })
  const readUsage = (row: { requests: unknown; estimatedRequests: unknown; inputTokens: unknown; outputTokens: unknown; amount: unknown }): Usage => ({
    costMicroUsd: microUsd(number(row.amount)), requests: number(row.requests), estimatedRequests: number(row.estimatedRequests),
    inputTokens: number(row.inputTokens), outputTokens: number(row.outputTokens),
  })

  const [memberDaily, guestDaily, perOrganization, peopleTotals, weekPeople, weekAtLimit] = await Promise.all([
    db.select({ day: memberDay, ...usageColumns(members) }).from(members).where(gte(members.created_at, from)).groupBy(memberDay),
    db.select({ day: guestDay, ...usageColumns(guests) }).from(guests).where(gte(guests.created_at, from)).groupBy(guestDay),
    db.select({
      organizationId: members.organization_id, ...usageColumns(members),
      activePeople: sql<number>`count(distinct ${members.principal_hash})`,
      lastUsedAt: sql<Date | string | null>`max(${members.created_at})`,
    }).from(members).where(gte(members.created_at, from)).groupBy(members.organization_id),
    db.select({ activePeople: sql<number>`count(distinct ${members.principal_hash})` }).from(members).where(gte(members.created_at, from)),
    db.select({ activePeople: sql<number>`count(distinct ${members.principal_hash})` }).from(members).where(gte(members.created_at, week.start)),
    // The weekly allowance is per person across organizations; count a person against each organization they used this week.
    db.selectDistinct({ organizationId: members.organization_id, principalHash: members.principal_hash }).from(members)
      .innerJoin(InferenceFreeUsageBucketTable, and(
        eq(InferenceFreeUsageBucketTable.identity_hash, members.principal_hash),
        eq(InferenceFreeUsageBucketTable.window_start_at, week.start),
        sql`${InferenceFreeUsageBucketTable.used_amount} >= ${InferenceFreeUsageBucketTable.limit_amount}`,
      ))
      .where(gte(members.created_at, week.start)),
  ])

  const daily = new Map<number, { membersMicroUsd: number; guestsMicroUsd: number; requests: number }>()
  for (let day = utcDayStart(from.getTime()); day <= utcDayStart(now.getTime()); day += DAY_MS) {
    daily.set(day / DAY_MS, { membersMicroUsd: 0, guestsMicroUsd: 0, requests: 0 })
  }
  const memberUsage = emptyUsage(), guestUsage = emptyUsage()
  for (const row of memberDaily) {
    const usage = readUsage(row)
    addUsage(memberUsage, usage)
    const entry = daily.get(number(row.day))
    if (entry) { entry.membersMicroUsd += usage.costMicroUsd; entry.requests += usage.requests }
  }
  for (const row of guestDaily) {
    const usage = readUsage(row)
    addUsage(guestUsage, usage)
    const entry = daily.get(number(row.day))
    if (entry) { entry.guestsMicroUsd += usage.costMicroUsd; entry.requests += usage.requests }
  }

  const atLimitByOrganization = new Map<string, number>()
  const peopleAtLimit = new Set<string>()
  for (const row of weekAtLimit) {
    atLimitByOrganization.set(row.organizationId, (atLimitByOrganization.get(row.organizationId) ?? 0) + 1)
    peopleAtLimit.add(row.principalHash)
  }

  const usageByOrganization = new Map(perOrganization.map((row) => [row.organizationId as string, row]))
  const ranked = [...perOrganization]
    .map((row) => ({ id: row.organizationId as string, costMicroUsd: microUsd(number(row.amount)), requests: number(row.requests) }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.requests - a.requests || a.id.localeCompare(b.id))
  const listedIds = ranked.map((row) => row.id).slice(0, FREE_AUTO_USAGE_ORGANIZATION_LIMIT)
  const listed = new Set(listedIds)

  const [organizations, memberCounts, liveSubscriptions] = listedIds.length ? await Promise.all([
    db.select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug, metadata: OrganizationTable.metadata })
      .from(OrganizationTable).where(inArray(OrganizationTable.id, listedIds as (typeof OrganizationTable.$inferSelect.id)[])),
    db.select({ organizationId: MemberTable.organizationId, members: count() }).from(MemberTable)
      .where(and(inArray(MemberTable.organizationId, listedIds as (typeof MemberTable.$inferSelect.organizationId)[]), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt)))
      .groupBy(MemberTable.organizationId),
    db.select({ organizationId: OrgSubscriptionTable.organization_id, status: OrgSubscriptionTable.status }).from(OrgSubscriptionTable)
      .where(and(inArray(OrgSubscriptionTable.organization_id, listedIds as (typeof OrgSubscriptionTable.$inferSelect.organization_id)[]), eq(OrgSubscriptionTable.type, "inference"))),
  ]) : [[], [], []]
  const memberCountById = new Map(memberCounts.map((row) => [row.organizationId as string, number(row.members)]))
  const paying = new Set(liveSubscriptions.filter((row) => inferenceSubscriptionLive(row.status)).map((row) => row.organizationId as string))

  const organizationRows = organizations.map((organization) => {
    const id = organization.id as string
    const row = usageByOrganization.get(id)
    return {
      id, name: organization.name, slug: organization.slug ?? null,
      subscribed: inferenceSubscribed(organization.metadata) || paying.has(id),
      memberCount: memberCountById.get(id) ?? 0,
      activePeople: row ? number(row.activePeople) : 0,
      peopleAtWeeklyLimit: atLimitByOrganization.get(id) ?? 0,
      lastUsedAt: timestamp(row?.lastUsedAt),
      ...(row ? readUsage(row) : emptyUsage()),
    }
  }).sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.requests - a.requests || a.name.localeCompare(b.name))

  const unlisted = perOrganization.filter((row) => !listed.has(row.organizationId as string))
  const otherOrganizations = unlisted.length ? unlisted.reduce((total, row) => {
    addUsage(total, readUsage(row))
    total.organizations += 1
    return total
  }, { ...emptyUsage(), organizations: 0 }) : null

  const totals = { ...emptyUsage(), activePeople: number(peopleTotals[0]?.activePeople), activeOrganizations: perOrganization.length }
  addUsage(totals, memberUsage)
  addUsage(totals, guestUsage)

  return {
    generatedAt: now.toISOString(),
    range: { days: input.days, from: from.toISOString(), to: now.toISOString(), timezone: "UTC" },
    settings: {
      membersEnabled: env.inferenceFree.enabled,
      weeklyLimitMicroUsd: microUsd(env.inferenceFree.weeklyLimitAmount),
    },
    totals,
    members: { ...memberUsage, activePeople: totals.activePeople },
    guests: guestUsage,
    week: { startsAt: week.start.toISOString(), endsAt: week.end.toISOString(), activePeople: number(weekPeople[0]?.activePeople), peopleAtWeeklyLimit: peopleAtLimit.size },
    daily: [...daily.entries()].map(([day, entry]) => ({ date: new Date(day * DAY_MS).toISOString().slice(0, 10), ...entry })),
    organizations: organizationRows,
    otherOrganizations,
  }
}

export function registerAdminFreeAutoUsageRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/admin/free-auto/usage",
    describeRoute({
      tags: ["Admin"],
      summary: "Get free Auto usage across all organizations",
      description: "Returns free Auto usage for the last `days` UTC days: platform totals, members and guests, a daily series, this week's allowance pressure, and usage per organization. Guests are reported only in aggregate.",
      responses: {
        200: jsonResponse("Free Auto usage returned.", freeAutoUsageResponseSchema),
        400: jsonResponse("The query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
        403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
      },
    }),
    adminRoute(),
    queryValidator(querySchema),
    async (c) => c.json(await readFreeAutoUsage({ days: c.req.valid("query").days }), 200, { "cache-control": "no-store" }),
  )
}
