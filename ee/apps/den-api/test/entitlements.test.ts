import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let entitlements: typeof import("../src/entitlements.js")

beforeAll(async () => {
  seedRequiredEnv()
  entitlements = await import("../src/entitlements.js")
})

test("parseOrganizationPlan defaults to the free tier", () => {
  expect(entitlements.parseOrganizationPlan(null)).toEqual({ tier: "free", source: "default" })
  expect(entitlements.parseOrganizationPlan("not json")).toEqual({ tier: "free", source: "default" })
  expect(entitlements.parseOrganizationPlan({})).toEqual({ tier: "free", source: "default" })
  expect(entitlements.parseOrganizationPlan({ plan: { tier: "platinum" } })).toEqual({ tier: "free", source: "default" })
})

test("parseOrganizationPlan reads object and string metadata", () => {
  const plan = { tier: "enterprise", source: "grandfathered", grandfatheredAt: "2026-06-12T00:00:00.000Z" }
  expect(entitlements.parseOrganizationPlan({ plan })).toEqual(plan)
  expect(entitlements.parseOrganizationPlan(JSON.stringify({ plan }))).toEqual(plan)
})

test("entitlements are all granted when gating is disabled", () => {
  expect(entitlements.getOrganizationEntitlements(null, { gatingEnabled: false })).toEqual({
    sso: true,
    desktopPolicies: true,
    orgControls: true,
    analytics: true,
  })
})

test("entitlements require the enterprise tier when gating is enabled", () => {
  expect(entitlements.getOrganizationEntitlements(null, { gatingEnabled: true })).toEqual({
    sso: false,
    desktopPolicies: false,
    orgControls: false,
    analytics: false,
  })
  expect(entitlements.getOrganizationEntitlements({ plan: { tier: "team" } }, { gatingEnabled: true })).toEqual({
    sso: false,
    desktopPolicies: false,
    orgControls: false,
    analytics: false,
  })
  expect(entitlements.getOrganizationEntitlements({ plan: { tier: "enterprise", source: "manual" } }, { gatingEnabled: true })).toEqual({
    sso: true,
    desktopPolicies: true,
    orgControls: true,
    analytics: true,
  })
})

test("grandfathered organizations keep full entitlements when gating is enabled", () => {
  const metadata = { plan: { tier: "enterprise", source: "grandfathered", grandfatheredAt: "2026-06-12T00:00:00.000Z" } }
  expect(entitlements.getOrganizationEntitlements(metadata, { gatingEnabled: true })).toEqual({
    sso: true,
    desktopPolicies: true,
    orgControls: true,
    analytics: true,
  })
})

test("checkEntitlement returns a 402 payload with a human-readable message", () => {
  const result = entitlements.checkEntitlement(null, "sso", { gatingEnabled: true })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.status).toBe(402)
    expect(result.response.error).toBe("enterprise_plan_required")
    expect(result.response.feature).toBe("sso")
    expect(result.response.message).toContain("Enterprise plan")
  }
})

test("checkEntitlement passes for entitled organizations", () => {
  expect(entitlements.checkEntitlement({ plan: { tier: "enterprise" } }, "desktopPolicies", { gatingEnabled: true })).toEqual({ ok: true })
  expect(entitlements.checkEntitlement(null, "desktopPolicies", { gatingEnabled: false })).toEqual({ ok: true })
})

test("usage analytics follows the same enterprise gate", () => {
  const denied = entitlements.checkEntitlement(null, "analytics", { gatingEnabled: true })
  expect(denied.ok).toBe(false)
  if (!denied.ok) {
    expect(denied.status).toBe(402)
    expect(denied.response.feature).toBe("analytics")
    expect(denied.response.message).toContain("Usage analytics")
  }
  expect(entitlements.checkEntitlement({ plan: { tier: "enterprise" } }, "analytics", { gatingEnabled: true })).toEqual({ ok: true })
  expect(entitlements.checkEntitlement(null, "analytics", { gatingEnabled: false })).toEqual({ ok: true })
})
