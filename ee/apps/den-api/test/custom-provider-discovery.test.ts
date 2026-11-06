import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeGatewayCustomBaseUrl } from "@openwork/types/den/gateway-custom-providers"
import {
  customModelFromModelsDev,
  discoverCustomProviderModels,
  discoveredModels,
  fetchCustomProviderModels,
  mapModalities,
  matchOpenRouterModel,
  parseModelsResponse,
  perTokenToPerMillion,
  suggestCustomModel,
} from "../src/llm/custom-provider-discovery.js"
import { checkCustomBaseUrl, customCatalogProvider, customModelConfig, sameCustomOrigin } from "../src/llm/gateway-custom-provider.js"
import type { ModelsDevModel } from "../src/llm/models-dev.js"

const KEY = "sk-custom-fixture-secret-000000"

const openRouterCatalog: ModelsDevModel[] = [
  { id: "openai/gpt-4o", name: "GPT-4o", config: { id: "openai/gpt-4o", name: "GPT-4o", attachment: true, reasoning: false, tool_call: true, structured_output: true, temperature: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 128000, output: 16384 }, cost: { input: 2.5, output: 10, cache_read: 1.25 } } },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", config: { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", attachment: true, reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "bogus" }], tool_call: true, temperature: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15 }, canonical_model_id: "anthropic/claude-4-sonnet-20250522" } },
  { id: "meta-llama/llama-3.1-8b", name: "Llama 3.1 8B", config: { id: "meta-llama/llama-3.1-8b", name: "Llama 3.1 8B", attachment: false, reasoning: false, tool_call: false, temperature: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 131072, output: 8192 } } },
  { id: "mistralai/mistral-large", name: "Mistral Large (Mistral)", config: { id: "mistralai/mistral-large", limit: { context: 128000, output: 4096 } } },
  { id: "someone/mistral-large", name: "Mistral Large (Someone)", config: { id: "someone/mistral-large", limit: { context: 128000, output: 4096 } } },
]

const detailedEntry = {
  id: "openai/gpt-4o",
  canonical_slug: "openai/gpt-4o",
  name: "OpenAI: GPT-4o",
  context_length: 120000,
  architecture: { input_modalities: ["text", "image", "file", "hologram"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0", input_cache_write: "-1" },
  top_provider: { context_length: 128000, max_completion_tokens: 4096 },
  supported_parameters: ["tools", "temperature"],
}

test("base URLs lose a trailing /chat/completions, /completions or slash", () => {
  assert.equal(normalizeGatewayCustomBaseUrl(" https://api.example.com/v1/chat/completions/ "), "https://api.example.com/v1")
  assert.equal(normalizeGatewayCustomBaseUrl("https://api.example.com/v1/completions"), "https://api.example.com/v1")
  assert.equal(normalizeGatewayCustomBaseUrl("https://api.example.com/v1///"), "https://api.example.com/v1")
  assert.equal(normalizeGatewayCustomBaseUrl("https://user:pw@api.example.com/v1"), null)
  assert.equal(normalizeGatewayCustomBaseUrl("https://api.example.com/v1?x=1"), null)
  assert.equal(normalizeGatewayCustomBaseUrl("ftp://api.example.com"), null)
  assert.equal(normalizeGatewayCustomBaseUrl("not a url"), null)
})

test("only public HTTPS addresses pass the egress check", () => {
  assert.deepEqual(checkCustomBaseUrl("https://api.example.com/v1/chat/completions"), { ok: true, baseUrl: "https://api.example.com/v1" })
  for (const refused of ["http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://10.0.0.8/v1", "https://192.168.1.2/v1", "https://[::1]/v1", "https://169.254.169.254/latest"]) {
    const result = checkCustomBaseUrl(refused)
    assert.equal(result.ok, false, refused)
  }
  assert.equal(sameCustomOrigin("https://a.example.com/v1", "https://a.example.com/v2"), true)
  assert.equal(sameCustomOrigin("https://a.example.com/v1", "https://b.example.com/v1"), false)
})

test("per-token prices become per-million prices without float noise; zero, negative and junk are dropped", () => {
  assert.equal(perTokenToPerMillion("0.0000025"), 2.5)
  assert.equal(perTokenToPerMillion("0.00000015"), 0.15)
  assert.equal(perTokenToPerMillion("0.000003"), 3)
  assert.equal(perTokenToPerMillion(0.00001), 10)
  assert.equal(perTokenToPerMillion("0"), null)
  assert.equal(perTokenToPerMillion("-1"), null)
  assert.equal(perTokenToPerMillion("free"), null)
  assert.equal(perTokenToPerMillion(""), null)
  assert.equal(perTokenToPerMillion(null), null)
})

test("modalities map file to pdf and drop unknown ones", () => {
  assert.deepEqual(mapModalities(["text", "Image", "file", "pdf", "hologram"]), ["text", "image", "pdf"])
  assert.equal(mapModalities("text"), null)
})

test("/models bodies are detailed, basic or unavailable", () => {
  const detailed = parseModelsResponse({ data: [detailedEntry, { id: "plain-model" }] })
  assert.equal(detailed.status, "detailed")
  const basic = parseModelsResponse({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "openai" }, { id: "gpt-4o" }, { nope: true }, "junk"] })
  assert.equal(basic.status, "basic")
  assert.deepEqual(basic.status === "basic" ? basic.entries.map((entry) => entry.id) : [], ["gpt-4o"], "duplicates and entries without an id are skipped")
  assert.equal(parseModelsResponse({ models: [] }).status, "unavailable")
  assert.equal(parseModelsResponse([{ id: "x" }]).status, "unavailable")
  assert.equal(parseModelsResponse({ data: [] }).status, "unavailable")
  assert.equal(parseModelsResponse("text").status, "unavailable")
  const many = parseModelsResponse({ data: Array.from({ length: 700 }, (_, index) => ({ id: `model-${index}` })) })
  assert.equal(many.status === "basic" ? many.entries.length : 0, 500, "at most 500 models")
})

