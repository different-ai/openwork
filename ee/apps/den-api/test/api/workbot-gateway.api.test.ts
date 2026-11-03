import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, isRecord, list, startFakeHttpServer, summary, text, type Call, type Member } from "./harness.js"

// Only the outside catalog and runner are synthetic. Authentication, permissions,
// provider matrices and Workbot routes use the real Den app/MySQL.
const realFetch = globalThis.fetch
const upstreamSecrets = ["fixture-openai-private-key", "fixture-anthropic-private-key", "fixture-other-org-private-key"]
const runnerToken = "fixture-runner-authentication-token-123456789"
const gatewayBaseUrl = "http://127.0.0.1:8791"
const probes: Record<string, unknown>[] = []
let catalogRequests = 0
let runnerCatalogRequests = 0
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  catalogRequests++
  return Response.json({
    openai: { id: "openai", name: "Fixture OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
      "gpt-6-luna": { id: "gpt-6-luna", name: "Actual upstream Luna", limit: { context: 100000, output: 1000 } },
      "not-luna": { id: "not-luna", name: "GPT-6 Luna", limit: { context: 100000, output: 1000 } },
    } },
    anthropic: { id: "anthropic", name: "Fixture Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"], api: "https://api.anthropic.com/v1", models: {
      "claude-fixture": { id: "claude-fixture", name: "Fixture Claude", limit: { context: 100000, output: 1000 } },
    } },
  })
}
const runner = await startFakeHttpServer((request, raw, response) => {
  assert.equal(request.headers.authorization, `Bearer ${runnerToken}`)
  response.setHeader("content-type", "application/json")
  if (request.method === "GET" && request.url === "/v1/models") {
    runnerCatalogRequests++
    response.end(JSON.stringify({ defaultModel: "gateway/legacy", verified: true, models: [{ id: "gateway/legacy", name: "Legacy global runner model" }] }))
    return
  }
  if (request.method === "POST" && request.url === "/v1/model-probe") {
    const body: unknown = JSON.parse(raw)
    assert.ok(isRecord(body))
    probes.push(body)
    response.end(JSON.stringify({ status: "answered", errorCode: null, requestedModel: body.model, reportedModel: "fixture-provider-reported-model" }))
    return
  }
  response.writeHead(404).end(JSON.stringify({ error: "unexpected_fixture_route" }))
})
const den = await bootDen({ env: {
  GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayBaseUrl, GATEWAY_PUBLIC_BASE_URL: gatewayBaseUrl,
  DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: runnerToken,
  DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "fixture-private-runner-callback-token-123456789",
} })
after(async () => { globalThis.fetch = realFetch; await den.close(); await runner.close() })
const settingsPath = "/v1/org/workbot-settings"
const safeResponses: Call[] = []

function ok(response: Call, status = 200): Call {
  assert.equal(response.status, status, summary(response))
  return response
}
function safe(response: Call, status = 200): Call {
  ok(response, status)
  safeResponses.push(response)
  return response
}
function modelIds(response: Call): unknown[] {
  return list(field(response.body, "models")).map(model => model.id).sort()
}

