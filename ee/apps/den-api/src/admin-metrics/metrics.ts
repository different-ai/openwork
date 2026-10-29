import { sql } from "@openwork-ee/den-db/drizzle"
import {
  CONTROL_CENTER_CAPABILITY_TRACKING_STARTED,
  CONTROL_CENTER_RANGE_DAYS,
  CONTROL_CENTER_TRACKING_STARTED,
  CONTROL_CENTER_TREND_START,
  type ControlCenterAccounts,
  type ControlCenterInvitations,
  type ControlCenterLifecycle,
  type ControlCenterPulse,
  type ControlCenterRange,
  type ControlCenterRevenue,
  type ControlCenterSectionKey,
  type ControlCenterSharing,
} from "@openwork/types/den/admin-control-center"
import { parseOrganizationPlan } from "../entitlements.js"
import { PERSONAL_EMAIL_DOMAINS } from "../routes/admin/opportunity-signals.js"
import { DEFAULT_OPENWORK_MARKETPLACE_NAME, RETIRED_STARTER_MARKETPLACE_NAME } from "../routes/org/plugin-system/default-marketplaces.js"
import {
  DAY_MS,
  activationFunnel,
  activeBetween,
  addDays,
  buildRetentionCohorts,
  classifyWeeks,
  dayKey,
  dayTime,
  isReactivated,
  isSharedSkill,
  median,
  num,
  ratio,
  reuseRate,
  taskOutcomes,
  toDay,
  weekStart,
  weekStarts,
  weekdaysBetween,
  type CapabilityUse,
  type UserActivity,
} from "./definitions.js"
import { HUMAN_MEMBER, SELECT, TASK_EVENT, inList, type Rows } from "./sql.js"

/**
 * The Control Center's metric queries. Each metric runs independently, reads
 * platform tables through an indexed time window and returns aggregate
 * payloads: one per range, or one under "all" when the range does not apply.
 * Never selects emails, tokens or credential columns; the invitation table is
 * read only as counts and durations.
 */

export const RANGES = Object.keys(CONTROL_CENTER_RANGE_DAYS) as ControlCenterRange[]
export type RangeKey = ControlCenterRange | "all"

type Payloads = {
  pulse: ControlCenterPulse
  lifecycle: ControlCenterLifecycle
  invitations: ControlCenterInvitations
  sharing: ControlCenterSharing
  revenue: ControlCenterRevenue
  accounts: ControlCenterAccounts
}
export type MetricPayload<K extends ControlCenterSectionKey> = Payloads[K]
export type MetricResult<K extends ControlCenterSectionKey> = Partial<Record<RangeKey, MetricPayload<K>>>
export type MetricContext = { now: Date; rows: Rows }

const BUILT_IN_MARKETPLACES = [DEFAULT_OPENWORK_MARKETPLACE_NAME, RETIRED_STARTER_MARKETPLACE_NAME]
/** Weekly charts show this many weeks per range; the 7-day range still needs a trend. */
const RANGE_WEEKS: Record<ControlCenterRange, number> = { "7d": 4, "30d": 5, "90d": 13 }

const later = (a: string, b: string) => (a > b ? a : b)
const rangeStartDay = (today: string, range: ControlCenterRange) => addDays(today, 1 - CONTROL_CENTER_RANGE_DAYS[range])
const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS)

function perRange<T>(build: (range: ControlCenterRange) => T): Record<ControlCenterRange, T> {
  return { "7d": build("7d"), "30d": build("30d"), "90d": build("90d") }
}

function workEmail(column: string) {
  const domain = sql.raw(`lower(trim(substring_index(${column}, '@', -1)))`)
  return sql`${domain} NOT IN (${inList(PERSONAL_EMAIL_DOMAINS)})`
}

const notSetupAgentUser = sql.raw(`NOT EXISTS (SELECT 1 FROM member sa WHERE sa.user_id = u.id AND sa.is_setup_agent = 1)`)

