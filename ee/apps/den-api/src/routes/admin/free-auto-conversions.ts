import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable as User, FreeAutoLimitEventTable as Limit, FreeAutoPurchaseTable as Purchase } from "@openwork-ee/den-db/schema"
import { adminFreeAutoConversionsSchema, freeAutoConversionStageSchema } from "@openwork/types/den/admin-free-auto"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const DAY = 86_400_000
const querySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30),
  page: z.coerce.number().int().min(1).max(2001).default(1), search: z.string().trim().max(160).default(""), stage: freeAutoConversionStageSchema.default("all") })

function time(value: Date | string | null): string | null {
  if (value === null) return null
  return (value instanceof Date ? value : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`)).toISOString()
}

/** Counts in SQL; only one bounded page of account identities leaves the database. */
export async function readFreeAutoConversions(input: z.infer<typeof querySchema>, now = new Date()) {
  const start = Math.floor(now.getTime() / DAY) * DAY - (input.days - 1) * DAY
  const from = new Date(start)
  const facts = db.$with("free_auto_conversion_facts").as(db.select({
    cohort: sql<string>`coalesce(${Limit.user_id}, concat('guest:', ${Limit.subject_hash}))`.as("cohort"),
    id: Limit.id, userId: Limit.user_id, name: User.name, email: User.email, exhaustedAt: Limit.exhausted_at,
    guest: sql<number>`case when ${Limit.audience} = 'guest' then 1 else 0 end`.as("guest"),
    signedInAt: Limit.authenticated_at,
    signedUpAt: sql<Date | string | null>`case when ${Limit.audience} = 'guest' and ${User.createdAt} > ${Limit.exhausted_at}
      and ${User.createdAt} <= ${Limit.authenticated_at} then ${User.createdAt} end`.as("signed_up_at"),
    subscribedAt: Purchase.paid_at,
  }).from(Limit).leftJoin(User, eq(User.id, Limit.user_id)).leftJoin(Purchase, and(eq(Purchase.user_id, Limit.user_id),
    // The payer is the checkout creator, not everyone in the organization. Renewals of a pre-limit subscription cannot convert.
    sql`${Purchase.started_at} > ${Limit.exhausted_at}`, sql`${Purchase.started_at} <= date_add(${Limit.exhausted_at}, interval 30 day)`,
    sql`${Purchase.paid_at} >= ${Purchase.started_at}`,
    sql`${Purchase.paid_at} <= date_add(${Limit.exhausted_at}, interval 30 day)`, lte(Purchase.paid_at, now)))
    .where(and(gte(Limit.exhausted_at, from), lte(Limit.exhausted_at, now))))
  const cohorts = db.$with("free_auto_conversion_cohorts").as(db.select({
    id: sql<string>`min(${facts.id})`.as("id"), userId: sql<string | null>`max(${facts.userId})`.as("user_id"),
    name: sql<string | null>`max(${facts.name})`.as("name"), email: sql<string | null>`max(${facts.email})`.as("email"),
    exhaustedAt: sql<Date | string>`min(${facts.exhaustedAt})`.as("exhausted_at"),
    guest: sql<number>`max(${facts.guest})`.as("guest"),
    signedInAt: sql<Date | string | null>`min(${facts.signedInAt})`.as("signed_in_at"),
    signedUpAt: sql<Date | string | null>`min(${facts.signedUpAt})`.as("signed_up_at"),
    subscribedAt: sql<Date | string | null>`min(${facts.subscribedAt})`.as("subscribed_at"),
  }).from(facts).groupBy(facts.cohort))
  const stage = input.stage === "signed-in" ? isNotNull(cohorts.signedInAt)
    : input.stage === "new-account" ? isNotNull(cohorts.signedUpAt)
      : input.stage === "subscribed" ? isNotNull(cohorts.subscribedAt)
        : input.stage === "unlinked" ? isNull(cohorts.userId) : undefined
  // Literal substring search: % and _ in an email must not broaden the result.
  const search = input.search.toLowerCase()
  const filter = and(stage, search ? sql`(locate(${search}, lower(coalesce(${cohorts.name}, ''))) > 0
    or locate(${search}, lower(coalesce(${cohorts.email}, ''))) > 0 or ${cohorts.userId} = ${input.search})` : undefined)
  const counts = {
    reachedLimit: sql<number>`count(*)`, signedIn: sql<number>`count(${cohorts.signedInAt})`,
    newAccounts: sql<number>`count(${cohorts.signedUpAt})`, subscribed: sql<number>`count(${cohorts.subscribedAt})`,
  }
  const day = sql<number>`floor(unix_timestamp(${cohorts.exhaustedAt}) / 86400)`
  const [summary, daily, rows, total, first] = await Promise.all([
    db.with(facts, cohorts).select({ ...counts, unlinkedGuests: sql<number>`sum(case when ${cohorts.userId} is null then 1 else 0 end)` }).from(cohorts),
    db.with(facts, cohorts).select({ day, ...counts }).from(cohorts).groupBy(day).orderBy(asc(day)),
    db.with(facts, cohorts).select().from(cohorts).where(filter).orderBy(desc(cohorts.exhaustedAt), asc(cohorts.id)).limit(50).offset((input.page - 1) * 50),
    db.with(facts, cohorts).select({ total: sql<number>`count(*)` }).from(cohorts).where(filter),
    db.select({ at: Limit.exhausted_at }).from(Limit).orderBy(asc(Limit.exhausted_at)).limit(1),
  ])
  const totals = summary[0]
  const perDay = new Map(daily.map((row) => [new Date(Number(row.day) * DAY).toISOString().slice(0, 10), row]))
  return adminFreeAutoConversionsSchema.parse({
    from: from.toISOString(), to: now.toISOString(), generatedAt: now.toISOString(), attributionDays: 30, firstRecordedAt: time(first[0]?.at ?? null),
    totals: { reachedLimit: Number(totals?.reachedLimit ?? 0), signedIn: Number(totals?.signedIn ?? 0), newAccounts: Number(totals?.newAccounts ?? 0),
      subscribed: Number(totals?.subscribed ?? 0), unlinkedGuests: Number(totals?.unlinkedGuests ?? 0) },
    daily: Array.from({ length: input.days }, (_, index) => {
      const date = new Date(start + index * DAY).toISOString().slice(0, 10), row = perDay.get(date)
      return { date, reachedLimit: Number(row?.reachedLimit ?? 0), signedIn: Number(row?.signedIn ?? 0), newAccounts: Number(row?.newAccounts ?? 0), subscribed: Number(row?.subscribed ?? 0) }
    }),
    rows: rows.map((row) => ({ id: row.id, userId: row.userId, name: row.name, email: row.email, startedAsGuest: Number(row.guest) === 1,
      exhaustedAt: time(row.exhaustedAt), signedInAt: time(row.signedInAt), signedUpAt: time(row.signedUpAt), subscribedAt: time(row.subscribedAt) })),
    page: { page: input.page, pageSize: 50, total: Number(total[0]?.total ?? 0), hasMore: input.page * 50 < Number(total[0]?.total ?? 0) },
  })
}

export function registerAdminFreeAutoConversionsRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/free-auto/conversions", describeRoute({ tags: ["Admin"], summary: "Get observed behavior after the free Auto limit",
    description: "Cohorts by personal-limit observation date, deduplicated by known account or anonymous client-reported journey. Counts subsequent sign-ins, new accounts, and positively paid subscriptions started within 30 days of a limit. Guest links use a random client correlation ID, never IP matching. Historical guest behavior is not backfilled. Search and stage affect the bounded 50-row list, not cohort totals.",
    responses: { 200: jsonResponse("Free Auto conversions returned.", adminFreeAutoConversionsSchema), 400: jsonResponse("Invalid query.", invalidRequestSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), queryValidator(querySchema), async (c) => c.json(await readFreeAutoConversions(c.req.valid("query")), 200, { "cache-control": "no-store" }))
}
