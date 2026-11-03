import assert from "node:assert/strict"
import { test } from "node:test"
import {
  billingNotConfiguredMessage,
  parseBillingReturnTo,
  quotePlan,
  withReturnParams,
} from "@openwork/types/den/billing-plans"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const {
  checkoutReturnUrls,
  defaultCheckoutReturnPageUrl,
  isPerPersonPlanMetadata,
  planTierFromSubscriptionMetadata,
  reconcileOrganizationPlan,
} = await import("../src/billing-plans.ts")
const { billingNotConfiguredProductForError, BillingNotConfiguredError } = await import("../src/stripe-billing.ts")

test("a checkout may only return to Desktop or a Den dashboard page", () => {
  assert.equal(parseBillingReturnTo("desktop"), "desktop")
  assert.equal(parseBillingReturnTo("/dashboard/members"), "/dashboard/members")
  assert.equal(parseBillingReturnTo("/dashboard/members?invite=jordan%40acme.example&role=member"), "/dashboard/members?invite=jordan%40acme.example&role=member")
  assert.equal(parseBillingReturnTo("/dashboard/ai-gateway?tab=openwork-models"), "/dashboard/ai-gateway?tab=openwork-models")

  for (const unsafe of [
    undefined, null, 42, "", "Desktop", "desktop ", "openwork://", "https://evil.example/dashboard/x",
    "//evil.example/dashboard/x", "/dashboard//evil.example", "/dashboard/x?next=https://evil.example",
    "/dashboard\\evil", "\\dashboard/x", "/dashboard", "/dashboardx/members", "/admin/organizations",
    "/dashboard/../admin", "/dashboard/%2e%2e/admin", "/dashboard/./members", "/dashboard/members#top",
    "/dashboard/mem bers", "/dashboard/members\n", "/dashboard/ménage", "javascript:alert(1)",
    "/dashboard/x?a='b'", `/dashboard/${"a".repeat(250)}`,
  ]) {
    assert.equal(parseBillingReturnTo(unsafe), null, `refuses ${JSON.stringify(unsafe)}`)
  }
  assert.equal(parseBillingReturnTo(`/dashboard/${"a".repeat(245)}`)?.length, 256, "256 characters is the limit")
})

test("return parameters are added to a dashboard page without losing its query", () => {
  assert.equal(withReturnParams("/dashboard/members?invite=a%40b.example", { checkout: "canceled" }), "/dashboard/members?invite=a%40b.example&checkout=canceled")
  assert.equal(withReturnParams("/dashboard/billing", { checkout: "complete", session_id: "cs_1" }), "/dashboard/billing?checkout=complete&session_id=cs_1")
})

test("a plan costs every counted person at its per-person price", () => {
  assert.deepEqual(quotePlan({ plan: "team", people: 6 }), { people: 6, unitAmount: 1000, monthlyTotal: 6000 })
  assert.deepEqual(quotePlan({ plan: "team", people: 5, addPeople: 1 }), { people: 6, unitAmount: 1000, monthlyTotal: 6000 })
  assert.equal(quotePlan({ plan: "team", people: 0 }).people, 1, "never fewer than one person")
  assert.equal(quotePlan({ plan: "team", people: 3, addPeople: 500 }).people, 53, "at most 50 people are added")
  assert.equal(quotePlan({ plan: "team", people: Number.NaN, addPeople: -4 }).people, 1)
})

test("a seat subscription pays for Team, whatever plan it names; Enterprise is never bought by card", () => {
  assert.equal(planTierFromSubscriptionMetadata({ plan_tier: "enterprise" }), "team")
  assert.equal(planTierFromSubscriptionMetadata({ plan_tier: "team" }), "team")
  assert.equal(planTierFromSubscriptionMetadata({ subscription_type: "seat" }), "team")
  assert.equal(planTierFromSubscriptionMetadata({ plan_tier: "free" }), "team")
  assert.equal(planTierFromSubscriptionMetadata(null), "team")
  assert.equal(isPerPersonPlanMetadata({ pricing_model: "per_person" }), true)
  assert.equal(isPerPersonPlanMetadata({ subscription_type: "seat" }), false)
  assert.equal(isPerPersonPlanMetadata(undefined), false)
})

