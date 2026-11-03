import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { adminOpportunitiesSchema, adminOpportunityAccountSchema, adminOpportunityOverviewSchema, adminSignupCompaniesSchema } from "@openwork/types/den/admin-organization"
import { bootDen, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Opportunities fixtures require the disposable MySQL harness")
const query = (statement: string, values: (string | number | null)[] = []) => client.execute(statement, values)
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const owner = await den.signUp("Work Owner", `owner+${den.stamp}@studio.example.test`)
const peer = await den.signUp("Work Peer", `peer+${den.stamp}@studio.example.test`)
const work = await den.createOrg(owner, "Workplace example")
const teammate = await den.join(owner, work.orgId, peer)
const personalOwner = await den.signUp("Personal Owner", `owner+${den.stamp}@gmail.com`)
const personal = await den.createOrg(personalOwner, "Personal example")
const personalPeer = await den.signUp("Personal Peer", `peer+${den.stamp}@outlook.com`)
await den.join(personalOwner, personal.orgId, personalPeer)
const soloOwner = await den.signUp("Solo Owner", `solo+${den.stamp}@solo.example.test`)
const solo = await den.createOrg(soloOwner, "Solo example")
const quiet = await den.createOrg(owner, "No observed usage")
await den.join(owner, quiet.orgId, peer)
await query("UPDATE user SET email_verified = true WHERE id IN (?, ?, ?, ?, ?)", [owner.userId, peer.userId, personalOwner.userId, personalPeer.userId, soloOwner.userId])
await query("UPDATE user SET email = ? WHERE id = ?", [`peer+${den.stamp}@STUDIO.example.test`, peer.userId])
await query("UPDATE member SET joined_at = DATE_SUB(NOW(3), INTERVAL 60 DAY) WHERE organization_id IN (?, ?, ?, ?)", [work.orgId, personal.orgId, solo.orgId, quiet.orgId])

// These rows are setup, not observations. The public API must exclude pending,
// removed and provisional identities, and refuse cross-organization attribution.
const removed = createDenTypeId("member")
const pending = createDenTypeId("member")
const setupAgent = createDenTypeId("member")
const setupUser = await den.signUp("Provisional User")
await query("INSERT INTO member (id, organization_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, DATE_SUB(NOW(3), INTERVAL 5 DAY), NOW(3))", [removed, work.orgId, personalOwner.userId])
await query("INSERT INTO member (id, organization_id, user_id, joined_at) VALUES (?, ?, ?, NULL)", [pending, work.orgId, soloOwner.userId])
await query("INSERT INTO member (id, organization_id, user_id, is_setup_agent, joined_at) VALUES (?, ?, ?, 1, DATE_SUB(NOW(3), INTERVAL 5 DAY))", [setupAgent, work.orgId, setupUser.userId])
async function activity(orgId: string, memberId: string, minutesAgo: number) {
  await query("INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source) VALUES (?, ?, ?, 'user.active', DATE_SUB(NOW(3), INTERVAL ? MINUTE), 'app')", [createDenTypeId("telemetryEvent"), orgId, memberId, minutesAgo])
}
await activity(work.orgId, work.owner.memberId, 10)
await activity(work.orgId, teammate.memberId, 120)
await activity(personal.orgId, personal.owner.memberId, 4 * 1_440)
await activity(solo.orgId, solo.owner.memberId, 20)
await activity(work.orgId, removed, 1)
await activity(work.orgId, pending, 1)
await activity(work.orgId, setupAgent, 1)
await activity(personal.orgId, work.owner.memberId, 1)
// Future and pre-membership events must not make an organization active.
await activity(quiet.orgId, await den.memberIdOf(owner, quiet.orgId, owner.email), -60)
await activity(quiet.orgId, await den.memberIdOf(owner, quiet.orgId, owner.email), 70 * 1_440)

for (const [type, status, deleted] of [["skill", "active", 0], ["mcp", "active", 0], ["skill", "inactive", 0], ["mcp", "active", 1]]) {
  await query("INSERT INTO config_object (id, organization_id, object_type, source_mode, title, status, created_by_org_membership_id, deleted_at) VALUES (?, ?, ?, 'cloud', 'Example configuration', ?, ?, IF(? = 1, NOW(3), NULL))", [createDenTypeId("configObject"), work.orgId, type, status, work.owner.memberId, deleted])
}

async function report(search = "") {
  const response = await den.request(admin.token, "GET", `/v1/admin/opportunities${search ? `?${search}` : ""}`)
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.headers.get("cache-control"), "no-store")
  return adminOpportunitiesSchema.parse(response.body)
}

