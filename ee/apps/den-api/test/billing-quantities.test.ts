import assert from "node:assert/strict"
import { test } from "node:test"
import {
  calculateOrganizationBillingQuantities,
  canAddUserWithoutSeatSubscription,
  FREE_ORG_SEAT_COUNT,
  planAfterSubscriptionChange,
  enterpriseSubscriptionQuantity,
  minimumUsersFromStripeMetadata,
} from "../src/billing-quantities.js"

test("every subscription bills the same users", () => {
  // e.g. 4 joined members + 2 pending invitations that have not expired.
  const quantities = calculateOrganizationBillingQuantities({ users: 6 })
  assert.equal(quantities.seats.total, 6)
  assert.equal(quantities.seats.chargeable, 6)
  assert.equal(quantities.models.users, 6)
  assert.equal(quantities.models.quantity, 6)
  assert.equal(quantities.web.quantity, 6)
})

test("the Team plan bills every user, at any size", () => {
  // An organization may upgrade with a single user.
  assert.equal(calculateOrganizationBillingQuantities({ users: 1 }).seats.chargeable, 1)
  assert.equal(calculateOrganizationBillingQuantities({ users: FREE_ORG_SEAT_COUNT }).seats.chargeable, FREE_ORG_SEAT_COUNT)
  assert.equal(calculateOrganizationBillingQuantities({ users: 23 }).seats.chargeable, 23)
})

test("a raised Free plan limit only moves the upgrade point, never what Team bills", () => {
  const quantities = calculateOrganizationBillingQuantities({ users: 8, metadata: { seatsFreeAdditional: 5 } })
  assert.equal(quantities.seats.free, 10)
  assert.equal(quantities.seats.additionalFree, 5)
  assert.equal(quantities.seats.chargeable, 8)
  assert.equal(canAddUserWithoutSeatSubscription(quantities.seats), true)
})

test("Stripe quantities stay valid for empty and malformed counts", () => {
  const empty = calculateOrganizationBillingQuantities({ users: 0 })
  assert.equal(empty.models.users, 0)
  assert.equal(empty.models.quantity, 1)
  assert.equal(empty.seats.chargeable, 0)
  assert.equal(empty.web.quantity, 0)

  const malformed = calculateOrganizationBillingQuantities({ users: Number.NaN, additionalFreeSeats: -2 })
  assert.equal(malformed.users, 0)
  assert.equal(malformed.seats.free, FREE_ORG_SEAT_COUNT)
})

test("the Free plan allows users up to its limit; the next one needs the Team plan", () => {
  assert.equal(canAddUserWithoutSeatSubscription({ total: 4, free: 5 }), true)
  assert.equal(canAddUserWithoutSeatSubscription({ total: 5, free: 5 }), false)
})

test("paying for Team makes the organization Team; ending it returns it to Free", () => {
  const team = { team: true, enterprise: false }
  const none = { team: false, enterprise: false }
  assert.deepEqual(planAfterSubscriptionChange({ tier: "free", source: "default" }, team), { tier: "team", source: "stripe" })
  assert.equal(planAfterSubscriptionChange({ tier: "team", source: "stripe" }, team), null)
  assert.deepEqual(planAfterSubscriptionChange({ tier: "team", source: "stripe" }, none), { tier: "free", source: "default" })
  assert.equal(planAfterSubscriptionChange({ tier: "free", source: "default" }, none), null)
})

test("an Enterprise subscription makes the organization Enterprise and outranks Team", () => {
  assert.deepEqual(planAfterSubscriptionChange({ tier: "free", source: "default" }, { team: false, enterprise: true }), { tier: "enterprise", source: "stripe" })
  assert.deepEqual(planAfterSubscriptionChange({ tier: "team", source: "stripe" }, { team: true, enterprise: true }), { tier: "enterprise", source: "stripe" })
  assert.equal(planAfterSubscriptionChange({ tier: "enterprise", source: "stripe" }, { team: true, enterprise: true }), null)
})

test("ending an Enterprise subscription falls back to Team while Team is paid, otherwise Free", () => {
  assert.deepEqual(planAfterSubscriptionChange({ tier: "enterprise", source: "stripe" }, { team: true, enterprise: false }), { tier: "team", source: "stripe" })
  assert.deepEqual(planAfterSubscriptionChange({ tier: "enterprise", source: "stripe" }, { team: false, enterprise: false }), { tier: "free", source: "default" })
})

test("Stripe never changes admin-set, grandfathered or non-Stripe Enterprise plans", () => {
  for (const subscribed of [{ team: false, enterprise: false }, { team: true, enterprise: false }, { team: false, enterprise: true }]) {
    assert.equal(planAfterSubscriptionChange({ tier: "enterprise", source: "manual" }, subscribed), null)
    assert.equal(planAfterSubscriptionChange({ tier: "team", source: "manual" }, subscribed), null)
    assert.equal(planAfterSubscriptionChange({ tier: "free", source: "manual" }, subscribed), null)
    assert.equal(planAfterSubscriptionChange({ tier: "enterprise", source: "grandfathered" }, subscribed), null)
    assert.equal(planAfterSubscriptionChange({ tier: "enterprise", source: "default" }, subscribed), null)
  }
})

test("Enterprise bills every user, never below the committed minimum, and at least 1", () => {
  assert.equal(enterpriseSubscriptionQuantity({ users: 120, minimumUsers: 50 }), 120)
  assert.equal(enterpriseSubscriptionQuantity({ users: 12, minimumUsers: 50 }), 50)
  assert.equal(enterpriseSubscriptionQuantity({ users: 0, minimumUsers: 0 }), 1)
  assert.equal(enterpriseSubscriptionQuantity({ users: Number.NaN, minimumUsers: -3 }), 1)
})

test("the committed minimum is read only from a whole number in Stripe metadata", () => {
  assert.equal(minimumUsersFromStripeMetadata({ minimum_users: "50" }), 50)
  assert.equal(minimumUsersFromStripeMetadata({ minimum_users: " 7 " }), 7)
  assert.equal(minimumUsersFromStripeMetadata({ minimum_users: "-5" }), 0)
  assert.equal(minimumUsersFromStripeMetadata({ minimum_users: "12.5" }), 0)
  assert.equal(minimumUsersFromStripeMetadata({}), 0)
  assert.equal(minimumUsersFromStripeMetadata(null), 0)
})
