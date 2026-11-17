import assert from "node:assert/strict"
import { test } from "node:test"
import { adminOutreachSchema } from "@openwork/types/den/admin-organization"
import { buildOutreach, companyClusters, type OutreachFacts, type OutreachPerson, type OutreachSubscription } from "../src/routes/admin/outreach-plays.js"

/** The admin Opportunities list: who to write to, at which account, and why. */

const NOW = new Date("2026-11-17T12:00:00.000Z")
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)

function person(userId: string, overrides: Partial<OutreachPerson> = {}): OutreachPerson {
  return { userId, name: `${userId} Example`, email: `${userId}@example.test`, role: "member", activeDays: 0, companyDomain: null, limitHits: 0, ...overrides }
}
function subscription(overrides: Partial<OutreachSubscription> = {}): OutreachSubscription {
  return { type: "seat", status: "active", paymentFailed: false, cancelAtPeriodEnd: false, currentPeriodEnd: daysAgo(-20), canceledAt: null, createdAt: daysAgo(90), ...overrides }
}
function account(id: string, overrides: Partial<OutreachFacts> = {}): OutreachFacts {
  return { id, name: `${id} workspace`, plan: "free", members: 1, seatLimit: 5, people: [person(`${id}-owner`, { role: "owner" })], subscriptions: [], followUp: null, ...overrides }
}
function followUp(overrides: Partial<NonNullable<OutreachFacts["followUp"]>> = {}): NonNullable<OutreachFacts["followUp"]> {
  return {
    stage: "contacted", ownerUserId: "admin", ownerName: "Sam", nextAction: null, nextFollowUpAt: null, lastContactedAt: null,
    lastActionKind: "contacted", lastActionAt: null, confirmedOpportunity: null, updatedAt: NOW.toISOString(), ...overrides,
  }
}
const list = (accounts: OutreachFacts[]) => buildOutreach(accounts, [], NOW)

test("a team running tasks without a plan names the busiest person and the owner", () => {
  const { items } = list([account("team", {
    members: 3,
    people: [person("owner", { role: "owner" }), person("ava", { activeDays: 9 }), person("ben", { activeDays: 2 })],
  })])
  assert.equal(items.length, 1)
  assert.equal(items[0]?.play, "team_no_plan")
  assert.equal(items[0]?.reason, "2 people ran tasks in the last 14 days, no Team plan")
  assert.equal(items[0]?.contact?.userId, "ava")
  assert.deepEqual(items[0]?.others.map(other => other.userId), ["ben", "owner"])
})

test("one person, or a team already on the Team plan, is not listed", () => {
  const busy = [person("a", { activeDays: 5 }), person("b", { activeDays: 5 })]
  assert.equal(list([account("solo", { people: [person("a", { activeDays: 12 })] })]).items.length, 0)
  assert.equal(list([account("paid", { members: 2, people: busy, subscriptions: [subscription()] })]).items.length, 0)
})

test("money reasons outrank usage reasons and go to the owner", () => {
  const { items } = list([account("late", {
    members: 2, subscriptions: [subscription({ type: "inference", status: "past_due" })],
    people: [person("owner", { role: "owner" }), person("ava", { activeDays: 9 }), person("ben", { activeDays: 3 })],
  })])
  assert.equal(items[0]?.play, "payment")
  assert.equal(items[0]?.reason, "Payment failed for the Models add-on")
  assert.equal(items[0]?.contact?.userId, "owner")
  assert.deepEqual(items[0]?.also, ["2 people ran tasks in the last 14 days, no Team plan"])
})

test("a plan set to end and a recent cancellation are listed; an old cancellation is not", () => {
  const ending = list([account("ending", { subscriptions: [subscription({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date("2026-11-30T00:00:00.000Z") })], people: [person("o", { role: "owner", activeDays: 1 })] })]).items[0]
  assert.equal(ending?.play, "cancelling")
  assert.equal(ending?.reason, "Team plan set to end Nov 30")
  assert.equal(ending?.endsAt, "2026-11-30T00:00:00.000Z")
  const gone = list([account("gone", { subscriptions: [subscription({ status: "canceled", canceledAt: daysAgo(5) })] })]).items[0]
  assert.equal(gone?.reason, "Canceled the Team plan on Nov 12")
  assert.equal(list([account("old", { subscriptions: [subscription({ status: "canceled", canceledAt: daysAgo(45) })] })]).items.length, 0)
})

