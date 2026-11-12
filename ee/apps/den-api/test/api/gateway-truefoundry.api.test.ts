/**
 * AI Gateway TrueFoundry providers: one admin key, a personal access token for
 * each person. Den talks to a fake TrueFoundry tenant (an operator-approved
 * local origin) that follows the rules of the real one: only an admin key may
 * add users and create tokens for them, a token is owned by its user and can
 * only be listed and deleted by itself, each user may hold three tokens, and
 * each token reaches the models its user has access to.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, list, summary, text } from "./harness.js"

const ADMIN = "tfy_va_openwork-admin_fixture0001"
const MEMBER_VA = "tfy_va_member-only_fixture0002"
const MODELS = ["anthropic/claude-fixture", "openai/gpt-fixture"]

type TfUser = { id: string; email: string; active: boolean }
type TfToken = { id: string; name: string; email: string; value: string }
const users = new Map<string, TfUser>()
const tokens = new Map<string, TfToken>()
/** email -> models that person's tokens reach. New users reach none. */
const access = new Map<string, string[]>()
const registered: string[] = []

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

const tenant = await startTenant()
async function startTenant() {
  const { startFakeHttpServer } = await import("./harness.js")
  return startFakeHttpServer((request, body, response) => {
    const url = new URL(request.url ?? "/", "http://tenant")
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? ""
    const token = [...tokens.values()].find((entry) => entry.value === bearer) ?? null
    const admin = bearer === ADMIN
    if (!admin && !token && bearer !== MEMBER_VA) return json(response, 401, { statusCode: 401, message: "Invalid or expired token" })
    const input: Record<string, unknown> = body ? JSON.parse(body) : {}
    const route = `${request.method} ${url.pathname}`
    if (route === "GET /api/llm/models") {
      const models = admin ? MODELS : token ? access.get(token.email) ?? [] : []
      return json(response, 200, { object: "list", data: [...models.map((id) => ({ id, object: "model", model_types: ["chat"] })), { id: "openai/embed-fixture", model_types: ["embedding"] }] })
    }
    if (route === "POST /api/svc/v1/users/register") {
      if (!admin) return json(response, 403, { statusCode: 403, message: "Forbidden" })
      const email = String(input.email).toLowerCase()
      if (input.dryRun) return json(response, 201, {})
      if (!users.has(email)) { users.set(email, { id: `u_${randomBytes(4).toString("hex")}`, email, active: true }); registered.push(email) }
      return json(response, 201, {})
    }
    if (route === "GET /api/svc/v1/users") {
      if (!admin) return json(response, 403, { statusCode: 403, message: "Forbidden" })
      const query = (url.searchParams.get("query") ?? "").toLowerCase()
      return json(response, 200, { data: [...users.values()].filter((user) => user.email.includes(query)), pagination: { total: users.size } })
    }
    if (route === "POST /api/svc/v1/personal-access-tokens/for-user") {
      if (token) return json(response, 400, { statusCode: 400, message: "Cannot create a personal access token for another user with a personal access token" })
      if (!admin) return json(response, 403, { statusCode: 403, message: "Forbidden" })
      const email = String(input.userEmail).toLowerCase()
      if (!users.has(email)) return json(response, 404, { statusCode: 404, message: `User with email ${email} not found` })
      if ([...tokens.values()].filter((entry) => entry.email === email).length >= 3) return json(response, 400, { statusCode: 400, message: "Maximum number of Personal Access Tokens reached: 3" })
      const created = { id: `pat_${randomBytes(4).toString("hex")}`, name: String(input.name), email, value: `tfy_pat_${String(input.name)}_${randomBytes(8).toString("hex")}` }
      tokens.set(created.id, created)
      return json(response, 200, { token: created.value })
    }
    if (route === "GET /api/svc/v1/personal-access-tokens") {
      const own = token ? [...tokens.values()].filter((entry) => entry.email === token.email && entry.name.includes(url.searchParams.get("nameSearchQuery") ?? "")) : []
      return json(response, 200, { data: own.map((entry) => ({ id: entry.id, type: "pat", manifest: { name: entry.name, type: "pat", user_fqn: entry.email } })), pagination: { total: own.length } })
    }
    const deleting = /^DELETE \/api\/svc\/v1\/personal-access-tokens\/(.+)$/.exec(route)
    if (deleting) {
      const target = tokens.get(deleting[1])
      // Like TrueFoundry: an admin can't delete another user's token; the token can delete itself.
      if (!target || !token || target.email !== token.email) return json(response, 404, { statusCode: 404, message: `Personal Access Token with id ${deleting[1]} was not found` })
      tokens.delete(target.id)
      return json(response, 200, {})
    }
    return json(response, 404, { statusCode: 404, message: "not found" })
  })
}
// The fake tenant is a local address: only an operator-approved origin may be reached.
process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = tenant.url

