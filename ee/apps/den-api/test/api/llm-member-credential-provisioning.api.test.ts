/**
 * A provisioning script pushes each member's gateway key with an organization
 * API key (the "per-person key" setup for LiteLLM, TrueFoundry and other
 * OpenAI-compatible gateways). The member then resolves their own key and the
 * gateway accepts it. Every other way of sending a provider key with an API key
 * stays refused, the key is never read back, and the write is audited against
 * the API key.
 *
 * By default the gateway is a local OpenAI-compatible fake. Set
 * DEN_API_TEST_GATEWAY_URL and DEN_API_TEST_GATEWAY_KEY (for example a real
 * TrueFoundry gateway and a personal access token) to run the same proof
 * against a live gateway.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, list, startFakeHttpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })

const liveUrl = process.env.DEN_API_TEST_GATEWAY_URL?.trim().replace(/\/+$/, "")
const liveKey = process.env.DEN_API_TEST_GATEWAY_KEY?.trim()
const live = Boolean(liveUrl && liveKey)

/** The key the script minted upstream for the teammate. */
const MEMBER_KEY = live ? String(liveKey) : `tfy-member-${randomBytes(16).toString("hex")}`
const PROOF = `gateway-proof-${randomBytes(6).toString("hex")}`

const fake = live ? null : await startFakeHttpServer((request, _body, response) => {
  response.setHeader("content-type", "application/json")
  if (request.headers.authorization !== `Bearer ${MEMBER_KEY}`) {
    response.statusCode = 401
    response.end(JSON.stringify({ error: "unauthorized" }))
    return
  }
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.end(JSON.stringify({ object: "list", data: [{ id: "openai/gpt-5.5", object: "model" }] }))
    return
  }
  response.end(JSON.stringify({ id: "chatcmpl-proof", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: PROOF }, finish_reason: "stop" }] }))
})
const gatewayUrl = live ? String(liveUrl) : String(fake?.url)

after(async () => {
  await fake?.close()
  await den.close()
})

let orgId = ""
let owner: Member
let teammate: Member
let providerId = ""
let modelId = "openai/gpt-5.5"
let scriptKey = ""
let scriptKeyId = ""

/** The script's request: authenticated only by the organization API key. */
function script(method: "GET" | "POST" | "PUT" | "PATCH", pathname: string, body?: unknown) {
  return den.request(null, method, pathname, { orgId, headers: { "x-api-key": scriptKey }, body })
}

before(async () => {
  const created = await den.createOrg(await den.signUp("Gateway Owner"), "Gateway provisioning org")
  orgId = created.orgId
  owner = created.owner
  teammate = await den.newMember(owner, orgId, "Gateway Teammate")

  if (live) {
    // Use whatever model the live gateway actually serves to this key.
    const models = await fetch(`${gatewayUrl}/models`, { headers: { authorization: `Bearer ${MEMBER_KEY}` } })
    assert.equal(models.status, 200, `live gateway /models returned ${models.status}`)
    const first = list(field(await models.json(), "data"))[0]
    modelId = text(first?.id, "live gateway model id")
  }

  const provider = await den.as(owner, orgId)("POST", "/v1/llm-providers", {
    name: "Team gateway",
    source: "custom",
    customConfig: {
      id: "team-gateway",
      name: "Team gateway",
      npm: "@ai-sdk/openai-compatible",
      env: ["TEAM_GATEWAY_API_KEY"],
      api: gatewayUrl,
      models: [{ id: modelId, name: modelId }],
    },
    credentialMode: "per_member",
    allMembers: true,
    memberIds: [],
    teamIds: [],
  })
  assert.equal(provider.status, 201, summary(provider))
  providerId = text(field(provider.body, "llmProvider", "id"), "provider id")

  const minted = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Gateway key provisioner" })
  assert.equal(minted.status, 201, summary(minted))
  scriptKey = text(field(minted.body, "key"), "api key value")
  scriptKeyId = text(field(minted.body, "apiKey", "id"), "api key id")
})

