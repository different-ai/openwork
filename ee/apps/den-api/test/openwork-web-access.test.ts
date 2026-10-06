import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { OrganizationTable } from "@openwork-ee/den-db/schema"
import { createOpenWorkWebPaidSourceRegistry, type OpenWorkWebPaidSource } from "../src/core/providers/openwork-web-paid-source.js"
import { createSubscriptionChangeRegistry, type SubscriptionChange } from "../src/core/providers/subscription-changes.js"
import { createSubscriptionStatusRegistry, subscriptionStatus } from "../src/core/providers/subscription-status.js"
import { hasOpenWorkWebComplimentaryAccess, setOpenWorkWebComplimentaryAccess } from "../src/openwork-web/complimentary.js"
import { composeOpenWorkWebSummary, NO_OPENWORK_WEB_BILLING, resolveOpenWorkWebAccess } from "../src/openwork-web/resolve.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

function orgId(value: string): OrgId {
  const id: OrgId = `org_${value}`
  return id
}

describe("resolveOpenWorkWebAccess", () => {
  const cases: Array<[boolean, boolean, boolean, "subscription" | "complimentary" | null]> = [
    [true, true, true, "subscription"],
    [true, true, false, "subscription"],
    [true, false, true, "complimentary"],
    [true, false, false, null],
    [false, true, true, "complimentary"],
    [false, true, false, null],
    [false, false, true, "complimentary"],
    [false, false, false, null],
  ]
  for (const [deploymentAvailable, hasEligibleSubscription, complimentaryAccess, accessSource] of cases) {
    test(`deployment=${deploymentAvailable} subscription=${hasEligibleSubscription} complimentary=${complimentaryAccess} -> ${accessSource}`, () => {
      assert.deepEqual(
        resolveOpenWorkWebAccess({ deploymentAvailable, hasEligibleSubscription, complimentaryAccess }),
        { hasAccess: accessSource !== null, accessSource, complimentaryAccess },
      )
    })
  }
})

describe("complimentary grant", () => {
  test("reads object and JSON metadata", () => {
    assert.equal(hasOpenWorkWebComplimentaryAccess({ complimentaryAccess: { openworkWeb: true } }), true)
    assert.equal(hasOpenWorkWebComplimentaryAccess(JSON.stringify({ complimentaryAccess: { openworkWeb: true } })), true)
    assert.equal(hasOpenWorkWebComplimentaryAccess({ complimentaryAccess: { openworkWeb: "yes" } }), false)
    assert.equal(hasOpenWorkWebComplimentaryAccess("not json"), false)
    assert.equal(hasOpenWorkWebComplimentaryAccess(null), false)
  })

  test("set and clear keep unrelated metadata", () => {
    const granted = setOpenWorkWebComplimentaryAccess({ other: 1 }, true)
    assert.deepEqual(granted, { other: 1, complimentaryAccess: { openworkWeb: true } })
    assert.deepEqual(setOpenWorkWebComplimentaryAccess(granted, false), { other: 1 })
  })
})

describe("GET /v1/billing/web summary", () => {
  // Captured from origin/dev (loadOpenWorkWebBillingSummary) on a deployment
  // without Stripe: three joined members, complimentary grant, no web row.
  const goldenNoBilling = JSON.stringify({
    configured: false,
    unitAmount: 5000,
    currency: "usd",
    interval: "month",
    quantityDefinition: "joined_non_removed_members",
    quantityDescription: "Every joined, non-removed organization member; pending invitations are excluded.",
    quantity: 3,
    expectedMonthlyTotal: 15000,
    hasEligibleSubscription: false,
    hasAccess: true,
    accessSource: "complimentary",
    complimentaryAccess: true,
    subscription: null,
  })

  test("without a paid source the body is byte-identical to the no-Stripe output", () => {
    const summary = composeOpenWorkWebSummary({
      deploymentAvailable: true,
      joinedMemberCount: 3,
      complimentaryAccess: true,
      billing: NO_OPENWORK_WEB_BILLING,
    })
    assert.equal(JSON.stringify(summary), goldenNoBilling)
  })

  test("a paid subscription takes precedence and billing fields pass through", () => {
    const subscription = {
      status: "active",
      paymentStatus: "paid",
      quantity: 3,
      currentPeriodStart: "2026-10-01T00:00:00.000Z",
      currentPeriodEnd: "2026-11-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
    }
    const summary = composeOpenWorkWebSummary({
      deploymentAvailable: true,
      joinedMemberCount: 3,
      complimentaryAccess: true,
      billing: { configured: true, hasEligibleSubscription: true, subscription },
    })
    assert.equal(summary.configured, true)
    assert.equal(summary.accessSource, "subscription")
    assert.equal(summary.hasAccess, true)
    assert.deepEqual(summary.subscription, subscription)
  })

  test("a paid subscription does not grant access while the deployment is off", () => {
    const summary = composeOpenWorkWebSummary({
      deploymentAvailable: false,
      joinedMemberCount: 0,
      complimentaryAccess: false,
      billing: { configured: false, hasEligibleSubscription: true, subscription: null },
    })
    assert.equal(summary.hasAccess, false)
    assert.equal(summary.accessSource, null)
    assert.equal(summary.quantity, 0)
    assert.equal(summary.expectedMonthlyTotal, 0)
  })
})

describe("Core providers", () => {
  test("paid source registry holds at most one source", () => {
    const registry = createOpenWorkWebPaidSourceRegistry()
    assert.equal(registry.current(), null)
    const source: OpenWorkWebPaidSource = {
      hasEligibleSubscription: async () => true,
      billingSummary: async () => NO_OPENWORK_WEB_BILLING,
    }
    registry.register(source)
    registry.register(source)
    assert.equal(registry.current(), source)
    assert.throws(() => registry.register({ ...source }), /openwork_web_paid_source_already_registered/)
  })

  test("subscription status defaults to no subscriptions", async () => {
    assert.equal(await createSubscriptionStatusRegistry().current().hasActiveSubscription(orgId("a"), "inference"), false)
    assert.equal(await subscriptionStatus().hasActiveSubscription(orgId("a"), "web"), false)
  })

  test("subscription changes run listeners in order, awaited, and propagate errors", async () => {
    const registry = createSubscriptionChangeRegistry()
    const calls: string[] = []
    registry.on(async (change) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      calls.push(`first:${change.change}`)
    })
    registry.on(async (change) => {
      calls.push(`second:${change.change}`)
      if (change.reason === "webhook") throw new Error("setInferenceEnabled failed")
    })
    const third = async () => {
      calls.push("third")
    }
    registry.on(third)
    registry.on(third)

    const change: SubscriptionChange = { organizationId: orgId("a"), type: "inference", change: "activated", reason: "checkout" }
    await registry.emit(change)
    assert.deepEqual(calls, ["first:activated", "second:activated", "third"])

    calls.length = 0
    await assert.rejects(registry.emit({ ...change, change: "deactivated", reason: "webhook" }), /setInferenceEnabled failed/)
    assert.deepEqual(calls, ["first:deactivated", "second:deactivated"])
  })
})
