import { and, asc, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable, OrgSubscriptionTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { adminOrganizationDetailSchema, adminOrganizationInsightsSchema, adminOrganizationUsageSchema } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { parseOrganizationPlan } from "../../entitlements.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { DEFAULT_ORGANIZATION_LIMITS, normalizeOrganizationMetadata } from "../../organization-limits.js"
import { getOrganizationPlanStates } from "../../organization-plan-state.js"
import { readAdminOpenWorkWebAccess } from "./openwork-web-access-state.js"
import { getOrganizationPeopleCounts } from "../../stripe-billing.js"
import type { AuthContextVariables } from "../../session.js"
import { readAdminOrganizationInsights, readAdminOrganizationUsage } from "../org/gateway-usage.js"
import { buildAdminPageInfo, normalizeAdminPageRequest, sanitizeAdminSearchForLike, type AdminPageRequest } from "./scale-performance.js"

const querySchema = z.object({ search: z.string().optional(), limit: z.string().optional(), offset: z.string().optional() })

async function organizationDetail(id: typeof OrganizationTable.$inferSelect.id, request: AdminPageRequest) {
  const started = Date.now()
  const [organization] = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug, metadata: OrganizationTable.metadata, createdAt: OrganizationTable.createdAt })
    .from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  if (!organization) return null
  const scope = and(eq(MemberTable.organizationId, id), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false))
  const pattern = `%${sanitizeAdminSearchForLike(request.search)}%`
  const filter = and(scope, request.search ? sql`(lower(${AuthUserTable.name}) like ${pattern} escape '|' or lower(${AuthUserTable.email}) like ${pattern} escape '|' or lower(${MemberTable.role}) like ${pattern} escape '|')` : undefined)
  const [members, totals, matching] = await Promise.all([
    db.select({ id: MemberTable.id, userId: MemberTable.userId, name: AuthUserTable.name, email: AuthUserTable.email, role: MemberTable.role, joinedAt: MemberTable.joinedAt })
      .from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id)).where(filter)
      .orderBy(asc(AuthUserTable.name), asc(MemberTable.id)).limit(request.limit).offset(request.offset),
    db.select({ total: sql<number>`count(*)` }).from(MemberTable).where(scope),
    db.select({ total: sql<number>`count(*)` }).from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id)).where(filter),
  ])
  const metadata = normalizeOrganizationMetadata(organization.metadata).metadata
  const [planStates, people, subscriptionRows] = await Promise.all([
    getOrganizationPlanStates([organization]),
    getOrganizationPeopleCounts(id),
    db.select({
      type: OrgSubscriptionTable.type, status: OrgSubscriptionTable.status, stripe_price_id: OrgSubscriptionTable.stripe_price_id,
      payment_failed: OrgSubscriptionTable.payment_failed, currentPeriodEnd: OrgSubscriptionTable.current_period_end, cancelAtPeriodEnd: OrgSubscriptionTable.cancel_at_period_end,
    }).from(OrgSubscriptionTable).where(and(eq(OrgSubscriptionTable.organization_id, id), inArray(OrgSubscriptionTable.type, ["seat", "web"]))),
  ])
  const plan = planStates.get(organization.id)
  const subscription = (type: "seat") => {
    const row = subscriptionRows.find((entry) => entry.type === type)
    return row ? { status: row.status, currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: row.cancelAtPeriodEnd } : null
  }
  const web = readAdminOpenWorkWebAccess(metadata, subscriptionRows.find((entry) => entry.type === "web") ?? null)
  return {
    organization: {
      id: organization.id, name: organization.name, slug: organization.slug, createdAt: organization.createdAt.toISOString(),
      planTier: parseOrganizationPlan(metadata).tier, seatLimit: metadata.limits.members ?? DEFAULT_ORGANIZATION_LIMITS.members,
      memberCount: Number(totals[0]?.total ?? 0),
      ...(plan ? { plan } : {}),
      people: { joined: people.joined, invited: people.invited },
      subscriptions: { team: subscription("seat") },
      openworkWeb: { complimentaryAccess: web.complimentaryAccess, hasAccess: web.hasAccess, hasOngoingSubscription: web.hasOngoingSubscription, subscriptionStatus: web.subscriptionStatus },
    },
    members: members.map((member) => ({ ...member, joinedAt: member.joinedAt?.toISOString() ?? null })),
    page: buildAdminPageInfo(request, Number(matching[0]?.total ?? 0), members.length, Date.now() - started),
    generatedAt: new Date().toISOString(),
  }
}

export function registerAdminOrganizationDetailRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  for (const section of ["members", "usage", "insights"]) {
    const usage = section === "usage"
    const insights = section === "insights"
    app.get(`/v1/admin/organizations/:organizationId${section === "members" ? "" : `/${section}`}`,
      describeRoute({
        tags: ["Admin"], summary: insights ? "Get organization activity, people and model insights" : usage ? "Get organization usage and a bounded member page" : "Get an organization and a bounded member page",
        description: insights ? "Returns two 30-day UTC usage periods, 30 daily totals, at most eight people and eight models ranked by requests. Adoption counts current non-setup memberships with recorded gateway use. Totals include historical members, preserve unknown accounting coverage and never read prompts or conversation content." : usage ? "Returns the organization's last 30 UTC days of gateway usage, with requests, reported tokens, recorded cost and accounting coverage. Member usage is bounded to the requested member page; organization totals include all members, including removed members. Raw and retained usage use the same accounting as the organization dashboard." : "Returns organization identity, the resolved plan (tier, who pays, users and the user limit every join path enforces, optional end date), and active memberships. Members are searched and paginated on the server. Does not calculate usage or resolve feature maps.",
        responses: {
          200: jsonResponse("Organization detail returned.", insights ? adminOrganizationInsightsSchema : usage ? adminOrganizationUsageSchema : adminOrganizationDetailSchema),
          400: jsonResponse("Invalid organization id or pagination query.", invalidRequestSchema),
          401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema),
          404: jsonResponse("Organization not found.", notFoundSchema),
        },
      }), adminRoute(), queryValidator(querySchema), async (c) => {
        c.header("Cache-Control", "no-store")
        const id = c.req.param("organizationId")
        if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
        const request = normalizeAdminPageRequest(c.req.valid("query"))
        if (insights) {
          // Insights do not depend on the member page, so read both at once.
          const [detail, report] = await Promise.all([organizationDetail(id, request), readAdminOrganizationInsights(id)])
          if (!detail) return c.json({ error: "not_found", message: "Organization not found." }, 404)
          return c.json({ ...detail, insights: report })
        }
        const detail = await organizationDetail(id, request)
        if (!detail) return c.json({ error: "not_found", message: "Organization not found." }, 404)
        if (!usage) return c.json(detail)
        return c.json({ ...detail, usage: await readAdminOrganizationUsage(id, detail.members.map((member) => member.id)) })
      })
  }
}