test("a provisioning script pushes a member's gateway key with an API key, and that member's calls carry it", async () => {
  const listed = await script("GET", `/v1/llm-providers/${providerId}/member-credentials`)
  assert.equal(listed.status, 200, summary(listed))
  const binding = list(field(listed.body, "memberCredentials")).find((entry) => entry.orgMembershipId === teammate.memberId)
  assert.equal(field(binding, "state"), "missing", listed.text.slice(0, 400))

  const pushed = await script("PUT", `/v1/llm-providers/${providerId}/member-credentials/${teammate.memberId}`, {
    apiKey: MEMBER_KEY,
    externalPrincipalId: "teammate@gateway",
    externalCredentialId: "pat-teammate",
  })
  assert.equal(pushed.status, 200, summary(pushed))
  assert.equal(field(pushed.body, "state"), "active")
  assert.equal(pushed.text.includes(MEMBER_KEY), false, "the write echoed the key")

  const relisted = await script("GET", `/v1/llm-providers/${providerId}/member-credentials`)
  assert.equal(relisted.text.includes(MEMBER_KEY), false, "the list returned the key")

  // The teammate resolves their own key; the owner, who has none, does not get it.
  const mine = await den.as(teammate, orgId)("GET", `/v1/llm-providers/${providerId}/connect`)
  assert.equal(mine.status, 200, summary(mine))
  assert.equal(field(mine.body, "llmProvider", "memberCredential", "state"), "active")
  const resolved = text(field(mine.body, "llmProvider", "apiKey"), "teammate's resolved key")
  const ownerView = await den.as(owner, orgId)("GET", `/v1/llm-providers/${providerId}/connect`)
  assert.equal(ownerView.status, 200, summary(ownerView))
  assert.equal(field(ownerView.body, "llmProvider", "memberCredential", "state"), "missing")
  assert.equal(ownerView.text.includes(MEMBER_KEY), false, "a teammate's key reached the owner")

  // The gateway accepts the key the teammate resolved.
  const completion = await fetch(`${gatewayUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${resolved}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ready" }] }),
  })
  const completionBody: unknown = await completion.json()
  assert.equal(completion.status, 200, JSON.stringify(completionBody).slice(0, 300))
  const content = text(field(list(field(completionBody, "choices"))[0], "message", "content"), "completion content")
  if (!live) assert.equal(content, PROOF)
})

test("an API key still cannot send a provider key anywhere else", async () => {
  const attempts = [
    script("POST", "/v1/llm-providers", { name: "Smuggled", source: "custom", customConfig: { id: "smuggled", name: "Smuggled", npm: "@ai-sdk/openai-compatible", env: ["SMUGGLED_API_KEY"], api: gatewayUrl, models: [{ id: modelId, name: modelId }] }, apiKey: MEMBER_KEY, allMembers: true, memberIds: [], teamIds: [] }),
    script("PATCH", `/v1/llm-providers/${providerId}`, { apiKey: MEMBER_KEY }),
    script("PUT", `/v1/llm-providers/${providerId}/my-credential`, { apiKey: MEMBER_KEY }),
    script("POST", "/v1/llm-providers/test-connection", { source: "custom", customConfig: { id: "probe", name: "Probe", npm: "@ai-sdk/openai-compatible", env: ["PROBE_API_KEY"], api: gatewayUrl, models: [{ id: modelId, name: modelId }] }, apiKey: MEMBER_KEY }),
  ]
  for (const attempt of await Promise.all(attempts)) {
    assert.equal(attempt.status, 400, summary(attempt))
    assert.equal(field(attempt.body, "error"), "secure_entry_required")
    assert.equal(attempt.text.includes(MEMBER_KEY), false)
  }
})

test("the push is audited against the API key and the key's value is never stored in the audit log", async () => {
  const deadline = Date.now() + 15_000
  let operation: Record<string, unknown> | undefined
  for (;;) {
    const listed = await den.as(owner, orgId)("GET", `/v1/audit/operations?limit=50&action=${encodeURIComponent("llm_provider.member_credential.set.succeeded")}`)
    assert.equal(listed.status, 200, summary(listed))
    operation = list(field(listed.body, "operations")).find((entry) => field(entry, "initiatingActor", "credentialId") === scriptKeyId)
    if (operation || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(operation, "no audited member-credential write by the API key")
  assert.equal((await den.auditStorageText()).includes(MEMBER_KEY), false, "the member key reached audit storage")
})
