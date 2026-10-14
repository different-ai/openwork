import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { FeatureOverrides, FeatureRollouts } from "@openwork/features"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/white_label_bootstrap_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-white-label-bootstrap-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-white-label-bootstrap-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DEPLOYMENT = "cloud"
const { db } = await import("../src/db.js")
const { cache } = await import("../src/cache.js")
const { env } = await import("../src/env.js")
const { resolveBootstrapWorkspaceBranding, bootstrapWorkspaceBrandingSchema } = await import("../src/workspace-bootstrap-branding.js")
afterEach(() => { mock.restoreAll(); env.features.deployment = "cloud" })

function setup() {
  const organizationId = createDenTypeId("organization")
  const brand = { appName: "Existing desktop", logoUrl: "https://example.com/logo", iconUrl: "https://example.com/icon" }
  const stored = { brandAppName: brand.appName, brandLogoUrl: brand.logoUrl, brandIconUrl: brand.iconUrl, preserved: { nested: [1, 2] } }
  const original = structuredClone(stored)
  const state: { rollouts: FeatureRollouts; overrides: FeatureOverrides } = { rollouts: {}, overrides: {} }
  mock.method(cache.features, "state", async (id: string) => { assert.equal(id, organizationId); return state })
  mock.method(db, "select", () => {
    const chain = { from: () => chain, where: () => chain, async limit() { return [{ metadata: stored, logo: "https://example.com/old-org-logo" }] } }
    return chain
  })
  return { organizationId, brand, stored, original, state }
}

test("workspace bootstrap emits an explicit top-level flag and stock branding for a new Cloud org", async () => {
  const h = setup()
  const response = await resolveBootstrapWorkspaceBranding(h.organizationId)
  assert.deepEqual(response, { whiteLabelEnabled: false, brand: { appName: "OpenWork", logoUrl: null, iconUrl: null } })
  assert.deepEqual(bootstrapWorkspaceBrandingSchema.parse(response), response)
  assert.equal(bootstrapWorkspaceBrandingSchema.safeParse({ brand: h.brand }).success, false, "brand presence cannot substitute for the opt-in boolean")
  assert.deepEqual(h.stored, h.original, "fake metadata on a new Cloud org cannot grant the feature or rewrite storage")
})

test("workspace bootstrap honors existing-org overrides, kill switch and self-hosted defaults", async () => {
  const h = setup()
  h.state.overrides = { whiteLabel: true }
  assert.deepEqual(await resolveBootstrapWorkspaceBranding(h.organizationId), { whiteLabelEnabled: true, brand: h.brand })
  h.state.rollouts = { whiteLabel: { enabled: true, killed: true } }
  assert.deepEqual(await resolveBootstrapWorkspaceBranding(h.organizationId), { whiteLabelEnabled: false, brand: { appName: "OpenWork", logoUrl: null, iconUrl: null } })
  env.features.deployment = "self_hosted"
  h.state.rollouts = {}
  h.state.overrides = {}
  assert.deepEqual(await resolveBootstrapWorkspaceBranding(h.organizationId), { whiteLabelEnabled: true, brand: h.brand })
  h.state.overrides = { whiteLabel: false }
  assert.equal((await resolveBootstrapWorkspaceBranding(h.organizationId)).whiteLabelEnabled, false)
  assert.deepEqual(h.stored, h.original)
})
