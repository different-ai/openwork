import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, ConfigObjectTable, MemberTable, OrganizationTable, TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { adminOpportunitiesSchema, adminOpportunityOverviewSchema } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { ADMIN_MAX_PAGE_OFFSET, normalizeAdminPageRequest, sanitizeAdminSearchForLike } from "./scale-performance.js"
import { registerAdminOpportunityAccountRoutes } from "./opportunity-accounts.js"
import { readAdminOpportunityOverview } from "./opportunity-overview.js"
import { registerAdminSignupCompaniesRoute } from "./opportunity-companies.js"
import { DEFAULT_SIGNALS, companyDomainSql, contactedSql, readOrganizationSignals } from "./opportunity-signals.js"

function opportunityScope(input: { days: string; minMembers: string; companyEmail: string; setup: string; outreach: string; sort: string; search?: string }) {
  return JSON.stringify([input.days, input.minMembers, input.companyEmail, input.setup, input.outreach, input.sort, input.search?.trim().toLowerCase() ?? ""])
}

const cursorPayloadSchema = z.object({
  value: z.number().int().nonnegative().safe(), at: z.number().int().positive().safe(),
  id: denTypeIdSchema("organization"), scope: z.string().max(512),
})
const cursorQuerySchema = z.string().min(1).max(1024).transform((value, context) => {
  let payload: unknown
  try { payload = /^[A-Za-z0-9_-]+$/.test(value) ? JSON.parse(Buffer.from(value, "base64url").toString("utf8")) : null } catch { payload = null }
  const parsed = cursorPayloadSchema.safeParse(payload)
  if (parsed.success) return parsed.data
  context.addIssue({ code: "custom", message: "Invalid opportunity cursor." })
  return z.NEVER
}).meta({ description: "Opaque nextCursor from the preceding page. Keep the same filters and sort; omit for the first page." })

const querySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30"),
  minMembers: z.enum(["1", "2", "5", "10"]).default("2"),
  companyEmail: z.enum(["0", "1"]).default("0"),
  setup: z.enum(["any", "skills", "mcp", "both"]).default("any"),
  outreach: z.enum(["any", "not_contacted", "contacted"]).default("any").meta({ description: "Whether a platform admin recorded outreach, a reply or a meeting for the organization." }),
  sort: z.enum(["recent", "active", "members"]).default("recent"),
  search: z.string().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).meta({ description: "Maximum organizations per page, from 1 to 100. Defaults to 50." }),
  cursor: cursorQuerySchema.optional(),
  offset: z.string().optional().meta({ deprecated: true, description: "Compatibility for numbered admin pages. Use cursor for continued traversal; do not combine with cursor." }),
}).refine(input => !input.cursor || (input.offset === undefined && input.cursor.scope === opportunityScope(input)), {
  path: ["cursor"], message: "Keep the cursor's filters and sort unchanged, and do not combine cursor with offset.",
})