/** Distinct people who ran a task in the last 1, 7 and 30 days. Shared with den_overview. */
export async function readTaskUserWindows(rows: Rows, now: Date) {
  const [row] = await rows(sql`${SELECT}
      COUNT(DISTINCT CASE WHEN t.event_timestamp >= ${ago(now, 1)} THEN m.user_id END) AS daily,
      COUNT(DISTINCT CASE WHEN t.event_timestamp >= ${ago(now, 7)} THEN m.user_id END) AS weekly,
      COUNT(DISTINCT m.user_id) AS monthly,
      COUNT(DISTINCT CASE WHEN t.event_timestamp >= ${ago(now, 14)} AND t.event_timestamp < ${ago(now, 7)} THEN m.user_id END) AS previous_weekly,
      SUM(t.event_type = 'task.started' AND t.event_timestamp >= ${ago(now, 7)}) AS started,
      SUM(t.event_type = 'task.completed' AND t.event_timestamp >= ${ago(now, 7)}) AS completed,
      SUM(t.event_type = 'task.failed' AND t.event_timestamp >= ${ago(now, 7)}) AS failed,
      SUM(t.event_type = 'task.started' AND t.event_timestamp >= ${ago(now, 14)} AND t.event_timestamp < ${ago(now, 7)}) AS previous_started,
      SUM(t.event_type = 'task.failed' AND t.event_timestamp >= ${ago(now, 14)} AND t.event_timestamp < ${ago(now, 7)}) AS previous_failed
    FROM telemetry_event t JOIN member m ON m.id = t.member_id
    WHERE t.event_timestamp >= ${ago(now, 30)} AND t.event_timestamp <= ${now} AND ${TASK_EVENT} AND ${HUMAN_MEMBER}`)
  return {
    daily: num(row?.daily), weekly: num(row?.weekly), monthly: num(row?.monthly), previousWeekly: num(row?.previous_weekly),
    started: num(row?.started), completed: num(row?.completed), failed: num(row?.failed),
    previousStarted: num(row?.previous_started), previousFailed: num(row?.previous_failed),
  }
}

/** Organizations with at least two people in them. */
async function readTeamOrganizations(rows: Rows): Promise<Map<string, number>> {
  const result = await rows(sql`${SELECT} m.organization_id AS org, COUNT(*) AS people FROM member m
    WHERE ${HUMAN_MEMBER} GROUP BY m.organization_id HAVING COUNT(*) >= 2`)
  return new Map(result.map((row) => [String(row.org), num(row.people)]))
}

/** People who ran a task and tasks started per organization in [from, to). */
async function readOrganizationActivity(rows: Rows, from: Date, to: Date) {
  const result = await rows(sql`${SELECT} m.organization_id AS org, COUNT(DISTINCT m.user_id) AS people, SUM(t.event_type = 'task.started') AS tasks
    FROM telemetry_event t JOIN member m ON m.id = t.member_id
    WHERE t.event_timestamp >= ${from} AND t.event_timestamp < ${to} AND ${TASK_EVENT} AND ${HUMAN_MEMBER}
    GROUP BY m.organization_id`)
  return new Map(result.map((row) => [String(row.org), { people: num(row.people), tasks: num(row.tasks) }]))
}

// --- A. Pulse ---

