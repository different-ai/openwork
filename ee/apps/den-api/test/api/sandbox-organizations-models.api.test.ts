/**
 * Enterprise sandboxes: on a deployment that mints model keys, each sandbox is created on the Enterprise plan with
 * its own OpenRouter key capped at the chosen credit, added as an ordinary AI Gateway provider for everyone.
 * Closing disables the key, extending re-enables it and moves the plan's end date, the cap can be changed, and
 * deleting the organization deletes the key. Only the outside services are synthetic: the public model catalog and
 * OpenRouter's key API (recorded below). Den's routes, database, Gateway writes and MCP tools are real.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, list, summary, text } from "./harness.js"

const MINTED_KEY = "sk-or-v1-sandbox-fixture-key"
type KeyCall = { method: string; path: string; body: Record<string, unknown> | null; auth: string | null }
const keyCalls: KeyCall[] = []
let remainingUsd = 21.5
let failNextDisable = false

const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === "https://models.openworklabs.com/api.json") {
    return Response.json({
      openrouter: { id: "openrouter", name: "OpenRouter", npm: "@openrouter/ai-sdk-provider", env: ["OPENROUTER_API_KEY"], api: "https://openrouter.ai/api/v1", models: {
        "anthropic/claude-sonnet-5.5": { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", limit: { context: 200000, output: 8000 } },
        "openai/gpt-5.5": { id: "openai/gpt-5.5", name: "GPT-5.5", limit: { context: 200000, output: 8000 } },
      } },
    })
  }
  if (url.startsWith("https://openrouter.ai/api/v1/keys")) {
    const method = init?.method ?? "GET"
    const raw = typeof init?.body === "string" ? init.body : null
    const headers = new Headers(init?.headers)
    keyCalls.push({ method, path: new URL(url).pathname, body: raw ? JSON.parse(raw) : null, auth: headers.get("authorization") })
    if (method === "POST") return Response.json({ key: MINTED_KEY, data: { hash: `hash_${keyCalls.length}` } }, { status: 201 })
    if (method === "GET") return Response.json({ data: { limit: 25, limit_remaining: remainingUsd, disabled: false } })
    if (method === "PATCH" && raw && field(JSON.parse(raw), "disabled") === true && failNextDisable) {
      failNextDisable = false
      return Response.json({ error: { message: "Temporary upstream outage" } }, { status: 503 })
    }
    return Response.json({ data: {} })
  }
  return realFetch(input, init)
}

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", ...gatewayFixtureEnv, OPENROUTER_MANAGEMENT_API_KEY: "or-management-fixture", DEN_SANDBOX_GATEWAY_MODELS: "anthropic/claude-sonnet-5.5,openai/gpt-5.5", DEN_SANDBOX_CREDIT_USD: "40", DEN_SANDBOX_WORKPLACE_URL: "http://127.0.0.1:9/", DEN_PLAN_GATING_ENABLED: "true" } })
after(async () => { globalThis.fetch = realFetch; await den.close() })

const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const create = (body: Record<string, unknown>) => den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", {
  body: { name: "Trial sandbox", connectorBaseUrl: null, days: 14, memberLimit: 10, allowedEmailDomains: [], ...body },
})
const callsFor = (hash: string) => keyCalls.filter((call) => call.path.endsWith(`/${hash}`))
/** The hash the fake OpenRouter gave the most recently minted key. */
const lastHash = () => `hash_${keyCalls.findLastIndex((call) => call.method === "POST") + 1}`
const { client } = await import("../../src/db.js")
/** What the organization's people get: Den's Enterprise entitlement, as the app reads it. */
async function enterpriseUnlocked(orgId: string) {
  const context = await den.request(admin.token, "GET", "/v1/org", { orgId })
  assert.equal(context.status, 200, summary(context))
  return field(context.body, "entitlements", "desktopPolicies")
}
/** ARRANGE ONLY: the sandbox's time ran out (waiting days is not practical in a test). */
const expire = (sandboxId: string) => client.execute("UPDATE sandbox_organization SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?", [sandboxId])
async function storedPlan(orgId: string) {
  const [rows] = await client.query("SELECT metadata FROM organization WHERE id = ?", [orgId])
  const metadata: unknown = field(Array.isArray(rows) ? rows[0] : null, "metadata")
  return field(typeof metadata === "string" ? JSON.parse(metadata) : metadata, "plan")
}

