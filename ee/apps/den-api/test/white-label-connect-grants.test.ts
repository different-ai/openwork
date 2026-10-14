import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { CONNECT_LINK_AUDIENCE, CONNECT_LINK_VERSION } from "@openwork/connect-link"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/white_label_grants_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-white-label-grant-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-white-label-grant-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DEPLOYMENT = "cloud"
const { db } = await import("../src/db.js")
const { cache } = await import("../src/cache.js")
const { previewDesktopConnectGrant, inspectDesktopConnectGrant, consumeDesktopConnectGrant } = await import("../src/desktop-connect-grants.js")
afterEach(() => mock.restoreAll())

test("old stored grants project the owner's live flag without rewriting original claims", async () => {
  const organizationId = createDenTypeId("organization")
  const installLinkId = createDenTypeId("install_link")
  const brand = { appName: "Existing desktop", logoUrl: "https://example.com/logo", iconUrl: "https://example.com/icon" }
  const claims = {
    iss: "https://api.example.com", aud: CONNECT_LINK_AUDIENCE, iat: Math.floor(Date.now() / 1000) - 1,
    exp: Math.floor(Date.now() / 1000) + 3600, jti: "old-grant", v: CONNECT_LINK_VERSION,
    org: { name: "Example org" }, brand, den: { baseUrl: "https://example.com" }, requireSignin: true,
  }
  const original = structuredClone(claims)
  const row = { installLink: { id: installLinkId, organizationId, revokedAt: null, expiresAt: null }, grant: { claims, expiresAt: new Date(Date.now() + 3600_000), consumedAt: null, consumedNonce: null } }
  let whiteLabelEnabled = false
  mock.method(cache.features, "state", async (ownerId: string) => {
    assert.equal(ownerId, organizationId, "flag scope comes from the owning install link")
    return { rollouts: {}, overrides: { whiteLabel: whiteLabelEnabled } }
  })
  mock.method(db, "select", (fields: Record<string, unknown>) => {
    const chain = {
      from: () => chain, innerJoin: () => chain, where: () => chain,
      async limit() { return "grant" in fields ? [row] : [{ codeHash: "old-grant" }] },
    }
    return chain
  })
  mock.method(db, "transaction", async (callback: (database: typeof db) => Promise<unknown>) => callback(db))
  mock.method(db, "update", () => ({ set: (value: Record<string, unknown>) => ({ async where() {
    assert.equal("claims" in value, false, "exchange only consumes the grant, never replaces original signed data")
  } }) }))
  for (const enabled of [false, true, false]) {
    whiteLabelEnabled = enabled
    for (const read of [previewDesktopConnectGrant, inspectDesktopConnectGrant, consumeDesktopConnectGrant]) {
      const result = await read("existing-secret-code")
      assert.equal(result.ok, true)
      if (!result.ok) continue
      assert.equal(result.claims.whiteLabelEnabled, enabled)
      assert.deepEqual(result.claims.brand, enabled ? brand : { appName: "OpenWork", logoUrl: null, iconUrl: null })
      assert.deepEqual(claims, original)
    }
  }
  row.grant.expiresAt = new Date(0)
  assert.deepEqual(await previewDesktopConnectGrant("existing-secret-code"), { ok: false, code: "expired" })
})
