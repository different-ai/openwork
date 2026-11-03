import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "@openwork-ee/den-db/drizzle"
import {
  AccountFollowUpActionTable, AccountFollowUpTable, AuthUserTable, ConfigObjectTable, MemberTable, OrgSubscriptionTable, OrganizationTable, TelemetryEventTable,
} from "@openwork-ee/den-db/schema"
import type { OpportunityItem } from "@openwork/types/den/admin-organization"
import { db } from "../../db.js"
import { DEFAULT_ORGANIZATION_LIMITS, normalizeOrganizationMetadata } from "../../organization-limits.js"
import { buildOpportunity, sortOpportunities, startOfUtcDay, type OrganizationFacts } from "./opportunity-queue.js"

const DAY = 86_400_000
type OrganizationId = typeof OrganizationTable.$inferSelect.id
type FollowUp = NonNullable<OpportunityItem["followUp"]>
const humanMember = and(isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), isNotNull(MemberTable.userId), eq(MemberTable.isSetupAgent, false))
// Setup/provisioning identities are not signups.
const humanAccount = sql`not exists (select 1 from ${MemberTable} where ${MemberTable.userId} = ${AuthUserTable.id} and ${MemberTable.isSetupAgent} = true)`
// Initial ownership is not team expansion: only joins after another human member.
const joinedAfterAnotherMember = sql`exists (select 1 from member earlier where earlier.organization_id = ${MemberTable.organizationId}
  and earlier.id <> ${MemberTable.id} and earlier.joined_at <= ${MemberTable.joinedAt}
  and earlier.removed_at is null and earlier.is_setup_agent = false and earlier.user_id is not null)`
const openFollowUp = sql`${AccountFollowUpTable.stage} not in ('closed', 'dismissed')`
const ms = (value: unknown) => value === null || value === undefined ? null : new Date(Number(value))

// Monday-to-now UTC against the identical elapsed period one week earlier.
export function opportunityWeek(now: Date) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const from = new Date(midnight - ((now.getUTCDay() + 6) % 7) * DAY)
  return { from, to: now, previousFrom: new Date(from.getTime() - 7 * DAY), previousTo: new Date(now.getTime() - 7 * DAY) }
}

