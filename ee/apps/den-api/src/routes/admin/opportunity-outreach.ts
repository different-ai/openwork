import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  AccountFollowUpActionTable, AccountFollowUpTable, AuthUserTable, FreeAutoLimitEventTable, MemberTable, OrgSubscriptionTable, OrganizationTable, TelemetryEventTable,
} from "@openwork-ee/den-db/schema"
import { adminOutreachSchema, type OutreachItem } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { parseOrganizationPlan } from "../../entitlements.js"
import { adminRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { DEFAULT_ORGANIZATION_LIMITS, normalizeOrganizationMetadata } from "../../organization-limits.js"
import type { AuthContextVariables } from "../../session.js"
import { companyDomainSql } from "./opportunity-signals.js"
import {
  CANCELED_DAYS, FREE_LIMIT_DAYS, OUTREACH_WINDOW_DAYS, buildOutreach, companyClusters,
  type CompanyCluster, type OutreachFacts, type OutreachPerson,
} from "./outreach-plays.js"

const DAY = 86_400_000
/** People loaded per listed account, and accounts considered per request. Both far above what the rules produce today. */
const MAX_PEOPLE = 6_000
const MAX_ACCOUNTS = 1_500
type OrganizationId = typeof OrganizationTable.$inferSelect.id
type FollowUp = NonNullable<OutreachItem["followUp"]>
const humanMember = and(isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), isNotNull(MemberTable.userId), eq(MemberTable.isSetupAgent, false))

export async function readFollowUps(ids: OrganizationId[]) {
  const result = new Map<string, FollowUp>()
  if (!ids.length) return result
  const owner = db.select({ id: AuthUserTable.id, name: AuthUserTable.name }).from(AuthUserTable).as("follow_up_owner")
  const [rows, latest] = await Promise.all([
    db.select({ row: AccountFollowUpTable, ownerName: owner.name }).from(AccountFollowUpTable)
      .leftJoin(owner, eq(owner.id, AccountFollowUpTable.ownerUserId)).where(inArray(AccountFollowUpTable.organizationId, ids)),
    db.select({ organizationId: AccountFollowUpActionTable.organizationId, kind: AccountFollowUpActionTable.kind, occurredAt: AccountFollowUpActionTable.occurredAt })
      .from(AccountFollowUpActionTable).where(and(inArray(AccountFollowUpActionTable.organizationId, ids),
        sql`${AccountFollowUpActionTable.id} = (select latest.id from account_follow_up_action latest where latest.organization_id = ${AccountFollowUpActionTable.organizationId} order by latest.occurred_at desc, latest.id desc limit 1)`)),
  ])
  for (const { row, ownerName } of rows) {
    const last = latest.find(entry => entry.organizationId === row.organizationId)
    result.set(row.organizationId, {
      stage: row.stage, ownerUserId: row.ownerUserId, ownerName: ownerName ?? null, nextAction: row.nextAction,
      nextFollowUpAt: row.nextFollowUpAt?.toISOString() ?? null, lastContactedAt: row.lastContactedAt?.toISOString() ?? null,
      lastActionKind: last?.kind ?? null, lastActionAt: last?.occurredAt.toISOString() ?? null,
      confirmedOpportunity: row.confirmedOpportunity, updatedAt: row.updatedAt.toISOString(),
    })
  }
  return result
}

/**
 * Who to write to and why, from what Den already records: who ran tasks, recorded
 * subscriptions, free model limit refusals and the team's own follow-up notes.
 * Reads no content, credentials or Stripe; calls nothing outside the database.
 */
