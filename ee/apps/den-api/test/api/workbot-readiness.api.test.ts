/**
 * GET /v1/org/workbot-readiness: Den web asks it before sending someone to Workbot.
 * - with the operational free allowance disabled, gatewayRequired is true;
 * - hasGatewayProvider is true only for an active AI Gateway provider of this organization: a disabled one and
 *   another organization's do not count;
 * - any member can read it (they cannot list providers), it names nothing, and non-members are refused.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text, type Call } from "./harness.js"

// Only the outside model catalog is synthetic; providers are created through Den's real API.
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    openai: { id: "openai", name: "Fixture OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
      "gpt-6-luna": { id: "gpt-6-luna", name: "Fixture Luna", limit: { context: 100000, output: 1000 } },
    } },
  })
}
const gatewayBaseUrl = "http://127.0.0.1:8791"
const den = await bootDen({ env: { INFERENCE_FREE_ENABLED: "false", GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayBaseUrl, GATEWAY_PUBLIC_BASE_URL: gatewayBaseUrl } })
after(async () => { globalThis.fetch = realFetch; await den.close() })

const path = "/v1/org/workbot-readiness"

function readiness(call: Call) {
  assert.equal(call.status, 200, summary(call))
  assert.equal(call.headers.get("cache-control"), "no-store")
  assert.ok(call.body && typeof call.body === "object" && !Array.isArray(call.body))
  // Content-free: exactly two booleans, never provider names, counts or ids.
  assert.deepEqual(Object.keys(call.body).sort(), ["gatewayRequired", "hasGatewayProvider"])
  return { gatewayRequired: field(call.body, "gatewayRequired"), hasGatewayProvider: field(call.body, "hasGatewayProvider") }
}

test("Workbot readiness counts only this organization's active AI Gateway providers", { timeout: 90_000 }, async () => {
  const a = await den.createOrg(await den.signUp("Readiness Owner A"), "Readiness workspace A")
  const b = await den.createOrg(await den.signUp("Readiness Owner B"), "Readiness workspace B")
  const member = await den.newMember(a.owner, a.orgId, "Readiness Member")
  const owner = den.as(a.owner, a.orgId)
  const asMember = den.as(member, a.orgId)
  const otherOwner = den.as(b.owner, b.orgId)

  // No provider anywhere.
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })
  assert.deepEqual(readiness(await owner("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })

  // Another organization's active provider does not count.
  const foreign = await otherOwner("POST", "/v1/inference-providers", { name: "Other org OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] })
  assert.equal(foreign.status, 201, summary(foreign))
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })
  assert.deepEqual(readiness(await otherOwner("GET", path)), { gatewayRequired: true, hasGatewayProvider: true })

  // A disabled provider does not count.
  const disabled = await owner("POST", "/v1/inference-providers", { name: "Disabled OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"], status: "disabled" })
  assert.equal(disabled.status, 201, summary(disabled))
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })

  // An active provider counts, for every member, even one without a grant to it.
  const created = await owner("POST", "/v1/inference-providers", { name: "Active OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] })
  assert.equal(created.status, 201, summary(created))
  const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  const memberView = await asMember("GET", path)
  assert.deepEqual(readiness(memberView), { gatewayRequired: true, hasGatewayProvider: true })
  assert.ok(!memberView.text.includes(providerId) && !memberView.text.includes("Active OpenAI"))

  // Disabling it makes Workbot unready again.
  const paused = await owner("PATCH", `/v1/inference-providers/${providerId}`, { status: "disabled" })
  assert.equal(paused.status, 200, summary(paused))
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })
})

test("GA does not enable the operational free allowance or offer unconfigured purchases", async () => {
  const workspace = await den.createOrg(await den.signUp("Operational Setting Owner"), "Operational settings workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const options = await den.request(token, "GET", "/v1/workbot/model-recovery")
  assert.equal(options.status, 200, summary(options))
  assert.equal(field(options.body, "purchaseEligible"), false)
  assert.equal(field(options.body, "canUpgrade"), false)
  assert.equal(field(options.body, "freeExhausted"), false)
  assert.equal(field(options.body, "freeResetsAt"), null)
  const { WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID } = await import("@openwork/types/den/workbot-settings")
  for (const model of [WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID]) {
    const turn = await den.request(token, "POST", "/v1/workbot/run-token", { body: { model, modelAccessRequired: true } })
    assert.equal(turn.status, 403, summary(turn))
    assert.equal(field(turn.body, "modelAccess"), undefined, "claiming recovery cannot bypass entitlement")
  }
})

test("Workbot readiness is refused without a session or outside the organization", { timeout: 60_000 }, async () => {
  const a = await den.createOrg(await den.signUp("Readiness Owner C"), "Readiness workspace C")
  const outsider = await den.createOrg(await den.signUp("Readiness Outsider"), "Readiness outsider workspace")

  const anonymous = await den.request(null, "GET", path, { orgId: a.orgId })
  assert.equal(anonymous.status, 401, summary(anonymous))

  // Naming an organization the caller doesn't belong to never answers for it.
  const foreign = await den.as(outsider.owner, a.orgId)("GET", path)
  assert.equal(foreign.status, 404, summary(foreign))
  assert.equal(field(foreign.body, "gatewayRequired"), undefined)
})