export async function readAdminOpportunityOverview(now = new Date()) {
  const { from, to, previousFrom, previousTo } = opportunityWeek(now)
  const current = (at: Parameters<typeof gte>[0]) => and(gte(at, from), lt(at, to))
  const previous = (at: Parameters<typeof gte>[0]) => and(gte(at, previousFrom), lt(at, previousTo))
  // Do not transfer emails or configuration content into this summary.
  const activity = db.$with("weekly_opportunity_activity").as(db.select({
    organizationId: MemberTable.organizationId,
    current: sql<number>`count(distinct case when ${current(TelemetryEventTable.event_timestamp)} then ${MemberTable.userId} end)`.as("current_users"),
    previous: sql<number>`count(distinct case when ${previous(TelemetryEventTable.event_timestamp)} then ${MemberTable.userId} end)`.as("previous_users"),
  }).from(TelemetryEventTable).innerJoin(MemberTable, and(eq(MemberTable.id, TelemetryEventTable.member_id), eq(MemberTable.organizationId, TelemetryEventTable.org_id)))
    .where(and(humanMember, gte(TelemetryEventTable.event_timestamp, previousFrom), lt(TelemetryEventTable.event_timestamp, to),
      sql`${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt}`)).groupBy(MemberTable.organizationId))
  const activityRows = () => db.with(activity).select({ id: OrganizationTable.id, name: OrganizationTable.name, current: activity.current, previous: activity.previous })
    .from(activity).innerJoin(OrganizationTable, eq(OrganizationTable.id, activity.organizationId))
  const [signupTotals, memberTotals, userTotals, orgTotals, signupDays, memberDays, recentSignups, growingTeams, rising, falling] = await Promise.all([
    db.select({ current: sql<number>`count(case when ${current(AuthUserTable.createdAt)} then 1 end)`, previous: sql<number>`count(case when ${previous(AuthUserTable.createdAt)} then 1 end)` })
      .from(AuthUserTable).where(and(humanAccount, gte(AuthUserTable.createdAt, previousFrom), lt(AuthUserTable.createdAt, to))),
    db.select({ current: sql<number>`count(case when ${current(MemberTable.joinedAt)} then 1 end)`, previous: sql<number>`count(case when ${previous(MemberTable.joinedAt)} then 1 end)` })
      .from(MemberTable).where(and(humanMember, gte(MemberTable.joinedAt, previousFrom), lt(MemberTable.joinedAt, to))),
    db.select({ current: sql<number>`count(distinct case when ${current(TelemetryEventTable.event_timestamp)} then ${MemberTable.userId} end)`, previous: sql<number>`count(distinct case when ${previous(TelemetryEventTable.event_timestamp)} then ${MemberTable.userId} end)` })
      .from(TelemetryEventTable).innerJoin(MemberTable, and(eq(MemberTable.id, TelemetryEventTable.member_id), eq(MemberTable.organizationId, TelemetryEventTable.org_id)))
      .where(and(humanMember, gte(TelemetryEventTable.event_timestamp, previousFrom), lt(TelemetryEventTable.event_timestamp, to), sql`${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt}`)),
    db.with(activity).select({ current: sql<number>`count(case when ${activity.current} > 0 then 1 end)`, previous: sql<number>`count(case when ${activity.previous} > 0 then 1 end)` }).from(activity),
    db.select({ date: sql<string>`date_format(${AuthUserTable.createdAt}, '%Y-%m-%d')`, total: sql<number>`count(*)` }).from(AuthUserTable)
      .where(and(humanAccount, current(AuthUserTable.createdAt))).groupBy(sql`date_format(${AuthUserTable.createdAt}, '%Y-%m-%d')`),
    db.select({ date: sql<string>`date_format(${MemberTable.joinedAt}, '%Y-%m-%d')`, total: sql<number>`count(*)` }).from(MemberTable)
      .where(and(humanMember, current(MemberTable.joinedAt))).groupBy(sql`date_format(${MemberTable.joinedAt}, '%Y-%m-%d')`),
    db.select({ id: AuthUserTable.id, name: AuthUserTable.name, createdAt: AuthUserTable.createdAt }).from(AuthUserTable)
      .where(and(humanAccount, current(AuthUserTable.createdAt))).orderBy(desc(AuthUserTable.createdAt), asc(AuthUserTable.id)).limit(8),
    db.select({ id: OrganizationTable.id, name: OrganizationTable.name, joinedMembers: sql<number>`count(*)` }).from(MemberTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId)).where(and(humanMember, current(MemberTable.joinedAt), joinedAfterAnotherMember))
      .groupBy(OrganizationTable.id, OrganizationTable.name).orderBy(desc(sql`count(*)`), asc(OrganizationTable.id)).limit(8),
    activityRows().where(sql`${activity.current} > ${activity.previous}`).orderBy(desc(sql`${activity.current} - ${activity.previous}`), asc(OrganizationTable.id)).limit(8),
    activityRows().where(sql`${activity.previous} > ${activity.current}`).orderBy(desc(sql`${activity.previous} - ${activity.current}`), asc(OrganizationTable.id)).limit(8),
  ])
  const tomorrow = new Date(startOfUtcDay(now).getTime() + DAY)
  const [signupOrganizations, activationOrganizations, commercialOrganizations, dueFollowUps, waitingFollowUps, hiddenFollowUps, progress, readyFollowUps, recentJoins] = await Promise.all([
    // Welcome each new person through the first workspace they joined.
    db.select({ organizationId: MemberTable.organizationId }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(humanMember, humanAccount, current(AuthUserTable.createdAt))).orderBy(desc(AuthUserTable.createdAt), asc(MemberTable.joinedAt)).limit(16),
    // Two to 21 days old with no observed organization-scoped app use. Missing telemetry is unobserved, not inactive.
    db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(and(
      gte(OrganizationTable.createdAt, new Date(now.getTime() - 21 * DAY)), lt(OrganizationTable.createdAt, new Date(now.getTime() - 2 * DAY)),
      sql`exists (select 1 from ${MemberTable} where ${MemberTable.organizationId} = ${OrganizationTable.id} and ${humanMember})`,
      sql`not exists (select 1 from ${TelemetryEventTable} where ${TelemetryEventTable.org_id} = ${OrganizationTable.id} and ${TelemetryEventTable.event_timestamp} >= ${OrganizationTable.createdAt})`,
    )).orderBy(desc(OrganizationTable.createdAt), asc(OrganizationTable.id)).limit(10),
    db.select({ id: OrgSubscriptionTable.organization_id }).from(OrgSubscriptionTable).where(and(
      sql`${OrgSubscriptionTable.status} in ('active', 'trialing')`, gte(OrgSubscriptionTable.current_period_end, now),
      sql`(${OrgSubscriptionTable.cancel_at_period_end} = true or (${OrgSubscriptionTable.status} = 'trialing' and ${OrgSubscriptionTable.current_period_end} < ${new Date(now.getTime() + 14 * DAY)}))`,
    )).orderBy(asc(OrgSubscriptionTable.current_period_end)).limit(10),
    db.select({ id: AccountFollowUpTable.organizationId }).from(AccountFollowUpTable)
      .where(and(openFollowUp, lt(AccountFollowUpTable.nextFollowUpAt, tomorrow))).orderBy(asc(AccountFollowUpTable.nextFollowUpAt)).limit(20),
    db.select({ id: AccountFollowUpTable.organizationId }).from(AccountFollowUpTable)
      .where(and(openFollowUp, gte(AccountFollowUpTable.nextFollowUpAt, tomorrow))).orderBy(asc(AccountFollowUpTable.nextFollowUpAt), asc(AccountFollowUpTable.organizationId)).limit(10),
    db.select({ stage: AccountFollowUpTable.stage, total: sql<number>`count(*)` }).from(AccountFollowUpTable)
      .where(sql`${AccountFollowUpTable.stage} in ('closed', 'dismissed')`).groupBy(AccountFollowUpTable.stage),
    readProgress(from, now),
    db.select({ id: AccountFollowUpTable.organizationId }).from(AccountFollowUpTable)
      .where(and(eq(AccountFollowUpTable.stage, "ready"), isNull(AccountFollowUpTable.nextFollowUpAt))).orderBy(asc(AccountFollowUpTable.updatedAt)).limit(20),
    // Seat limits are checked for teams that added people in the last 30 days.
    db.select({ id: MemberTable.organizationId }).from(MemberTable).where(and(humanMember, gte(MemberTable.joinedAt, new Date(now.getTime() - 30 * DAY)), lt(MemberTable.joinedAt, now)))
      .groupBy(MemberTable.organizationId).orderBy(desc(sql`max(${MemberTable.joinedAt})`)).limit(20),
  ])
  const [activation] = await db.with(activity).select({
    total: sql<number>`count(case when (${activity.previous} = 0 and ${activity.current} >= 1) or (${activity.previous} = 1 and ${activity.current} >= 2) then 1 end)`,
  }).from(activity)
  const ids = [...new Set([
    ...dueFollowUps.map(row => row.id), ...readyFollowUps.map(row => row.id), ...commercialOrganizations.map(row => row.id), ...growingTeams.map(row => row.id),
    ...rising.map(row => row.id), ...falling.map(row => row.id), ...activationOrganizations.map(row => row.id),
    ...signupOrganizations.map(row => row.organizationId), ...recentJoins.map(row => row.id), ...waitingFollowUps.map(row => row.id),
  ])]
  const facts = await readOrganizationFacts(ids, now)
  const waitingIds = new Set(waitingFollowUps.map(row => row.id))
  const queue = sortOpportunities(ids.filter(id => !waitingIds.has(id)).flatMap(id => {
    const entry = facts.get(id)
    const item = entry ? buildOpportunity(entry, now) : null
    return item ? [item] : []
  })).slice(0, 40)
  const waiting = waitingFollowUps.flatMap(row => {
    const entry = facts.get(row.id)
    return entry?.followUp ? [{ organizationId: row.id, organizationName: entry.name, followUp: entry.followUp }] : []
  })
  const hidden = (stage: string) => Number(hiddenFollowUps.find(row => row.stage === stage)?.total ?? 0)
  const metric = (rows: { current: number; previous: number }[]) => ({ current: Number(rows[0]?.current ?? 0), previous: Number(rows[0]?.previous ?? 0) })
  const daily = []
  for (let at = from.getTime(); at <= now.getTime(); at += DAY) {
    const date = new Date(at).toISOString().slice(0, 10)
    daily.push({ date, signups: Number(signupDays.find(day => day.date === date)?.total ?? 0), joinedMembers: Number(memberDays.find(day => day.date === date)?.total ?? 0) })
  }
  return {
    from: from.toISOString(), to: to.toISOString(), previousFrom: previousFrom.toISOString(), previousTo: previousTo.toISOString(), generatedAt: now.toISOString(),
    signups: metric(signupTotals), joinedMembers: metric(memberTotals), activeUsers: metric(userTotals), activeOrganizations: metric(orgTotals), daily,
    recentSignups: recentSignups.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
    growingTeams: growingTeams.map(row => ({ ...row, joinedMembers: Number(row.joinedMembers) })),
    risingActivity: rising.map(row => ({ ...row, current: Number(row.current), previous: Number(row.previous) })),
    fallingActivity: falling.map(row => ({ ...row, current: Number(row.current), previous: Number(row.previous) })),
    timeZone: "UTC" as const, queue, waiting, hidden: { closed: hidden("closed"), dismissed: hidden("dismissed") },
    progress: { ...progress, activationProgress: Number(activation?.total ?? 0) },
  }
}