export async function readAdminOutreach(now = new Date()) {
  const from = new Date(now.getTime() - OUTREACH_WINDOW_DAYS * DAY)
  // One pass over the time index, grouped by member, before any join.
  const recent = db.select({
    memberId: TelemetryEventTable.member_id,
    days: sql<number>`count(distinct date(${TelemetryEventTable.event_timestamp}))`.as("active_days"),
  }).from(TelemetryEventTable).where(and(
    gte(TelemetryEventTable.event_timestamp, from), lt(TelemetryEventTable.event_timestamp, now),
    sql`${TelemetryEventTable.event_type} like 'task.%'`, eq(TelemetryEventTable.source, "app"),
  )).groupBy(TelemetryEventTable.member_id).as("recent_activity")
  const [activity, subscriptions, limits, followUpIds] = await Promise.all([
    db.select({ organizationId: MemberTable.organizationId, userId: MemberTable.userId, days: recent.days, companyDomain: companyDomainSql() })
      .from(recent).innerJoin(MemberTable, eq(MemberTable.id, recent.memberId)).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(humanMember),
    db.select({
      organizationId: OrgSubscriptionTable.organization_id, type: OrgSubscriptionTable.type, status: OrgSubscriptionTable.status,
      paymentFailed: OrgSubscriptionTable.payment_failed, cancelAtPeriodEnd: OrgSubscriptionTable.cancel_at_period_end,
      currentPeriodEnd: OrgSubscriptionTable.current_period_end, canceledAt: OrgSubscriptionTable.canceled_at, createdAt: OrgSubscriptionTable.created_at,
    }).from(OrgSubscriptionTable).where(or(
      inArray(OrgSubscriptionTable.status, ["active", "trialing", "past_due", "unpaid"]),
      gte(OrgSubscriptionTable.canceled_at, new Date(now.getTime() - CANCELED_DAYS * DAY)),
    )),
    db.select({ organizationId: FreeAutoLimitEventTable.organization_id, userId: FreeAutoLimitEventTable.user_id, hits: sql<number>`count(*)` })
      .from(FreeAutoLimitEventTable).where(and(
        eq(FreeAutoLimitEventTable.audience, "member"), isNotNull(FreeAutoLimitEventTable.organization_id), isNotNull(FreeAutoLimitEventTable.user_id),
        gte(FreeAutoLimitEventTable.exhausted_at, new Date(now.getTime() - FREE_LIMIT_DAYS * DAY)), lt(FreeAutoLimitEventTable.exhausted_at, now),
      )).groupBy(FreeAutoLimitEventTable.organization_id, FreeAutoLimitEventTable.user_id),
    db.select({ id: AccountFollowUpTable.organizationId }).from(AccountFollowUpTable).where(or(
      isNotNull(AccountFollowUpTable.nextFollowUpAt), gte(AccountFollowUpTable.lastContactedAt, from),
      inArray(AccountFollowUpTable.stage, ["closed", "dismissed"]),
    )),
  ])

  const rows = activity.flatMap(row => row.userId ? [{ organizationId: row.organizationId, userId: row.userId, activeDays: Number(row.days), companyDomain: row.companyDomain }] : [])
  const activeByOrganization = new Map<string, number>()
  for (const row of rows) activeByOrganization.set(row.organizationId, (activeByOrganization.get(row.organizationId) ?? 0) + 1)
  const seeds = companyClusters(rows)
  const hasModels = new Set(subscriptions.filter(row => row.type === "inference" && (row.status === "active" || row.status === "trialing")).map(row => row.organizationId))
  const candidates = new Set<OrganizationId>()
  for (const [id, active] of activeByOrganization) if (active >= 2) candidates.add(id as OrganizationId)
  for (const row of subscriptions) candidates.add(row.organizationId)
  for (const row of limits) if (row.organizationId && !hasModels.has(row.organizationId)) candidates.add(row.organizationId)
  for (const seed of seeds) candidates.add(seed.homeOrganizationId as OrganizationId)
  for (const row of followUpIds) candidates.add(row.id)
  const ids = [...candidates].slice(0, MAX_ACCOUNTS)
  if (!ids.length) return { generatedAt: now.toISOString(), windowDays: OUTREACH_WINDOW_DAYS, ...buildOutreach([], [], now) }

  // People in the listed workspaces, plus colleagues in other workspaces named by a company reason.
  const colleagues = [...new Set(seeds.flatMap(seed => seed.others.map(other => other.userId)))] as NonNullable<typeof MemberTable.$inferSelect.userId>[]
  const person = { organizationId: MemberTable.organizationId, userId: MemberTable.userId, role: MemberTable.role, name: AuthUserTable.name, email: AuthUserTable.email, companyDomain: companyDomainSql() }
  const [organizations, members, others, followUps] = await Promise.all([
    db.select({ id: OrganizationTable.id, name: OrganizationTable.name, metadata: OrganizationTable.metadata }).from(OrganizationTable).where(inArray(OrganizationTable.id, ids)),
    db.select(person).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(humanMember, inArray(MemberTable.organizationId, ids))).limit(MAX_PEOPLE),
    colleagues.length ? db.select(person).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(humanMember, inArray(MemberTable.userId, colleagues))).limit(MAX_PEOPLE) : [],
    readFollowUps(ids),
  ])
  const daysOf = new Map(rows.map(row => [`${row.organizationId}:${row.userId}`, row.activeDays]))
  const hitsOf = new Map(limits.map(row => [`${row.organizationId}:${row.userId}`, Number(row.hits)]))
  const toPerson = (row: (typeof members)[number]): OutreachPerson | null => row.userId && row.email ? {
    userId: row.userId, name: row.name, email: row.email, role: row.role, companyDomain: row.companyDomain,
    activeDays: daysOf.get(`${row.organizationId}:${row.userId}`) ?? 0, limitHits: hitsOf.get(`${row.organizationId}:${row.userId}`) ?? 0,
  } : null

  const facts: OutreachFacts[] = organizations.map(organization => {
    const people = members.filter(row => row.organizationId === organization.id)
    return {
      id: organization.id, name: organization.name, plan: parseOrganizationPlan(organization.metadata).tier,
      members: people.length, seatLimit: normalizeOrganizationMetadata(organization.metadata).metadata.limits.members ?? DEFAULT_ORGANIZATION_LIMITS.members,
      people: people.flatMap(row => toPerson(row) ?? []),
      subscriptions: subscriptions.filter(row => row.organizationId === organization.id).map(({ organizationId: _, ...row }) => row),
      followUp: followUps.get(organization.id) ?? null,
    }
  })
  const clusters: CompanyCluster[] = seeds.map(seed => ({
    ...seed,
    others: seed.others.flatMap(other => {
      const row = others.find(entry => entry.organizationId === other.organizationId && entry.userId === other.userId)
      return row ? toPerson(row) ?? [] : []
    }),
  }))
  return { generatedAt: now.toISOString(), windowDays: OUTREACH_WINDOW_DAYS, ...buildOutreach(facts, clusters, now) }
}

export function registerAdminOutreachRoute<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/opportunities/outreach", describeRoute({
    tags: ["Admin"], summary: "List the accounts worth writing to, with who and why",
    description: "Platform-admin-only. One row per organization under its strongest reason: a follow-up that is due, a failed payment, a plan ending or canceled in the last 30 days, two or more people running tasks without a Team plan, every seat in use, colleagues at one verified company domain running tasks from separate workspaces, a member reaching the free model limit in the last 7 days, or a paid plan with no tasks seen in 14 days. Each row names the person to write to with their name, email and role, and up to five other people. Accounts an admin dismissed or closed are left out; accounts contacted in the last 14 days are returned as waiting. At most 50 rows per reason; totals count every match. Missing telemetry is not inactivity and an email domain is not proof of employment. No content, credentials, Stripe calls or external enrichment, and nothing is sent.",
    responses: { 200: jsonResponse("Outreach list returned.", adminOutreachSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), async c => {
    c.header("Cache-Control", "no-store")
    return c.json(await readAdminOutreach())
  })
}
