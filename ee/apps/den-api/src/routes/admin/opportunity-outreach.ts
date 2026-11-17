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
  CANCELED_DAYS, FREE_LIMIT_DAYS, HISTORY_DAYS, OUTREACH_WINDOW_DAYS, RESULT_DAYS, buildOutreach, companyClusters,
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
  const history = new Date(now.getTime() - HISTORY_DAYS * DAY)
  const at = TelemetryEventTable.event_timestamp
  // One pass over the time index, grouped by member, before any join. "Before" is history up to the window.
  const recent = db.select({
    memberId: TelemetryEventTable.member_id,
    days: sql<number>`count(distinct case when ${at} >= ${from} then date(${at}) end)`.as("active_days"),
    beforeDays: sql<number>`count(distinct case when ${at} < ${from} then date(${at}) end)`.as("before_days"),
    startedBefore: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.started' and ${at} < ${from}), 0)`.as("started_before"),
    failedBefore: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.failed' and ${at} < ${from}), 0)`.as("failed_before"),
    lastMs: sql<number>`unix_timestamp(max(${at})) * 1000`.as("last_ms"),
  }).from(TelemetryEventTable).where(and(
    gte(at, history), lt(at, now), sql`${TelemetryEventTable.event_type} like 'task.%'`, eq(TelemetryEventTable.source, "app"),
  )).groupBy(TelemetryEventTable.member_id).as("recent_activity")
  const [activity, subscriptions, limits, followUpIds] = await Promise.all([
    db.select({
      organizationId: MemberTable.organizationId, userId: MemberTable.userId, companyDomain: companyDomainSql(),
      days: recent.days, beforeDays: recent.beforeDays, startedBefore: recent.startedBefore, failedBefore: recent.failedBefore, lastMs: recent.lastMs,
    })
      .from(recent).innerJoin(MemberTable, eq(MemberTable.id, recent.memberId)).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(humanMember),
    db.select({
      organizationId: OrgSubscriptionTable.organization_id, type: OrgSubscriptionTable.type, status: OrgSubscriptionTable.status,
      paymentFailed: OrgSubscriptionTable.payment_failed, cancelAtPeriodEnd: OrgSubscriptionTable.cancel_at_period_end,
      currentPeriodEnd: OrgSubscriptionTable.current_period_end, canceledAt: OrgSubscriptionTable.canceled_at, createdAt: OrgSubscriptionTable.created_at,
    }).from(OrgSubscriptionTable).where(or(
      inArray(OrgSubscriptionTable.status, ["active", "trialing", "past_due", "unpaid"]),
      gte(OrgSubscriptionTable.canceled_at, new Date(now.getTime() - CANCELED_DAYS * DAY)),
    )),
    db.select({
      organizationId: FreeAutoLimitEventTable.organization_id, userId: FreeAutoLimitEventTable.user_id,
      hits: sql<number>`coalesce(sum(${FreeAutoLimitEventTable.exhausted_at} >= ${new Date(now.getTime() - FREE_LIMIT_DAYS * DAY)}), 0)`,
      lastMs: sql<number>`unix_timestamp(max(${FreeAutoLimitEventTable.exhausted_at})) * 1000`,
    })
      .from(FreeAutoLimitEventTable).where(and(
        eq(FreeAutoLimitEventTable.audience, "member"), isNotNull(FreeAutoLimitEventTable.organization_id), isNotNull(FreeAutoLimitEventTable.user_id),
        gte(FreeAutoLimitEventTable.exhausted_at, history), lt(FreeAutoLimitEventTable.exhausted_at, now),
      )).groupBy(FreeAutoLimitEventTable.organization_id, FreeAutoLimitEventTable.user_id),
    db.select({ id: AccountFollowUpTable.organizationId, contactedAt: AccountFollowUpTable.lastContactedAt }).from(AccountFollowUpTable).where(or(
      isNotNull(AccountFollowUpTable.nextFollowUpAt), gte(AccountFollowUpTable.lastContactedAt, new Date(now.getTime() - (RESULT_DAYS + OUTREACH_WINDOW_DAYS) * DAY)),
      inArray(AccountFollowUpTable.stage, ["closed", "dismissed"]),
    )),
  ])

  const rows = activity.flatMap(row => row.userId ? [{
    organizationId: row.organizationId, userId: row.userId, companyDomain: row.companyDomain, activeDays: Number(row.days), beforeDays: Number(row.beforeDays),
    startedBefore: Number(row.startedBefore), failedBefore: Number(row.failedBefore), lastActiveAt: new Date(Number(row.lastMs)),
  }] : [])
  const activeByOrganization = new Map<string, number>()
  // Accounts where people ran tasks before the window: how many, how regularly, and whether a work address is among them.
  const earlier = new Map<string, { people: number, stopped: number, regular: boolean, work: boolean, started: number, failed: number }>()
  for (const row of rows) {
    if (row.activeDays > 0) activeByOrganization.set(row.organizationId, (activeByOrganization.get(row.organizationId) ?? 0) + 1)
    if (row.beforeDays === 0) continue
    const entry = earlier.get(row.organizationId) ?? { people: 0, stopped: 0, regular: false, work: false, started: 0, failed: 0 }
    earlier.set(row.organizationId, {
      people: entry.people + 1, stopped: entry.stopped + (row.activeDays === 0 && row.beforeDays >= 3 ? 1 : 0), regular: entry.regular || row.beforeDays >= 3,
      work: entry.work || Boolean(row.companyDomain), started: entry.started + row.startedBefore, failed: entry.failed + row.failedBefore,
    })
  }
  const seeds = companyClusters(rows)
  const hasModels = new Set(subscriptions.filter(row => row.type === "inference" && (row.status === "active" || row.status === "trialing")).map(row => row.organizationId))
  const candidates = new Set<OrganizationId>()
  for (const [id, active] of activeByOrganization) if (active >= 2) candidates.add(id as OrganizationId)
  const limited = new Set(limits.map(row => row.organizationId))
  for (const [id, entry] of earlier) {
    const active = activeByOrganization.get(id) ?? 0
    // Lapsed: regular use, then nobody. Kept to accounts with a team, a work address, failures or the free limit behind them.
    const lapsed = active === 0 && entry.regular && (entry.people >= 2 || entry.work || limited.has(id as OrganizationId) || (entry.started >= 5 && entry.failed / entry.started >= 0.3))
    if (lapsed || (active > 0 && entry.people >= 2 && entry.stopped > 0)) candidates.add(id as OrganizationId)
  }
  for (const row of subscriptions) candidates.add(row.organizationId)
  for (const row of limits) if (row.organizationId && Number(row.hits) > 0 && !hasModels.has(row.organizationId)) candidates.add(row.organizationId)
  for (const seed of seeds) candidates.add(seed.homeOrganizationId as OrganizationId)
  for (const row of followUpIds) candidates.add(row.id)
  const ids = [...candidates].slice(0, MAX_ACCOUNTS)
  if (!ids.length) return { generatedAt: now.toISOString(), windowDays: OUTREACH_WINDOW_DAYS, ...buildOutreach([], [], now) }

  // People in the listed workspaces, plus colleagues in other workspaces named by a company reason.
  const colleagues = [...new Set(seeds.flatMap(seed => seed.others.map(other => other.userId)))] as NonNullable<typeof MemberTable.$inferSelect.userId>[]
  const person = { organizationId: MemberTable.organizationId, userId: MemberTable.userId, role: MemberTable.role, name: AuthUserTable.name, email: AuthUserTable.email, companyDomain: companyDomainSql() }
  const contactedIds = followUpIds.flatMap(row => row.contactedAt ? [row.id] : [])
  const [organizations, members, others, followUps, activeDays] = await Promise.all([
    db.select({ id: OrganizationTable.id, name: OrganizationTable.name, metadata: OrganizationTable.metadata }).from(OrganizationTable).where(inArray(OrganizationTable.id, ids)),
    db.select(person).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(humanMember, inArray(MemberTable.organizationId, ids))).limit(MAX_PEOPLE),
    colleagues.length ? db.select(person).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(humanMember, inArray(MemberTable.userId, colleagues))).limit(MAX_PEOPLE) : [],
    readFollowUps(ids),
    // Days with a task, only for accounts someone recorded contacting: did they come back afterwards?
    contactedIds.length ? db.select({ organizationId: TelemetryEventTable.org_id, date: sql<string>`date_format(${at}, '%Y-%m-%d')`.as("active_date") })
      .from(TelemetryEventTable).where(and(inArray(TelemetryEventTable.org_id, contactedIds), gte(at, new Date(now.getTime() - (RESULT_DAYS + 2 * OUTREACH_WINDOW_DAYS) * DAY)), lt(at, now),
        sql`${TelemetryEventTable.event_type} like 'task.%'`, eq(TelemetryEventTable.source, "app")))
      .groupBy(TelemetryEventTable.org_id, sql`active_date`) : [],
  ])
  const activityOf = new Map(rows.map(row => [`${row.organizationId}:${row.userId}`, row]))
  const limitOf = new Map(limits.map(row => [`${row.organizationId}:${row.userId}`, row]))
  const toPerson = (row: (typeof members)[number]): OutreachPerson | null => {
    if (!row.userId || !row.email) return null
    const activity = activityOf.get(`${row.organizationId}:${row.userId}`), limit = limitOf.get(`${row.organizationId}:${row.userId}`)
    return {
      userId: row.userId, name: row.name, email: row.email, role: row.role, companyDomain: row.companyDomain,
      activeDays: activity?.activeDays ?? 0, beforeDays: activity?.beforeDays ?? 0, startedBefore: activity?.startedBefore ?? 0, failedBefore: activity?.failedBefore ?? 0,
      lastActiveAt: activity?.lastActiveAt ?? null, limitHits: Number(limit?.hits ?? 0), lastLimitAt: limit ? new Date(Number(limit.lastMs)) : null,
    }
  }

  const facts: OutreachFacts[] = organizations.map(organization => {
    const people = members.filter(row => row.organizationId === organization.id)
    return {
      id: organization.id, name: organization.name, plan: parseOrganizationPlan(organization.metadata).tier,
      members: people.length, seatLimit: normalizeOrganizationMetadata(organization.metadata).metadata.limits.members ?? DEFAULT_ORGANIZATION_LIMITS.members,
      people: people.flatMap(row => toPerson(row) ?? []),
      subscriptions: subscriptions.filter(row => row.organizationId === organization.id).map(({ organizationId: _, ...row }) => row),
      followUp: followUps.get(organization.id) ?? null,
      activeDates: activeDays.filter(row => row.organizationId === organization.id).map(row => row.date),
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
    description: "Platform-admin-only. One row per organization under its strongest reason: a follow-up that is due, a failed payment, a plan ending or canceled in the last 30 days, two or more people running tasks without a Team plan, every seat in use, colleagues at one verified company domain running tasks from separate workspaces, part of a team that stopped, a member reaching the free model limit in the last 7 days, a paid plan with no tasks seen in 14 days, or an account that ran tasks regularly in the last 60 days and then stopped (after failed tasks, after the free model limit, or without a recorded cause). Results count, for accounts contacted in the last 30 days, replies recorded and quiet accounts where someone ran a task afterwards; that is observed, not attributed to the contact. Each row names the person to write to with their name, email and role, and up to five other people. Accounts an admin dismissed or closed are left out; accounts contacted in the last 14 days are returned as waiting. At most 50 rows per reason; totals count every match. Missing telemetry is not inactivity and an email domain is not proof of employment. No content, credentials, Stripe calls or external enrichment, and nothing is sent.",
    responses: { 200: jsonResponse("Outreach list returned.", adminOutreachSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), async c => {
    c.header("Cache-Control", "no-store")
    return c.json(await readAdminOutreach())
  })
}