async function readProgress(from: Date, now: Date) {
  const today = startOfUtcDay(now), tomorrow = new Date(today.getTime() + DAY)
  const thisWeek = and(gte(AccountFollowUpActionTable.occurredAt, from), lt(AccountFollowUpActionTable.occurredAt, now))
  const [[actions], [followUps]] = await Promise.all([
    db.select({
      reviewed: sql<number>`count(distinct case when ${AccountFollowUpActionTable.kind} <> 'note' then ${AccountFollowUpActionTable.organizationId} end)`,
      outreach: sql<number>`count(case when ${AccountFollowUpActionTable.kind} = 'contacted' then 1 end)`,
      conversations: sql<number>`count(case when ${AccountFollowUpActionTable.kind} in ('replied', 'meeting') then 1 end)`,
      followUpsCompleted: sql<number>`count(${AccountFollowUpActionTable.followUpDueAt})`,
      // Due dates are UTC calendar days; anything before the end of that day is on time.
      followUpsOnTime: sql<number>`count(case when ${AccountFollowUpActionTable.occurredAt} < ${AccountFollowUpActionTable.followUpDueAt} + interval 1 day then 1 end)`,
    }).from(AccountFollowUpActionTable).where(thisWeek),
    db.select({
      dueToday: sql<number>`count(case when ${AccountFollowUpTable.nextFollowUpAt} >= ${today} and ${AccountFollowUpTable.nextFollowUpAt} < ${tomorrow} then 1 end)`,
      overdue: sql<number>`count(case when ${AccountFollowUpTable.nextFollowUpAt} < ${today} then 1 end)`,
      confirmedExpansion: sql<number>`count(case when ${AccountFollowUpTable.confirmedOpportunity} = 'expansion' and ${AccountFollowUpTable.stage} <> 'dismissed' then 1 end)`,
      confirmedCommercial: sql<number>`count(case when ${AccountFollowUpTable.confirmedOpportunity} = 'commercial' and ${AccountFollowUpTable.stage} <> 'dismissed' then 1 end)`,
    }).from(AccountFollowUpTable).where(sql`${AccountFollowUpTable.stage} <> 'closed' or ${AccountFollowUpTable.confirmedOpportunity} is not null`),
  ])
  const n = (value: unknown) => Number(value ?? 0)
  return {
    reviewed: n(actions?.reviewed), outreach: n(actions?.outreach), conversations: n(actions?.conversations),
    followUpsCompleted: n(actions?.followUpsCompleted), followUpsOnTime: n(actions?.followUpsOnTime),
    dueToday: n(followUps?.dueToday), overdue: n(followUps?.overdue),
    confirmedExpansion: n(followUps?.confirmedExpansion), confirmedCommercial: n(followUps?.confirmedCommercial),
  }
}

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

