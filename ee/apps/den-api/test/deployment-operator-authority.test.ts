import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { AuthContextVariables } from "../src/session.js"

// Hosted Den: deny before any allowlist lookup. No database is contacted.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/operator_authority_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-operator-authority-unit-test-secret-not-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-operator-authority-unit-test-key-not-production"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_DEPLOYMENT = "cloud"
process.env.DEN_REQUIRE_EMAIL_VERIFICATION = "true"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://api.unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { canManageDeploymentServices, isLocalDeploymentOperator, requireAdminMiddleware } = await import("../src/middleware/admin.js")

test("hosted Den never grants installation authority, to sessions or API keys, and never looks up the allowlist", async () => {
  const lookups = mock.method(db, "select", () => { throw new Error("hosted Den must not consult the local allowlist") })
  try {
    const userId = createDenTypeId("user")
    const user = { id: userId, email: "operator@example.test", name: "Operator", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() }
    const apiKey = { id: createDenTypeId("apiKey"), configId: "default", referenceId: userId, metadata: null }
    const session = { id: createDenTypeId("session"), token: "synthetic-session-token", userId, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(), ipAddress: null, userAgent: null, activeOrganizationId: null, activeTeamId: null }
    const principals: AuthContextVariables[] = [{ user, session: null, apiKey }, { user, session, apiKey: null }]
    for (const principal of principals) {
      assert.equal(await isLocalDeploymentOperator(principal), false)
      assert.equal(await canManageDeploymentServices(principal), false)
    }
    assert.equal(lookups.mock.callCount(), 0)
  } finally { lookups.mock.restore() }
})

test("where Den verifies emails, an allowlisted email grants platform admin only once it is verified", async () => {
  // Every allowlist lookup answers yes, so only the verification decides.
  const lookups = mock.method(db, "select", () => ({
    from() { return { where() { return { async limit() { return [{ id: "unit_admin_allowlist" }] } } } } },
  }))
  try {
    const statuses: Record<string, unknown> = {}
    for (const emailVerified of [true, false]) {
      const user = { id: createDenTypeId("user"), email: "platform-admin@example.test", name: "Platform Admin", emailVerified, image: null, createdAt: new Date(), updatedAt: new Date() }
      const app = new Hono<{ Variables: AuthContextVariables }>()
      app.use(async (c, next) => {
        c.set("user", user)
        c.set("session", null)
        c.set("apiKey", null)
        await next()
      })
      app.get("/v1/admin/overview", requireAdminMiddleware, (c) => c.json({ ok: true }))
      const response = await app.request("/v1/admin/overview")
      statuses[emailVerified ? "verified" : "unverified"] = { status: response.status, body: await response.json() }
    }
    assert.deepEqual(statuses, {
      verified: { status: 200, body: { ok: true } },
      unverified: { status: 403, body: { error: "admin_email_unverified" } },
    })
    assert.equal(lookups.mock.callCount(), 1, "the unverified email never reaches the allowlist")
  } finally { lookups.mock.restore() }
})
