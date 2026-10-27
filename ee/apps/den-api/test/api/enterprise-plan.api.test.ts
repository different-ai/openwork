/**
 * One place for an organization's plan and users: a platform admin sets the
 * plan and how many users it allows (PATCH /v1/admin/organizations/:id/plan),
 * and every way people join enforces that number with no feature flag:
 * invitations, and SCIM (the same check SSO sign-up uses). A full plan set by
 * OpenWork answers org_limit_reached, never the Team upgrade; a Free workspace
 * still gets the 402 Team flow. Only platform admins reach the Stripe
 * Enterprise subscription routes, which are refused while Stripe Enterprise
 * billing is not configured.
 *
 * Stripe seat billing is configured with placeholder keys so the user limit is
 * enforced; no request here reaches Stripe because no organization has a
 * subscription.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen({
  env: {
    STRIPE_SECRET_KEY: "sk_test_placeholder_never_called",
    STRIPE_SEAT_PRICE_ID: "price_seat_placeholder",
    STRIPE_ENTERPRISE_PRODUCT_ID: "",
    DEN_DEPLOYMENT: "cloud",
  },
})
after(() => den.close())

const platformAdmin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const adminToken = platformAdmin.token
const enterprisePath = (orgId: string) => `/v1/admin/organizations/${orgId}/enterprise-subscription`
const planPath = (orgId: string) => `/v1/admin/organizations/${orgId}/plan`
const startBody = { priceId: "price_enterpriseContract", minimumUsers: 25, billingEmail: "billing@example.test", daysUntilDue: 30 }
const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
const API_ORIGIN = "http://127.0.0.1:8790"

const setPlan = (orgId: string, body: Record<string, unknown>) => den.request(adminToken, "PATCH", planPath(orgId), { body })
const invite = (owner: Member, orgId: string, label: string) => den.as(owner, orgId)("POST", "/v1/invitations", { email: `${label}-${den.stamp}@example.test`, role: "member" })

async function inviteUpTo(owner: Member, orgId: string, users: number, label: string) {
  // The owner is the first user; pending invitations count too.
  for (let index = 2; index <= users; index += 1) {
    const invited = await invite(owner, orgId, `${label}-${index}`)
    assert.equal(invited.status < 300, true, summary(invited))
  }
}

test("only a platform administrator can read or start an Enterprise subscription or set a plan", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Erin Owner"), "Enterprise access org")
  for (const token of [null, owner.token]) {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      const result = await den.request(token, method, enterprisePath(orgId), { body: method === "GET" ? undefined : method === "POST" ? startBody : { minimumUsers: 10 } })
      assert.equal(result.status, token ? 403 : 401, summary(result))
    }
    const plan = await den.request(token, "PATCH", planPath(orgId), { body: { tier: "enterprise", seatLimit: 20 } })
    assert.equal(plan.status, token ? 403 : 401, summary(plan))
  }
})

test("starting Enterprise in Stripe needs no feature flag, only Stripe Enterprise billing configured", async () => {
  const { orgId } = await den.createOrg(await den.signUp("Eli Owner"), "Enterprise start org")
  const state = await den.request(adminToken, "GET", enterprisePath(orgId))
  assert.equal(state.status, 200, summary(state))
  assert.equal(field(state.body, "enterprise", "featureEnabled"), undefined, "the section has no feature lock")
  assert.equal(field(state.body, "enterprise", "configured"), false)
  assert.equal(field(state.body, "enterprise", "subscription"), null)
  assert.equal(field(state.body, "enterprise", "users"), 1)

  const invalid = await den.request(adminToken, "POST", enterprisePath(orgId), { body: { ...startBody, priceId: "not-a-price" } })
  assert.equal(invalid.status, 400, summary(invalid))
  const unconfigured = await den.request(adminToken, "POST", enterprisePath(orgId), { body: startBody })
  assert.equal(unconfigured.status, 503, summary(unconfigured))
  assert.equal(field(unconfigured.body, "error"), "enterprise_product_not_configured")
  const noSubscription = await den.request(adminToken, "PATCH", enterprisePath(orgId), { body: { minimumUsers: 10 } })
  assert.equal(noSubscription.status, 503, summary(noSubscription))
})

test("a Free workspace is refused its sixth user with the Team upgrade", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Fay Owner"), "Free limit org")
  await inviteUpTo(owner, orgId, 5, "free")
  const sixth = await invite(owner, orgId, "free-6")
  assert.equal(sixth.status, 402, summary(sixth))
  assert.equal(field(sixth.body, "error"), "payment_required")
  assert.equal(field(sixth.body, "reason"), "seat_subscription_required")
  assert.equal(field(sixth.body, "freeSeatCount"), 5)
})

test("an Enterprise plan set by a platform admin allows its users with no feature flag, and refuses the next person as a full plan", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Eve Owner"), "Enterprise limit org")
  await inviteUpTo(owner, orgId, 5, "limit")
  assert.equal((await invite(owner, orgId, "limit-6")).status, 402, "Free first")

  const saved = await setPlan(orgId, { tier: "enterprise", seatLimit: 7, endsAt: "2026-11-22" })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "organization", "plan"), {
    tier: "enterprise", source: "manual", paidBy: "none", users: 5, userLimit: 7, seats: 7, endsAt: "2026-11-22", ended: false,
  })

  assert.equal((await invite(owner, orgId, "limit-6")).status, 201, "the sixth user fits")
  assert.equal((await invite(owner, orgId, "limit-7")).status, 201, "the seventh user fits")
  const eighth = await invite(owner, orgId, "limit-8")
  assert.equal(eighth.status, 409, summary(eighth))
  assert.deepEqual(eighth.body, {
    error: "org_limit_reached",
    limitType: "members",
    currentCount: 7,
    limit: 7,
    message: "Your Enterprise plan includes 7 users, counting pending invitations. Ask your OpenWork contact to add seats.",
  })

  const billing = await den.as(owner, orgId)("GET", "/v1/billing")
  assert.equal(billing.status, 200, summary(billing))
  assert.equal(field(billing.body, "billing", "plan", "tier"), "enterprise")
  assert.equal(field(billing.body, "billing", "plan", "userLimit"), 7)
  assert.equal(field(billing.body, "billing", "plan", "endsAt"), "2026-11-22")

  const detail = await den.request(adminToken, "GET", `/v1/admin/organizations/${orgId}?limit=1`)
  assert.equal(detail.status, 200, summary(detail))
  assert.equal(field(detail.body, "organization", "plan", "users"), 7)
  assert.equal(field(detail.body, "organization", "plan", "userLimit"), 7)
  assert.equal(field(detail.body, "organization", "seatLimit"), 7, "the legacy seat limit mirrors the plan")
})

test("a plan end date round-trips, is display only once passed, and is refused on Free", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Dee Owner"), "End date org")
  const past = await setPlan(orgId, { tier: "team", seatLimit: 6, endsAt: "2020-01-31" })
  assert.equal(past.status, 200, summary(past))
  assert.equal(field(past.body, "organization", "plan", "ended"), true)
  assert.equal(field(past.body, "organization", "plan", "userLimit"), 6, "nothing changes when the date passes")
  assert.equal((await invite(owner, orgId, "ended-2")).status, 201)

  const cleared = await setPlan(orgId, { tier: "team", seatLimit: 6, endsAt: null })
  assert.equal(field(cleared.body, "organization", "plan", "endsAt"), null, summary(cleared))
  const listed = await den.request(adminToken, "GET", `/v1/admin/organizations?search=${encodeURIComponent("End date org")}&includeFeatures=0`)
  const row = list(field(listed.body, "organizations")).find((entry) => entry.id === orgId)
  assert.equal(field(row, "userLimit"), 6, summary(listed))
  assert.equal(field(row, "paidBy"), "none")
  assert.equal(field(row, "endsAt"), null)

  for (const body of [{ tier: "free", seatLimit: 10, endsAt: "2026-11-22" }, { tier: "team", seatLimit: 10, endsAt: "2026-02-30" }, { tier: "team", seatLimit: 10, endsAt: "22/11/2026" }]) {
    const refused = await setPlan(orgId, body)
    assert.equal(refused.status, 400, `${JSON.stringify(body)}: ${summary(refused)}`)
  }

  const free = await setPlan(orgId, { tier: "free", seatLimit: 8 })
  assert.equal(free.status, 200, summary(free))
  assert.deepEqual(field(free.body, "organization", "plan"), { tier: "free", source: "manual", paidBy: "none", users: 2, userLimit: 8, seats: null, endsAt: null, ended: false })
  const small = await setPlan(orgId, { tier: "enterprise", seatLimit: 2 })
  assert.equal(field(small.body, "organization", "plan", "userLimit"), 5, "never fewer than the Free plan's 5")
})

function saml(label: string, domain: string) {
  return {
    issuer: `http://127.0.0.1/okta/${label}-${den.stamp}`,
    domain,
    entryPoint: `https://okta.example.test/app/openwork/${label}-${den.stamp}/sso/saml`,
    cert: "okta-test-signing-certificate",
    audience: API_ORIGIN,
  }
}

function scimCreate(bearer: string, domain: string, label: string) {
  return den.request(null, "POST", "/api/auth/scim/v2/Users", {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/scim+json, application/json", "content-type": "application/scim+json" },
    rawBody: JSON.stringify({
      schemas: [SCIM_USER_SCHEMA], userName: `${label}@${domain}`, name: { givenName: label, familyName: "Provisioned" },
      emails: [{ primary: true, value: `${label}@${domain}`, type: "work" }], externalId: `00u-${label}`, active: true,
    }),
  })
}

test("SCIM provisioning follows the same user limit as invitations", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Sol Owner"), "SCIM limit org")
  const domain = `scim-limit-${den.stamp}.test`
  assert.equal((await den.as(owner, orgId)("POST", "/v1/sso/saml", saml("limit", domain))).status, 201)
  await den.arrangeSsoConnectionEnabled(orgId)
  const issued = await den.as(owner, orgId)("POST", "/v1/scim/token")
  assert.equal(issued.status, 201, summary(issued))
  const bearer = text(field(issued.body, "scimToken"), "SCIM token")

  await inviteUpTo(owner, orgId, 5, "scim")
  const freeRefused = await scimCreate(bearer, domain, "free-sixth")
  assert.equal(freeRefused.status, 403, `Free allows 5 users: ${summary(freeRefused)}`)

  assert.equal((await setPlan(orgId, { tier: "enterprise", seatLimit: 6 })).status, 200)
  const sixth = await scimCreate(bearer, domain, "sixth")
  assert.equal(sixth.status, 201, summary(sixth))
  const seventh = await scimCreate(bearer, domain, "seventh")
  assert.equal(seventh.status, 403, `an Enterprise plan is held to its users like an invitation: ${summary(seventh)}`)
})