test("a detailed entry maps to a models.dev-shaped model", () => {
  const parsed = parseModelsResponse({ data: [{ ...detailedEntry, id: "acme/house-model", canonical_slug: undefined, supported_parameters: ["tools", "response_format", "include_reasoning"] }] })
  assert.equal(parsed.status, "detailed")
  const entry = parsed.status === "detailed" ? parsed.entries[0] : undefined
  assert.ok(entry)
  assert.deepEqual(suggestCustomModel(entry, null), {
    id: "acme/house-model",
    name: "OpenAI: GPT-4o",
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: false,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 120000, output: 4096 },
    cost: { input: 2.5, output: 10 },
  })
})

test("a detailed entry without limits or parameters gets defaults", () => {
  const parsed = parseModelsResponse({ data: [{ id: "tiny", name: "Tiny" }] })
  const entry = parsed.status === "detailed" ? parsed.entries[0] : undefined
  assert.ok(entry)
  assert.deepEqual(suggestCustomModel(entry, null), { id: "tiny", name: "Tiny", attachment: false, reasoning: false, tool_call: false, structured_output: false, temperature: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 8192 } })
})

test("matching tries exact id, canonical_slug, unique suffix, then unique loose suffix", () => {
  assert.deepEqual(matchOpenRouterModel({ id: "openai/gpt-4o" }, openRouterCatalog)?.by, "id")
  const bySlug = matchOpenRouterModel({ id: "claude-4-sonnet-latest", canonicalSlug: "anthropic/claude-4-sonnet-20250522" }, openRouterCatalog)
  assert.deepEqual([bySlug?.model.id, bySlug?.by], ["anthropic/claude-sonnet-4", "canonical_slug"])
  const bySuffix = matchOpenRouterModel({ id: "gpt-4o" }, openRouterCatalog)
  assert.deepEqual([bySuffix?.model.id, bySuffix?.by], ["openai/gpt-4o", "suffix"])
  const byPrefixedSuffix = matchOpenRouterModel({ id: "azure/gpt-4o" }, openRouterCatalog)
  assert.deepEqual([byPrefixedSuffix?.model.id, byPrefixedSuffix?.by], ["openai/gpt-4o", "suffix"])
  const byLoose = matchOpenRouterModel({ id: "Llama_3_1:8B" }, openRouterCatalog)
  assert.deepEqual([byLoose?.model.id, byLoose?.by], ["meta-llama/llama-3.1-8b", "loose"])
  assert.equal(matchOpenRouterModel({ id: "mistral-large" }, openRouterCatalog), null, "two models end in mistral-large")
  assert.equal(matchOpenRouterModel({ id: "Mistral_Large" }, openRouterCatalog), null, "still ambiguous when loose")
  assert.equal(matchOpenRouterModel({ id: "unknown-model" }, openRouterCatalog), null)
})

test("a match is the base; /models limits, modalities and cost override it", () => {
  const parsed = parseModelsResponse({ data: [detailedEntry] })
  const [model] = discoveredModels(parsed.status === "detailed" ? parsed.entries : [], openRouterCatalog)
  assert.deepEqual(model?.match, { providerId: "openrouter", modelId: "openai/gpt-4o", by: "id" })
  assert.deepEqual(model?.model, {
    id: "openai/gpt-4o",
    name: "OpenAI: GPT-4o",
    attachment: true,
    reasoning: false,
    tool_call: true,
    structured_output: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 120000, output: 4096 },
    cost: { input: 2.5, output: 10, cache_read: 1.25 },
  })
})