export async function computePulse({ now, rows }: MetricContext): Promise<MetricResult<"pulse">> {
  const today = dayKey(now)
  const from = later(CONTROL_CENTER_TRACKING_STARTED, addDays(today, -89))
  const [windows, daily, teams, currentOrgs, previousOrgs, signupDays, signupWeeks] = await Promise.all([
    readTaskUserWindows(rows, now),
    rows(sql`${SELECT} DATE(t.event_timestamp) AS day, COUNT(DISTINCT m.user_id) AS people,
        SUM(t.event_type = 'task.started') AS started, SUM(t.event_type = 'task.completed') AS completed, SUM(t.event_type = 'task.failed') AS failed
      FROM telemetry_event t JOIN member m ON m.id = t.member_id
      WHERE t.event_timestamp >= ${new Date(dayTime(from))} AND t.event_timestamp <= ${now} AND ${TASK_EVENT} AND ${HUMAN_MEMBER}
      GROUP BY day`),
    readTeamOrganizations(rows),
    readOrganizationActivity(rows, ago(now, 7), now),
    readOrganizationActivity(rows, ago(now, 14), ago(now, 7)),
    rows(sql`${SELECT} DATE(u.created_at) AS day, COUNT(*) AS signups, SUM(${workEmail("u.email")}) AS work
      FROM user u WHERE u.created_at >= ${new Date(dayTime(from))} AND u.created_at <= ${now} AND ${notSetupAgentUser} GROUP BY day`),
    rows(sql`${SELECT} SUM(u.created_at >= ${ago(now, 7)}) AS current, SUM(u.created_at < ${ago(now, 7)}) AS previous,
        SUM(u.created_at >= ${ago(now, 7)} AND ${workEmail("u.email")}) AS work
      FROM user u WHERE u.created_at >= ${ago(now, 14)} AND u.created_at <= ${now} AND ${notSetupAgentUser}`),
  ])
  const activeTeams = (activity: Map<string, { people: number }>) => [...activity].filter(([org, value]) => teams.has(org) && value.people >= 2).length
  const outcomes = taskOutcomes(windows.started, windows.completed, windows.failed)
  const taskDays = new Map(daily.map((row) => [toDay(row.day), row]))
  const signupByDay = new Map(signupDays.map((row) => [toDay(row.day), row]))
  const allDays: ControlCenterPulse["daily"] = []
  for (let day = from; day <= today; day = addDays(day, 1)) {
    const task = taskDays.get(day)
    const signup = signupByDay.get(day)
    allDays.push({
      date: day, taskUsers: num(task?.people), started: num(task?.started), completed: num(task?.completed), failed: num(task?.failed),
      signups: num(signup?.signups), workEmailSignups: num(signup?.work),
    })
  }
  const signups = signupWeeks[0]
  const kpis = {
    taskUsers: { daily: windows.daily, weekly: windows.weekly, monthly: windows.monthly, previousWeekly: windows.previousWeekly, dailyOverMonthly: ratio(windows.daily, windows.monthly) },
    tasks: {
      weekly: windows.started, previousWeekly: windows.previousStarted,
      perWeekday: windows.started / Math.max(1, weekdaysBetween(addDays(today, -6), addDays(today, 1))),
      perActiveUser: ratio(windows.started, windows.weekly),
    },
    failures: { ...outcomes, previousFailureRate: ratio(windows.previousFailed, windows.previousStarted) },
    teamOrganizations: { active: activeTeams(currentOrgs), previous: activeTeams(previousOrgs) },
    signups: { weekly: num(signups?.current), previousWeekly: num(signups?.previous), workEmail: num(signups?.work), workEmailShare: ratio(num(signups?.work), num(signups?.current)) },
  }
  return perRange((range) => ({ ...kpis, daily: allDays.filter((day) => day.date >= rangeStartDay(today, range)) }))
}

// --- B–D. Growth, lifecycle, activation, retention and reactivation ---

async function readUserActivity(rows: Rows, now: Date, from: string) {
  const [activity, signups] = await Promise.all([
    rows(sql`${SELECT} m.user_id AS uid, DATE(t.event_timestamp) AS day, MIN(u.created_at) AS signup
      FROM telemetry_event t JOIN member m ON m.id = t.member_id JOIN user u ON u.id = m.user_id
      WHERE t.event_timestamp >= ${new Date(dayTime(from))} AND t.event_timestamp <= ${now} AND ${TASK_EVENT} AND ${HUMAN_MEMBER}
      GROUP BY m.user_id, day`),
    rows(sql`${SELECT} u.id AS uid, u.created_at AS signup FROM user u
      WHERE u.created_at >= ${new Date(dayTime(from))} AND u.created_at <= ${now} AND ${notSetupAgentUser}`),
  ])
  const users = new Map<string, { signupDay: string; days: Set<string> }>()
  const ensure = (uid: unknown, signup: unknown) => {
    const signupDay = toDay(signup)
    if (typeof uid !== "string" || signupDay === null) return null
    const user = users.get(uid) ?? { signupDay, days: new Set<string>() }
    users.set(uid, user)
    return user
  }
  for (const row of signups) ensure(row.uid, row.signup)
  for (const row of activity) {
    const day = toDay(row.day)
    if (day) ensure(row.uid, row.signup)?.days.add(day)
  }
  return users
}

