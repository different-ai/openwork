import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

// A deployment that sells nothing through Stripe: buying answers 503
// billing_not_configured with the product, never a 500.
const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", STRIPE_SECRET_KEY: "", STRIPE_SEAT_PRICE_ID: "", STRIPE_INFERENCE_PRICE_ID: "", STRIPE_ENTERPRISE_PRICE_ID: "" } })
after(() => den.close())
const org = await den.createOrg(await den.signUp("Unbilled Owner"), "Unbilled workspace")
const member = await den.newMember(org.owner, org.orgId, "Unbilled Member")
const owner = den.as(org.owner, org.orgId)

test("every buy and billing action answers 503 billing_not_configured with the product it cannot sell", async () => {
  assert.equal((await den.setFeature(org.orgId, "teamPlan", true)).status, 200)
  assert.equal((await den.setFeature(org.orgId, "selfServeEnterprise", true)).status, 200)
  const cases = [
    { path: "/v1/billing/stripe/checkout", body: {}, product: "inference" },
    { path: "/v1/billing/stripe/checkout", body: { type: "inference", returnTo: "desktop" }, product: "inference" },
    { path: "/v1/billing/stripe/checkout", body: { type: "seat" }, product: "seat" },
    { path: "/v1/billing/stripe/checkout", body: { type: "plan", plan: "team", addPeople: 1 }, product: "team" },
    { path: "/v1/billing/stripe/checkout", body: { type: "plan", plan: "enterprise" }, product: "enterprise" },
    { path: "/v1/billing/stripe/portal", body: undefined, product: "portal" },
    { path: "/v1/billing/stripe/checkout/sync", body: { sessionId: "cs_test_unbilled" }, product: "checkout" },
  ] as const
  for (const entry of cases) {
    const result = await owner("POST", entry.path, entry.body)
    assert.equal(result.status, 503, `${entry.path} ${JSON.stringify(entry.body)}: ${summary(result)}`)
    assert.equal(field(result.body, "error"), "billing_not_configured")
    assert.equal(field(result.body, "product"), entry.product)
    assert.equal(typeof field(result.body, "message"), "string")
  }
  const models = await owner("POST", "/v1/billing/stripe/checkout", { type: "inference" })
  assert.equal(field(models.body, "message"), "OpenWork Models isn't sold on this deployment.")
})

test("a plan whose feature is off is not offered, even before configuration is checked", async () => {
  assert.equal((await den.setFeature(org.orgId, "teamPlan", false)).status, 200)
  const result = await owner("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "team" })
  assert.equal(result.status, 404, summary(result))
  assert.deepEqual(result.body, { error: "feature_disabled", feature: "teamPlan" })
  const missingPlan = await owner("POST", "/v1/billing/stripe/checkout", { type: "plan" })
  assert.equal(missingPlan.status, 400, summary(missingPlan))
  const tooMany = await owner("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "team", addPeople: 51 })
  assert.equal(tooMany.status, 400, summary(tooMany))
})

test("billing and Models report that nothing is sold, with honest people counts", async () => {
  assert.equal((await den.setFeature(org.orgId, "teamPlan", true)).status, 200)
  const billing = await owner("GET", "/v1/billing")
  assert.equal(billing.status, 200, summary(billing))
  assert.equal(field(billing.body, "billing", "stripe", "configured"), false)
  assert.deepEqual(field(billing.body, "billing", "plan"), { tier: "free", source: "default", people: 2, joined: 2, invited: 0, freeSeatCount: 5, userLimit: null, endsAt: null }, "nothing limits users where seat billing is not sold")
  assert.deepEqual(field(billing.body, "billing", "plans", "team"), { available: false, unitAmount: 1000, currency: "usd", interval: "month" })
  assert.deepEqual(field(billing.body, "billing", "plans", "enterprise"), { available: false, unitAmount: 2000, currency: "usd", interval: "month" })
  const models = await owner("GET", "/v1/inference")
  assert.equal(models.status, 200, summary(models))
  assert.equal(field(models.body, "inference", "billingConfigured"), false)
})

test("a member without billing rights is refused before anything is sold", async () => {
  const result = await den.as(member, org.orgId)("POST", "/v1/billing/stripe/checkout", { type: "plan", plan: "team" })
  assert.equal(result.status, 403, summary(result))
})