test("paying sets the plan, Stripe giving up returns it to Free, and manual grants are never lowered", () => {
  const free = { tier: "free", source: "default" } as const
  const stripeTeam = { tier: "team", source: "stripe" } as const
  const stripeEnterprise = { tier: "enterprise", source: "stripe" } as const
  const manualTeam = { tier: "team", source: "manual" } as const
  const manualEnterprise = { tier: "enterprise", source: "manual" } as const
  const grandfatheredEnterprise = { tier: "enterprise", source: "grandfathered", grandfatheredAt: "2026-01-01T00:00:00.000Z" } as const

  // Paying (or Stripe still collecting) sets the plan.
  for (const status of ["active", "trialing", "past_due"]) {
    assert.deepEqual(reconcileOrganizationPlan({ current: free, status, tier: "team" }), stripeTeam, status)
  }
  assert.deepEqual(reconcileOrganizationPlan({ current: stripeEnterprise, status: "active", tier: "team" }), stripeTeam, "an old Stripe-set Enterprise follows its Team subscription")
  assert.equal(reconcileOrganizationPlan({ current: stripeTeam, status: "active", tier: "team" }), null, "unchanged plans never write")

  // Manual and grandfathered grants at the same or a higher tier stay.
  assert.equal(reconcileOrganizationPlan({ current: manualEnterprise, status: "active", tier: "team" }), null)
  assert.equal(reconcileOrganizationPlan({ current: manualTeam, status: "active", tier: "team" }), null)
  assert.equal(reconcileOrganizationPlan({ current: grandfatheredEnterprise, status: "active", tier: "team" }), null)
  assert.deepEqual(reconcileOrganizationPlan({ current: { tier: "free", source: "manual" }, status: "active", tier: "team" }), stripeTeam)

  // Stripe stopped collecting: only a Stripe-sourced plan returns to Free.
  for (const status of ["canceled", "unpaid", "incomplete_expired", "expired", "paused"]) {
    assert.deepEqual(reconcileOrganizationPlan({ current: stripeTeam, status, tier: "team" }), free, status)
    assert.deepEqual(reconcileOrganizationPlan({ current: stripeEnterprise, status, tier: "team" }), free, status)
    assert.equal(reconcileOrganizationPlan({ current: manualTeam, status, tier: "team" }), null, `manual survives ${status}`)
    assert.equal(reconcileOrganizationPlan({ current: grandfatheredEnterprise, status, tier: "team" }), null, `grandfathered survives ${status}`)
    assert.equal(reconcileOrganizationPlan({ current: free, status, tier: "team" }), null)
  }

  // A legacy seat subscription that bills nobody (a saved card) is not a payment.
  assert.equal(reconcileOrganizationPlan({ current: free, status: "active", tier: "team", legacyWithoutCharge: true }), null)
  assert.deepEqual(reconcileOrganizationPlan({ current: stripeTeam, status: "canceled", tier: "team", legacyWithoutCharge: true }), free)
  assert.equal(reconcileOrganizationPlan({ current: stripeTeam, status: "something_new", tier: "team" }), null, "unknown statuses change nothing")
})

test("an incomplete initial payment never grants Team, and payment completion does", () => {
  const free = { tier: "free", source: "default" } as const
  const tier = "team"
  assert.equal(reconcileOrganizationPlan({ current: free, status: "incomplete", tier }), null, "Team awaits payment")
  assert.deepEqual(reconcileOrganizationPlan({ current: { tier, source: "stripe" }, status: "incomplete", tier }), free, "remove any premature Stripe grant")
  for (const source of ["manual", "grandfathered"] as const) {
    assert.equal(reconcileOrganizationPlan({ current: { tier, source }, status: "incomplete", tier }), null, `${source} survives`)
    assert.equal(reconcileOrganizationPlan({ current: { tier: "enterprise", source }, status: "incomplete", tier }), null, `${source} Enterprise survives`)
  }
  assert.deepEqual(reconcileOrganizationPlan({ current: free, status: "active", tier }), { tier, source: "stripe" })
})

test("without returnTo a checkout keeps its existing return pages", () => {
  const defaults = {
    successUrl: "https://den.example/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=models",
    cancelUrl: "https://den.example/dashboard/billing",
  }
  const urls = checkoutReturnUrls({ origin: "https://den.example", kind: "models", returnTo: null, defaults })
  assert.equal(urls.successUrl, defaults.successUrl)
  assert.equal(urls.cancelUrl, defaults.cancelUrl)
  assert.equal(urls.completedUrl, "https://den.example/dashboard/billing/stripe/checking?return=models")
  assert.equal(defaultCheckoutReturnPageUrl("https://den.example", "plan"), "https://den.example/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=plan")
})

test("returnTo sends the buyer through the return page to the page they came from", () => {
  const defaults = { successUrl: "https://den.example/dashboard/billing?stripe_checkout=seat&session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://den.example/dashboard/billing" }
  const members = checkoutReturnUrls({ origin: "https://den.example", kind: "plan", returnTo: "/dashboard/members?invite=jordan%40acme.example", defaults })
  assert.equal(members.successUrl, "https://den.example/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=plan&returnTo=%2Fdashboard%2Fmembers%3Finvite%3Djordan%2540acme.example")
  assert.equal(members.cancelUrl, "https://den.example/dashboard/members?invite=jordan%40acme.example&checkout=canceled")
  assert.equal(members.completedUrl, "https://den.example/dashboard/billing/stripe/checking?return=plan&returnTo=%2Fdashboard%2Fmembers%3Finvite%3Djordan%2540acme.example")

  const desktop = checkoutReturnUrls({ origin: "https://den.example", kind: "models", returnTo: "desktop", defaults: { successUrl: "unused", cancelUrl: "https://den.example/dashboard/billing" } })
  assert.equal(desktop.successUrl, "https://den.example/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=models&returnTo=desktop")
  assert.equal(desktop.cancelUrl, "https://den.example/dashboard/billing?checkout=canceled")
})

test("configuration failures name the product that is not sold; other failures stay errors", () => {
  assert.equal(billingNotConfiguredProductForError(new Error("stripe_secret_key_missing"), "portal"), "portal")
  assert.equal(billingNotConfiguredProductForError(new Error("stripe_inference_price_id_missing"), "inference"), "inference")
  assert.equal(billingNotConfiguredProductForError(new Error("stripe_seat_price_id_missing"), "team"), "team")
  assert.equal(billingNotConfiguredProductForError(new Error("stripe_seat_price_id_missing"), "seat"), "seat")
  assert.equal(billingNotConfiguredProductForError(new Error("stripe_openwork_web_price_contract_invalid"), "web"), "web")
  assert.equal(billingNotConfiguredProductForError(new BillingNotConfiguredError("web"), "team"), "web")
  assert.equal(billingNotConfiguredProductForError(new Error("card_declined"), "inference"), null)
  assert.equal(billingNotConfiguredProductForError("stripe_secret_key_missing", "inference"), null)
  assert.equal(billingNotConfiguredMessage("inference"), "OpenWork Models isn't sold on this deployment.")
})