test("basic models get the match's settings under their own id, or null when nothing matches", () => {
  const parsed = parseModelsResponse({ data: [{ id: "claude-sonnet-4", object: "model" }, { id: "house-model", object: "model" }] })
  const [matched, unmatched] = discoveredModels(parsed.status === "basic" ? parsed.entries : [], openRouterCatalog)
  assert.equal(matched?.model?.id, "claude-sonnet-4", "the upstream id is what is sent as model")
  assert.equal(matched?.model?.name, "Claude Sonnet 4")
  assert.deepEqual(matched?.model?.reasoning_options, [{ type: "toggle" }], "valid reasoning options are kept")
  assert.equal(matched?.model?.structured_output, false)
  assert.deepEqual(unmatched, { id: "house-model", model: null, match: null })
})

test("a models.dev record converts to a valid custom model", () => {
  assert.deepEqual(customModelFromModelsDev("x", { limit: { context: 1000 } }), { id: "x", attachment: false, reasoning: false, tool_call: false, structured_output: false, temperature: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1000, output: 1000 } })
})

test("stored catalog: model configs carry id and name, unreadable settings give no catalog", () => {
  const model = { id: "house-model", attachment: false, reasoning: false, tool_call: true, structured_output: false, temperature: true, modalities: { input: ["text" as const], output: ["text" as const] }, limit: { context: 1000, output: 100 } }
  assert.deepEqual(customModelConfig(model), { ...model, name: "house-model" })
  const catalog = customCatalogProvider({ name: "Acme AI", settings: { custom: { version: 1, catalog: [model], discovery: { status: "basic", lastFetchedAt: null } } } })
  assert.deepEqual([catalog?.id, catalog?.npm, catalog?.models.map((entry) => entry.id)], ["openwork-custom", "@ai-sdk/openai-compatible", ["house-model"]])
  assert.equal(customCatalogProvider({ name: "Broken", settings: { custom: { version: 2 } } }), null)
})

test("fetching /models sends the key, caps the size and never reports the key", async () => {
  const seen: Array<{ url: string; authorization: string | null; redirect: string }> = []
  const ok = await fetchCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, { fetch: async (input, init) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, authorization: request.headers.get("authorization"), redirect: request.redirect })
    return Response.json({ data: [{ id: "a" }] })
  } })
  assert.equal(ok.status, "ok")
  assert.deepEqual(seen, [{ url: "https://api.example.com/v1/models", authorization: `Bearer ${KEY}`, redirect: "error" }])

  const tooBig = await fetchCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, { maxBytes: 10, fetch: async () => new Response("x".repeat(100)) })
  assert.deepEqual(tooBig, { status: "unavailable", upstreamStatus: 200, reason: "The provider's model list is too large." })
  const refused = await fetchCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, { fetch: async () => new Response(`bad key ${KEY}`, { status: 401 }) })
  assert.deepEqual(refused, { status: "unavailable", upstreamStatus: 401, reason: "The provider refused the API key." })
  const notJson = await fetchCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, { fetch: async () => new Response("<html>") })
  assert.equal(notJson.status === "unavailable" ? notJson.reason : null, "The provider's model list is not JSON.")
  const down = await fetchCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, { fetch: async () => { throw new Error(`connect ECONNREFUSED with ${KEY}`) } })
  assert.deepEqual(down, { status: "unavailable", upstreamStatus: null, reason: "Couldn't connect to the provider at this address." })
  const slow = await fetchCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, { timeoutMs: 20, fetch: (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
  }) })
  assert.deepEqual(slow, { status: "unavailable", upstreamStatus: null, reason: "The provider took too long to list its models." })
  for (const outcome of [tooBig, refused, notJson, down, slow]) assert.ok(!JSON.stringify(outcome).includes(KEY))
})

test("the default fetch refuses private addresses before connecting", async () => {
  const result = await fetchCustomProviderModels({ baseUrl: "https://127.0.0.1:9/v1", apiKey: KEY })
  assert.equal(result.status, "unavailable")
})

test("discovery still lists models when the models.dev catalog can't be read", async () => {
  const result = await discoverCustomProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: KEY }, {
    fetch: async () => Response.json({ data: [{ id: "gpt-4o" }] }),
    loadMatchCatalog: async () => { throw new Error("models.dev down") },
  })
  assert.deepEqual(result, { status: "basic", baseUrl: "https://api.example.com/v1", reason: null, upstreamStatus: 200, models: [{ id: "gpt-4o", model: null, match: null }] })
})
