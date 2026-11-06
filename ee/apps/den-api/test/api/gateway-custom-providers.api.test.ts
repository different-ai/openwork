/**
 * AI Gateway custom OpenAI-compatible providers (feature gatewayCustomProviders): an admin fetches the
 * provider's models, tests one through AI Gateway, adds the provider and edits it. Den talks to a fake
 * OpenAI-compatible upstream (an operator-approved local origin) and a fake AI Gateway; the public model
 * catalog it reads is synthetic. The API key never comes back in a response.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, list, startFakeHttpServer, summary, text } from "./harness.js"

const KEY = "sk-custom-upstream-fixture-key-0001"
const NEW_KEY = "sk-custom-upstream-fixture-key-0002"

let upstreamMode: "detailed" | "basic" | "broken" = "detailed"
const upstreamAuth: string[] = []
const upstream = await startFakeHttpServer((request, _body, response) => {
  upstreamAuth.push(request.headers.authorization ?? "")
  response.setHeader("content-type", "application/json")
  if (request.url !== "/v1/models") { response.statusCode = 404; return void response.end("{}") }
  if (upstreamMode === "broken") return void response.end("<html>not json</html>")
  if (upstreamMode === "basic") return void response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "acme" }, { id: "house-model", object: "model", owned_by: "acme" }] }))
  response.end(JSON.stringify({ data: [
    { id: "openai/gpt-4o", name: "GPT-4o via Acme", context_length: 100000, pricing: { prompt: "0.0000025", completion: "0.00001" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ["tools", "temperature"] },
    { id: "acme/house-model", name: "Acme House", context_length: 32000, supported_parameters: ["temperature"] },
  ] }))
})
const gatewayTests: unknown[] = []
const gateway = await startFakeHttpServer((request, body, response) => {
  response.setHeader("content-type", "application/json")
  if (request.url !== "/api/v1/provider-tests") { response.statusCode = 404; return void response.end("{}") }
  const parsed: unknown = JSON.parse(body)
  gatewayTests.push(parsed)
  const secret = typeof parsed === "object" && parsed !== null && "credential" in parsed && typeof parsed.credential === "object" && parsed.credential !== null && "secret" in parsed.credential ? parsed.credential.secret : null
  response.end(JSON.stringify(secret === KEY || secret === NEW_KEY
    ? { ok: true, model: "openai/gpt-4o", status: 200, code: null, message: null }
    : { ok: false, model: "openai/gpt-4o", status: 401, code: "provider_authentication_failed", message: "The provider rejected this key." }))
})
// The fake upstream is a local address: only an operator-approved origin may be reached.
process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = upstream.url

const den = await bootDen({ env: { ...gatewayFixtureEnv, GATEWAY_PROXY_BASE_URL: gateway.url, GATEWAY_PUBLIC_BASE_URL: gateway.url } })
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    openrouter: { id: "openrouter", name: "OpenRouter", npm: "@openrouter/ai-sdk-provider", env: ["OPENROUTER_API_KEY"], api: "https://openrouter.ai/api/v1", models: {
      "openai/gpt-4o": { id: "openai/gpt-4o", name: "GPT-4o", attachment: true, reasoning: false, tool_call: true, structured_output: true, temperature: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 128000, output: 16384 }, cost: { input: 2.5, output: 10, cache_read: 1.25 } },
    } },
    openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {} },
  })
}
after(async () => { globalThis.fetch = realFetch; await den.close(); await upstream.close(); await gateway.close() })

const baseUrl = `${upstream.url}/v1`
const org = await den.createOrg(await den.signUp("Acme Custom Owner"), "Acme custom providers")
const teammate = await den.newMember(org.owner, org.orgId, "Acme Custom Teammate")
const owner = den.as(org.owner, org.orgId)
const enabled = await den.setFeature(org.orgId, "gatewayCustomProviders", true)
assert.equal(enabled.status, 200, summary(enabled))

const houseModel = { id: "acme/house-model", name: "Acme House", attachment: false, reasoning: false, tool_call: false, structured_output: false, temperature: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 32000, output: 8192 } }

test("with the feature off every custom route answers 404 feature_disabled", { timeout: 60_000 }, async () => {
  const other = await den.createOrg(await den.signUp("Other Custom Owner"), "Other custom org")
  const call = den.as(other.owner, other.orgId)
  for (const [method, path, body] of [
    ["POST", "/v1/inference-providers/custom/discover-models", { baseUrl, apiKey: KEY }],
    ["POST", "/v1/inference-providers/custom/test-connection", { baseUrl, apiKey: KEY, model: houseModel }],
    ["POST", "/v1/inference-providers/custom", { name: "Nope", baseUrl, apiKey: KEY, models: [houseModel] }],
  ] as const) {
    const response = await call(method, path, body)
    assert.equal(response.status, 404, `${path}: ${summary(response)}`)
    assert.equal(field(response.body, "error"), "feature_disabled")
  }
})

test("discovery reads detailed, basic and broken /models answers", { timeout: 60_000 }, async () => {
  upstreamMode = "detailed"
  const detailed = await owner("POST", "/v1/inference-providers/custom/discover-models", { baseUrl: `${baseUrl}/chat/completions`, apiKey: KEY })
  assert.equal(detailed.status, 200, summary(detailed))
  assert.equal(field(detailed.body, "status"), "detailed")
  assert.equal(field(detailed.body, "baseUrl"), baseUrl, "a trailing /chat/completions is removed")
  const models = list(field(detailed.body, "models"))
  assert.deepEqual(models.map((model) => model.id), ["openai/gpt-4o", "acme/house-model"])
  assert.deepEqual(field(models[0], "match"), { providerId: "openrouter", modelId: "openai/gpt-4o", by: "id" })
  assert.deepEqual(field(models[0], "model", "limit"), { context: 100000, output: 4096 }, "/models limits override the match")
  assert.deepEqual(field(models[0], "model", "cost"), { input: 2.5, output: 10, cache_read: 1.25 })
  assert.equal(field(models[1], "match"), null)
  assert.equal(field(models[1], "model", "name"), "Acme House")
  assert.equal(upstreamAuth.at(-1), `Bearer ${KEY}`)

  upstreamMode = "basic"
  const basic = await owner("POST", "/v1/inference-providers/custom/discover-models", { baseUrl, apiKey: KEY })
  assert.equal(field(basic.body, "status"), "basic", summary(basic))
  const basicModels = list(field(basic.body, "models"))
  assert.deepEqual(basicModels.map((model) => [model.id, field(model, "match", "by") ?? null]), [["gpt-4o", "suffix"], ["house-model", null]])
  assert.equal(field(basicModels[1], "model"), null, "nothing is known about an unmatched id")

  upstreamMode = "broken"
  const broken = await owner("POST", "/v1/inference-providers/custom/discover-models", { baseUrl, apiKey: KEY })
  assert.equal(broken.status, 200, summary(broken))
  assert.deepEqual([field(broken.body, "status"), field(broken.body, "reason"), field(broken.body, "upstreamStatus")], ["unavailable", "The provider's model list is not JSON.", 200])
  upstreamMode = "detailed"
  for (const response of [detailed, basic, broken]) assert.ok(!response.text.includes(KEY))
})

test("private addresses are refused before anything is sent", { timeout: 60_000 }, async () => {
  const sentBefore = upstreamAuth.length
  for (const address of ["https://127.0.0.1:9/v1", "https://10.0.0.5/v1", "http://api.example.com/v1", "https://localhost/v1"]) {
    const response = await owner("POST", "/v1/inference-providers/custom/discover-models", { baseUrl: address, apiKey: KEY })
    assert.equal(response.status, 400, `${address}: ${summary(response)}`)
    assert.equal(field(response.body, "error"), "invalid_base_url")
  }
  const created = await owner("POST", "/v1/inference-providers/custom", { name: "Private", baseUrl: "https://192.168.1.10/v1", apiKey: KEY, models: [houseModel] })
  assert.equal(created.status, 400, summary(created))
  assert.equal(upstreamAuth.length, sentBefore)
})

test("the test goes through AI Gateway with the custom provider payload and says which step failed", { timeout: 60_000 }, async () => {
  const passed = await owner("POST", "/v1/inference-providers/custom/test-connection", { baseUrl, apiKey: KEY, model: houseModel })
  assert.equal(passed.status, 200, summary(passed))
  assert.deepEqual(passed.body, { ok: true, model: "openai/gpt-4o", status: 200, code: null, message: null, step: null })
  assert.deepEqual(gatewayTests.at(-1), { providerId: "openwork-custom", model: "acme/house-model", settings: { upstreamBaseUrl: baseUrl }, credential: { kind: "api_key", secret: KEY }, customModel: houseModel })

  const failed = await owner("POST", "/v1/inference-providers/custom/test-connection", { baseUrl, apiKey: "sk-wrong-key", model: houseModel })
  assert.equal(failed.status, 200, summary(failed))
  assert.equal(field(failed.body, "ok"), false)
  assert.equal(field(failed.body, "step"), "connection")

  const generic = await owner("POST", "/v1/inference-providers/test-connection", { providerId: "openwork-custom", model: "acme/house-model", credential: { kind: "api_key", secret: KEY } })
  assert.equal(generic.status, 400, summary(generic))
  assert.equal(field(generic.body, "error"), "custom_setup_required")
  const genericCreate = await owner("POST", "/v1/inference-providers", { name: "Generic", providerId: "openwork-custom" })
  assert.equal(field(genericCreate.body, "error"), "custom_setup_required", summary(genericCreate))
})

test("an admin adds a custom provider, members get its models, and the key never comes back", { timeout: 90_000 }, async () => {
  const gpt = { id: "openai/gpt-4o", name: "GPT-4o via Acme", attachment: true, reasoning: false, tool_call: true, structured_output: true, temperature: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 100000, output: 4096 }, cost: { input: 2.5, output: 10 } }
  const created = await owner("POST", "/v1/inference-providers/custom", { name: "Acme AI", baseUrl: `${baseUrl}/`, apiKey: KEY, models: [gpt, houseModel], discoveryStatus: "detailed", listedModelIds: ["openai/gpt-4o"], allMembers: true })
  assert.equal(created.status, 201, summary(created))
  assert.ok(!created.text.includes(KEY))
  const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  assert.equal(field(created.body, "inferenceProvider", "providerId"), "openwork-custom")
  assert.equal(field(created.body, "inferenceProvider", "custom", "baseUrl"), baseUrl)
  assert.equal(field(created.body, "inferenceProvider", "custom", "hasKey"), true)
  assert.equal(field(created.body, "inferenceProvider", "custom", "discovery", "status"), "detailed")
  assert.deepEqual(field(created.body, "inferenceProvider", "custom", "discovery", "listedModelIds"), ["openai/gpt-4o"], "only listed ids are remembered; the hand-added model is not")
  assert.deepEqual(list(field(created.body, "inferenceProvider", "custom", "models")).map((model) => model.id), ["openai/gpt-4o", "acme/house-model"])
  assert.equal(field(created.body, "inferenceProvider", "settings", "custom"), undefined, "stored settings stay internal")

  // A member's desktop gets the provider like any Gateway provider.
  const usable = await den.as(teammate, org.orgId)("GET", "/v1/inference-providers?scope=usable")
  assert.equal(usable.status, 200, summary(usable))
  const provider = list(field(usable.body, "inferenceProviders")).find((entry) => entry.id === providerId)
  assert.ok(provider, "the member sees the provider")
  assert.equal(field(provider, "credentialStatus"), "ready")
  assert.equal(field(provider, "providerConfig", "npm"), "@ai-sdk/openai-compatible")
  const memberModels = list(field(provider, "models"))
  assert.deepEqual(memberModels.map((model) => model.upstreamModelId).sort(), ["acme/house-model", "openai/gpt-4o"])
  const gptConfig = memberModels.find((model) => model.upstreamModelId === "openai/gpt-4o")?.config
  assert.deepEqual(field(gptConfig, "limit"), { context: 100000, output: 4096 })
  assert.deepEqual(field(gptConfig, "cost"), { input: 2.5, output: 10 })
  const connect = await den.as(teammate, org.orgId)("GET", `/v1/inference-providers/${providerId}/connect`)
  assert.equal(connect.status, 200, summary(connect))
  const envNames = Object.keys(field(connect.body, "inferenceProvider", "apiKeys") as Record<string, string>)
  assert.equal(envNames.length, 1)
  assert.match(envNames[0] ?? "", /^IPR_.+_OPENWORK_CUSTOM_API_KEY$/)
  assert.ok(!connect.text.includes(KEY), "members get their own gateway key, never the upstream key")

  // Re-fetch with the saved key; another host would need the key again.
  const refetch = await owner("POST", "/v1/inference-providers/custom/discover-models", { inferenceProviderId: providerId })
  assert.equal(field(refetch.body, "status"), "detailed", summary(refetch))
  assert.equal(upstreamAuth.at(-1), `Bearer ${KEY}`)
  const elsewhere = await owner("POST", "/v1/inference-providers/custom/discover-models", { inferenceProviderId: providerId, baseUrl: "https://api.example.com/v1" })
  assert.equal(field(elsewhere.body, "error"), "api_key_required", summary(elsewhere))
  const savedKeyTest = await owner("POST", "/v1/inference-providers/custom/test-connection", { baseUrl, inferenceProviderId: providerId, model: houseModel })
  assert.equal(field(savedKeyTest.body, "ok"), true, summary(savedKeyTest))

  // Edit: rename, replace the key, swap a model.
  const renamedModel = { ...houseModel, id: "acme/house-model-2", name: "Acme House 2" }
  const moveHost = await owner("PATCH", `/v1/inference-providers/${providerId}/custom`, { baseUrl: "https://api.example.com/v1" })
  assert.equal(field(moveHost.body, "error"), "api_key_required", summary(moveHost))
  const edited = await owner("PATCH", `/v1/inference-providers/${providerId}/custom`, { name: "Acme AI (EU)", apiKey: NEW_KEY, models: [gpt, renamedModel], discoveryStatus: "unavailable" })
  assert.equal(edited.status, 200, summary(edited))
  assert.ok(!edited.text.includes(NEW_KEY) && !edited.text.includes(KEY))
  assert.equal(field(edited.body, "inferenceProvider", "name"), "Acme AI (EU)")
  assert.deepEqual(field(edited.body, "inferenceProvider", "custom", "discovery", "listedModelIds"), ["openai/gpt-4o"], "an unavailable re-fetch keeps the last listed ids")
  assert.deepEqual(list(field(edited.body, "inferenceProvider", "custom", "models")).map((model) => model.id), ["openai/gpt-4o", "acme/house-model-2"])
  const groups = list(field(edited.body, "inferenceProvider", "modelGroups"))
  assert.deepEqual(groups.map((group) => [...(group.modelIds as string[])].sort()), [["acme/house-model-2", "openai/gpt-4o"]], "the all-models group keeps every model")
  assert.equal(list(field(edited.body, "inferenceProvider", "accessGrants")).length, 1, "access is kept")
  await owner("POST", "/v1/inference-providers/custom/discover-models", { inferenceProviderId: providerId })
  assert.equal(upstreamAuth.at(-1), `Bearer ${NEW_KEY}`, "the replaced key is used")
  const afterEdit = await den.as(teammate, org.orgId)("GET", "/v1/inference-providers?scope=usable")
  const editedProvider = list(field(afterEdit.body, "inferenceProviders")).find((entry) => entry.id === providerId)
  assert.deepEqual(list(field(editedProvider, "models")).map((model) => model.upstreamModelId).sort(), ["acme/house-model-2", "openai/gpt-4o"])

  // The stored models come from the provider's own list; a catalog refresh keeps them.
  const refreshed = await owner("GET", `/v1/inference-providers/${providerId}/models`)
  assert.equal(refreshed.status, 200, summary(refreshed))
  assert.deepEqual(list(field(refreshed.body, "models")).map((model) => model.id).sort(), ["acme/house-model-2", "openai/gpt-4o"])
  assert.equal(field(refreshed.body, "catalogWarning"), undefined)

  // Only custom providers are edited here.
  const openai = await owner("POST", "/v1/inference-providers", { name: "Plain OpenAI", providerId: "openai" })
  const openaiId = text(field(openai.body, "inferenceProvider", "id"), "openai provider id")
  const wrongKind = await owner("PATCH", `/v1/inference-providers/${openaiId}/custom`, { name: "Nope" })
  assert.equal(field(wrongKind.body, "error"), "custom_not_configured", summary(wrongKind))
})

test("generic provider routes keep a custom provider's name in sync and refuse a second key, key maps and per-member sign-in", { timeout: 90_000 }, async () => {
  const created = await owner("POST", "/v1/inference-providers/custom", { name: "Beta AI", baseUrl, apiKey: KEY, models: [houseModel], discoveryStatus: "detailed", allMembers: true })
  assert.equal(created.status, 201, summary(created))
  const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  const setId = text(list(field(created.body, "inferenceProvider", "credentialSets"))[0]?.id, "credential set id")

  // A rename through the generic route also renames what members and the desktop read.
  const renamed = await owner("PATCH", `/v1/inference-providers/${providerId}`, { name: "Beta AI (renamed)" })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(field(renamed.body, "inferenceProvider", "name"), "Beta AI (renamed)")
  assert.equal(field(renamed.body, "inferenceProvider", "providerConfig", "name"), "Beta AI (renamed)")
  const usable = await den.as(teammate, org.orgId)("GET", "/v1/inference-providers?scope=usable")
  const forMember = list(field(usable.body, "inferenceProviders")).find((entry) => entry.id === providerId)
  assert.equal(field(forMember, "name"), "Beta AI (renamed)", summary(usable))
  assert.equal(field(forMember, "providerConfig", "name"), "Beta AI (renamed)")
  assert.equal(list(field(forMember, "models")).length, 1, "the rename keeps the models")

  // The address changes only through the custom edit, which asks for the key again for another host.
  const moved = await owner("PATCH", `/v1/inference-providers/${providerId}`, { settings: { upstreamBaseUrl: "https://api.example.com/v1" } })
  assert.equal(moved.status, 409, summary(moved))
  assert.equal(field(moved.body, "error"), "provider_destination_immutable")
  assert.match(String(field(moved.body, "message")), /\/custom/)
  const unchanged = await owner("PATCH", `/v1/inference-providers/${providerId}`, { settings: { upstreamBaseUrl: baseUrl } })
  assert.equal(unchanged.status, 200, summary(unchanged))

  // Pins and the stored catalog work like any provider.
  const pinned = await owner("PATCH", `/v1/inference-providers/${providerId}`, { pinnedModelIds: ["acme/house-model"] })
  assert.equal(pinned.status, 200, summary(pinned))
  const available = await owner("GET", `/v1/inference-providers/${providerId}/available-models`)
  assert.deepEqual(list(field(available.body, "models")).map((model) => model.id), ["acme/house-model"], summary(available))

  // One organization API key: no second set, no key map, no per-member sign-in.
  const second = await owner("POST", `/v1/inference-providers/${providerId}/credential-sets`, { name: "Second key", credentialMode: "org", credential: { kind: "api_key", secret: NEW_KEY } })
  assert.equal(second.status, 409, summary(second))
  assert.equal(field(second.body, "error"), "custom_single_key")
  const memberSet = await owner("POST", `/v1/inference-providers/${providerId}/credential-sets`, { name: "Personal", credentialMode: "member" })
  assert.equal(field(memberSet.body, "error"), "unsupported_credential_mode", summary(memberSet))
  const keyMap = await owner("PATCH", `/v1/inference-providers/${providerId}/credential-sets/${setId}`, { apiKeys: { OPENWORK_CUSTOM_API_KEY: NEW_KEY } })
  assert.equal(keyMap.status, 400, summary(keyMap))
  assert.equal(field(keyMap.body, "error"), "invalid_credential")
  const toMember = await owner("PATCH", `/v1/inference-providers/${providerId}/credential-sets/${setId}`, { credentialMode: "member" })
  assert.equal(field(toMember.body, "error"), "unsupported_credential_mode", summary(toMember))
  for (const response of [second, keyMap]) assert.ok(!response.text.includes(NEW_KEY))

  // The saved key is untouched and still used for re-fetching.
  await owner("POST", "/v1/inference-providers/custom/discover-models", { inferenceProviderId: providerId })
  assert.equal(upstreamAuth.at(-1), `Bearer ${KEY}`)
})