/** Bounded per-organization facts for recommendations. Never reads content, credentials or emails. */
export async function readOrganizationFacts(ids: OrganizationId[], now: Date) {
  const facts = new Map<string, OrganizationFacts>()
  if (!ids.length) return facts
  const { from, previousFrom, previousTo } = opportunityWeek(now)
  const windowStart = new Date(now.getTime() - 30 * DAY)
  const between = (at: Parameters<typeof gte>[0], start: Date, end: Date) => and(gte(at, start), lt(at, end))
  const [organizations, members, activity, setup, subscriptions, signups, followUps] = await Promise.all([
    db.select({ id: OrganizationTable.id, name: OrganizationTable.name, createdAt: OrganizationTable.createdAt, metadata: OrganizationTable.metadata })
      .from(OrganizationTable).where(inArray(OrganizationTable.id, ids)),
    db.select({
      organizationId: MemberTable.organizationId, members: sql<number>`count(*)`,
      joined: sql<number>`count(case when ${between(MemberTable.joinedAt, from, now)} and ${joinedAfterAnotherMember} then 1 end)`,
      latestJoinMs: sql<number | null>`unix_timestamp(max(case when ${between(MemberTable.joinedAt, from, now)} and ${joinedAfterAnotherMember} then ${MemberTable.joinedAt} end)) * 1000`,
    }).from(MemberTable).where(and(humanMember, inArray(MemberTable.organizationId, ids))).groupBy(MemberTable.organizationId),
    db.select({
      organizationId: MemberTable.organizationId,
      current: sql<number>`count(distinct case when ${between(TelemetryEventTable.event_timestamp, from, now)} then ${MemberTable.userId} end)`,
      previous: sql<number>`count(distinct case when ${between(TelemetryEventTable.event_timestamp, previousFrom, previousTo)} then ${MemberTable.userId} end)`,
      lastMs: sql<number | null>`unix_timestamp(max(${TelemetryEventTable.event_timestamp})) * 1000`,
    }).from(TelemetryEventTable).innerJoin(MemberTable, and(eq(MemberTable.id, TelemetryEventTable.member_id), eq(MemberTable.organizationId, TelemetryEventTable.org_id)))
      .where(and(humanMember, inArray(TelemetryEventTable.org_id, ids), gte(TelemetryEventTable.event_timestamp, windowStart), lt(TelemetryEventTable.event_timestamp, now),
        sql`${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt}`)).groupBy(MemberTable.organizationId),
    // Count metadata only. Never read skill text, MCP addresses or credentials.
    db.select({
      organizationId: ConfigObjectTable.organizationId,
      skills: sql<number>`sum(case when ${ConfigObjectTable.objectType} = 'skill' then 1 else 0 end)`,
      mcp: sql<number>`sum(case when ${ConfigObjectTable.objectType} = 'mcp' then 1 else 0 end)`,
    }).from(ConfigObjectTable).where(and(inArray(ConfigObjectTable.organizationId, ids), eq(ConfigObjectTable.status, "active"), isNull(ConfigObjectTable.deletedAt)))
      .groupBy(ConfigObjectTable.organizationId),
    db.select({ organizationId: OrgSubscriptionTable.organization_id, status: OrgSubscriptionTable.status, cancelAtPeriodEnd: OrgSubscriptionTable.cancel_at_period_end, currentPeriodEnd: OrgSubscriptionTable.current_period_end })
      .from(OrgSubscriptionTable).where(inArray(OrgSubscriptionTable.organization_id, ids)),
    db.select({ organizationId: MemberTable.organizationId, userId: AuthUserTable.id, name: AuthUserTable.name, createdAt: AuthUserTable.createdAt })
      .from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(humanMember, humanAccount, inArray(MemberTable.organizationId, ids), between(AuthUserTable.createdAt, from, now)))
      .orderBy(desc(AuthUserTable.createdAt)).limit(200),
    readFollowUps(ids),
  ])
  for (const organization of organizations) {
    const member = members.find(row => row.organizationId === organization.id)
    const observed = activity.find(row => row.organizationId === organization.id)
    const config = setup.find(row => row.organizationId === organization.id)
    facts.set(organization.id, {
      id: organization.id, name: organization.name, createdAt: organization.createdAt,
      members: Number(member?.members ?? 0), seatLimit: normalizeOrganizationMetadata(organization.metadata).metadata.limits.members ?? DEFAULT_ORGANIZATION_LIMITS.members,
      joinedThisWeek: Number(member?.joined ?? 0), latestJoinAt: ms(member?.latestJoinMs),
      activeCurrent: Number(observed?.current ?? 0), activePrevious: Number(observed?.previous ?? 0), lastObservedAt: ms(observed?.lastMs),
      skills: Number(config?.skills ?? 0), mcpConnections: Number(config?.mcp ?? 0),
      subscriptions: subscriptions.filter(row => row.organizationId === organization.id),
      signups: signups.filter(row => row.organizationId === organization.id).slice(0, 4).map(({ userId, name, createdAt }) => ({ userId, name, createdAt })),
      followUp: followUps.get(organization.id) ?? null,
    })
  }
  return facts
}