const den = await bootDen({ env: gatewayFixtureEnv })
// The public model catalog Den matches TrueFoundry models against: only OpenAI's model is in it.
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
      "gpt-fixture": { id: "gpt-fixture", name: "GPT Fixture", reasoning: true, tool_call: true, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 400000, output: 128000 }, cost: { input: 1, output: 8 } },
    } },
  })
}
after(async () => { globalThis.fetch = realFetch; await den.close(); await tenant.close() })

const org = await den.createOrg(await den.signUp("TrueFoundry Owner"), "Acme TrueFoundry")
const alice = await den.newMember(org.owner, org.orgId, "TrueFoundry Alice")
const bob = await den.newMember(org.owner, org.orgId, "TrueFoundry Bob")
const owner = den.as(org.owner, org.orgId)
const asAlice = den.as(alice, org.orgId)
const asBob = den.as(bob, org.orgId)
users.set(alice.email.toLowerCase(), { id: "u_alice", email: alice.email.toLowerCase(), active: true })
access.set(alice.email.toLowerCase(), ["openai/gpt-fixture"])

const tokensOf = (email: string) => [...tokens.values()].filter((entry) => entry.email === email.toLowerCase())
let providerId = ""

async function usableModels(as: typeof asAlice) {
  const listed = await as("GET", "/v1/inference-providers")
  assert.equal(listed.status, 200, summary(listed))
  const provider = list(field(listed.body, "inferenceProviders")).find((entry) => entry.id === providerId)
  return provider ? list(field(provider, "models")).map((model) => String(model.upstreamModelId)).sort() : null
}

async function details() {
  const response = await owner("GET", `/v1/inference-providers/${providerId}`)
  assert.equal(response.status, 200, summary(response))
  return field(response.body, "inferenceProvider")
}

test("TrueFoundry setup is behind the truefoundryGateway feature and refuses personal tokens", { timeout: 60_000 }, async () => {
  const body = { controlPlaneUrl: tenant.url, apiKey: ADMIN, allMembers: true }
  const off = await owner("POST", "/v1/inference-providers/truefoundry", body)
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")
  assert.equal((await den.setFeature(org.orgId, "truefoundryGateway", true)).status, 200)

  const personal = await owner("POST", "/v1/inference-providers/truefoundry", { ...body, apiKey: "tfy_pat_someone_123" })
  assert.equal(personal.status, 400, summary(personal))
  assert.equal(field(personal.body, "error"), "truefoundry_personal_token")
  const notAdmin = await owner("POST", "/v1/inference-providers/truefoundry", { ...body, apiKey: MEMBER_VA })
  assert.equal(notAdmin.status, 409, summary(notAdmin))
  assert.equal(field(notAdmin.body, "error"), "truefoundry_not_admin")
  assert.equal(tokens.size, 0)
})

test("one admin key creates a token for each person found in TrueFoundry", { timeout: 60_000 }, async () => {
  const created = await owner("POST", "/v1/inference-providers/truefoundry", { controlPlaneUrl: `${tenant.url}/llm-gateway/playground`, apiKey: ADMIN, allMembers: true })
  assert.equal(created.status, 201, summary(created))
  assert.ok(!created.text.includes(ADMIN), "the admin key never comes back")
  providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  assert.equal(field(created.body, "inferenceProvider", "providerId"), "truefoundry")
  assert.equal(field(created.body, "inferenceProvider", "settings", "upstreamBaseUrl"), `${tenant.url}/api/llm`)
  assert.deepEqual(field(created.body, "sync"), { modelCount: 2, people: 1, tokensCreated: 1, usersCreated: 0, notInTrueFoundry: 2, noModels: 0, tokenLimit: 0, errors: 0, removed: 0 })

  // Alice has a token owned by her TrueFoundry user, reaching only what TrueFoundry gives her.
  assert.equal(tokensOf(alice.email).length, 1)
  assert.match(tokensOf(alice.email)[0].name, /^openwork-[0-9a-f]{12}$/)
  assert.deepEqual(await usableModels(asAlice), ["openai/gpt-fixture"])
  // TrueFoundry lists ids only; the name, capabilities and limits come from the matching catalog model, never its price.
  const listed = list(field((await asAlice("GET", "/v1/inference-providers")).body, "inferenceProviders")).find((entry) => entry.id === providerId)
  const model = list(field(listed, "models"))[0]
  assert.equal(model?.name, "GPT Fixture")
  assert.deepEqual(field(model, "config", "limit"), { context: 400000, output: 128000 })
  assert.equal(field(model, "config", "reasoning"), true)
  assert.equal(field(model, "config", "cost"), undefined)
  const aliceList = await asAlice("GET", "/v1/inference-providers")
  assert.ok(!aliceList.text.includes(tokensOf(alice.email)[0].value), "the token is never shown, not even to its owner")

  // Bob and the owner are not TrueFoundry users, and missing users are not created by default.
  const status = field(await details(), "truefoundry")
  assert.equal(field(status, "createMissingUsers"), false)
  assert.equal(field(status, "hasAdminKey"), true)
  assert.equal(field(status, "activeMemberCount"), 1)
  assert.deepEqual(list(field(status, "attention")).map((entry) => [entry.email, entry.reason]).sort(), [[bob.email, "not_in_truefoundry"], [org.owner.email, "not_in_truefoundry"]].sort())
  assert.equal(registered.length, 0)
  assert.deepEqual((await usableModels(asBob)) ?? [], [])
})

