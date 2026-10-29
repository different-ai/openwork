import assert from "node:assert/strict"
import { test } from "node:test"

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

const { checkEntitlement, getOrganizationEntitlements } = await import("../src/entitlements.ts")

const gated = { gatingEnabled: true }
// The metadata PATCH /v1/admin/organizations/:id/plan writes, and what Stripe writes for a paid Team plan.
const adminEnterprise = { plan: { tier: "enterprise", source: "manual", grantedAt: "2026-10-21T00:00:00.000Z" } }
const adminTeam = { plan: { tier: "team", source: "manual" } }
const stripeTeam = { plan: { tier: "team", source: "stripe" } }

test("SSO is a Team capability; SCIM is Enterprise", () => {
  assert.deepEqual(
    [getOrganizationEntitlements({}, gated).sso, getOrganizationEntitlements({}, gated).scim],
    [false, false],
  )
  for (const team of [adminTeam, stripeTeam]) {
    const entitlements = getOrganizationEntitlements(team, gated)
    assert.equal(entitlements.sso, true)
    assert.equal(entitlements.scim, false)
  }
  const enterprise = getOrganizationEntitlements(adminEnterprise, gated)
  assert.equal(enterprise.sso, true)
  assert.equal(enterprise.scim, true)
})

test("an Enterprise plan set by a platform admin unlocks SCIM token creation", () => {
  assert.deepEqual(checkEntitlement(adminEnterprise, "scim", gated), { ok: true })
  const refused = checkEntitlement(adminTeam, "scim", gated)
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.equal(refused.status, 402)
    assert.equal(refused.response.feature, "scim")
  }
})

test("with plan gating off (self-hosted default) nothing is locked", () => {
  const entitlements = getOrganizationEntitlements({}, { gatingEnabled: false })
  assert.equal(entitlements.sso, true)
  assert.equal(entitlements.scim, true)
})
