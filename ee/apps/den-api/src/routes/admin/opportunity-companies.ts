import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "@openwork-ee/den-db/drizzle"
import { AccountFollowUpTable, AuthSessionTable, AuthUserTable, MemberTable, OrgSubscriptionTable, OrganizationTable, TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { adminSignupCompaniesSchema } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { normalizeAdminPageRequest, sanitizeAdminSearchForLike, ADMIN_MAX_PAGE_OFFSET } from "./scale-performance.js"
import { companyDomainSql, contactedSql, payingSql } from "./opportunity-signals.js"

const DAY = 86_400_000
const PLANS = ["free", "team", "enterprise"] as const

function companyScope(input: { activity: string; outreach: string; billing: string; sort: string; search?: string }) {
  return JSON.stringify([input.activity, input.outreach, input.billing, input.sort, input.search?.trim().toLowerCase() ?? ""])
}

// Grouped rows have no stable key to seek from, so the opaque cursor carries the
// next position together with the filters it belongs to.
const cursorSchema = z.string().min(1).max(1024).transform((value, context) => {
  let payload: unknown
  try { payload = /^[A-Za-z0-9_-]+$/.test(value) ? JSON.parse(Buffer.from(value, "base64url").toString("utf8")) : null } catch { payload = null }
  const parsed = z.object({ position: z.number().int().nonnegative().max(ADMIN_MAX_PAGE_OFFSET), scope: z.string().max(512) }).safeParse(payload)
  if (parsed.success) return parsed.data
  context.addIssue({ code: "custom", message: "Invalid company cursor." })
  return z.NEVER
}).meta({ description: "Opaque nextCursor from the preceding page. Keep the same filters and sort; omit for the first page." })

const querySchema = z.object({
  activity: z.enum(["active", "all"]).default("active").meta({ description: "active keeps companies with at least one person observed using the app in the last 30 days." }),
  outreach: z.enum(["not_contacted", "contacted", "any"]).default("not_contacted"),
  billing: z.enum(["any", "paying", "not_paying"]).default("any"),
  sort: z.enum(["active", "signups", "recent", "signin"]).default("active"),
  search: z.string().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).meta({ description: "Maximum companies per page, from 1 to 100. Defaults to 50." }),
  cursor: cursorSchema.optional(),
  offset: z.string().optional().meta({ deprecated: true, description: "Compatibility for numbered admin pages. Use cursor for continued traversal; do not combine with cursor." }),
}).refine(input => !input.cursor || (input.offset === undefined && input.cursor.scope === companyScope(input)), {
  path: ["cursor"], message: "Keep the cursor's filters and sort unchanged, and do not combine cursor with offset.",
})

/**
 * Signups grouped by verified company email domain across every organization
 * those people joined. A domain is a signal, not proof of employment; the
 * organizations themselves are never merged. No external enrichment.
 */
