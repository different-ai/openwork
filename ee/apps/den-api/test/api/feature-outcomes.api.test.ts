/**
 * /admin › Features: per feature and across organizations, whether it is used and working. The readers aggregate
 * the stores that already own the outcomes (automation_run, Your agent's checks, slack_send_as_bot's limits), seeded
 * here as the product writes them; background work marks feature_usage once per day.
 */
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
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
// Your agent is the remaining background feature that reports outcomes; the schedule-trigger
// outcome features are retired (GA), so they are no longer seeded or asserted here.
const turnedOn: Array<[string, string]> = [
  [acme.orgId, "workbotProactive"],
]
for (const [orgId, key] of turnedOn) {
  const set = await den.setFeature(orgId, key, true)
  assert.equal(set.status, 200, `${key}: ${summary(set)}`)
}
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")
const { db } = await import("../../src/db.js")
const { recordFeatureUsage } = await import("@openwork-ee/den-db/organization-features")

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
await recordFeatureUsage(db, { organizationId: acme.orgId, memberId: acmeMember.memberId, keys: ["workbotProactive"], at: daysAgo(0, 1) })

const report = (range?: string) => den.request(adminToken, "GET", `/v1/admin/feature-usage${range ? `?range=${range}` : ""}`)
const detail = (key: string, range = "7d") => den.request(adminToken, "GET", `/v1/admin/feature-usage/${key}?range=${range}`)
function feature(call: Call, key: string) {
  const entry = list(field(call.body, "features")).find((row) => row.key === key)
  assert.ok(entry, `${key} in ${summary(call)}`)
  return entry
}

test("only platform administrators read feature outcomes", async () => {
  for (const path of ["/v1/admin/feature-usage", "/v1/admin/feature-usage/workbotProactive"]) {
    for (const token of [null, acme.owner.token, acmeMember.token, northwind.owner.token]) {
      const result = await den.request(token, "GET", path)
      assert.equal(result.status, token ? 403 : 401, `${path}: ${summary(result)}`)
    }
  }
  assert.equal((await report("90d")).status, 400)
  assert.equal((await detail("notARealFeature")).status, 400)
})

test("Your agent: runs, how they ended and why, by organization, this week", async () => {
  const result = await report()
  assert.equal(result.status, 200, summary(result))
  assert.equal(field(result.body, "range"), "7d")
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

  // A feature with no reader shows adoption only.
  const plain = feature(result, "settledSessions")
  assert.equal(plain.outcomes, null)
  assert.deepEqual(field(plain, "health"), { status: "not_used", count: null })
})

test("30 days include the older runs, uses and counters", async () => {
  const result = await report("30d")
  assert.equal(result.status, 200, summary(result))
  const agent = feature(result, "workbotProactive")
  assert.equal(field(agent, "outcomes", "succeeded"), 21)
  // Check records are kept two weeks, so failures before then are not known.
  assert.equal(field(agent, "outcomes", "coverage", "counts"), "failed")
})

test("Slack bot operational outcomes remain visible after its rollout graduates", async () => {
  const result = await den.request(adminToken, "GET", "/v1/admin/slack-send-as-bot/outcomes?range=7d")
  assert.equal(result.status, 200, summary(result))
  const outcomes = field(result.body, "outcomes")
  assert.equal(field(outcomes, "unit"), "message")
  assert.equal(field(outcomes, "delivered"), 21)
  assert.equal(field(outcomes, "failed"), 2)
  assert.equal(field(outcomes, "limited"), 1)
  assert.equal(field(outcomes, "coverage", "counts"), "all")
  assert.deepEqual(field(result.body, "health"), { status: "limited", count: 1 })
  const byOrg = new Map(list(field(result.body, "byOrganization")).map((row) => [row.organizationId, row]))
  assert.equal(field(byOrg.get(acme.orgId), "outcomes", "limited"), 1)
  assert.equal(field(byOrg.get(northwind.orgId), "outcomes", "delivered"), 3)
  assert.equal((await den.request(acme.owner.token, "GET", "/v1/admin/slack-send-as-bot/outcomes")).status, 403)
})
