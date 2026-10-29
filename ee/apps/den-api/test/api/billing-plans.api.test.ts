import assert from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"
// The same loopback fake Stripe the e2e worlds use (Node built-ins only).
import { redirectStripeSdk, startFakeStripe } from "../../../../../evals/packages/labs/src/fake-stripe.mjs"

const SECRET = "sk_test_den_api_billing_plans_fixture_not_real"
const WEBHOOK_SECRET = "whsec_den_api_billing_plans_fixture_not_real"
const PRICES = { seat: "price_test_team_seat", inference: "price_test_models", enterprise: "price_test_enterprise" }

const stripe = await startFakeStripe({
  secretKey: SECRET,
  prices: [
    { id: PRICES.seat, unitAmount: 1000, nickname: "Team plan" },
    { id: PRICES.inference, unitAmount: 1000, nickname: "OpenWork Models" },
    { id: PRICES.enterprise, unitAmount: 2000, nickname: "Enterprise plan" },
  ],
})
// Send the Stripe SDK's transport (not any Den function) to the fake.
await redirectStripeSdk({ sdkRoot: new URL("../../node_modules/stripe/", import.meta.url), port: stripe.port, secretKey: SECRET })
const den = await bootDen({
  env: {
    DEN_DEPLOYMENT: "cloud",
    DEN_PLAN_GATING_ENABLED: "true",
    STRIPE_SECRET_KEY: SECRET,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_SEAT_PRICE_ID: PRICES.seat,
    STRIPE_INFERENCE_PRICE_ID: PRICES.inference,
    STRIPE_ENTERPRISE_PRICE_ID: PRICES.enterprise,
  },
})
after(async () => {
  await den.close()
  await stripe.close()
})

/** An owner and four people: the workspace has used its five free people. */
async function fivePersonWorkspace(name: string) {
  const org = await den.createOrg(await den.signUp(`${name} Owner`), `${name} workspace`)
  const people: Member[] = []
  for (const index of [1, 2, 3, 4]) people.push(await den.newMember(org.owner, org.orgId, `${name} Person ${["One", "Two", "Three", "Four"][index - 1]}`))
  return { ...org, people, owner: org.owner, call: den.as(org.owner, org.orgId) }
}

async function orgPlan(member: Member, orgId: string) {
  const context = await den.request(member.token, "GET", "/v1/org", { orgId })
  assert.equal(context.status, 200, summary(context))
  return { plan: field(context.body, "plan"), sso: field(context.body, "entitlements", "sso") }
}

function sessionFor(orgId: string) {
  return stripe.state().sessions.filter((session) => session.metadata.org_id === orgId).at(-1) ?? null
}