export async function computeLifecycle({ now, rows }: MetricContext): Promise<MetricResult<"lifecycle">> {
  const today = dayKey(now)
  const currentWeek = weekStart(today)
  const lastComplete = addDays(currentWeek, -7)
  const firstTrendWeek = weekStart(CONTROL_CENTER_TREND_START)
  const recentWeeks = weekStarts(lastComplete, RANGE_WEEKS["90d"])
  // A week is compared with the one before it, so lifecycle weeks start once that week was tracked too.
  const lifecycleWeeks = recentWeeks.filter((week) => week >= addDays(firstTrendWeek, 7))
  const from = later(CONTROL_CENTER_TRACKING_STARTED, addDays(today, -126))
  const inactiveCutoff = ago(now, 30)
  const [users, organizations, oldAccounts] = await Promise.all([
    readUserActivity(rows, now, from),
    rows(sql`${SELECT} DATE(o.created_at) AS day,
        (SELECT COUNT(*) FROM member m WHERE m.organization_id = o.id AND ${HUMAN_MEMBER}) AS people
      FROM organization o WHERE o.created_at >= ${new Date(dayTime(recentWeeks[0] ?? currentWeek))} AND o.created_at < ${new Date(dayTime(currentWeek))}`),
    rows(sql`${SELECT} COUNT(*) AS accounts FROM user u WHERE u.created_at < ${inactiveCutoff} AND ${notSetupAgentUser}`),
  ])
  const people: UserActivity[] = [...users.values()]
  const weekRows = classifyWeeks(people, lifecycleWeeks)
  // Organization creation does not depend on usage tracking, so it covers every week in the range.
  const organizationWeeks = new Map(recentWeeks.map((week) => [week, { week, personal: 0, team: 0 }]))
  for (const row of organizations) {
    const day = toDay(row.day)
    const bucket = day ? organizationWeeks.get(weekStart(day)) : undefined
    if (!bucket) continue
    if (num(row.people) >= 2) bucket.team += 1
    else bucket.personal += 1
  }

  // Signups before tracking started have no activity history to compare, so they are counted as old accounts.
  const recentlyActiveOld = people.filter((user) => dayTime(user.signupDay) < inactiveCutoff.getTime() && activeBetween(user, dayKey(inactiveCutoff), addDays(today, 1))).length
  const previousWeek = addDays(lastComplete, -7)
  const returnedPrevious = people.filter((user) => weekStart(user.signupDay) !== previousWeek && activeBetween(user, previousWeek, lastComplete) && !activeBetween(user, addDays(previousWeek, -7), previousWeek))
  const lastWeekRow = classifyWeeks(people, [lastComplete])[0]
  const reactivation = {
    week: lastComplete,
    reactivated: people.filter((user) => isReactivated(user, lastComplete)).length,
    returned: lastWeekRow?.returned ?? 0,
    lost: lastWeekRow?.lost ?? 0,
    inactivePool: Math.max(0, num(oldAccounts[0]?.accounts) - recentlyActiveOld),
    returnersStayed: (() => {
      const stayed = returnedPrevious.filter((user) => activeBetween(user, lastComplete, currentWeek)).length
      return { week: previousWeek, returned: returnedPrevious.length, stayed, rate: ratio(stayed, returnedPrevious.length) }
    })(),
  }

  const cohortRows = buildRetentionCohorts(
    people.filter((user) => user.signupDay >= firstTrendWeek && user.signupDay < currentWeek)
      .map((user, index) => ({ userId: String(index), cohort: weekStart(user.signupDay), signupTime: dayTime(user.signupDay) })),
    people.flatMap((user, index) => [...user.days].map((day) => ({ userId: String(index), dayTime: dayTime(day) }))),
  )
  const cohorts = cohortRows.map((cohort) => {
    // An offset is shown only once the cohort's last signup day has had that whole week.
    const complete = Math.floor((dayTime(today) - dayTime(addDays(cohort.cohort, 6))) / (7 * DAY_MS)) - 1
    const retention = []
    for (let offset = 0; offset <= Math.min(complete, 13); offset += 1) {
      const retained = cohort.retained.get(offset) ?? 0
      retention.push({ offset, users: retained, rate: ratio(retained, cohort.signups) })
    }
    return { week: cohort.cohort, signups: cohort.signups, retention }
  })

  const funnelTo = addDays(today, -14)
  return perRange((range) => {
    const weeks = new Set(weekStarts(lastComplete, RANGE_WEEKS[range]))
    const funnelFrom = later(CONTROL_CENTER_TRACKING_STARTED, addDays(funnelTo, 1 - CONTROL_CENTER_RANGE_DAYS[range]))
    return {
      weeks: weekRows.filter((row) => weeks.has(row.week)),
      organizations: [...organizationWeeks.values()].filter((row) => weeks.has(row.week)),
      activation: { from: funnelFrom, to: funnelTo, ...activationFunnel(people, funnelFrom, funnelTo) },
      cohorts: cohorts.filter((cohort) => weeks.has(cohort.week)),
      reactivation,
    }
  })
}

// --- D. Invitations ---

const CONTACT_ACTIONS = sql.raw(`'contacted', 'replied', 'meeting'`)