test("a new sandbox is Enterprise until it ends and gets its own capped OpenRouter key as an AI Gateway provider for everyone", async () => {
  const defaults = field((await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")).body, "defaults")
  assert.equal(field(defaults, "creditUsd"), 40, "the deployment default cap is offered")
  assert.equal(field(defaults, "gatewayProviderId"), "openrouter")

  const created = await create({ creditUsd: 25 })
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(field(sandbox, "planTier"), "enterprise")
  assert.deepEqual(field(sandbox, "modelCredit"), { limitUsd: 25, remainingUsd: 21.5 })
  assert.ok(!JSON.stringify(created.body).includes(MINTED_KEY), "the key never leaves Den")

  const mint = keyCalls.find((call) => call.method === "POST")
  assert.equal(mint?.auth, "Bearer or-management-fixture", "minted with the management key")
  assert.equal(field(mint?.body, "limit"), 25)

  const plan = await storedPlan(orgId)
  assert.equal(field(plan, "tier"), "enterprise")
  assert.equal(field(plan, "seats"), 10, "seats match the sandbox")

  const member = await den.newMember(admin, orgId, "Sandbox Member")
  const usable = await den.as(member, orgId)("GET", "/v1/inference-providers?scope=usable")
  assert.equal(usable.status, 200, summary(usable))
  const provider = list(field(usable.body, "inferenceProviders")).find((entry) => entry.name === "Sandbox models")
  assert.ok(provider, `everyone can use the sandbox's models: ${summary(usable)}`)
  assert.deepEqual(list(provider.models).map((model) => model.upstreamModelId).sort(), ["anthropic/claude-sonnet-5.5", "openai/gpt-5.5"])
  assert.ok(!JSON.stringify(usable.body).includes(MINTED_KEY))
})

test("the cap can be changed; closing disables the key and extending turns it back on and moves the plan's end", async () => {
  const sandbox = field((await create({})).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id")
  assert.equal(field(sandbox, "modelCredit", "limitUsd"), 40, "omitted credit uses the deployment default")
  const hash = lastHash()

  const credit = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/credit`, { body: { creditUsd: 75 } })
  assert.equal(credit.status, 200, summary(credit))
  assert.equal(field(credit.body, "sandbox", "modelCredit", "limitUsd"), 75)
  assert.deepEqual(callsFor(hash).filter((call) => call.method === "PATCH").map((call) => call.body), [{ limit: 75 }])

  const orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(await enterpriseUnlocked(orgId), true, "Enterprise features are on while the sandbox runs")
  const closed = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/close`)
  assert.equal(field(closed.body, "sandbox", "state"), "closed", summary(closed))
  assert.equal(await enterpriseUnlocked(orgId), false, "closing ends the Enterprise grant")
  assert.equal(field(closed.body, "sandbox", "planTier"), "free")
  const extended = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/extend`, { body: { days: 30 } })
  assert.equal(field(extended.body, "sandbox", "state"), "open", summary(extended))
  assert.equal(await enterpriseUnlocked(orgId), true, "reopening grants Enterprise again")
  assert.deepEqual(callsFor(hash).filter((call) => call.method === "PATCH").map((call) => call.body), [{ limit: 75 }, { disabled: true }, { disabled: false }])

  const plan = await storedPlan(orgId)
  const expiresAt = text(field(extended.body, "sandbox", "expiresAt"), "expiresAt")
  assert.equal(field(plan, "tier"), "enterprise")
  assert.equal(field(plan, "endsAt"), expiresAt.slice(0, 10), "the plan ends with the sandbox")
})

test("a sandbox whose time ran out loses Enterprise and its key without anyone closing it; a plan set by hand is never undone", async () => {
  const lapsing = field((await create({})).body, "sandbox")
  const lapsingId = text(field(lapsing, "id"), "sandbox id"), lapsingOrg = text(field(lapsing, "organizationId"), "organization id")
  const lapsingHash = lastHash()
  await expire(lapsingId)
  const { closeExpiredSandboxes } = await import("../../src/sandbox-organizations.js")
  await closeExpiredSandboxes()
  assert.equal(await enterpriseUnlocked(lapsingOrg), false)
  assert.ok(callsFor(lapsingHash).some((call) => call.method === "PATCH" && field(call.body, "disabled") === true), "its key is disabled")

  const converted = field((await create({})).body, "sandbox")
  const convertedId = text(field(converted, "id"), "sandbox id"), convertedOrg = text(field(converted, "organizationId"), "organization id")
  const sold = await den.request(admin.token, "PATCH", `/v1/admin/organizations/${convertedOrg}/plan`, { body: { tier: "enterprise", seatLimit: 40, endsAt: "2027-12-31" } })
  assert.equal(sold.status, 200, summary(sold))
  await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${convertedId}/close`)
  assert.equal(await enterpriseUnlocked(convertedOrg), true, "an Enterprise plan an admin set by hand survives closing the sandbox")
  assert.equal(field(await storedPlan(convertedOrg), "seats"), 40)
})

test("expiry reconciliation retries key revocation after a transient failure even when the sandbox is already closed", async () => {
  const sandbox = field((await create({})).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id")
  const hash = lastHash()
  failNextDisable = true
  const closed = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/close`)
  assert.equal(field(closed.body, "sandbox", "state"), "closed", summary(closed))
  const disables = () => callsFor(hash).filter(call => call.method === "PATCH" && field(call.body, "disabled") === true)
  assert.equal(disables().length, 1, "the first disable failed upstream")
  const { closeExpiredSandboxes } = await import("../../src/sandbox-organizations.js")
  await closeExpiredSandboxes()
  assert.equal(disables().length, 2, "closed rows are retried without waiting for their original expiry")
})

test("deleting a sandbox's organization deletes its key at OpenRouter", async () => {
  const sandbox = field((await create({})).body, "sandbox")
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  const hash = lastHash()
  const deleted = await den.request(admin.token, "DELETE", "/v1/org", { orgId })
  assert.equal(deleted.status, 200, summary(deleted))
  assert.ok(callsFor(hash).some((call) => call.method === "DELETE"), JSON.stringify(callsFor(hash)))
  const listed = list(field((await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")).body, "sandboxes"))
  assert.ok(!listed.some((entry) => entry.organizationId === orgId), "the sandbox row goes with the organization")
})

test("the admin MCP creates, credits and closes sandboxes with the same results", async () => {
  const owned = await den.createOrg(admin, "Admin home")
  const token = await den.mintMcpToken(admin, owned.orgId)
  const created = await den.callMcpTool(token, "execute_capability", { name: "admin:den_sandbox_create", arguments: { name: "Agent sandbox", days: 7, memberLimit: 5, creditUsd: 30 } })
  assert.equal(created.isError, false, created.text)
  const sandbox = field(created.body, "sandbox")
  assert.equal(field(sandbox, "planTier"), "enterprise", created.text)
  assert.equal(field(sandbox, "modelCredit", "limitUsd"), 30)
  assert.equal(field(sandbox, "connectorCount"), 5, "the deployment's workplace connectors are added")
  const id = text(field(sandbox, "id"), "sandbox id")

  const credited = await den.callMcpTool(token, "execute_capability", { name: "admin:den_sandbox_set_credit", arguments: { sandboxId: id, creditUsd: 60 } })
  assert.equal(field(credited.body, "sandbox", "modelCredit", "limitUsd"), 60, credited.text)
  const closed = await den.callMcpTool(token, "execute_capability", { name: "admin:den_sandbox_close", arguments: { sandboxId: id } })
  assert.equal(field(closed.body, "sandbox", "state"), "closed", closed.text)
  const listed = await den.callMcpTool(token, "execute_capability", { name: "admin:den_sandbox_list", arguments: {} })
  assert.ok(list(field(listed.body, "sandboxes")).some((entry) => entry.id === id), listed.text)

  const person = await den.signUp("Not Admin")
  const theirs = await den.createOrg(person, "Their org")
  const refused = await den.callMcpTool(await den.mintMcpToken(person, theirs.orgId), "execute_capability", { name: "admin:den_sandbox_create", arguments: { name: "Nope", days: 1, memberLimit: 1 } })
  assert.ok(refused.isError || refused.rpcError, `non-admins cannot reach admin tools: ${refused.text}`)
})
