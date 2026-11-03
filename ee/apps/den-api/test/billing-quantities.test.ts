import assert from "node:assert/strict"
import { test } from "node:test"
import {
  calculateOrganizationBillingQuantities,
  canAddUserWithoutSeatSubscription,
  FREE_ORG_SEAT_COUNT,
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