export async function computeInvitations({ now, rows }: MetricContext): Promise<MetricResult<"invitations">> {
  const from = ago(now, 90)
  const [joined, states, acceptance, pending, contacts] = await Promise.all([
    // member_invite_id narrows to invited members; the first task uses telemetry_event_member_ts.
    rows(sql`${SELECT} m.user_id AS uid, m.joined_at AS joined,
        (SELECT MIN(t.event_timestamp) FROM telemetry_event t WHERE t.member_id = m.id AND t.event_timestamp >= m.joined_at AND ${TASK_EVENT}) AS first_task
      FROM member m WHERE m.invite_id IS NOT NULL AND m.joined_at >= ${from} AND ${HUMAN_MEMBER}`),
    rows(sql`${SELECT} i.created_at >= ${ago(now, 7)} AS in7, i.created_at >= ${ago(now, 30)} AS in30, i.status AS status, i.expires_at < ${now} AS expired, COUNT(*) AS invitations
      FROM invitation i WHERE i.created_at >= ${from} GROUP BY in7, in30, i.status, expired`),
    rows(sql`${SELECT} i.created_at AS created, TIMESTAMPDIFF(SECOND, i.created_at, m.joined_at) AS seconds
      FROM invitation i JOIN member m ON m.invite_id = i.id WHERE i.created_at >= ${from} AND i.status = 'accepted'`),
    rows(sql`${SELECT} COUNT(*) AS invitations FROM invitation i WHERE i.status = 'pending' AND i.expires_at >= ${now}`),
    rows(sql`${SELECT} c.org AS org, c.at AS at,
        EXISTS (SELECT 1 FROM telemetry_event t WHERE t.org_id = c.org AND t.event_timestamp >= c.at AND t.event_timestamp < c.at + INTERVAL 7 DAY AND ${TASK_EVENT}) AS active
      FROM (
        SELECT a.organization_id AS org, a.occurred_at AS at FROM account_follow_up_action a WHERE a.kind IN (${CONTACT_ACTIONS}) AND a.occurred_at >= ${from}
        UNION ALL
        SELECT l.subject_key, l.sent_at FROM lifecycle_email l WHERE l.kind = 'team_nudge' AND l.status = 'sent' AND l.sent_at >= ${from}
      ) c`),
  ])
  const time = (value: unknown) => {
    const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`) : Number.NaN
    return Number.isNaN(parsed) ? null : parsed
  }
  return perRange((range) => {
    const since = ago(now, CONTROL_CENTER_RANGE_DAYS[range]).getTime()
    const inRange = (row: { in7?: unknown; in30?: unknown }) => range === "90d" || (range === "30d" ? num(row.in30) === 1 : num(row.in7) === 1)
    const members = joined.filter((row) => (time(row.joined) ?? 0) >= since)
    const ranTask = members.filter((row) => time(row.first_task) !== null)
    const invitations = { sent: 0, accepted: 0, expired: 0, pending: 0, canceled: 0 }
    for (const row of states.filter(inRange)) {
      const value = num(row.invitations)
      invitations.sent += value
      if (row.status === "accepted") invitations.accepted += value
      else if (row.status === "pending" && num(row.expired) === 1) invitations.expired += value
      else if (row.status === "pending") invitations.pending += value
      else invitations.canceled += value
    }
    const hours = acceptance.filter((row) => (time(row.created) ?? 0) >= since).map((row) => num(row.seconds) / 3_600).filter((value) => value >= 0)
    const contacted = contacts.filter((row) => (time(row.at) ?? 0) >= since)
    return {
      joinedThroughInvite: members.length,
      joinedRanTask: ranTask.length,
      joinedRanTaskWithin7Days: ranTask.filter((row) => (time(row.first_task) ?? 0) - (time(row.joined) ?? 0) <= 7 * DAY_MS).length,
      peopleWithAcceptedInvite: new Set(members.map((row) => String(row.uid))).size,
      invitations: { ...invitations, medianHoursToAccept: median(hours) },
      pendingNow: num(pending[0]?.invitations),
      outreach: contacts.length === 0 ? null : {
        contactedOrganizations: new Set(contacted.map((row) => String(row.org))).size,
        activeWithin7Days: new Set(contacted.filter((row) => num(row.active) === 1).map((row) => String(row.org))).size,
      },
    }
  })
}

// --- E–F. Skills, MCP sharing and connector reliability ---

export async function computeSharing({ now, rows }: MetricContext): Promise<MetricResult<"sharing">> {
  const today = dayKey(now)
  const from = later(CONTROL_CENTER_CAPABILITY_TRACKING_STARTED, addDays(today, -89))
  const fromTime = new Date(dayTime(from))
  const builtInMarketplaces = inList(BUILT_IN_MARKETPLACES)
  const [teams, builtInPlugins, builtInSkills, uses, skills, plugins, marketplaces] = await Promise.all([
    readTeamOrganizations(rows),
    rows(sql`${SELECT} DISTINCT mp.plugin_id AS id FROM marketplace_plugin mp JOIN marketplace mk ON mk.id = mp.marketplace_id WHERE mk.name IN (${builtInMarketplaces})`),
    rows(sql`${SELECT} DISTINCT pco.config_object_id AS id FROM plugin_config_object pco
      JOIN marketplace_plugin mp ON mp.plugin_id = pco.plugin_id JOIN marketplace mk ON mk.id = mp.marketplace_id WHERE mk.name IN (${builtInMarketplaces})`),
    // Raw events are deleted as the gateway folds them into daily rollups, so the two never overlap.
    rows(sql`${SELECT} u.day AS day, u.organization_id AS org, u.org_membership_id AS member, u.kind AS kind, u.plugin_id AS plugin,
        u.config_object_id AS skill, co.created_by_org_membership_id AS skill_creator,
        u.connection_id AS connection, emc.name AS connection_name, emc.created_by_org_membership_id AS connection_creator,
        SUM(u.uses) AS uses, SUM(u.errors) AS errors
      FROM (
        SELECT DATE(r.bucket_start) AS day, r.organization_id, r.org_membership_id, r.kind, r.plugin_id, r.config_object_id, r.connection_id, r.use_count AS uses, r.error_count AS errors
          FROM capability_usage_rollups r WHERE r.bucket_start >= ${fromTime}
        UNION ALL
        SELECT DATE(e.created_at), e.organization_id, e.org_membership_id, e.kind, e.plugin_id, e.config_object_id, e.connection_id, 1, e.outcome = 'error'
          FROM capability_usage_event e WHERE e.created_at >= ${fromTime}
      ) u
      LEFT JOIN config_object co ON co.id = u.config_object_id
      LEFT JOIN external_mcp_connection emc ON emc.id = u.connection_id
      GROUP BY u.day, u.organization_id, u.org_membership_id, u.kind, u.plugin_id, u.config_object_id, u.connection_id`),
    rows(sql`${SELECT} co.id AS id, co.organization_id AS org, co.created_by_org_membership_id AS creator, co.created_at AS created,
        g.org_wide AS org_wide, g.team_id AS team, g.org_membership_id AS grantee
      FROM config_object co LEFT JOIN config_object_access_grant g ON g.config_object_id = co.id AND g.removed_at IS NULL
      WHERE co.object_type = 'skill' AND co.status = 'active' AND co.deleted_at IS NULL`),
    rows(sql`${SELECT} p.id AS id, p.created_at AS created FROM plugin p WHERE p.status = 'active' AND p.created_at >= ${ago(now, 90)}`),
    rows(sql`${SELECT} mk.created_at AS created FROM marketplace mk WHERE mk.status = 'active' AND mk.created_at >= ${ago(now, 90)} AND mk.name NOT IN (${builtInMarketplaces})`),
  ])
  const builtInPluginIds = new Set(builtInPlugins.map((row) => String(row.id)))
  const builtInSkillIds = new Set(builtInSkills.map((row) => String(row.id)))
  const skillRecords = new Map<string, { org: string; creator: string; createdDay: string | null; grants: { orgWide: boolean; teamId: string | null; memberId: string | null }[] }>()
  for (const row of skills) {
    const id = String(row.id)
    if (builtInSkillIds.has(id)) continue
    const record = skillRecords.get(id) ?? { org: String(row.org), creator: String(row.creator), createdDay: toDay(row.created), grants: [] }
    if (row.org_wide !== null && row.org_wide !== undefined) {
      record.grants.push({ orgWide: num(row.org_wide) === 1, teamId: typeof row.team === "string" ? row.team : null, memberId: typeof row.grantee === "string" ? row.grantee : null })
    }
    skillRecords.set(id, record)
  }
  const teamSkills = [...skillRecords.values()].filter((skill) => teams.has(skill.org))
  const sharedTeamSkills = teamSkills.filter((skill) => isSharedSkill(skill.creator, skill.grants)).length
  const useRows = uses
    .map((row) => ({
      day: toDay(row.day) ?? "", org: String(row.org), member: String(row.member), kind: String(row.kind),
      builtIn: (typeof row.plugin === "string" && builtInPluginIds.has(row.plugin)) || (typeof row.skill === "string" && builtInSkillIds.has(row.skill)),
      skillCreator: typeof row.skill_creator === "string" ? row.skill_creator : null,
      connection: typeof row.connection === "string" ? row.connection : null,
      connectionName: typeof row.connection_name === "string" ? row.connection_name : null,
      connectionCreator: typeof row.connection_creator === "string" ? row.connection_creator : null,
      uses: num(row.uses), errors: num(row.errors),
    }))
    .filter((row) => row.day)

  return perRange((range) => {
    const start = later(from, rangeStartDay(today, range))
    const inRange = useRows.filter((row) => row.day >= start)
    const weeks = weekStarts(today, RANGE_WEEKS[range]).filter((week) => week >= weekStart(from))
    const weekly = weeks.map((week) => {
      const rowsInWeek = inRange.filter((row) => weekStart(row.day) === week)
      const skillRows = rowsInWeek.filter((row) => row.kind === "skill")
      const mcpRows = rowsInWeek.filter((row) => row.kind === "connector_tool")
      return {
        week,
        skillUsers: new Set(skillRows.map((row) => row.member)).size,
        skillUses: skillRows.reduce((sum, row) => sum + row.uses, 0),
        mcpUsers: new Set(mcpRows.map((row) => row.member)).size,
        mcpCalls: mcpRows.reduce((sum, row) => sum + row.uses, 0),
      }
    })
    const teamSkillUses: CapabilityUse[] = inRange.filter((row) => row.kind === "skill" && !row.builtIn && teams.has(row.org))
      .map((row) => ({ memberId: row.member, creatorId: row.skillCreator, uses: row.uses }))
    const skillReuse = reuseRate(teamSkillUses)
    // Only calls through an added connection have a creator; legacy per-person provider connections are left out.
    const teamConnectionUses: CapabilityUse[] = inRange.filter((row) => row.kind === "connector_tool" && row.connectionCreator !== null && teams.has(row.org))
      .map((row) => ({ memberId: row.member, creatorId: row.connectionCreator, uses: row.uses }))
    const connectionReuse = reuseRate(teamConnectionUses)
    const connectors = new Map<string, { people: Set<string>; calls: number; errors: number }>()
    for (const row of inRange) {
      if (row.kind !== "connector_tool") continue
      const name = row.connectionName ?? row.connection ?? "Unknown connection"
      const connector = connectors.get(name) ?? { people: new Set<string>(), calls: 0, errors: 0 }
      connector.people.add(row.member)
      connector.calls += row.uses
      connector.errors += row.errors
      connectors.set(name, connector)
    }
    const rangeStart = ago(now, CONTROL_CENTER_RANGE_DAYS[range]).getTime()
    const createdInRange = (value: unknown) => {
      const day = toDay(value)
      return day !== null && dayTime(day) >= rangeStart - DAY_MS
    }
    return {
      weekly,
      skills: {
        creators: new Set([...skillRecords.values()].filter((skill) => skill.createdDay !== null && skill.createdDay >= rangeStartDay(today, range)).map((skill) => skill.creator)).size,
        teamSkills: teamSkills.length,
        sharedTeamSkills,
        sharingRate: ratio(sharedTeamSkills, teamSkills.length),
        teamUses: skillReuse.total,
        teammateUses: skillReuse.byOthers,
        teammateReuseRate: skillReuse.rate,
      },
      mcp: { teamCalls: connectionReuse.total, sharedConnectionCalls: connectionReuse.byOthers, sharedReuseRate: connectionReuse.rate },
      connectors: [...connectors.entries()]
        .map(([name, value]) => ({ name: name.slice(0, 255), people: value.people.size, calls: value.calls, errors: value.errors, errorRate: ratio(value.errors, value.calls) }))
        .sort((a, b) => b.people - a.people || b.calls - a.calls)
        .slice(0, 10),
      catalog: {
        plugins: plugins.filter((row) => !builtInPluginIds.has(String(row.id)) && createdInRange(row.created)).length,
        marketplaces: marketplaces.filter((row) => createdInRange(row.created)).length,
      },
    }
  })
}

// --- G. Revenue ---

const SEAT_TYPES = new Set(["seat", "web", "enterprise"])
type SubscriptionType = ControlCenterRevenue["monthly"][number]["type"]
const subscriptionType = (value: unknown): SubscriptionType | null =>
  value === "inference" || value === "seat" || value === "web" || value === "enterprise" ? value : null

/** Paid seats per organization from active seat-based subscriptions. */
function paidSeats(subscriptions: { org: string; type: SubscriptionType; status: string; seats: number }[]) {
  const seats = new Map<string, number>()
  for (const subscription of subscriptions) {
    if (subscription.status !== "active" || !SEAT_TYPES.has(subscription.type) || subscription.seats <= 0) continue
    seats.set(subscription.org, (seats.get(subscription.org) ?? 0) + subscription.seats)
  }
  return seats
}

async function readSubscriptions(rows: Rows) {
  const result = await rows(sql`${SELECT} s.organization_id AS org, o.name AS name, s.type AS type, s.status AS status,
      GREATEST(s.quantity, s.minimum_quantity) AS seats, s.created_at AS created, s.canceled_at AS canceled
    FROM org_subscriptions s JOIN organization o ON o.id = s.organization_id`)
  return result.flatMap((row) => {
    const type = subscriptionType(row.type)
    return type ? [{ org: String(row.org), name: String(row.name), type, status: String(row.status), seats: num(row.seats), created: toDay(row.created), canceled: toDay(row.canceled) }] : []
  })
}

export async function computeRevenue({ now, rows }: MetricContext): Promise<MetricResult<"revenue">> {
  const subscriptions = await readSubscriptions(rows)
  const seats = paidSeats(subscriptions)
  const activity = seats.size ? await readOrganizationActivity(rows, ago(now, 7), now) : new Map<string, { people: number }>()
  const months: string[] = []
  for (let index = 5; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1))
    months.push(date.toISOString().slice(0, 7))
  }
  const monthly: ControlCenterRevenue["monthly"] = []
  for (const month of months) {
    for (const type of ["seat", "web", "inference", "enterprise"] as const) {
      const ofType = subscriptions.filter((subscription) => subscription.type === type && subscription.status !== "incomplete" && subscription.status !== "incomplete_expired")
      const started = ofType.filter((subscription) => subscription.created?.startsWith(month)).length
      const canceled = ofType.filter((subscription) => subscription.canceled?.startsWith(month)).length
      if (started || canceled) monthly.push({ month, type, started, canceled })
    }
  }
  const names = new Map(subscriptions.map((subscription) => [subscription.org, subscription.name]))
  const atRisk = [...seats.entries()]
    .map(([organizationId, count]) => {
      const activeMembers = activity.get(organizationId)?.people ?? 0
      return { organizationId, name: names.get(organizationId) ?? organizationId, seats: count, activeMembers, seatUsage: ratio(activeMembers, count) }
    })
    .sort((a, b) => (a.seatUsage ?? 0) - (b.seatUsage ?? 0) || b.seats - a.seats)
    .slice(0, 10)
  return {
    all: {
      activePaidSeats: [...seats.values()].reduce((sum, value) => sum + value, 0),
      activePlans: subscriptions.filter((subscription) => subscription.status === "active").length,
      pastDue: subscriptions.filter((subscription) => subscription.status === "past_due").length,
      monthly,
      atRisk,
    },
  }
}

// --- H. Accounts to watch ---

export async function computeAccounts({ now, rows }: MetricContext): Promise<MetricResult<"accounts">> {
  const [teams, activity, subscriptions] = await Promise.all([
    readTeamOrganizations(rows),
    readOrganizationActivity(rows, ago(now, 7), now),
    readSubscriptions(rows),
  ])
  const top = [...teams.entries()]
    .map(([org, members]) => ({ org, members, active: activity.get(org)?.people ?? 0, tasks: activity.get(org)?.tasks ?? 0 }))
    .sort((a, b) => b.active - a.active || b.tasks - a.tasks || b.members - a.members)
    .slice(0, 25)
  if (top.length === 0) return { all: { rows: [] } }
  const organizations = await rows(sql`${SELECT} o.id AS id, o.name AS name, o.metadata AS metadata FROM organization o WHERE o.id IN (${inList(top.map((row) => row.org))})`)
  const byId = new Map(organizations.map((row) => [String(row.id), row]))
  const seats = paidSeats(subscriptions)
  const paying = new Set(subscriptions.filter((subscription) => subscription.status === "active").map((subscription) => subscription.org))
  return {
    all: {
      rows: top.flatMap((row) => {
        const organization = byId.get(row.org)
        if (!organization) return []
        const metadata = organization.metadata
        const seatCount = seats.get(row.org) ?? null
        return [{
          organizationId: row.org, name: String(organization.name), members: row.members, active7d: row.active, tasks7d: row.tasks,
          plan: parseOrganizationPlan(typeof metadata === "string" || isRecord(metadata) ? metadata : null).tier, paying: paying.has(row.org),
          seats: seatCount, seatUsage: seatCount === null ? null : ratio(row.active, seatCount),
        }]
      }),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