export async function readAdminSignupCompanies(input: z.infer<typeof querySchema>, now = new Date()) {
  const request = normalizeAdminPageRequest({ ...input, offset: input.cursor ? String(input.cursor.position) : input.offset, limit: String(input.limit) })
  const from = new Date(now.getTime() - 30 * DAY)
  const domain = companyDomainSql()
  const people = db.$with("company_people").as(db.select({
    userId: sql<string>`${AuthUserTable.id}`.as("person_id"), domain: sql<string>`${domain}`.as("company_domain"),
    signedUpMs: sql<number>`unix_timestamp(${AuthUserTable.createdAt}) * 1000`.as("signed_up_ms"),
    // Sessions are the latest sign-in still on record; expired sessions may be gone.
    // Qualified by hand: a single-table CTE renders its columns without the table name.
    lastSignInMs: sql<number | null>`(select unix_timestamp(max(${sql.identifier("session")}.${sql.identifier("created_at")})) * 1000 from ${AuthSessionTable}
      where ${sql.identifier("session")}.${sql.identifier("user_id")} = ${sql.identifier("user")}.${sql.identifier("id")})`.as("last_sign_in_ms"),
  }).from(AuthUserTable).where(and(sql`${domain} is not null`, lte(AuthUserTable.createdAt, now))))
  const memberships = db.$with("company_memberships").as(db.select({
    domain: sql<string>`${people.domain}`.as("membership_domain"), organizationId: MemberTable.organizationId, userId: MemberTable.userId,
    active: sql<number>`exists(select 1 from ${TelemetryEventTable} where ${TelemetryEventTable.member_id} = ${MemberTable.id}
      and ${TelemetryEventTable.org_id} = ${MemberTable.organizationId} and ${gte(TelemetryEventTable.event_timestamp, from)}
      and ${lte(TelemetryEventTable.event_timestamp, now)} and ${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt})`.as("active"),
    planRank: sql<number>`case json_unquote(json_extract(${OrganizationTable.metadata}, '$.plan.tier')) when 'enterprise' then 2 when 'team' then 1 else 0 end`.as("plan_rank"),
    paying: payingSql(MemberTable.organizationId, now).as("paying"),
    modelsAddOn: sql<number>`exists(select 1 from ${OrgSubscriptionTable} where ${OrgSubscriptionTable.organization_id} = ${MemberTable.organizationId}
      and ${OrgSubscriptionTable.type} = 'inference' and ${OrgSubscriptionTable.status} in ('active', 'trialing')
      and (${OrgSubscriptionTable.current_period_end} is null or ${OrgSubscriptionTable.current_period_end} >= ${now}))`.as("models_add_on"),
    contacted: contactedSql(MemberTable.organizationId).as("contacted"),
    lastContactedMs: sql<number | null>`(select unix_timestamp(${AccountFollowUpTable.lastContactedAt}) * 1000 from ${AccountFollowUpTable}
      where ${AccountFollowUpTable.organizationId} = ${MemberTable.organizationId})`.as("last_contacted_ms"),
  }).from(MemberTable).innerJoin(people, eq(people.userId, MemberTable.userId))
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), lte(MemberTable.joinedAt, now), eq(MemberTable.isSetupAgent, false))))
  const signups = db.$with("company_signups").as(db.select({
    domain: sql<string>`${people.domain}`.as("signup_domain"), signups: sql<number>`count(*)`.as("signups"),
    firstMs: sql<number>`min(${people.signedUpMs})`.as("first_ms"), lastSignInMs: sql<number | null>`max(${people.lastSignInMs})`.as("company_last_sign_in_ms"),
  }).from(people).groupBy(people.domain))
  const usage = db.$with("company_usage").as(db.select({
    domain: sql<string>`${memberships.domain}`.as("usage_domain"),
    organizations: sql<number>`count(distinct ${memberships.organizationId})`.as("organizations"),
    activeUsers: sql<number>`count(distinct case when ${memberships.active} then ${memberships.userId} end)`.as("active_users"),
    planRank: sql<number>`max(${memberships.planRank})`.as("company_plan_rank"),
    paying: sql<number>`max(${memberships.paying})`.as("company_paying"),
    modelsAddOn: sql<number>`max(${memberships.modelsAddOn})`.as("company_models_add_on"),
    contacted: sql<number>`max(${memberships.contacted})`.as("company_contacted"),
    lastContactedMs: sql<number | null>`max(${memberships.lastContactedMs})`.as("company_last_contacted_ms"),
  }).from(memberships).groupBy(memberships.domain))
  const activeUsers = sql<number>`coalesce(${usage.activeUsers}, 0)`
  const pattern = `%${sanitizeAdminSearchForLike(request.search)}%`
  const filter = and(
    input.activity === "active" ? sql`${activeUsers} > 0` : undefined,
    input.outreach === "any" ? undefined : input.outreach === "contacted" ? sql`coalesce(${usage.contacted}, 0) = 1` : sql`coalesce(${usage.contacted}, 0) = 0`,
    input.billing === "any" ? undefined : input.billing === "paying" ? sql`coalesce(${usage.paying}, 0) = 1` : sql`coalesce(${usage.paying}, 0) = 0`,
    request.search ? sql`${signups.domain} like ${pattern} escape '|'` : undefined,
  )
  const lastSignIn = sql`coalesce(${signups.lastSignInMs}, 0)`
  const order = input.sort === "signups" ? [desc(signups.signups), desc(activeUsers)]
    : input.sort === "recent" ? [desc(signups.firstMs)]
    : input.sort === "signin" ? [desc(lastSignIn)]
    : [desc(activeUsers), desc(signups.signups)]
  const base = () => db.with(people, memberships, signups, usage)
  const [rows, totals] = await Promise.all([
    base().select({
      domain: signups.domain, signups: signups.signups, firstMs: signups.firstMs, lastSignInMs: signups.lastSignInMs,
      organizations: sql<number>`coalesce(${usage.organizations}, 0)`, activeUsers,
      planRank: sql<number>`coalesce(${usage.planRank}, 0)`, paying: sql<number>`coalesce(${usage.paying}, 0)`,
      modelsAddOn: sql<number>`coalesce(${usage.modelsAddOn}, 0)`, contacted: sql<number>`coalesce(${usage.contacted}, 0)`,
      lastContactedMs: usage.lastContactedMs,
    }).from(signups).leftJoin(usage, eq(usage.domain, signups.domain)).where(filter)
      .orderBy(...order, desc(lastSignIn), asc(signups.domain)).limit(request.limit + 1).offset(request.offset),
    base().select({ total: sql<number>`count(*)` }).from(signups).leftJoin(usage, eq(usage.domain, signups.domain)).where(filter),
  ])
  const visible = rows.slice(0, request.limit)
  const workspaces = await readCompanyWorkspaces(visible.map(row => row.domain), now)
  const hasMore = rows.length > request.limit && request.offset + request.limit <= ADMIN_MAX_PAGE_OFFSET
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({ position: request.offset + request.limit, scope: companyScope(input) }), "utf8").toString("base64url") : null
  const date = (value: number | null) => value === null || value === undefined ? null : new Date(Number(value)).toISOString()
  return {
    from: from.toISOString(), to: now.toISOString(), generatedAt: now.toISOString(), nextCursor,
    companies: visible.map(row => ({
      domain: row.domain, signups: Number(row.signups), organizations: Number(row.organizations), activeUsers: Number(row.activeUsers),
      firstSignupAt: new Date(Number(row.firstMs)).toISOString(), lastSignInAt: date(row.lastSignInMs),
      billing: { plan: PLANS[Number(row.planRank)] ?? "free", paying: Number(row.paying) === 1, modelsAddOn: Number(row.modelsAddOn) === 1 },
      outreach: { status: Number(row.contacted) === 1 ? "contacted" as const : "not_contacted" as const, lastContactedAt: date(row.lastContactedMs) },
      workspaces: workspaces.get(row.domain) ?? [],
    })),
    page: {
      limit: request.limit, total: Number(totals[0]?.total ?? 0), returned: visible.length,
      hasMore,
    },
  }
}