async function postStripeEvent(type: string, object: unknown) {
  const created = Math.floor(Date.now() / 1000)
  const payload = JSON.stringify({ id: `evt_test_${randomUUID()}`, object: "event", type, created, data: { object } })
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${created}.${payload}`).digest("hex")
  return den.request(null, "POST", "/v1/webhooks/stripe", { rawBody: payload, headers: { "content-type": "application/json", "stripe-signature": `t=${created},v1=${signature}` } })
}

const acme = await fivePersonWorkspace("Acme")

test("the sixth invitation is refused with a Team quote for the whole workspace", async () => {
  const refused = await acme.call("POST", "/v1/invitations", { email: `jordan+${den.stamp}@acme.example`, role: "member" })
  assert.equal(refused.status, 402, summary(refused))
  assert.equal(field(refused.body, "reason"), "seat_subscription_required")
  assert.equal(field(refused.body, "currentCount"), 5)
  assert.equal(field(refused.body, "freeSeatCount"), 5)
  assert.equal(typeof field(refused.body, "billingUrl"), "string")
  assert.deepEqual(field(refused.body, "quote"), {
    plan: "team", people: 6, joined: 5, invited: 0, unitAmount: 1000, monthlyTotal: 6000, currency: "usd", interval: "month", available: false,
  })

  assert.equal((await den.setFeature(acme.orgId, "teamPlan", true)).status, 200)
  const quoted = await acme.call("POST", "/v1/invitations", { email: `jordan+${den.stamp}@acme.example`, role: "member" })
  assert.equal(quoted.status, 402, summary(quoted))
  assert.equal(field(quoted.body, "quote", "available"), true, "Team checkout is offered once the feature is on")
})

test("Team checkout is offered only to organizations with the feature on", async () => {
  const other = await fivePersonWorkspace("Other")
  const refused = await other.call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "team", addPeople: 1 })
  assert.equal(refused.status, 404, summary(refused))
  assert.deepEqual(refused.body, { error: "feature_disabled", feature: "teamPlan" })
  assert.equal(sessionFor(other.orgId), null, "no Checkout was started")
  assert.deepEqual((await orgPlan(other.owner, other.orgId)).plan, { tier: "free", source: "default" })
})

test("paying for Team for six people sets the plan and unlocks Team features, without OpenWork Models", async () => {
  const before = await orgPlan(acme.owner, acme.orgId)
  assert.deepEqual(before, { plan: { tier: "free", source: "default" }, sso: false })

  const started = await acme.call("POST", "/v1/billing/stripe/checkout", {
    type: "plan", plan: "team", addPeople: 1, returnTo: "/dashboard/members?invite=jordan%40acme.example",
  })
  assert.equal(started.status, 200, summary(started))
  const url = text(field(started.body, "url"), "checkout url")
  assert.ok(url.startsWith(`${stripe.origin}/checkout/`), url)

  const session = sessionFor(acme.orgId)
  assert.ok(session)
  assert.equal(session.mode, "subscription")
  assert.deepEqual(session.lineItems, [{ price: PRICES.seat, quantity: 6 }])
  assert.equal(session.amount_total, 6000)
  assert.deepEqual(session.metadata, {
    org_id: acme.orgId, created_by_org_member_id: acme.owner.memberId, openwork_product: "openwork_plan",
    subscription_type: "seat", plan_tier: "team", pricing_model: "per_person",
  })
  assert.match(session.success_url, /\/dashboard\/billing\/stripe\/checking\?session_id=\{CHECKOUT_SESSION_ID\}&return=plan&returnTo=%2Fdashboard%2Fmembers%3Finvite%3Djordan%2540acme\.example$/)
  assert.match(session.cancel_url, /\/dashboard\/members\?invite=jordan%40acme\.example&checkout=canceled$/)

  stripe.complete(session.id)
  const synced = await acme.call("POST", "/v1/billing/stripe/checkout/sync", { sessionId: session.id })
  assert.equal(synced.status, 200, summary(synced))
  assert.equal(field(synced.body, "synced"), true)

  assert.deepEqual(await orgPlan(acme.owner, acme.orgId), { plan: { tier: "team", source: "stripe" }, sso: true })
  const billing = await acme.call("GET", "/v1/billing")
  assert.equal(billing.status, 200, summary(billing))
  assert.deepEqual(field(billing.body, "billing", "plan"), { tier: "team", source: "stripe", people: 5, joined: 5, invited: 0, freeSeatCount: 5, userLimit: null, endsAt: null })
  assert.equal(field(billing.body, "billing", "stripe", "seats", "hasActiveSubscription"), true)
  assert.equal(field(billing.body, "billing", "stripe", "hasActiveSubscription"), false, "OpenWork Models is a separate purchase")
  assert.equal(stripe.state().subscriptions.filter((subscription) => subscription.metadata.org_id === acme.orgId && subscription.metadata.subscription_type === "inference").length, 0)
})

test("on Team, the sixth person is invited and every person is billed", async () => {
  const invited = await acme.call("POST", "/v1/invitations", { email: `jordan+${den.stamp}@acme.example`, role: "member" })
  assert.equal(invited.status, 201, summary(invited))
  const subscription = stripe.state().subscriptions.find((entry) => entry.metadata.org_id === acme.orgId)
  assert.equal(subscription?.items.data[0]?.quantity, 6, "per-person plans bill every counted person, invited included")
  const billing = await acme.call("GET", "/v1/billing")
  assert.deepEqual(field(billing.body, "billing", "plan"), { tier: "team", source: "stripe", people: 6, joined: 5, invited: 1, freeSeatCount: 5, userLimit: null, endsAt: null })
  assert.equal(field(billing.body, "billing", "stripe", "seats", "subscription", "quantity"), 6)
})

test("buying the plan the organization already has is refused", async () => {
  const again = await acme.call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "team" })
  assert.equal(again.status, 409, summary(again))
  assert.equal(field(again.body, "error"), "stripe_subscription_exists")
})

test("Team moves to Enterprise on the same subscription and the plan follows immediately", async () => {
  const refused = await acme.call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "enterprise" })
  assert.equal(refused.status, 404, summary(refused))
  assert.deepEqual(refused.body, { error: "feature_disabled", feature: "selfServeEnterprise" })

  assert.equal((await den.setFeature(acme.orgId, "selfServeEnterprise", true)).status, 200)
  const sessionsBefore = stripe.state().sessions.length
  const teamSubscription = stripe.state().subscriptions.find((entry) => entry.metadata.org_id === acme.orgId)
  assert.ok(teamSubscription)
  stripe.setSubscriptionPaymentDeclined(teamSubscription.id, true)
  const declined = await acme.call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "enterprise" })
  assert.equal(declined.status, 409, summary(declined))
  assert.equal(field(declined.body, "error"), "stripe_subscription_exists")
  assert.equal(teamSubscription.metadata.plan_tier, "team", "Stripe must not save an unpaid tier")
  assert.equal(teamSubscription.items.data[0]?.price.id, PRICES.seat, "the paid Team price remains")
  assert.deepEqual((await orgPlan(acme.owner, acme.orgId)).plan, { tier: "team", source: "stripe" })
  assert.equal((await postStripeEvent("customer.subscription.updated", teamSubscription)).status, 200)
  assert.deepEqual((await orgPlan(acme.owner, acme.orgId)).plan, { tier: "team", source: "stripe" }, "a later webhook cannot grant the unpaid upgrade")
  const update = stripe.state().requests.filter((entry) => entry.method === "POST" && entry.path === `/v1/subscriptions/${teamSubscription.id}`).at(-1)
  assert.equal(update?.form?.proration_behavior, "always_invoice", "collect upgrade prorations now, not next month")
  assert.equal(update?.form?.payment_behavior, "error_if_incomplete", "only save the new tier after collection succeeds")

  stripe.setSubscriptionPaymentDeclined(teamSubscription.id, false)
  const moved = await acme.call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "enterprise", returnTo: "/dashboard/sso" })
  assert.equal(moved.status, 200, summary(moved))
  assert.equal(field(moved.body, "completed"), true)
  assert.match(text(field(moved.body, "url"), "return page"), /\/dashboard\/billing\/stripe\/checking\?return=plan&returnTo=%2Fdashboard%2Fsso$/)
  assert.equal(stripe.state().sessions.length, sessionsBefore, "no second payment page")
  const subscriptions = stripe.state().subscriptions.filter((entry) => entry.metadata.org_id === acme.orgId)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0]?.items.data[0]?.price.id, PRICES.enterprise)
  assert.equal(subscriptions[0]?.items.data[0]?.quantity, 6)
  assert.equal(subscriptions[0]?.metadata.plan_tier, "enterprise")
  assert.deepEqual((await orgPlan(acme.owner, acme.orgId)).plan, { tier: "enterprise", source: "stripe" })
  const billing = await acme.call("GET", "/v1/billing")
  assert.equal(field(billing.body, "billing", "plans", "enterprise", "available"), true)
})

test("when Stripe cancels a Stripe-paid plan the organization returns to Free", async () => {
  const subscription = stripe.state().subscriptions.find((entry) => entry.metadata.org_id === acme.orgId)
  assert.ok(subscription)
  const canceled = stripe.setSubscriptionStatus(subscription.id, "canceled")
  const delivered = await postStripeEvent("customer.subscription.deleted", canceled)
  assert.equal(delivered.status, 200, summary(delivered))
  assert.deepEqual(await orgPlan(acme.owner, acme.orgId), { plan: { tier: "free", source: "default" }, sso: false })
})

test("a manual Enterprise grant is never lowered by buying or cancelling Team", async () => {
  const granted = await fivePersonWorkspace("Granted")
  assert.equal((await den.setFeature(granted.orgId, "teamPlan", true)).status, 200)
  const platform = await den.signIn(`platform-admin+${den.stamp}@example.test`)
  const adminToken = text(field(platform.body, "token"), "platform admin session")
  const grant = await den.request(adminToken, "PATCH", `/v1/admin/organizations/${granted.orgId}/plan`, { body: { tier: "enterprise", seatLimit: 50 } })
  assert.equal(grant.status, 200, summary(grant))
  assert.equal(field(await orgPlan(granted.owner, granted.orgId), "plan", "source"), "manual")
  assert.equal(field((await granted.call("GET", "/v1/billing")).body, "billing", "plan", "userLimit"), 50, "the admin-set plan allows its users")

  const started = await granted.call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "team", returnTo: "https://evil.example/dashboard" })
  assert.equal(started.status, 200, summary(started))
  const session = sessionFor(granted.orgId)
  assert.ok(session)
  assert.deepEqual(session.lineItems, [{ price: PRICES.seat, quantity: 5 }], "five people, nobody added")
  assert.match(session.success_url, /\/dashboard\/billing\/stripe\/checking\?session_id=\{CHECKOUT_SESSION_ID\}&return=plan$/, "an unsafe returnTo is ignored")
  stripe.complete(session.id)
  assert.equal((await granted.call("POST", "/v1/billing/stripe/checkout/sync", { sessionId: session.id })).status, 200)
  const kept = await orgPlan(granted.owner, granted.orgId)
  assert.equal(field(kept, "plan", "tier"), "enterprise")
  assert.equal(field(kept, "plan", "source"), "manual")
  assert.equal(field((await granted.call("GET", "/v1/billing")).body, "billing", "plan", "userLimit"), null, "paying for Team in Stripe lifts the limit")

  const subscription = stripe.state().subscriptions.find((entry) => entry.metadata.org_id === granted.orgId)
  assert.ok(subscription)
  assert.equal((await postStripeEvent("customer.subscription.deleted", stripe.setSubscriptionStatus(subscription.id, "canceled"))).status, 200)
  assert.equal(field(await orgPlan(granted.owner, granted.orgId), "plan", "tier"), "enterprise", "cancelling never lowers a manual grant")
})

test("incomplete initial payments do not unlock paid plans through webhooks or checkout sync", async () => {
  for (const plan of ["team", "enterprise"] as const) {
    const pending = await den.createOrg(await den.signUp(`Pending ${plan} Owner`), `Pending ${plan} workspace`)
    const call = den.as(pending.owner, pending.orgId)
    assert.equal((await den.setFeature(pending.orgId, plan === "team" ? "teamPlan" : "selfServeEnterprise", true)).status, 200)
    const started = await call("POST", "/v1/billing/stripe/checkout", { type: "plan", plan })
    assert.equal(started.status, 200, summary(started))
    const session = sessionFor(pending.orgId)
    assert.ok(session)
    stripe.complete(session.id)
    const subscription = stripe.state().subscriptions.find((entry) => entry.metadata.org_id === pending.orgId)
    assert.ok(subscription)
    const incomplete = stripe.setSubscriptionStatus(subscription.id, "incomplete")
    const delivered = await postStripeEvent("customer.subscription.created", incomplete)
    assert.equal(delivered.status, 200, summary(delivered))
    assert.deepEqual(await orgPlan(pending.owner, pending.orgId), { plan: { tier: "free", source: "default" }, sso: false })

    const synced = await call("POST", "/v1/billing/stripe/checkout/sync", { sessionId: session.id })
    assert.equal(synced.status, 200, summary(synced))
    assert.deepEqual(await orgPlan(pending.owner, pending.orgId), { plan: { tier: "free", source: "default" }, sso: false }, "checkout sync cannot bypass payment")

    const paid = await postStripeEvent("customer.subscription.updated", stripe.setSubscriptionStatus(subscription.id, "active"))
    assert.equal(paid.status, 200, summary(paid))
    assert.deepEqual(await orgPlan(pending.owner, pending.orgId), { plan: { tier: plan, source: "stripe" }, sso: true })
  }
})

test("a checkout session from another organization cannot be synced into this one", async () => {
  const other = list(stripe.state().sessions.filter((session) => session.metadata.org_id !== acme.orgId))[0]
  assert.ok(other)
  const result = await acme.call("POST", "/v1/billing/stripe/checkout/sync", { sessionId: String(other.id) })
  assert.equal(result.status, 404, summary(result))
})
