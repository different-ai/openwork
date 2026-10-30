import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyAdminPlan,
  canAddPerson,
  normalizePlanEndDate,
  personAddRefusal,
  planLimitReachedMessage,
  planPaidBy,
  resolveOrganizationPlanState,
  type OrganizationPlanInput,
} from "../src/organization-plan.js"

const today = "2026-10-26"
const base: OrganizationPlanInput = {
  plan: { tier: "free", source: "default" },
  metadata: {},
  users: 0,
  paidBy: "none",
  gateEnabled: true,
  today,
}
const resolve = (overrides: Partial<OrganizationPlanInput>) => resolveOrganizationPlanState({ ...base, ...overrides })

test("Free allows 5 users, counting pending invitations", () => {
  const state = resolve({ users: 4 })
  assert.deepEqual(state, { tier: "free", source: "default", paidBy: "none", users: 4, userLimit: 5, seats: null, endsAt: null, ended: false })
  assert.equal(canAddPerson(state), true)
  const full = resolve({ users: 5 })
  assert.equal(canAddPerson(full), false)
  assert.equal(personAddRefusal(full), "free_limit_reached")
})

test("Free with extra users a platform admin allowed", () => {
  const state = resolve({ users: 7, metadata: { seatsFreeAdditional: 3 } })
  assert.equal(state.userLimit, 8)
  assert.equal(canAddPerson(state), true)
  assert.equal(personAddRefusal(resolve({ users: 8, metadata: { seatsFreeAdditional: 3 } })), "free_limit_reached")
})

test("a Team or Enterprise plan a platform admin set allows its seats, never fewer than 5", () => {
  for (const tier of ["team", "enterprise"] as const) {
    const state = resolve({ plan: { tier, source: "manual" }, metadata: { plan: { tier, source: "manual", seats: 20 }, seatsFreeAdditional: 40 }, users: 19 })
    assert.equal(state.userLimit, 20, "extra free users never apply to a paid tier")
    assert.equal(state.seats, 20)
    assert.equal(canAddPerson(state), true)
    const full = resolve({ plan: { tier, source: "manual" }, metadata: { plan: { tier, source: "manual", seats: 20 } }, users: 20 })
    assert.equal(personAddRefusal(full), "plan_limit_reached")
  }
  const small = resolve({ plan: { tier: "enterprise", source: "manual" }, metadata: { plan: { seats: 2 } }, users: 4 })
  assert.equal(small.userLimit, 5)
  assert.equal(small.seats, 5)
})

test("seats fall back to the legacy limits.members value", () => {
  const state = resolve({ plan: { tier: "enterprise", source: "manual" }, metadata: { limits: { members: 1000 } }, users: 31 })
  assert.equal(state.userLimit, 1000)
  const missing = resolve({ plan: { tier: "team", source: "manual" }, metadata: {}, users: 3 })
  assert.equal(missing.userLimit, 5)
})

test("a grandfathered plan follows the same rule as an admin-set plan", () => {
  const state = resolve({ plan: { tier: "enterprise", source: "grandfathered" }, metadata: { limits: { members: 32 } }, users: 32 })
  assert.equal(state.userLimit, 32)
  assert.equal(personAddRefusal(state), "plan_limit_reached")
})

test("an active Team subscription has no limit, even on top of an admin-set Enterprise plan", () => {
  assert.equal(resolve({ plan: { tier: "team", source: "stripe" }, paidBy: "stripe_team", users: 500 }).userLimit, null)
  const manual = resolve({ plan: { tier: "enterprise", source: "manual" }, metadata: { plan: { seats: 20 } }, paidBy: "stripe_team", users: 50 })
  assert.equal(manual.userLimit, null)
  assert.equal(canAddPerson(manual), true)
  assert.equal(personAddRefusal(manual), null)
})

test("a Team plan Stripe set without an active subscription falls back to the Free limit", () => {
  assert.equal(resolve({ plan: { tier: "team", source: "stripe" }, users: 5 }).userLimit, 5)
})

test("who pays: a Team (seat) subscription while active or trialing; Enterprise is never paid through Stripe", () => {
  assert.equal(planPaidBy({ seat: { status: "active" } }), "stripe_team")
  assert.equal(planPaidBy({ seat: { status: "trialing" } }), "stripe_team")
  for (const status of ["past_due", "canceled", "unpaid", "incomplete"]) {
    assert.equal(planPaidBy({ seat: { status } }), "none", status)
  }
  assert.equal(planPaidBy({ seat: null }), "none")
})

