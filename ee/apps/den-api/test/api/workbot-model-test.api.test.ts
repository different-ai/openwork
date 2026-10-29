import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { modelProbeFixture } from "../../../headless-runner/scripts/model-probe-fixture.js"
import { bootDen, field, summary, type Member } from "./harness.js"
import { grantGatewayModels, memberGatewayKey, stubPublicModelCatalog } from "./gateway-fixture.js"

// The real Node runner probes the owner's own AI Gateway route: the synthetic provider stands in for the Gateway
// and accepts only that member's Gateway key. Only the public model catalog and the upstream provider are synthetic.
const runner = await modelProbeFixture({ protocol: "openai-responses" })
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: {
  DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32),
  GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: runner.providerUrl, GATEWAY_PUBLIC_BASE_URL: runner.providerUrl,
} })
after(async () => { restoreFetch(); await den.close(); await runner.close() })
const path = "/v1/org/workbot-settings/test-default-model"

/** The owner's Gateway grant for Luna and another model; the synthetic upstream accepts their Gateway key. */
async function gatewayAccess(owner: Member, orgId: string) {
  const aliases = await grantGatewayModels(den, owner, orgId, [owner], ["gpt-6-luna", "gpt-fixture-other"])
  const key = await memberGatewayKey(orgId, owner)
  runner.acceptModelKey(key)
  return { luna: aliases["gpt-6-luna"], other: aliases["gpt-fixture-other"], key }
}

test("only a recent real admin session can pay for a server-selected synthetic check, not catalog-derived success", async () => {
  const workspace = await den.createOrg(await den.signUp("Diagnostic Owner"), "Diagnostic workspace")
  const outsider = await den.createOrg(await den.signUp("Other Diagnostic Owner"), "Other diagnostic workspace")
  const member = await den.newMember(workspace.owner, workspace.orgId, "Diagnostic Member")
  const access = await gatewayAccess(workspace.owner, workspace.orgId)
  const call = den.as(workspace.owner, workspace.orgId)
  assert.equal((await den.as(member, workspace.orgId)("POST", path, {})).status, 403)
  assert.equal((await den.as(outsider.owner, workspace.orgId)("POST", path, {})).status, 404)
  const mcp = await den.mintMcpToken(workspace.owner, workspace.orgId)
  assert.notEqual((await den.request(mcp, "POST", path, { orgId: workspace.orgId, body: {} })).status, 200, "an MCP request is not evidence of a fresh user sign-in")
  assert.equal((await call("POST", path, { model: "gateway/other", prompt: "member content", apiKey: "untrusted" })).status, 400)
  assert.equal(runner.calls().length, 0)
  const catalogOnly = await call("GET", "/v1/org/workbot-settings")
  assert.equal(field(catalogOnly.body, "defaultReadiness"), "available")
  assert.equal(catalogOnly.text.includes('"status":"answered"'), false)
  assert.equal(runner.calls().length, 0)

  const answer = await call("POST", path, {})
  assert.equal(answer.status, 200, summary(answer))
  assert.deepEqual(answer.body, { status: "answered", errorCode: null, requestedModel: access.luna, reportedModel: "gpt-6-luna-fixture-snapshot" })
  runner.setMode("unauthorized")
  const denied = await call("POST", path, {})
  assert.equal(denied.status, 200, summary(denied))
  assert.equal(field(denied.body, "status"), "failed")
  assert.equal(field(denied.body, "errorCode"), "authentication_failed")
  assert.equal(field((await call("GET", "/v1/org/workbot-settings")).body, "defaultReadiness"), "available", "a listed model can still refuse a paid completion")
  runner.setMode("payment_required")
  const payment = await call("POST", path, {})
  assert.equal(field(payment.body, "status"), "failed")
  assert.equal(field(payment.body, "errorCode"), "payment_required")
  const { db } = await import("../../src/db.js")
  const [durableLimit] = await db.select({ count: RateLimitTable.count }).from(RateLimitTable).where(eq(RateLimitTable.key, `workbot-model-test:org:${workspace.orgId}`))
  assert.equal(durableLimit?.count, 3, "the diagnostic limit is persisted in the existing database primitive, not a process Map")
  const attempts = runner.calls().length
  const throttled = await call("POST", path, {})
  assert.equal(throttled.status, 429, summary(throttled))
  assert.ok(throttled.headers.get("retry-after"))
  assert.equal(runner.calls().length, attempts)
  for (const response of [answer, denied, payment]) {
    for (const secret of ["fixture-model-key", access.key, "fixture-private", "fixture-answer", "READY", "member content"]) assert.equal(response.text.includes(secret), false)
  }
  assert.equal(runner.sessionCount(), 0)
})

test("a saved org override is server-derived and an aged real session is required to reauthenticate", async () => {
  runner.setMode("answered")
  const workspace = await den.createOrg(await den.signUp("Override Diagnostic Owner"), "Override diagnostic workspace")
  const call = den.as(workspace.owner, workspace.orgId)
  const access = await gatewayAccess(workspace.owner, workspace.orgId)
  assert.equal((await call("PUT", "/v1/org/workbot-settings", { model: access.other })).status, 200)
  const answer = await call("POST", path, {})
  assert.equal(answer.status, 200, summary(answer))
  assert.equal(field(answer.body, "requestedModel"), access.other)
  const { db } = await import("../../src/db.js")
  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.userId, workspace.owner.userId))
  const attempts = runner.calls().length
  const stale = await call("POST", path, {})
  assert.equal(stale.status, 403, summary(stale))
  assert.equal(field(stale.body, "error"), "reauth")
  assert.equal(field(stale.body, "reason"), "fresh_auth_required")
  assert.equal(runner.calls().length, attempts)
  assert.equal(runner.sessionCount(), 0)
})
