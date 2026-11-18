/**
 * The platform admin Opportunities list reads real tables: who ran tasks, recorded
 * subscriptions, free model limit refusals and the team's own follow-up steps. Only
 * platform admins can read it, and recording a step moves the account off the list.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { OUTREACH_PLAYS, adminOutreachSchema } from "@openwork/types/den/admin-organization"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, summary, type Call, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Outreach fixtures require the disposable MySQL harness")
const query = (statement: string, values: (string | number | null)[] = []) => client.execute(statement, values)
const utc = (at: Date) => at.toISOString().replace("T", " ").replace("Z", "")
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const person = await den.signUp("Regular Person")

async function ranTasks(orgId: string, member: Member, days: number[], source = "app", type = "task.started") {
  for (const day of days) {
    await query("INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [createDenTypeId("telemetryEvent"), orgId, member.memberId, type, utc(daysAgo(day)), source, randomUUID()])
  }
}
async function subscribe(orgId: string, type: string, status: string, createdDaysAgo = 60) {
  await query("INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [createDenTypeId("orgSubscription"), orgId, type, status, `cus_${randomUUID()}`, `sub_${randomUUID()}`, utc(daysAgo(createdDaysAgo))])
}
async function workAddress(session: { userId: string }, address: string) {
  await query("UPDATE user SET email = ?, email_verified = 1 WHERE id = ?", [address, session.userId])
}

// A team of three on the free plan: two of them ran tasks, one far more often.
const team = await den.createOrg(await den.signUp("Team Owner"), "Maple Robotics")
const ava = await den.newMember(team.owner, team.orgId, "Ava Busy")
const ben = await den.newMember(team.owner, team.orgId, "Ben Light")
await ranTasks(team.orgId, ava, [1, 2, 3, 5])
await ranTasks(team.orgId, ben, [2])
// Runtime events and old events are not people using the app.
await ranTasks(team.orgId, team.owner, [1], "worker")
await ranTasks(team.orgId, team.owner, [20])

// A paying workspace whose payment failed.
const late = await den.createOrg(await den.signUp("Late Owner"), "Harbor Analytics")
await subscribe(late.orgId, "inference", "past_due")

// Two colleagues, each alone in their own workspace.
const domain = `acme-${den.stamp}.test`.toLowerCase()
const cy = await den.createOrg(await den.signUp("Cy Colleague"), "Cy's workspace")
const dee = await den.createOrg(await den.signUp("Dee Colleague"), "Dee's workspace")
await workAddress(cy.owner, `cy@${domain}`)
await workAddress(dee.owner, `dee@${domain}`)
await ranTasks(cy.orgId, cy.owner, [1, 2, 3])
await ranTasks(dee.orgId, dee.owner, [1])

// Someone alone who ran out of free model use twice this week.
const kim = await den.createOrg(await den.signUp("Kim Limit"), "Kim's workspace")
await ranTasks(kim.orgId, kim.owner, [1])
for (const hours of [3, 30]) {
  await query("INSERT INTO free_auto_limit_events (id, audience, subject_hash, user_id, organization_id, window_start_at, exhausted_at) VALUES (?, 'member', ?, ?, ?, ?, ?)",
    [randomUUID(), randomUUID().replaceAll("-", ""), kim.owner.userId, kim.orgId, utc(daysAgo(7)), utc(new Date(Date.now() - hours * 3_600_000))])
}

// Someone with a work address who used it for a week, saw half the tasks fail, and stopped three weeks ago.
const quill = await den.createOrg(await den.signUp("Quill Gone"), "Quill Partners")
await workAddress(quill.owner, `quill@quill-${den.stamp}.test`.toLowerCase())
await ranTasks(quill.orgId, quill.owner, [21, 22, 22, 23, 24, 25])
await ranTasks(quill.orgId, quill.owner, [22, 23, 24], "app", "task.failed")

async function outreach() {
  const response: Call = await den.request(admin.token, "GET", "/v1/admin/opportunities/outreach")
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.headers.get("cache-control"), "no-store")
  return adminOutreachSchema.parse(response.body)
}
const record = (orgId: string, body: Record<string, unknown>) =>
  den.request(admin.token, "POST", `/v1/admin/opportunities/accounts/${orgId}/actions`, { body: { requestId: randomUUID(), ...body } })

test("only platform admins can read the outreach list", async () => {
  assert.equal((await den.request(null, "GET", "/v1/admin/opportunities/outreach")).status, 401)
  assert.equal((await den.request(person.token, "GET", "/v1/admin/opportunities/outreach")).status, 403)
})

test("each account is listed under its strongest reason with the person to write to", async () => {
  const list = await outreach()
  const row = (orgId: string) => list.items.find(item => item.organizationId === orgId)

  const maple = row(team.orgId)
  assert.equal(maple?.play, "team_no_plan")
  assert.equal(maple?.reason, "2 people ran tasks in the last 14 days, no Team plan")
  assert.deepEqual(maple?.people, { members: 3, active: 2 })
  assert.equal(maple?.contact?.email, ava.email)
  assert.equal(maple?.contact?.activeDays, 4)
  assert.deepEqual(maple?.others.map(other => other.email), [ben.email, team.owner.email])

  const harbor = row(late.orgId)
  assert.equal(harbor?.play, "payment")
  assert.equal(harbor?.contact?.email, late.owner.email)
  assert.equal(harbor?.billing.paying, false)

  const colleagues = row(cy.orgId)
  assert.equal(colleagues?.play, "company")
  assert.equal(colleagues?.reason, `2 people at ${domain} ran tasks in 2 separate workspaces`)
  assert.equal(colleagues?.contact?.email, `cy@${domain}`)
  assert.deepEqual(colleagues?.others.map(other => other.email), [`dee@${domain}`])
  assert.equal(row(dee.orgId), undefined, "the company is listed once")

  const limited = row(kim.orgId)
  assert.equal(limited?.play, "free_limit")
  assert.equal(limited?.reason, "Kim reached the free model limit 2 times in the last 7 days")

  const gone = row(quill.orgId)
  assert.equal(gone?.play, "lapsed_failed")
  assert.equal(gone?.reason, "Stopped 21 days ago after 3 of 6 tasks failed")
  assert.deepEqual(gone?.people, { members: 1, active: 0 })
  assert.equal(gone?.lastActiveAt?.slice(0, 10), daysAgo(21).toISOString().slice(0, 10))
  assert.deepEqual(list.results, { days: 30, contacted: 0, replied: 0, quietWhenContacted: 0, cameBack: 0 })

  assert.deepEqual(list.items.map(item => item.play), [...list.items].map(item => item.play).sort((a, b) => order(a) - order(b)), "strongest reasons first")
})
const order = (play: string) => (OUTREACH_PLAYS as readonly string[]).indexOf(play)

test("marking an account contacted moves it to waiting, and not a fit hides it", async () => {
  const followUpOn = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  const contacted = await record(team.orgId, { kind: "contacted", contactUserId: ava.userId, followUpOn, assignToMe: true })
  assert.equal(contacted.status, 200, summary(contacted))
  assert.equal((await record(quill.orgId, { kind: "contacted", followUpOn })).status, 200)
  const dismissed = await record(late.orgId, { kind: "dismissed" })
  assert.equal(dismissed.status, 200, summary(dismissed))

  const list = await outreach()
  assert.equal(list.items.some(item => item.organizationId === team.orgId || item.organizationId === late.orgId), false)
  const waiting = list.waiting.find(entry => entry.organizationId === team.orgId)
  assert.equal(waiting?.ownerName, "Platform Admin")
  assert.equal(waiting?.followUpAt?.slice(0, 10), followUpOn)
  assert.equal(list.hidden >= 1, true)
  // The team ran tasks this week; Quill had been quiet for three weeks when it was contacted.
  assert.deepEqual(list.results, { days: 30, contacted: 2, replied: 0, quietWhenContacted: 1, cameBack: 0 })

  assert.equal((await record(late.orgId, { kind: "reopened" })).status, 200)
  assert.equal((await outreach()).items.find(item => item.organizationId === late.orgId)?.play, "payment")
})