test("syncing reuses each working token instead of creating more", { timeout: 60_000 }, async () => {
  const before = tokensOf(alice.email).map((entry) => entry.id)
  const synced = await owner("POST", `/v1/inference-providers/${providerId}/truefoundry/sync`)
  assert.equal(synced.status, 200, summary(synced))
  assert.equal(field(synced.body, "sync", "tokensCreated"), 0)
  assert.deepEqual(tokensOf(alice.email).map((entry) => entry.id), before)

  // TrueFoundry gives Alice another model: the next sync moves her to the matching group.
  access.set(alice.email.toLowerCase(), [...MODELS])
  await owner("POST", `/v1/inference-providers/${providerId}/truefoundry/sync`)
  assert.deepEqual(await usableModels(asAlice), [...MODELS].sort())
})

test("Create missing users in TrueFoundry adds people, who get models once TrueFoundry gives them access", { timeout: 60_000 }, async () => {
  const updated = await owner("PATCH", `/v1/inference-providers/${providerId}/truefoundry`, { createMissingUsers: true })
  assert.equal(updated.status, 200, summary(updated))
  assert.deepEqual(registered.sort(), [bob.email.toLowerCase(), org.owner.email.toLowerCase()].sort())
  assert.equal(field(updated.body, "sync", "usersCreated"), 2)
  assert.equal(field(updated.body, "sync", "noModels"), 2)
  assert.equal(tokensOf(bob.email).length, 1, "the token is kept while TrueFoundry gives no models")
  assert.deepEqual((await usableModels(asBob)) ?? [], [])
  const status = field(await details(), "truefoundry")
  assert.equal(field(status, "createdUserCount"), 2)
  assert.equal(list(field(status, "attention")).find((entry) => entry.email === bob.email)?.reason, "no_models")

  access.set(bob.email.toLowerCase(), ["anthropic/claude-fixture"])
  const synced = await owner("POST", `/v1/inference-providers/${providerId}/truefoundry/sync`)
  assert.equal(field(synced.body, "sync", "tokensCreated"), 0, "the same token now reaches a model")
  assert.deepEqual(await usableModels(asBob), ["anthropic/claude-fixture"])
})

test("members can't disconnect or replace OpenWork-managed TrueFoundry keys", { timeout: 60_000 }, async () => {
  const disconnect = await asAlice("DELETE", `/v1/inference-providers/${providerId}/oauth`)
  assert.equal(disconnect.status, 409, summary(disconnect))
  assert.equal(field(disconnect.body, "error"), "truefoundry_keys_managed")
  const set = list(field(await details(), "credentialSets"))[0]
  const edit = await owner("PATCH", `/v1/inference-providers/${providerId}/credential-sets/${String(set.id)}`, { name: "Renamed" })
  assert.equal(edit.status, 400, summary(edit))
  assert.equal(field(edit.body, "error"), "truefoundry_managed")
})

test("people who lose access have their tokens deleted in TrueFoundry; removing the provider deletes the rest", { timeout: 60_000 }, async () => {
  const provider = await details()
  const everyone = list(field(provider, "accessGrants")).find((grant) => field(grant, "audience", "type") === "organization")
  assert.ok(everyone, "the organization grant exists")
  const grant = await owner("PATCH", `/v1/inference-providers/${providerId}/access-grants/${String(everyone.id)}`, { audience: { type: "member", memberId: alice.memberId } })
  assert.equal(grant.status, 200, summary(grant))
  // Bob stops being served at once, before TrueFoundry hears about it.
  assert.equal(await usableModels(asBob), null)
  assert.equal(tokensOf(bob.email).length, 1)

  const synced = await owner("POST", `/v1/inference-providers/${providerId}/truefoundry/sync`)
  assert.equal(field(synced.body, "sync", "removed"), 2)
  assert.equal(tokensOf(bob.email).length, 0, "Bob's token deleted itself in TrueFoundry")
  assert.equal(tokensOf(org.owner.email).length, 0)
  assert.equal(users.has(bob.email.toLowerCase()), true, "TrueFoundry users OpenWork added are never removed")
  assert.deepEqual(await usableModels(asAlice), [...MODELS].sort())

  const removed = await owner("DELETE", `/v1/inference-providers/${providerId}`)
  assert.equal(removed.status, 204, summary(removed))
  assert.equal(tokens.size, 0, "every token OpenWork created is deleted")
})
