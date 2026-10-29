/**
 * /admin › Features: per feature and across organizations, whether it is used and working. The readers aggregate
 * the stores that already own the outcomes (automation_run, Your agent's checks, slack_send_as_bot's limits), seeded
 * here as the product writes them; background work marks feature_usage once per day.
 */
import { AUTOMATION_FREE_MODEL, type AutomationIntervalSchedule } from "@openwork/types/automations"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  AgentCheckTable,
  AgentInstanceTable,
  AgentMemberCheckTable,
  AutomationRevisionTable,
  AutomationRunTable,
  AutomationTable,
  FeatureUsageTable,
  RateLimitTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

const den = await bootDen({ env: { DEN_AUTOMATIONS_RUNTIME_ENABLED: "true" } })
after(() => den.close())

const acme = await den.createOrg(await den.signUp("Sam Rivera"), "Acme Robotics")
const acmeMember = await den.newMember(acme.owner, acme.orgId, "Alex Chen")
const northwind = await den.createOrg(await den.signUp("Jordan Lee"), "Northwind Labs")
const turnedOn: Array<[string, string]> = [
  [acme.orgId, "automationCalendarTriggers"], [northwind.orgId, "automationCalendarTriggers"],
  [acme.orgId, "automationIntervalSchedules"], [acme.orgId, "workbotProactive"], [acme.orgId, "slackSendAsBot"],
]
for (const [orgId, key] of turnedOn) {
  const set = await den.setFeature(orgId, key, true)
  assert.equal(set.status, 200, `${key}: ${summary(set)}`)
}
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")
const { db } = await import("../../src/db.js")
const { recordFeatureUsage } = await import("@openwork-ee/den-db/organization-features")
const { createFeatureUsageMarker } = await import("../../src/feature-usage.js")

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.now()
const daysAgo = (days: number, hours = 0) => new Date(now - days * DAY - hours * HOUR)
const MEETING_TITLE = "Quarterly planning with the robotics team"