test("only a platform admin can read adoption signals, including organization owners", async () => {
  assert.equal((await den.request(null, "GET", "/v1/admin/opportunities/overview")).status, 401)
  assert.equal((await den.request(owner.token, "GET", "/v1/admin/opportunities/overview")).status, 403)
  const overview = await den.request(admin.token, "GET", "/v1/admin/opportunities/overview")
  assert.equal(overview.status, 200, summary(overview))
  assert.equal(overview.headers.get("cache-control"), "no-store")
  adminOpportunityOverviewSchema.parse(overview.body)
  assert.equal((await den.request(null, "GET", "/v1/admin/opportunities")).status, 401)
  assert.equal((await den.request(owner.token, "GET", "/v1/admin/opportunities")).status, 403)
  assert.equal((await den.request(peer.token, "GET", "/v1/admin/opportunities")).status, 403)
  const data = await report()
  assert.deepEqual(data.organizations.map(row => row.id), [work.orgId, personal.orgId])
  assert.ok(!JSON.stringify(data).includes(owner.email))
  assert.ok(!JSON.stringify(data).includes("Example configuration"))
})

test("current human users, verified email signals and Cloud counts stay scoped to their organization", async () => {
  const data = await report("companyEmail=1&setup=both")
  assert.equal(data.page.total, 1)
  const row = data.organizations[0]
  assert.ok(row)
  assert.equal(row.id, work.orgId)
  assert.equal(row.members, 2)
  assert.equal(row.activeMembers, 2)
  assert.equal(row.companyEmailMembers, 2)
  assert.equal(row.companyDomain, "studio.example.test")
  assert.equal(row.companyDomainCount, 1)
  assert.equal(row.skills, 1)
  assert.equal(row.mcpConnections, 1)
  const minutesAgo = (Date.now() - Date.parse(row.lastActiveAt)) / 60_000
  assert.ok(minutesAgo >= 9 && minutesAgo < 12, `last observation was ${minutesAgo} minutes ago`)
  const personalRow = (await report()).organizations.find(row => row.id === personal.orgId)
  assert.equal(personalRow?.companyDomain, null)
  assert.equal(personalRow?.companyEmailMembers, 0)
})

test("filters, full-result pagination and domain search run before the page limit", async () => {
  const first = await report("minMembers=1&limit=1")
  const second = await report("minMembers=1&limit=1&offset=1")
  assert.equal(first.page.total, 3)
  assert.equal(first.page.hasMore, true)
  assert.equal(first.organizations[0]?.id, work.orgId)
  assert.equal(second.organizations[0]?.id, solo.orgId)
  assert.equal((await report("search=studio.example.test")).page.total, 1)
  assert.equal((await report("search=%25_")).page.total, 0)
  assert.equal((await report("minMembers=5")).page.total, 0)
  assert.equal((await report("setup=skills")).page.total, 1)
  const invalid = await den.request(admin.token, "GET", "/v1/admin/opportunities?days=365")
  assert.equal(invalid.status, 400)
})