test("Workbot uses current member Gateway grants, exact org defaults and private per-run credentials", { timeout: 90_000 }, async () => {
  const a = await den.createOrg(await den.signUp("Gateway Owner A"), "Gateway workspace A")
  const b = await den.createOrg(await den.signUp("Gateway Owner B"), "Gateway workspace B")
  const member = await den.newMember(a.owner, a.orgId, "Gateway Viewer")
  const manager = await den.newMember(a.owner, a.orgId, "Gateway Manager Without Models")
  const noGrant = await den.newMember(a.owner, a.orgId, "Gateway No Grant")
  const owner = den.as(a.owner, a.orgId)
  const otherOwner = den.as(b.owner, b.orgId)
  for (const [person, key] of [[member, "inference.view"], [manager, "inference.manage"]] satisfies [Member, string][]) {
    const teamId = await den.createTeam(a.owner, a.orgId, `${key} team`, [person.memberId])
    ok(await owner("POST", "/v1/permissions/sets", { teamId, permissions: [{ key, status: "allow" }] }), 201)
  }
  const tokens = new Map<string, string>()
  for (const [person, orgId] of [[a.owner, a.orgId], [b.owner, b.orgId], [member, a.orgId], [manager, a.orgId], [noGrant, a.orgId]] satisfies [Member, string][]) {
    tokens.set(person.userId, await den.mintMcpToken(person, orgId))
  }
  const session = (person: Member) => den.request(text(tokens.get(person.userId), "MCP token"), "GET", "/v1/workbot/session")
  const run = (person: Member, model?: string) => den.request(text(tokens.get(person.userId), "MCP token"), "POST", "/v1/workbot/run-token", { body: model === undefined ? {} : { model } })

  assert.equal(field(safe(await run(a.owner), 403).body, "reason"), "gateway_provider_missing")

  async function configuredProvider(call: ReturnType<typeof den.as>, providerId: string, modelIds: string[], secret: string, audience: Member[]) {
    const created = safe(await call("POST", "/v1/inference-providers", { name: `Fixture ${providerId}`, providerId, modelIds }), 201)
    const id = text(field(created.body, "inferenceProvider", "id"), "provider id")
    const group = safe(await call("POST", `/v1/inference-providers/${id}/model-groups`, { name: "Assigned models", modelIds }), 201)
    const groupId = text(field(group.body, "modelGroup", "id"), "model group id")
    const credential = safe(await call("POST", `/v1/inference-providers/${id}/credential-sets`, { name: "Shared fixture credential", credentialMode: "org", credential: { kind: "api_key", secret } }), 201)
    const setId = text(field(credential.body, "credentialSet", "id"), "credential set id")
    const grantIds: string[] = []
    for (const person of audience) {
      const grant = safe(await call("POST", `/v1/inference-providers/${id}/access-grants`, { modelGroupId: groupId, credentialSetId: setId, audience: { type: "member", memberId: person.memberId } }), 201)
      grantIds.push(text(field(grant.body, "accessGrant", "id"), "access grant id"))
    }
    return { id, groupId, setId, grantIds }
  }
  const openai = await configuredProvider(owner, "openai", ["gpt-6-luna", "not-luna"], upstreamSecrets[0]!, [a.owner])
  const anthropic = await configuredProvider(owner, "anthropic", ["claude-fixture"], upstreamSecrets[1]!, [a.owner, member])
  const other = await configuredProvider(otherOwner, "openai", ["gpt-6-luna"], upstreamSecrets[2]!, [b.owner])
  assert.ok(catalogRequests > 0, "the public provider catalog was read, not a mocked internal service")
  async function alias(person: Member, orgId: string, providerId: string, upstreamModelId: string) {
    const usable = safe(await den.as(person, orgId)("GET", "/v1/inference-providers?scope=usable"))
    const provider = list(field(usable.body, "inferenceProviders")).find(entry => entry.id === providerId)
    const selected = list(provider?.models).find(entry => entry.upstreamModelId === upstreamModelId)
    const id = text(selected?.id, "usable gateway alias")
    assert.match(id, /^gwm_/)
    return id
  }
  const luna = await alias(a.owner, a.orgId, openai.id, "gpt-6-luna")
  const imposter = await alias(a.owner, a.orgId, openai.id, "not-luna")
  const claude = await alias(member, a.orgId, anthropic.id, "claude-fixture")
  const otherLuna = await alias(b.owner, b.orgId, other.id, "gpt-6-luna")
  assert.notEqual(luna, otherLuna)
  const runnerReads = runnerCatalogRequests
  const catalog = safe(await owner("GET", settingsPath))
  assert.deepEqual(modelIds(catalog), [luna, imposter, claude].sort())
  assert.equal(field(catalog.body, "defaultModel"), luna, "Luna is identified by upstream ID, not the imposter display name")
  assert.equal(field(catalog.body, "defaultReadiness"), "available")
  assert.equal(probes.length, 0, "credential-ready catalogs are not paid-completion evidence")
  const viewerSettings = safe(await den.as(member, a.orgId)("GET", settingsPath))
  assert.deepEqual(modelIds(viewerSettings), [claude])
  assert.deepEqual(modelIds(safe(await otherOwner("GET", settingsPath))), [otherLuna])
  assert.deepEqual(modelIds(safe(await den.as(manager, a.orgId)("GET", settingsPath))), [])
  safe(await den.as(noGrant, a.orgId)("GET", settingsPath), 403)
  safe(await den.as(member, a.orgId)("PUT", settingsPath, { model: claude }), 403)
  safe(await den.as(manager, a.orgId)("PUT", settingsPath, { model: luna }), 400)
  safe(await den.as(b.owner, a.orgId)("GET", settingsPath), 404)
  for (const model of [otherLuna, "gateway/legacy", "gpt-6-luna", `openai/${luna}`]) safe(await owner("PUT", settingsPath, { model }), 400)

  safe(await owner("PUT", settingsPath, { model: luna }))
  const initial = safe(await session(a.owner))
  assert.equal(field(initial.body, "model"), luna)
  assert.equal(field(initial.body, "gatewayModels"), true)
  assert.equal(field(initial.body, "modelAccess"), undefined)
  assert.equal(field(initial.body, "apiKey"), undefined)
  // A selected org default never grants access or falls back to the shared runner key.
  for (const person of [member, noGrant, manager]) {
    const denied = safe(await run(person), 403)
    assert.equal(field(denied.body, "error"), "workbot_turn_access_denied")
    assert.equal(field(denied.body, "reason"), "gateway_member_access_missing")
    assert.equal(field(denied.body, "token"), undefined)
    assert.equal(field(denied.body, "modelAccess"), undefined)
  }
  const readOnlyToken = ok(await den.request(a.owner.token, "POST", "/v1/mcp/token", { orgId: a.orgId, body: { scopes: ["mcp:read"] } }))
  const scopeRefused = safe(await den.request(text(field(readOnlyToken.body, "token"), "read-only token"), "POST", "/v1/workbot/run-token", { body: { model: luna } }), 403)
  assert.equal(field(scopeRefused.body, "reason"), "oauth_scope_missing")
  // Simulate a default saved before Gateway aliases: refusal diagnoses it without migrating it.
  const [{ db }, { eq }, { OrganizationTable }, { normalizeDenTypeId }] = await Promise.all([
    import("../../src/db.js"), import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"),
  ])
  const organizationId = normalizeDenTypeId("organization", a.orgId)
  const [saved] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
  assert.ok(saved)
  await db.update(OrganizationTable).set({ metadata: { ...saved.metadata, workbot: { model: "gateway/legacy" } } }).where(eq(OrganizationTable.id, organizationId))
  assert.equal(field(safe(await run(a.owner), 403).body, "reason"), "gateway_model_unavailable")
  assert.equal(field(safe(await session(a.owner)).body, "model"), "gateway/legacy", "refusal leaves the invalid saved default intact")
  await db.update(OrganizationTable).set({ metadata: saved.metadata }).where(eq(OrganizationTable.id, organizationId))
  const ownerRun = ok(await run(a.owner))
  const ownerKey = text(field(ownerRun.body, "modelAccess", "apiKey"), "owner member gateway key")
  const ownerConnect = ok(await owner("GET", `/v1/inference-providers/${openai.id}/connect`))
  assert.equal(ownerKey, field(ownerConnect.body, "inferenceProvider", "apiKey"))
  assert.equal(field(ownerRun.body, "modelAccess", "baseUrl"), `${gatewayBaseUrl}/api/v1/providers/${openai.id}`)
  assert.equal(field(ownerRun.body, "modelAccess", "protocol"), "openai-responses")
  const memberRun = ok(await run(member, claude))
  const memberKey = text(field(memberRun.body, "modelAccess", "apiKey"), "viewer member gateway key")
  assert.notEqual(memberKey, ownerKey)
  assert.equal(field(memberRun.body, "modelAccess", "protocol"), "anthropic")
  assert.equal(field(memberRun.body, "modelAccess", "baseUrl"), `${gatewayBaseUrl}/api/v1/providers/${anthropic.id}`)
  assert.equal(memberKey, field(ok(await den.as(member, a.orgId)("GET", `/v1/inference-providers/${anthropic.id}/connect`)).body, "inferenceProvider", "apiKey"))
  assert.equal(field(safe(await run(member, luna), 403).body, "reason"), "gateway_member_access_missing")
  assert.equal(field(safe(await run(a.owner, otherLuna), 403).body, "reason"), "gateway_model_unavailable")
  assert.equal(field(safe(await run(a.owner, "gateway/legacy"), 403).body, "reason"), "gateway_model_unavailable")
  const otherRun = ok(await run(b.owner))
  const otherKey = text(field(otherRun.body, "modelAccess", "apiKey"), "other org gateway key")
  assert.notEqual(otherKey, ownerKey)
  assert.notEqual(otherKey, memberKey)

  safe(await owner("PUT", settingsPath, { model: claude }))
  assert.equal(field(safe(await session(member)).body, "model"), claude)
  assert.equal(field(safe(await otherOwner("GET", settingsPath)).body, "model"), null, "saved default is org-wide but tenant-isolated")
  const probe = safe(await owner("POST", `${settingsPath}/test-default-model`, {}))
  assert.equal(field(probe.body, "status"), "answered")
  assert.equal(field(probe.body, "requestedModel"), claude)
  assert.deepEqual(probes[0], { model: claude, modelAccess: { apiKey: ownerKey, baseUrl: `${gatewayBaseUrl}/api/v1/providers/${anthropic.id}`, protocol: "anthropic" } })
  safe(await owner("PUT", settingsPath, { model: luna }))
  assert.equal(field(safe(await owner("POST", `${settingsPath}/test-default-model`, {})).body, "status"), "answered")
  assert.deepEqual(probes[1], { model: luna, modelAccess: { apiKey: ownerKey, baseUrl: `${gatewayBaseUrl}/api/v1/providers/${openai.id}`, protocol: "openai-responses" } })

  // A durable interrupted Gateway turn rehydrates its original member's access,
  // never the deployment credential.
  const turn = { sessionId: "hs_gateway_resume_fixture", messageId: "msg-gateway-resume" }
  const durable = ok(await den.request(text(tokens.get(member.userId), "member MCP token"), "POST", "/v1/workbot/run-token", { body: { ...turn, model: claude } }))
  const grant = text(field(durable.body, "resumeGrant"), "durable resume grant")
  const exchangeBody = { ...turn, grant, model: claude, modelAccessRequired: true }
  const exchange = () => den.request(null, "POST", "/v1/headless/resume-token", {
    headers: { authorization: "Bearer fixture-private-runner-callback-token-123456789" }, body: exchangeBody,
  })
  safe(await den.request(null, "POST", "/v1/headless/resume-token", { body: exchangeBody }), 401)
  const resumed = ok(await exchange())
  assert.deepEqual(field(resumed.body, "modelAccess"), field(memberRun.body, "modelAccess"), "an interrupted Gateway turn keeps member-scoped access")
  const callerResume = () => den.request(text(tokens.get(member.userId), "member MCP token"), "POST", "/v1/workbot/run-token", { body: { ...turn, model: claude, modelAccessRequired: true } })
  assert.deepEqual(field(ok(await callerResume()).body, "modelAccess"), field(memberRun.body, "modelAccess"), "caller-driven recovery keeps the scoped credential domain")
  safe(await owner("DELETE", `/v1/inference-providers/${anthropic.id}/access-grants/${anthropic.grantIds[1]}`), 204)
  const refusedResume = safe(await exchange(), 403)
  assert.equal(field(refusedResume.body, "error"), "model_unavailable")
  assert.equal(field(refusedResume.body, "token"), undefined)
  assert.equal(field(refusedResume.body, "modelAccess"), undefined)
  const refusedCallerResume = safe(await callerResume(), 403)
  assert.equal(field(refusedCallerResume.body, "modelAccess"), undefined)
  assert.equal(field(refusedCallerResume.body, "token"), undefined)

  // Readiness is live, not a cached owner snapshot: disabling a credential set
  // removes aliases even though grants and the selected default remain saved.
  safe(await owner("PATCH", `/v1/inference-providers/${openai.id}/credential-sets/${openai.setId}`, { status: "disabled" }))
  const unavailable = safe(await owner("GET", settingsPath))
  assert.equal(field(unavailable.body, "model"), luna)
  assert.equal(field(unavailable.body, "modelAvailable"), false)
  assert.equal(field(unavailable.body, "defaultReadiness"), "unavailable")
  safe(await run(a.owner), 403)
  safe(await run(a.owner, luna), 403)
  assert.deepEqual(modelIds(safe(await den.as(member, a.orgId)("GET", settingsPath))), [])
  safe(await run(member, claude), 403)
  assert.equal(runnerCatalogRequests, runnerReads, "Workbot settings never consult the runner's global catalog")
  assert.equal(field(safe(await owner("GET", settingsPath)).body, "model"), luna, "an unavailable default keeps its exact saved alias")
  safe(await run(a.owner), 403)
  for (const response of safeResponses) {
    for (const secret of [...upstreamSecrets, runnerToken, ownerKey, memberKey, otherKey]) assert.equal(response.text.includes(secret), false, "safe public responses must not expose inference credentials")
    assert.equal(response.text.includes('"modelAccess"'), false)
  }
  for (const response of [ownerRun, memberRun, otherRun]) for (const secret of upstreamSecrets) assert.equal(response.text.includes(secret), false, "run-token returns a member gateway bearer, never an upstream key")
})