async function seedAutomation(orgId: string, memberId: string, kind: "calendar" | "interval") {
  const automationId = createDenTypeId("automation")
  const revisionId = createDenTypeId("automationRevision")
  await db.insert(AutomationTable).values({
    id: automationId, organization_id: normalizeDenTypeId("organization", orgId), owner_member_id: normalizeDenTypeId("member", memberId),
    name: `${kind} fixture`, state: "active", current_revision_id: revisionId,
  })
  await db.insert(AutomationRevisionTable).values({
    id: revisionId, automation_id: automationId, version: 1, instructions: "Write a short recap.", schedule_kind: kind,
    schedule_config: kind === "calendar"
      ? { kind: "calendar", timezone: "UTC", edge: "end", offsetMinutes: 5, rule: { withExternalAttendees: true } }
      : { kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
    timezone: "UTC", provider_id: AUTOMATION_FREE_MODEL.providerId, model_id: AUTOMATION_FREE_MODEL.modelId,
    execution_target: "cloud", maximum_runtime_ms: 600_000, digest: `fixture-digest-${revisionId}`,
  })
  return { automationId, revisionId }
}

type RunStatus = (typeof AutomationRunTable.$inferSelect)["status"]
type ErrorCode = NonNullable<(typeof AutomationRunTable.$inferSelect)["error"]>["code"]

async function seedRun(automation: { automationId: string; revisionId: string }, status: RunStatus, at: Date, code?: ErrorCode) {
  const id = createDenTypeId("automationRun")
  await db.insert(AutomationRunTable).values({
    id, automation_id: normalizeDenTypeId("automation", automation.automationId), revision_id: normalizeDenTypeId("automationRevision", automation.revisionId),
    trigger: "scheduled", scheduled_for: at, idempotency_key: `fixture:${id}`, status, execution_target: "cloud",
    cloud_thread_id: createDenTypeId("automationThread"), provider_id: AUTOMATION_FREE_MODEL.providerId, model_id: AUTOMATION_FREE_MODEL.modelId,
    error: code ? { code, message: "Fixture reason.", retryable: false } : null,
    trigger_context: { kind: "calendar_meeting", eventId: `event-${id}`, title: MEETING_TITLE, start: at.getTime(), end: at.getTime() + HOUR, attendeeDomains: ["example.com"], externalAttendees: 1, link: null },
    usage: { inputTokens: null, outputTokens: null, costMicros: null }, created_at: at, updated_at: at,
  })
}

// Calendar triggers: Acme mostly skipped this week, Northwind ran; an older Acme run is only in 30 days.
const acmeCalendar = await seedAutomation(acme.orgId, acmeMember.memberId, "calendar")
const northwindCalendar = await seedAutomation(northwind.orgId, northwind.owner.memberId, "calendar")
const calendarRuns: Array<[typeof acmeCalendar, RunStatus, Date, ErrorCode?]> = [
  [acmeCalendar, "succeeded", daysAgo(1)],
  ...[daysAgo(0, 1), daysAgo(0, 2), daysAgo(1, 2), daysAgo(2), daysAgo(2, 1)].map((at): [typeof acmeCalendar, RunStatus, Date, ErrorCode] => [acmeCalendar, "skipped", at, "execution_runtime_unavailable"]),
  ...[daysAgo(3), daysAgo(4), daysAgo(5)].map((at): [typeof acmeCalendar, RunStatus, Date, ErrorCode] => [acmeCalendar, "skipped", at, "model_access_lost"]),
  [acmeCalendar, "failed", daysAgo(3, 1), "execution_failed"],
  [acmeCalendar, "succeeded", daysAgo(20)],
  ...[daysAgo(0, 3), daysAgo(1), daysAgo(2), daysAgo(4)].map((at): [typeof acmeCalendar, RunStatus, Date] => [northwindCalendar, "succeeded", at]),
]
for (const [automation, status, at, code] of calendarRuns) await seedRun(automation, status, at, code)
// Every few hours: Acme, healthy.
const acmeInterval = await seedAutomation(acme.orgId, acme.owner.memberId, "interval")
for (const hours of [1, 4, 7]) await seedRun(acmeInterval, "succeeded", daysAgo(0, hours))

// Your agent: counters for every member, check records for members with My agent.
const today = new Date(now).toISOString().slice(0, 10)
await db.insert(AgentInstanceTable).values({ memberId: normalizeDenTypeId("member", acmeMember.memberId), organizationId: normalizeDenTypeId("organization", acme.orgId) })
await db.insert(AgentCheckTable).values([
  { organizationId: normalizeDenTypeId("organization", acme.orgId), day: today, responsibility: "meeting_prep", checks: 6, quiet: 4, sent: 2 },
  { organizationId: normalizeDenTypeId("organization", acme.orgId), day: today, responsibility: "waiting_on_you", checks: 6, quiet: 6, sent: 0 },
  { organizationId: normalizeDenTypeId("organization", acme.orgId), day: daysAgo(20).toISOString().slice(0, 10), responsibility: "meeting_prep", checks: 9, quiet: 9, sent: 0 },
])
const memberCheck = (reason: string, outcome: string, at: Date) => ({
  id: randomUUID(), organizationId: normalizeDenTypeId("organization", acme.orgId), memberId: normalizeDenTypeId("member", acmeMember.memberId),
  checkedAt: at, kind: "scheduled", outcome, reason, summary: "Fixture sentence the member reads.",
})
await db.insert(AgentMemberCheckTable).values([
  memberCheck("google_disconnected", "failed", daysAgo(0, 2)),
  memberCheck("member_not_linked", "failed", daysAgo(1)),
  memberCheck("daily_limit", "quiet", daysAgo(0, 1)),
  memberCheck("nothing_new", "quiet", daysAgo(0, 3)),
])

// slack_send_as_bot: Acme's member reached the daily limit today, Slack refused 2 of 20; Northwind sent 3.
const windowStart = now - 5 * HOUR
const rateLimit = (key: string, count: number, lastRequest: number) => ({ id: createDenTypeId("rateLimit"), key, count, lastRequest })
await db.insert(RateLimitTable).values([
  rateLimit(`slack-send-as-bot:day:${acme.orgId}:${acmeMember.userId}`, 20, windowStart),
  ...Array.from({ length: 18 }, (_, index) => rateLimit(`slack-send-as-bot:same:${acme.orgId}:${acmeMember.userId}:hash${index}`, 1, windowStart + index * 60_000)),
  rateLimit(`slack-send-as-bot:day:${northwind.orgId}:${northwind.owner.userId}`, 3, windowStart),
  ...Array.from({ length: 3 }, (_, index) => rateLimit(`slack-send-as-bot:same:${northwind.orgId}:${northwind.owner.userId}:hash${index}`, 1, windowStart + index * 60_000)),
  // A window from three days ago: overwritten history, outside the last 24 hours.
  rateLimit(`slack-send-as-bot:day:${northwind.orgId}:${acme.owner.userId}`, 20, now - 3 * DAY),
])

// Who used what: this week in Acme, three weeks ago in Northwind.
await recordFeatureUsage(db, { organizationId: acme.orgId, memberId: acmeMember.memberId, keys: ["automationCalendarTriggers", "workbotProactive"], at: daysAgo(0, 1) })
await recordFeatureUsage(db, { organizationId: northwind.orgId, memberId: northwind.owner.memberId, keys: ["automationCalendarTriggers"], at: daysAgo(20) })

const report = (range?: string) => den.request(adminToken, "GET", `/v1/admin/feature-usage${range ? `?range=${range}` : ""}`)
const detail = (key: string, range = "7d") => den.request(adminToken, "GET", `/v1/admin/feature-usage/${key}?range=${range}`)
function feature(call: Call, key: string) {
  const entry = list(field(call.body, "features")).find((row) => row.key === key)
  assert.ok(entry, `${key} in ${summary(call)}`)
  return entry
}

test("only platform administrators read feature outcomes", async () => {
  for (const path of ["/v1/admin/feature-usage", "/v1/admin/feature-usage/automationCalendarTriggers"]) {
    for (const token of [null, acme.owner.token, acmeMember.token, northwind.owner.token]) {
      const result = await den.request(token, "GET", path)
      assert.equal(result.status, token ? 403 : 401, `${path}: ${summary(result)}`)
    }
  }
  assert.equal((await report("90d")).status, 400)
  assert.equal((await detail("notARealFeature")).status, 400)
})

test("calendar triggers: runs, how they ended and why, by organization, this week", async () => {
  const result = await report()
  assert.equal(result.status, 200, summary(result))
  assert.equal(field(result.body, "range"), "7d")
  const calendar = feature(result, "automationCalendarTriggers")
  assert.equal(calendar.organizationsOn, 2)
  assert.equal(calendar.membersUsing, 1, "the Northwind use three weeks ago is outside 7 days")
  assert.deepEqual(field(calendar, "health"), { status: "mostly_skipped", count: null })
  const outcomes = field(calendar, "outcomes")
  assert.deepEqual(
    { runs: field(outcomes, "runs"), succeeded: field(outcomes, "succeeded"), failed: field(outcomes, "failed"), skipped: field(outcomes, "skipped"), unit: field(outcomes, "unit") },
    { runs: 14, succeeded: 5, failed: 1, skipped: 8, unit: "meeting" },
  )
  const days = list(field(outcomes, "days"))
  assert.equal(days.length, 7)
  assert.equal(days.at(-1)?.day, today)
  assert.equal(days.at(-1)?.runs, calendarRuns.filter(([, , at]) => at.toISOString().slice(0, 10) === today).length)
  assert.doesNotMatch(result.text, new RegExp(MEETING_TITLE), "never a meeting title")

  const one = await detail("automationCalendarTriggers")
  assert.equal(one.status, 200, summary(one))
  assert.deepEqual(field(one.body, "feature", "reasons"), [
    { reason: "execution_runtime_unavailable", outcome: "skipped", count: 5 },
    { reason: "model_access_lost", outcome: "skipped", count: 3 },
    { reason: "execution_failed", outcome: "failed", count: 1 },
  ])
  const organizations = list(field(one.body, "feature", "byOrganization"))
  assert.deepEqual(organizations.map((row) => row.name), ["Acme Robotics", "Northwind Labs"])
  const [acmeRow, northwindRow] = organizations
  assert.equal(acmeRow?.organizationId, acme.orgId)
  assert.equal(acmeRow?.enabled, true)
  assert.equal(acmeRow?.membersUsing, 1)
  assert.equal(field(acmeRow, "outcomes", "runs"), 10)
  assert.equal(field(acmeRow, "outcomes", "skipped"), 8)
  assert.equal(field(northwindRow, "outcomes", "runs"), 4)
  assert.equal(northwindRow?.membersUsing, 0)
  assert.doesNotMatch(one.text, new RegExp(MEETING_TITLE))
})

test("30 days include the older runs, uses and counters", async () => {
  const result = await report("30d")
  assert.equal(result.status, 200, summary(result))
  const calendar = feature(result, "automationCalendarTriggers")
  assert.equal(field(calendar, "outcomes", "runs"), 15)
  assert.equal(list(field(calendar, "outcomes", "days")).length, 30)
  assert.equal(calendar.membersUsing, 2)
  const agent = feature(result, "workbotProactive")
  assert.equal(field(agent, "outcomes", "succeeded"), 21)
  // Check records are kept two weeks, so failures before then are not known.
  assert.equal(field(agent, "outcomes", "coverage", "counts"), "failed")
  const one = await detail("automationCalendarTriggers", "30d")
  assert.equal(field(list(field(one.body, "feature", "byOrganization")).find((row) => row.name === "Northwind Labs"), "membersUsing"), 1)
})

test("every few hours, Your agent and Slack messages from the bot report what they did", async () => {
  const result = await report()
  const interval = feature(result, "automationIntervalSchedules")
  assert.equal(field(interval, "outcomes", "runs"), 3)
  assert.equal(field(interval, "outcomes", "unit"), "run")
  assert.equal(field(interval, "health", "status"), "healthy")

  const agent = feature(result, "workbotProactive")
  const agentOutcomes = field(agent, "outcomes")
  assert.equal(field(agentOutcomes, "unit"), "check")
  assert.equal(field(agentOutcomes, "succeeded"), 12)
  assert.equal(field(agentOutcomes, "delivered"), 2)
  assert.equal(field(agentOutcomes, "failed"), 2)
  assert.equal(field(agentOutcomes, "limited"), 1)
  assert.equal(field(agentOutcomes, "coverage"), null)
  assert.equal(agent.membersUsing, 1)
  const agentDetail = await detail("workbotProactive")
  assert.deepEqual(new Set(list(field(agentDetail.body, "feature", "reasons")).map((row) => row.reason)), new Set(["google_disconnected", "member_not_linked"]))
  assert.doesNotMatch(agentDetail.text, /Fixture sentence/, "never the sentence a member reads")

  const slack = feature(result, "slackSendAsBot")
  const slackOutcomes = field(slack, "outcomes")
  assert.equal(field(slackOutcomes, "unit"), "message")
  assert.equal(field(slackOutcomes, "delivered"), 21)
  assert.equal(field(slackOutcomes, "failed"), 2)
  assert.equal(field(slackOutcomes, "limited"), 1, "the window from three days ago is not counted")
  assert.equal(field(slackOutcomes, "coverage", "counts"), "all")
  assert.deepEqual(field(slack, "health"), { status: "limited", count: 1 })
  const slackDetail = await detail("slackSendAsBot")
  const byName = new Map(list(field(slackDetail.body, "feature", "byOrganization")).map((row) => [row.name, row]))
  assert.equal(field(byName.get("Acme Robotics"), "outcomes", "limited"), 1)
  assert.equal(field(byName.get("Northwind Labs"), "outcomes", "delivered"), 3)

  // A feature with no reader shows adoption only.
  const plain = feature(result, "mermaidZoom")
  assert.equal(plain.outcomes, null)
  assert.deepEqual(field(plain, "health"), { status: "not_used", count: null })
})

test("an interval Automation's occurrences mark its owner's use of the feature once per day", async () => {
  const { AutomationService } = await import("../../src/automations/service.js")
  const asOwner = den.as(acme.owner, acme.orgId)
  const schedule: AutomationIntervalSchedule = { kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 23 }
  const created = await asOwner("POST", "/v1/automations", {
    name: "Inbox sweep", instructions: "Sweep my inbox for anything urgent.", schedule,
    model: { providerId: AUTOMATION_FREE_MODEL.providerId, modelId: AUTOMATION_FREE_MODEL.modelId },
  })
  assert.equal(created.status, 201, summary(created))
  const automationId = text(field(created.body, "automation", "id"), "Automation id")
  let clock = Number(field(created.body, "automation", "nextDueAt"))
  let measuring = false
  const markFeaturesUsed = createFeatureUsageMarker((input) => recordFeatureUsage(db, input), () => new Date(clock))
  const service = new AutomationService({
    intervalSchedulesEnabled: async () => true,
    calendarTriggersEnabled: async () => false,
    markFeaturesUsed: (input) => { if (measuring) markFeaturesUsed(input) },
  })
  const usage = async () => {
    const [row] = await db.select({ daysUsed: FeatureUsageTable.days_used, lastUsedDay: FeatureUsageTable.last_used_day }).from(FeatureUsageTable).where(and(
      eq(FeatureUsageTable.member_id, normalizeDenTypeId("member", acme.owner.memberId)),
      eq(FeatureUsageTable.feature_key, "automationIntervalSchedules"),
    ))
    return row
  }
  const eventually = async (until: (row: Awaited<ReturnType<typeof usage>>) => boolean) => {
    for (let attempt = 0; attempt < 50 && !until(await usage()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    return usage()
  }
  /** Runs the due occurrence, then finishes it so the next one is not an overlap. */
  const occurrence = async () => {
    await service.tick({ now: clock })
    await db.update(AutomationRunTable).set({ status: "succeeded" }).where(eq(AutomationRunTable.automation_id, normalizeDenTypeId("automation", automationId)))
    const next = await asOwner("GET", `/v1/automations/${automationId}`)
    clock = Number(field(next.body, "automation", "nextDueAt"))
  }
  const day = (at: number) => new Date(at).toISOString().slice(0, 10)
  // The first occurrence follows the real clock, so after 18:00 UTC it is the day's last (21:00). Run on to the
  // next day's first occurrence without recording use, so the measured day has several occurrences at any hour.
  const createdDay = day(clock)
  while (day(clock) === createdDay) await occurrence()
  measuring = true
  const firstDay = day(clock)
  await occurrence()
  const first = await eventually((row) => row !== undefined)
  assert.deepEqual(first, { daysUsed: 1, lastUsedDay: firstDay })
  // Further occurrences that day write nothing more; the first one on the next day counts a second day.
  while (day(clock) === firstDay) await occurrence()
  const secondDay = day(clock)
  await occurrence()
  assert.deepEqual(await eventually((row) => row?.daysUsed === 2), { daysUsed: 2, lastUsedDay: secondDay })
  const runs = await asOwner("GET", `/v1/automations/${automationId}/runs`)
  assert.ok(list(field(runs.body, "items")).length >= 3, "several occurrences ran")
})