test("opaque cursors traverse every sort without duplicates and reject mismatched or invalid requests", async () => {
  for (const sort of ["recent", "active", "members"]) {
    const filters = new URLSearchParams({ minMembers: "1", limit: "1", sort })
    const first = await report(filters.toString())
    assert.ok(first.nextCursor)
    filters.set("cursor", first.nextCursor)
    const second = await report(filters.toString())
    assert.ok(second.nextCursor)
    filters.set("cursor", second.nextCursor)
    const third = await report(filters.toString())
    assert.equal(third.nextCursor, null)
    assert.equal(third.page.hasMore, false)
    const ids = [first, second, third].map(page => page.organizations[0]?.id)
    assert.equal(new Set(ids).size, 3)
    assert.deepEqual(ids, sort === "members" ? [work.orgId, personal.orgId, solo.orgId] : [work.orgId, solo.orgId, personal.orgId])
    assert.equal(second.page.total, 3)
    for (const suffix of ["&offset=0", "&search=changed", `&sort=${sort === "recent" ? "members" : "recent"}`]) {
      assert.equal((await den.request(admin.token, "GET", `/v1/admin/opportunities?${filters}${suffix}`)).status, 400)
    }
  }
  assert.equal((await den.request(admin.token, "GET", "/v1/admin/opportunities?cursor=invalid")).status, 400)
  assert.equal((await den.request(admin.token, "GET", "/v1/admin/opportunities?limit=101")).status, 400)
  // With identical activity timestamps, the stable organization-id tie break
  // must still reach both organizations exactly once.
  await query("UPDATE telemetry_event SET event_timestamp = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) WHERE org_id IN (?, ?)", [work.orgId, personal.orgId])
  const first = await report("limit=1")
  assert.ok(first.nextCursor)
  const second = await report(`limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
  assert.deepEqual([first.organizations[0]?.id, second.organizations[0]?.id], [work.orgId, personal.orgId].sort())
  assert.equal(second.nextCursor, null)
})

test("unverified company addresses do not qualify, and missing telemetry is not invented from sign-ins", async () => {
  await query("UPDATE user SET email_verified = false WHERE id IN (?, ?)", [owner.userId, peer.userId])
  assert.equal((await report("companyEmail=1")).page.total, 0)
  const data = await report("minMembers=1&days=90")
  assert.ok(!data.organizations.some(row => row.id === quiet.orgId))
})

test("weekly overview compares equal elapsed weeks, excludes invalid activity, and returns real signup and growth signals", async () => {
  const { opportunityWeek, readAdminOpportunityOverview } = await import("../../src/routes/admin/opportunity-overview.js")
  const now = new Date("2030-01-09T12:00:00Z")
  const week = opportunityWeek(now)
  assert.equal(week.from.toISOString(), "2030-01-07T00:00:00.000Z")
  assert.equal(week.previousFrom.toISOString(), "2029-12-31T00:00:00.000Z")
  assert.equal(week.previousTo.toISOString(), "2030-01-02T12:00:00.000Z")
  assert.equal(opportunityWeek(new Date("2030-01-07T00:00:00Z")).from.toISOString(), "2030-01-07T00:00:00.000Z")
  assert.equal(opportunityWeek(new Date("2030-01-13T23:59:59Z")).from.toISOString(), "2030-01-07T00:00:00.000Z")

  await query("UPDATE user SET created_at = '2030-01-07 00:00:00' WHERE id = ?", [owner.userId])
  await query("UPDATE user SET created_at = '2029-12-31 00:00:00' WHERE id = ?", [peer.userId])
  await query("UPDATE user SET created_at = '2030-01-08 00:00:00' WHERE id = ?", [setupUser.userId])
  await query("UPDATE member SET joined_at = '2030-01-08 00:00:00' WHERE id = ?", [teammate.memberId])
  async function observation(orgId: string, memberId: string, at: string) {
    await query("INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source) VALUES (?, ?, ?, 'user.active', ?, 'app')", [createDenTypeId("telemetryEvent"), orgId, memberId, at])
  }
  await observation(work.orgId, work.owner.memberId, "2030-01-07 00:00:00")
  await observation(work.orgId, teammate.memberId, "2030-01-08 01:00:00")
  await observation(quiet.orgId, quiet.owner.memberId, "2030-01-08 01:00:00")
  await observation(work.orgId, work.owner.memberId, "2029-12-31 00:00:00")
  await observation(personal.orgId, personal.owner.memberId, "2029-12-31 01:00:00")
  // Outside the equivalent elapsed period; not a previous-week active user.
  await observation(work.orgId, personal.owner.memberId, "2030-01-04 00:00:00")
  await observation(work.orgId, removed, "2030-01-08 01:00:00")
  await observation(work.orgId, pending, "2030-01-08 01:00:00")
  await observation(work.orgId, setupAgent, "2030-01-08 01:00:00")
  await observation(personal.orgId, work.owner.memberId, "2030-01-08 01:00:00")
  await observation(solo.orgId, solo.owner.memberId, "2030-01-10 00:00:00")
  const data = adminOpportunityOverviewSchema.parse(await readAdminOpportunityOverview(now))
  assert.deepEqual(data.signups, { current: 1, previous: 1 })
  assert.deepEqual(data.joinedMembers, { current: 1, previous: 0 })
  assert.deepEqual(data.activeUsers, { current: 2, previous: 2 })
  assert.deepEqual(data.activeOrganizations, { current: 2, previous: 2 })
  assert.deepEqual(data.daily, [
    { date: "2030-01-07", signups: 1, joinedMembers: 0 },
    { date: "2030-01-08", signups: 0, joinedMembers: 1 },
    { date: "2030-01-09", signups: 0, joinedMembers: 0 },
  ])
  assert.equal(data.recentSignups[0]?.id, owner.userId)
  assert.deepEqual(data.growingTeams, [{ id: work.orgId, name: "Workplace example", joinedMembers: 1 }])
  assert.deepEqual(data.risingActivity.find(row => row.id === work.orgId), { id: work.orgId, name: "Workplace example", current: 2, previous: 1 })
  assert.deepEqual(data.risingActivity.find(row => row.id === quiet.orgId), { id: quiet.orgId, name: "No observed usage", current: 1, previous: 0 })
  assert.deepEqual(data.fallingActivity, [{ id: personal.orgId, name: "Personal example", current: 0, previous: 1 }])
  assert.ok(!JSON.stringify(data).includes(owner.email))
})

test("recommendations name the reason, distinguish opportunity kinds and never treat missing telemetry as inactivity", async () => {
  const { buildOpportunity } = await import("../../src/routes/admin/opportunity-queue.js")
  const now = new Date("2030-01-09T12:00:00Z")
  const base = {
    id: "org_synthetic", name: "Synthetic team", createdAt: new Date("2029-10-01T00:00:00Z"), members: 2, seatLimit: 50,
    joinedThisWeek: 0, latestJoinAt: null, activeCurrent: 1, activePrevious: 1, lastObservedAt: new Date("2030-01-08T00:00:00Z"),
    skills: 0, mcpConnections: 0, subscriptions: [], signups: [], followUp: null,
  }
  assert.equal(buildOpportunity(base, now), null, "steady usage is not a sales signal")

  const welcome = buildOpportunity({ ...base, signups: [{ userId: "usr_synthetic", name: "New Person", createdAt: new Date("2030-01-08T09:00:00Z") }] }, now)
  assert.equal(welcome?.kind, "welcome")
  assert.equal(welcome?.priority, "low", "a signup alone is a welcome, not a priority sales lead")
  assert.equal(welcome?.signals[0]?.userId, "usr_synthetic")

  const activation = buildOpportunity({ ...base, createdAt: new Date("2030-01-03T00:00:00Z"), activeCurrent: 0, activePrevious: 0, lastObservedAt: null, skills: 2 }, now)
  assert.equal(activation?.kind, "activation")
  assert.match(activation?.why ?? "", /No observed app use/)
  assert.ok(activation?.signals.some(signal => signal.type === "setup_without_use"), "configuration is reported separately from usage")
  assert.equal(activation?.adoption.stage, "no_observed_use")

  const expansion = buildOpportunity({ ...base, joinedThisWeek: 2, latestJoinAt: new Date("2030-01-08T10:00:00Z"), activeCurrent: 3 }, now)
  assert.equal(expansion?.kind, "expansion")
  assert.equal(expansion?.priority, "high")
  assert.equal(expansion?.action.label, "Offer a team setup session")

  const seats = buildOpportunity({ ...base, members: 5, seatLimit: 5, joinedThisWeek: 1, latestJoinAt: new Date("2030-01-08T10:00:00Z") }, now)
  assert.equal(seats?.kind, "commercial", "a documented seat limit outranks a membership signal")
  assert.ok(seats?.signals.some(signal => signal.type === "members_joined"), "supporting signals stay visible")

  const trial = buildOpportunity({ ...base, subscriptions: [{ status: "trialing", cancelAtPeriodEnd: false, currentPeriodEnd: new Date("2030-01-12T00:00:00Z") }] }, now)
  assert.equal(trial?.kind, "commercial")
  assert.equal(trial?.why, "Trial ends Jan 12")

  const declining = buildOpportunity({ ...base, activeCurrent: 1, activePrevious: 4 }, now)
  assert.equal(declining?.kind, "declining")
  assert.match(declining?.action.purpose ?? "", /Telemetry can be missing/)

  const followUp = { stage: "contacted" as const, ownerUserId: null, ownerName: null, nextAction: "Send setup guide", nextFollowUpAt: null,
    lastContactedAt: "2030-01-05T00:00:00.000Z", lastActionKind: "contacted" as const, lastActionAt: "2030-01-05T00:00:00.000Z", confirmedOpportunity: null, updatedAt: "2030-01-05T00:00:00.000Z" }
  const recent = buildOpportunity({ ...base, joinedThisWeek: 2, followUp }, now)
  assert.equal(recent?.priority, "low", "a recently contacted account is not recommended for another message")
  assert.equal(recent?.action.label, "Wait before writing again")
  const due = buildOpportunity({ ...base, followUp: { ...followUp, nextFollowUpAt: "2030-01-08T00:00:00.000Z" } }, now)
  assert.equal(due?.kind, "follow_up")
  assert.equal(due?.why, "Follow-up overdue since Jan 8")
  assert.equal(due?.action.purpose, "Send setup guide")
  assert.equal(buildOpportunity({ ...base, joinedThisWeek: 3, followUp: { ...followUp, stage: "dismissed" } }, now), null)
  const ready = buildOpportunity({ ...base, followUp: { ...followUp, stage: "ready", lastContactedAt: null, nextAction: "Offer seat planning" } }, now)
  assert.equal(ready?.kind, "follow_up", "an account marked ready for outreach stays queued without other signals")
  assert.equal(ready?.action.label, "Offer seat planning")
})

test("only a platform admin reads account context and records follow-ups, which persist, deduplicate and drive the queue", async () => {
  const accountPath = `/v1/admin/opportunities/accounts/${work.orgId}`
  const today = new Date().toISOString().slice(0, 10)
  const step = (token: string | null, body: Record<string, unknown>) => den.request(token, "POST", `${accountPath}/actions`, { body })
  assert.equal((await den.request(null, "GET", accountPath)).status, 401)
  assert.equal((await den.request(owner.token, "GET", accountPath)).status, 403)
  assert.equal((await step(owner.token, { requestId: crypto.randomUUID(), kind: "note" })).status, 403)
  assert.equal((await den.request(admin.token, "GET", "/v1/admin/opportunities/accounts/not-an-org")).status, 400)

  const before = await den.request(admin.token, "GET", accountPath)
  assert.equal(before.status, 200, summary(before))
  assert.equal(before.headers.get("cache-control"), "no-store")
  const account = adminOpportunityAccountSchema.parse(before.body)
  assert.match(account.people[0]?.role ?? "", /owner/, "the owner is suggested first")
  assert.ok(account.people.every(person => person.userId !== setupUser.userId), "setup identities are not contacts")
  assert.equal(account.followUp, null)

  assert.equal((await step(admin.token, { requestId: crypto.randomUUID(), kind: "contacted", contactUserId: soloOwner.userId })).status, 400, "the contact must belong to the account")
  assert.equal((await step(admin.token, { requestId: crypto.randomUUID(), kind: "note", followUpOn: "2000-01-01" })).status, 400)
  const requestId = crypto.randomUUID()
  const contacted = { requestId, kind: "contacted", contactUserId: owner.userId, note: "Offered a team setup session", nextAction: "Confirm a time", followUpOn: today, assignToMe: true }
  const first = await step(admin.token, contacted)
  assert.equal(first.status, 200, summary(first))
  const retry = await step(admin.token, contacted)
  assert.deepEqual(retry.body, first.body, "a retried submission records one step")

  const recorded = adminOpportunityAccountSchema.parse((await den.request(admin.token, "GET", accountPath)).body)
  assert.equal(recorded.history.length, 1)
  assert.equal(recorded.history[0]?.contactName, "Work Owner")
  assert.equal(recorded.followUp?.stage, "contacted")
  assert.equal(recorded.followUp?.ownerName, "Platform Admin")
  assert.equal(recorded.followUp?.nextFollowUpAt, `${today}T00:00:00.000Z`)
  let overview = adminOpportunityOverviewSchema.parse((await den.request(admin.token, "GET", "/v1/admin/opportunities/overview")).body)
  const queued = overview.queue.find(item => item.organizationId === work.orgId)
  assert.equal(queued?.kind, "follow_up")
  assert.equal(queued?.action.purpose, "Confirm a time")
  assert.equal(overview.progress.outreach, 1)
  assert.equal(overview.progress.dueToday, 1)

  const replied = await step(admin.token, { requestId: crypto.randomUUID(), kind: "replied", contactUserId: owner.userId, followUpOn: null, confirmedOpportunity: "expansion" })
  assert.equal(replied.status, 200, summary(replied))
  overview = adminOpportunityOverviewSchema.parse((await den.request(admin.token, "GET", "/v1/admin/opportunities/overview")).body)
  assert.equal(overview.progress.conversations, 1)
  assert.equal(overview.progress.followUpsCompleted, 1)
  assert.equal(overview.progress.followUpsOnTime, 1)
  assert.equal(overview.progress.confirmedExpansion, 1)
  assert.equal(overview.progress.dueToday, 0)
  const engaged = adminOpportunityAccountSchema.parse((await den.request(admin.token, "GET", accountPath)).body)
  assert.equal(engaged.followUp?.stage, "engaged")
  assert.equal(engaged.followUp?.ownerName, "Platform Admin", "ownership is kept until reassigned")

  await step(admin.token, { requestId: crypto.randomUUID(), kind: "dismissed", note: "Not a fit right now" })
  overview = adminOpportunityOverviewSchema.parse((await den.request(admin.token, "GET", "/v1/admin/opportunities/overview")).body)
  assert.ok(!overview.queue.some(item => item.organizationId === work.orgId), "dismissed accounts leave the queue")
  assert.equal(overview.hidden.dismissed, 1)
})

test("signups group by company domain across organizations with plan, paid status and recorded outreach", async () => {
  // The weekly overview test moved these signups into 2030; future signups are not counted.
  await query("UPDATE user SET email_verified = true, created_at = DATE_SUB(NOW(3), INTERVAL 90 DAY) WHERE id IN (?, ?)", [owner.userId, peer.userId])
  const companies = async (search = "") => {
    const response = await den.request(admin.token, "GET", `/v1/admin/opportunities/companies${search ? `?${search}` : ""}`)
    assert.equal(response.status, 200, summary(response))
    assert.equal(response.headers.get("cache-control"), "no-store")
    return adminSignupCompaniesSchema.parse(response.body)
  }
  assert.equal((await den.request(owner.token, "GET", "/v1/admin/opportunities/companies")).status, 403)
  const all = await companies("outreach=any&activity=all&search=example.test")
  const studio = all.companies.find(row => row.domain === "studio.example.test")
  assert.ok(studio)
  assert.equal(studio.signups, 2)
  assert.ok(studio.organizations >= 2)
  assert.ok(studio.activeUsers >= 1, "earlier tests move some memberships, so at least the owner stays active")
  assert.deepEqual(studio.outreach.status, "contacted")
  assert.ok(studio.outreach.lastContactedAt)
  assert.equal(studio.workspaces[0]?.members, 2)
  assert.ok(!all.companies.some(row => row.domain === "gmail.com" || row.domain === "outlook.com"), "personal providers are not companies")
  assert.ok(!JSON.stringify(all).includes(owner.email))
  const soloCompany = all.companies.find(row => row.domain === "solo.example.test")
  assert.deepEqual(soloCompany?.billing, { plan: "free", paying: false, modelsAddOn: false })
  assert.equal(soloCompany?.outreach.status, "not_contacted")
  // Work was contacted in the follow-up test, so by default only the uncontacted solo company remains.
  assert.deepEqual((await companies("search=example.test")).companies.map(row => row.domain), ["solo.example.test"])

  await query("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.plan', JSON_OBJECT('tier', 'team')) WHERE id = ?", [solo.orgId])
  await query("INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, current_period_end) VALUES (?, ?, 'seat', 'active', 'cus_example', ?, DATE_ADD(NOW(3), INTERVAL 20 DAY))", [createDenTypeId("orgSubscription"), solo.orgId, `sub_${den.stamp}`])
  const paying = await companies("billing=paying&search=example.test")
  assert.deepEqual(paying.companies.map(row => [row.domain, row.billing.plan, row.billing.paying]), [["solo.example.test", "team", true]])
  assert.equal((await companies("billing=not_paying&search=solo.example.test")).page.total, 0)
  const adoption = await report("minMembers=1&outreach=not_contacted")
  assert.ok(!adoption.organizations.some(row => row.id === work.orgId), "contacted organizations leave the not-contacted filter")
  assert.deepEqual(adoption.organizations.find(row => row.id === solo.orgId)?.billing, { plan: "team", paying: true, modelsAddOn: false })
  assert.equal((await report("minMembers=1&outreach=contacted")).organizations[0]?.outreach.status, "contacted")
  assert.equal((await den.request(admin.token, "GET", "/v1/admin/opportunities/companies?sort=size")).status, 400)
  const firstPage = await companies("outreach=any&activity=all&search=example.test&limit=1")
  assert.ok(firstPage.nextCursor)
  const secondPage = await companies(`outreach=any&activity=all&search=example.test&limit=1&cursor=${firstPage.nextCursor}`)
  assert.equal(secondPage.nextCursor, null)
  assert.equal(new Set([...firstPage.companies, ...secondPage.companies].map(row => row.domain)).size, 2)
  assert.equal((await den.request(admin.token, "GET", `/v1/admin/opportunities/companies?outreach=contacted&limit=1&cursor=${firstPage.nextCursor}`)).status, 400)
})