/** The three organizations with the most people from each company domain. */
async function readCompanyWorkspaces(domains: string[], now: Date) {
  const workspaces = new Map<string, { id: string, name: string, members: number }[]>()
  if (!domains.length) return workspaces
  const domain = companyDomainSql()
  const rows = await db.select({
    domain: sql<string>`${domain}`, id: OrganizationTable.id, name: OrganizationTable.name, members: sql<number>`count(distinct ${MemberTable.userId})`,
  }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(inArray(sql`${domain}`, domains), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), lte(MemberTable.joinedAt, now), eq(MemberTable.isSetupAgent, false)))
    .groupBy(sql`${domain}`, OrganizationTable.id, OrganizationTable.name)
    .orderBy(desc(sql`count(distinct ${MemberTable.userId})`), asc(OrganizationTable.id))
  for (const row of rows) {
    const list = workspaces.get(row.domain) ?? []
    if (list.length < 3) list.push({ id: row.id, name: row.name, members: Number(row.members) })
    workspaces.set(row.domain, list)
  }
  return workspaces
}

export function registerAdminSignupCompaniesRoute<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/opportunities/companies", describeRoute({
    tags: ["Admin"], summary: "Group signups by company email domain",
    description: "Platform-admin-only, paginated. Groups accounts with a verified, non-personal email domain across every organization they joined: signups, first signup, latest sign-in still on record, organizations, people observed using the app in the last 30 days, highest stored plan, current paid subscription, and whether a platform admin recorded outreach for any of those organizations. Defaults to active companies nobody has contacted. A domain does not establish employment and organizations are never merged. No content, credentials, Stripe calls or external enrichment.",
    responses: { 200: jsonResponse("Signup companies returned.", adminSignupCompaniesSchema),
      400: jsonResponse("Invalid report filters.", invalidRequestSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), queryValidator(querySchema), async c => {
    c.header("Cache-Control", "no-store")
    return c.json(await readAdminSignupCompanies(c.req.valid("query")))
  })
}