test("where seat billing does not gate member additions nothing is limited", () => {
  assert.equal(resolve({ gateEnabled: false, users: 50 }).userLimit, null)
  assert.equal(resolve({ gateEnabled: false, plan: { tier: "enterprise", source: "manual" }, metadata: { plan: { seats: 20 } }, users: 50 }).userLimit, null)
})

test("a passed end date shows as ended but changes nothing", () => {
  const metadata = { plan: { tier: "enterprise", source: "manual", seats: 20, endsAt: "2026-10-25" } }
  const ended = resolve({ plan: { tier: "enterprise", source: "manual" }, metadata, users: 7 })
  assert.equal(ended.endsAt, "2026-10-25")
  assert.equal(ended.ended, true)
  assert.equal(ended.userLimit, 20)
  assert.equal(canAddPerson(ended), true)
  const lastDay = resolve({ plan: { tier: "enterprise", source: "manual" }, metadata: { plan: { endsAt: today } } })
  assert.equal(lastDay.ended, false, "the end date itself is still the plan's last day")
  assert.equal(resolve({ metadata: { plan: { endsAt: "2020-01-01" } } }).endsAt, null, "Free has no end date")
})

test("end dates are real calendar dates", () => {
  assert.equal(normalizePlanEndDate("2026-11-22"), "2026-11-22")
  assert.equal(normalizePlanEndDate("2026-02-30"), null)
  assert.equal(normalizePlanEndDate("2026-11-22T00:00:00Z"), null)
  assert.equal(normalizePlanEndDate(null), null)
})

test("the full-plan message names the plan and its users", () => {
  assert.equal(planLimitReachedMessage({ tier: "enterprise", userLimit: 20 }), "Your Enterprise plan includes 20 users, counting pending invitations. Ask your OpenWork contact to add seats.")
  assert.equal(planLimitReachedMessage({ tier: "team", userLimit: 8 }), "Your Team plan includes 8 users, counting pending invitations. Ask your OpenWork contact to add seats.")
})

test("saving Enterprise stores seats and the end date, mirrors limits.members and clears extra free users", () => {
  const now = new Date("2026-10-26T12:00:00Z")
  const next = applyAdminPlan({ plan: { tier: "free", source: "default" }, seatsFreeAdditional: 10, limits: { members: 5, workers: 1 }, brandAppName: "Acme" }, { tier: "enterprise", seatLimit: 20, endsAt: "2026-11-22" }, now)
  assert.deepEqual(next, {
    plan: { tier: "enterprise", source: "manual", seats: 20, endsAt: "2026-11-22", grantedAt: now.toISOString() },
    limits: { members: 20, workers: 1 },
    brandAppName: "Acme",
  })
  const edited = applyAdminPlan(next, { tier: "enterprise", seatLimit: 25, endsAt: null }, new Date("2026-12-01T00:00:00Z"))
  assert.deepEqual(edited.plan, { tier: "enterprise", source: "manual", seats: 25, grantedAt: now.toISOString() }, "editing keeps the original grant and clears the end")
})

test("saving a grandfathered plan keeps its history and never goes below 5", () => {
  const next = applyAdminPlan({ plan: { tier: "enterprise", source: "grandfathered", grandfatheredAt: "2026-01-01T00:00:00.000Z" } }, { tier: "team", seatLimit: 2 }, new Date("2026-10-26T00:00:00Z"))
  assert.deepEqual(next.plan, { tier: "team", source: "manual", grandfatheredAt: "2026-01-01T00:00:00.000Z", seats: 5 })
  assert.deepEqual(next.limits, { members: 5 })
})

test("saving Free stores the users allowed as extra free users and drops paid-plan fields", () => {
  const next = applyAdminPlan({ plan: { tier: "enterprise", source: "manual", seats: 20, endsAt: "2026-11-22", grantedAt: "x" } }, { tier: "free", seatLimit: 12, endsAt: "2026-11-22" }, new Date())
  assert.deepEqual(next, { plan: { tier: "free", source: "manual" }, limits: { members: 12 }, seatsFreeAdditional: 7 })
  const state = resolveOrganizationPlanState({ ...base, metadata: next, plan: { tier: "free", source: "manual" }, users: 11 })
  assert.equal(state.userLimit, 12)
  assert.equal(applyAdminPlan({}, { tier: "free", seatLimit: 3 }, new Date()).seatsFreeAdditional, 0)
})