test("the free model limit is a reason only without the Models add-on, and names who reached it", () => {
  const people = [person("owner", { role: "owner", activeDays: 1 }), person("kim", { name: "Kim Lee", activeDays: 6, limitHits: 3 })]
  const free = list([account("free", { members: 2, people })]).items[0]
  assert.equal(free?.play, "team_no_plan")
  assert.deepEqual(free?.also, ["Kim reached the free model limit 3 times in the last 7 days"])
  const solo = list([account("solo", { people: [person("kim", { name: "Kim Lee", activeDays: 6, limitHits: 1 })] })]).items[0]
  assert.equal(solo?.play, "free_limit")
  assert.equal(solo?.reason, "Kim reached the free model limit once in the last 7 days")
  assert.equal(solo?.contact?.userId, "kim")
  assert.equal(list([account("models", { people: [person("kim", { activeDays: 6, limitHits: 2 })], subscriptions: [subscription({ type: "inference" })] })]).items.length, 0)
})

test("a paid plan with no tasks seen is listed only once the plan is two weeks old", () => {
  assert.equal(list([account("quiet", { subscriptions: [subscription({ type: "inference" })] })]).items[0]?.reason, "Paying for the Models add-on, no tasks seen in 14 days")
  assert.equal(list([account("new", { subscriptions: [subscription({ createdAt: daysAgo(3) })] })]).items.length, 0)
})

test("colleagues in separate workspaces are grouped under the busiest person's workspace", () => {
  const seeds = companyClusters([
    { organizationId: "a", userId: "ava", activeDays: 9, companyDomain: "acme.test" },
    { organizationId: "b", userId: "ben", activeDays: 4, companyDomain: "acme.test" },
    { organizationId: "c", userId: "cy", activeDays: 0, companyDomain: "acme.test" },
    { organizationId: "d", userId: "dee", activeDays: 7, companyDomain: null },
    { organizationId: "e", userId: "eli", activeDays: 7, companyDomain: "solo.test" },
  ])
  assert.deepEqual(seeds, [{ domain: "acme.test", users: 2, organizations: 2, homeOrganizationId: "a", others: [{ organizationId: "b", userId: "ben" }] }])
  const ava = person("ava", { role: "owner", activeDays: 9, companyDomain: "acme.test" })
  const { items } = buildOutreach([account("a", { people: [ava] })], [{ ...seeds[0]!, others: [person("ben", { activeDays: 4, companyDomain: "acme.test" })] }], NOW)
  assert.equal(items[0]?.play, "company")
  assert.equal(items[0]?.reason, "2 people at acme.test ran tasks in 2 separate workspaces")
  assert.equal(items[0]?.company, "acme.test")
  assert.deepEqual(items[0]?.others.map(other => other.userId), ["ben"])
})

test("a contacted account waits, comes back when its follow-up is due, and stays hidden once dismissed", () => {
  const team = { members: 2, people: [person("a", { activeDays: 5 }), person("b", { activeDays: 5 })] }
  const waiting = list([account("wait", { ...team, followUp: followUp({ lastContactedAt: daysAgo(2).toISOString(), nextFollowUpAt: daysAgo(-5).toISOString() }) })])
  assert.equal(waiting.items.length, 0)
  assert.deepEqual(waiting.waiting.map(entry => [entry.organizationId, entry.ownerName]), [["wait", "Sam"]])

  const due = list([account("due", { ...team, followUp: followUp({ lastContactedAt: daysAgo(7).toISOString(), nextFollowUpAt: NOW.toISOString() }) })])
  assert.equal(due.items[0]?.play, "follow_up")
  assert.equal(due.items[0]?.reason, "No reply recorded since you wrote on Nov 10")
  assert.deepEqual(due.items[0]?.also, ["2 people ran tasks in the last 14 days, no Team plan"])
  assert.equal(due.waiting.length, 0)

  const dismissed = list([account("no", { ...team, followUp: followUp({ stage: "dismissed" }) }), account("idle", { followUp: followUp({ stage: "dismissed" }) })])
  assert.equal(dismissed.items.length, 0)
  assert.equal(dismissed.hidden, 1)
})

test("rows are ordered by reason, then by how many people use it, and the result matches the API schema", () => {
  const team = (id: string, active: number) => account(id, { members: active, people: Array.from({ length: active }, (_, index) => person(`${id}-${index}`, { activeDays: 3 })) })
  const result = list([team("small", 2), account("late", { subscriptions: [subscription({ paymentFailed: true })] }), team("big", 4)])
  assert.deepEqual(result.items.map(item => item.organizationId), ["late", "big", "small"])
  assert.equal(result.totals.team_no_plan, 2)
  assert.equal(result.totals.payment, 1)
  adminOutreachSchema.parse({ generatedAt: NOW.toISOString(), windowDays: 14, ...result })
})

test("each reason shows at most fifty rows while the total counts them all", () => {
  const many = Array.from({ length: 60 }, (_, index) => account(`org-${String(index).padStart(2, "0")}`, { subscriptions: [subscription({ status: "past_due" })] }))
  const result = list(many)
  assert.equal(result.items.length, 50)
  assert.equal(result.totals.payment, 60)
})
