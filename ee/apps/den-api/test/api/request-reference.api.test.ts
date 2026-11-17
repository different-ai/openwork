import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, type Method } from "./harness.js"

const den = await bootDen()
after(() => den.close())
await import("../../src/auth.js").then(({ auth }) => auth.$context)
const { appLogger } = await import("../../src/observability/logger.js")
const { publicRoute } = await import("../../src/middleware/route-access.js")
const { db } = await import("../../src/db.js")
const { PlatformAuditEventTable } = await import("@openwork-ee/den-db/schema")
const { eq } = await import("@openwork-ee/den-db/drizzle")

den.app.get("/reference-proof/throw", publicRoute, () => {
  appLogger.child({ component: "reference-proof" }).info("reference proof started")
  throw new Error("synthetic failure")
})
den.app.use("/reference-proof/limited", async (c) => c.json({ error: "rate_limited", retryAfter: 10 }, 429))

test("server references join JSON errors, middleware failures and request logs without exposing headers", async (t) => {
  const lines: string[] = []
  t.mock.method(process.stdout, "write", (chunk: unknown) => {
    if (typeof chunk === "string") lines.push(chunk)
    return true
  })
  const references = new Set<string>()
  const cases: Array<[Method, string, number]> = [
    ["GET", "/reference-proof/missing", 404],
    ["GET", "/reference-proof/missing", 404],
    ["GET", "/v1/auth/login-options?email=not-an-email", 400],
    ["GET", "/v1/me", 401],
    ["GET", "/reference-proof/throw", 500],
    ["GET", "/reference-proof/limited", 429],
  ]
  for (const [method, path, status] of cases) {
    const before = lines.length
    const response = await den.request(null, method, path, { headers: { "x-request-id": "req_01h2xcejqtf2nbrexx3vqjhp41" } })
    assert.equal(response.status, status, response.text)
    const reference = field(response.body, "referenceId")
    assert.equal(typeof reference, "string")
    if (typeof reference !== "string") throw new Error("reference missing")
    assert.match(reference, /^req_[0-9a-hjkmnp-tv-z]{26}$/)
    assert.notEqual(reference, "req_01h2xcejqtf2nbrexx3vqjhp41")
    assert.ok(!references.has(reference))
    references.add(reference)
    assert.equal(response.headers.get("x-request-id"), null)
    const logs = lines.slice(before).flatMap((line) => {
      try { const value: unknown = JSON.parse(line); return [value] } catch { return [] }
    })
    assert.ok(logs.some((entry) => field(entry, "message") === "request completed" && field(entry, "request_id") === reference))
    if (status === 500) {
      for (const message of ["request failed", "reference proof started"]) {
        assert.ok(logs.some((entry) => field(entry, "message") === message && field(entry, "request_id") === reference), message)
      }
    }
    if (status === 429) assert.equal(field(response.body, "retryAfter"), 10)
    if (path === "/v1/me") {
      const records = await db.select({ requestId: PlatformAuditEventTable.request_id }).from(PlatformAuditEventTable)
        .where(eq(PlatformAuditEventTable.request_id, reference))
      assert.ok(records.length > 0, "the existing platform audit record carries the response reference")
      assert.ok(records.every((record) => record.requestId === reference))
    }
  }
})

test("MCP and OAuth retain their existing protocol references", async () => {
  const mcp = await den.request(null, "POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize" } })
  assert.equal(mcp.status, 401)
  assert.match(String(field(mcp.body, "referenceId")), /^req_[0-9a-hjkmnp-tv-z]{26}$/)
  const oauth = await den.request(null, "POST", "/api/auth/oauth2/token", { rawBody: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer", headers: { "content-type": "application/x-www-form-urlencoded" } })
  assert.equal(oauth.status, 400)
  assert.match(String(field(oauth.body, "reference_id")), /^req_[0-9a-hjkmnp-tv-z]{26}$/)
  assert.equal(field(oauth.body, "referenceId"), field(oauth.body, "reference_id"))
})