export async function readAdminOpportunities(input: z.infer<typeof querySchema>, now = new Date()) {
  const request = normalizeAdminPageRequest({ ...input, limit: String(input.limit) })
  const from = new Date(now.getTime() - Number(input.days) * 86_400_000)
  const companyDomain = companyDomainSql()
  // Look up each current person's activity through telemetry_event_member_ts.
  // Sign-in timestamps and activity in another organization are not app usage
  // here. Missing/disabled telemetry stays unobserved, never guessed from login.
  const people = db.$with("opportunity_people").as(db.select({
    organizationId: MemberTable.organizationId, userId: MemberTable.userId,
    companyDomain: companyDomain.as("company_domain"),
    lastActiveMs: sql<number | null>`(select unix_timestamp(max(${TelemetryEventTable.event_timestamp})) * 1000
      from ${TelemetryEventTable} where ${TelemetryEventTable.member_id} = ${MemberTable.id}
      and ${TelemetryEventTable.org_id} = ${MemberTable.organizationId}
      and ${gte(TelemetryEventTable.event_timestamp, from)} and ${lte(TelemetryEventTable.event_timestamp, now)}
      and ${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt})`.as("last_active_ms"),
  }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), lte(MemberTable.joinedAt, now), eq(MemberTable.isSetupAgent, false))))
  const teams = db.$with("opportunity_teams").as(db.select({
    organizationId: people.organizationId,
    members: sql<number>`count(distinct ${people.userId})`.as("members"),
    activeMembers: sql<number>`count(distinct case when ${people.lastActiveMs} is not null then ${people.userId} end)`.as("active_members"),
    lastActiveMs: sql<number>`max(${people.lastActiveMs})`.as("last_active_ms"),
    companyEmailMembers: sql<number>`count(distinct case when ${people.companyDomain} is not null then ${people.userId} end)`.as("company_email_members"),
    companyDomain: sql<string | null>`min(${people.companyDomain})`.as("company_domain"),
    companyDomainCount: sql<number>`count(distinct ${people.companyDomain})`.as("company_domain_count"),
    domainSearch: sql<number>`max(case when ${people.companyDomain} like ${`%${sanitizeAdminSearchForLike(request.search)}%`} escape '|' then 1 else 0 end)`.as("domain_search"),
  }).from(people).groupBy(people.organizationId))
  // Count metadata only. Never read skill text, MCP addresses or credentials.
  const setup = db.$with("opportunity_setup").as(db.select({
    organizationId: ConfigObjectTable.organizationId,
    skills: sql<number>`sum(case when ${ConfigObjectTable.objectType} = 'skill' then 1 else 0 end)`.as("skills"),
    mcpConnections: sql<number>`sum(case when ${ConfigObjectTable.objectType} = 'mcp' then 1 else 0 end)`.as("mcp_connections"),
  }).from(ConfigObjectTable).where(and(eq(ConfigObjectTable.status, "active"), isNull(ConfigObjectTable.deletedAt)))
    .groupBy(ConfigObjectTable.organizationId))
  const skills = sql<number>`coalesce(${setup.skills}, 0)`
  const mcpConnections = sql<number>`coalesce(${setup.mcpConnections}, 0)`
  const pattern = `%${sanitizeAdminSearchForLike(request.search)}%`
  const filter = and(
    gte(teams.members, Number(input.minMembers)), isNotNull(teams.lastActiveMs),
    input.companyEmail === "1" ? gte(teams.companyEmailMembers, 1) : undefined,
    input.setup === "skills" || input.setup === "both" ? sql`${skills} > 0` : undefined,
    input.setup === "mcp" || input.setup === "both" ? sql`${mcpConnections} > 0` : undefined,
    input.outreach === "any" ? undefined : input.outreach === "contacted" ? contactedSql(OrganizationTable.id) : sql`not ${contactedSql(OrganizationTable.id)}`,
    request.search ? sql`(lower(${OrganizationTable.name}) like ${pattern} escape '|'
      or lower(${OrganizationTable.slug}) like ${pattern} escape '|' or ${teams.domainSearch} = 1)` : undefined,
  )
  const primary = input.sort === "members" ? teams.members : input.sort === "active" ? teams.activeMembers : teams.lastActiveMs
  const after = input.cursor ? or(
    lt(primary, input.cursor.value),
    and(eq(primary, input.cursor.value), lt(teams.lastActiveMs, input.cursor.at)),
    and(eq(primary, input.cursor.value), eq(teams.lastActiveMs, input.cursor.at), gt(OrganizationTable.id, input.cursor.id)),
  ) : undefined
  const base = () => db.with(people, teams, setup)
  const [rows, totals] = await Promise.all([
    base().select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug,
      members: teams.members, activeMembers: teams.activeMembers, lastActiveMs: teams.lastActiveMs,
      companyEmailMembers: teams.companyEmailMembers, companyDomain: teams.companyDomain, companyDomainCount: teams.companyDomainCount,
      skills, mcpConnections,
    }).from(teams).innerJoin(OrganizationTable, eq(OrganizationTable.id, teams.organizationId))
      .leftJoin(setup, eq(setup.organizationId, teams.organizationId)).where(and(filter, after))
      .orderBy(desc(primary), desc(teams.lastActiveMs), asc(OrganizationTable.id)).limit(request.limit + 1).offset(request.offset),
    base().select({ total: sql<number>`count(*)` }).from(teams).innerJoin(OrganizationTable, eq(OrganizationTable.id, teams.organizationId))
      .leftJoin(setup, eq(setup.organizationId, teams.organizationId)).where(filter),
  ])
  const total = Number(totals[0]?.total ?? 0)
  const visible = rows.slice(0, request.limit)
  const last = visible.at(-1)
  const hasMore = rows.length > request.limit && (input.cursor !== undefined || request.offset < ADMIN_MAX_PAGE_OFFSET)
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    value: Number(input.sort === "members" ? last.members : input.sort === "active" ? last.activeMembers : last.lastActiveMs),
    at: Number(last.lastActiveMs), id: last.id, scope: opportunityScope(input),
  }), "utf8").toString("base64url") : null
  const signals = await readOrganizationSignals(visible.map(row => row.id), now)
  return {
    from: from.toISOString(), to: now.toISOString(), generatedAt: now.toISOString(),
    nextCursor,
    organizations: visible.map(({ lastActiveMs, ...row }) => ({ ...row, ...(signals.get(row.id) ?? DEFAULT_SIGNALS), members: Number(row.members), activeMembers: Number(row.activeMembers),
      companyEmailMembers: Number(row.companyEmailMembers), companyDomainCount: Number(row.companyDomainCount),
      skills: Number(row.skills), mcpConnections: Number(row.mcpConnections), lastActiveAt: new Date(Number(lastActiveMs)).toISOString(),
    })),
    page: { limit: request.limit, total, returned: visible.length, hasMore },
  }
}

export function registerAdminOpportunitiesRoute<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/opportunities/overview", describeRoute({
    tags: ["Admin"], summary: "Get this week's actionable platform activity",
    description: "Platform-admin-only Monday-to-now UTC summary compared with the same elapsed period last week. Counts registered accounts, current joined human memberships and organization-scoped observed telemetry. Returns daily signup and membership counts, at most eight records per signal list, and a prioritized queue built from transparent, dated signals and recorded internal follow-ups. Missing telemetry does not establish inactivity or service health. No emails, content, credentials or external enrichment.",
    responses: { 200: jsonResponse("Weekly opportunity overview returned.", adminOpportunityOverviewSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), async c => {
    c.header("Cache-Control", "no-store")
    return c.json(await readAdminOpportunityOverview())
  })
  registerAdminOpportunityAccountRoutes(app)
  registerAdminSignupCompaniesRoute(app)
  // Internal platform-admin reporting, not an organization product entitlement.
  app.get("/v1/admin/opportunities", describeRoute({
    tags: ["Admin"], summary: "Find organizations with observed app adoption",
    description: "Platform-admin-only, server-paginated organization signals. Defaults to two joined human users and observed organization-scoped telemetry in the last 30 days, most recent first. Company-email signals use verified addresses excluding known personal providers; they do not establish employment. Cloud setup counts active, non-deleted skill and MCP metadata. Billing is the stored plan tier and recorded subscription status; outreach is what platform admins recorded. Missing telemetry does not imply inactivity. No content, credentials, Stripe calls or external enrichment.",
    responses: { 200: jsonResponse("Organization opportunities returned.", adminOpportunitiesSchema),
      400: jsonResponse("Invalid report filters.", invalidRequestSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), queryValidator(querySchema), async c => {
    c.header("Cache-Control", "no-store")
    return c.json(await readAdminOpportunities(c.req.valid("query")))
  })
}
