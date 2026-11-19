import assert from "node:assert/strict"
import { test } from "node:test"
import { FAST_DEFAULT_VARIANT, fetchGatewayInventory, providerPackage, reasoningVariants, toProviderRecord } from "./providers.ts"
import { API, createFakeDen, GATEWAY_KEY, MODEL_ID, PROVIDER_ID, SESSION_TOKEN } from "./test-den.ts"

const session = { apiBaseUrl: API, token: SESSION_TOKEN, orgId: "org_01m2" }

test("fetches usable gateway providers and the member's gateway key, like the desktop", async () => {
  const den = createFakeDen()
  const inventory = await fetchGatewayInventory(den.fetch, session)
  assert.equal(inventory.apiKey, GATEWAY_KEY)
  assert.deepEqual(inventory.providers.map((provider) => provider.id), [PROVIDER_ID])
  assert.deepEqual(den.calls, [
    "GET /v1/inference-providers?scope=usable",
    `GET /v1/inference-providers/${PROVIDER_ID}/connect`,
  ])
})

test("desktop inventory accepts only a dummy credential, never a reusable Gateway key", async () => {
  const den = createFakeDen()
  const rejected = await fetchGatewayInventory(den.fetch, session, undefined, "desktop")
  assert.equal(rejected.apiKey, null)
  assert.deepEqual(rejected.providers, [])
  const accepted = await fetchGatewayInventory(async (url, init) => {
    const response = await den.fetch(url, init)
    return new Response((await response.text()).replaceAll(GATEWAY_KEY, "ow_local_catalog"), { status: response.status, headers: response.headers })
  }, session, undefined, "desktop")
  assert.equal(accepted.apiKey, "ow_local_catalog")
  assert.deepEqual(accepted.providers.map(provider => provider.id), [PROVIDER_ID])
})

test("a connect 403 refetches the list and removes a provider whose access changed", async () => {
  const den = createFakeDen()
  let lists = 0
  const inventory = await fetchGatewayInventory(async (url, init) => {
    if (url.includes("?scope=usable") && ++lists > 1) return Response.json({ inferenceProviders: [] })
    if (url.endsWith("/connect")) return Response.json({ error: "forbidden" }, { status: 403 })
    return den.fetch(url, init)
  }, session)
  assert.equal(lists, 2)
  assert.deepEqual(inventory.providers, [])
  assert.equal(inventory.apiKey, null)
})

test("a persistent connect 403 is bounded and never returns denied provider credentials", async () => {
  const den = createFakeDen()
  let lists = 0
  const inventory = await fetchGatewayInventory(async (url, init) => {
    if (url.includes("?scope=usable")) lists++
    if (url.endsWith("/connect")) return Response.json({ error: "forbidden" }, { status: 403 })
    return den.fetch(url, init)
  }, session)
  assert.equal(lists, 2)
  assert.deepEqual(inventory.providers, [])
})

test("maps a gateway provider to a V2 provider with the gateway key and native package", async () => {
  const den = createFakeDen()
  const inventory = await fetchGatewayInventory(den.fetch, session)
  const record = toProviderRecord(inventory.providers[0]!, GATEWAY_KEY)
  assert.deepEqual(record.info, {
    id: PROVIDER_ID,
    name: "Anthropic (OpenWork)",
    activation: "enabled",
    integrationID: "openwork-gateway",
    package: "@opencode/ai/providers/anthropic",
    settings: {
      baseURL: `https://gateway.example.test/api/v1/providers/${PROVIDER_ID}`,
      apiKey: GATEWAY_KEY,
    },
  })
  assert.notEqual(record.info.integrationID, "openwork", "the session credential must never replace the gateway key")

  const model = record.models[0]!
  assert.equal(model.id, MODEL_ID)
  assert.equal(model.modelID, MODEL_ID)
  assert.equal(model.providerID, PROVIDER_ID)
  assert.equal(model.name, "Claude Sonnet 4.6", "routing labels are stripped from the picker name")
  assert.deepEqual(model.headers, { "x-openwork-gateway-request-model": MODEL_ID })
  assert.deepEqual(model.capabilities, { tools: true, input: ["text", "image", "pdf"], output: ["text"] })
  assert.deepEqual(model.limit, { context: 1_000_000, output: 64_000 })
  assert.deepEqual(model.cost, [
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.3, write: 3.75 } },
  ])
  assert.equal(model.time.released, Date.parse("2026-02-17"))
  assert.deepEqual(model.variants.map((variant) => variant.id), ["low", "medium", "high", "max"])
  assert.deepEqual(model.variants[2], { id: "high", settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" } })
  assert.equal(model.package, undefined, "models inherit the provider package")
})

test("maps AI SDK packages to native OpenCode packages, falling back to the AI SDK package", () => {
  assert.equal(providerPackage("@ai-sdk/openai"), "@opencode/ai/providers/openai")
  assert.equal(providerPackage("@ai-sdk/openai-compatible"), "@opencode/ai/providers/openai-compatible")
  assert.equal(providerPackage("@ai-sdk/google"), "@opencode/ai/providers/google")
  assert.equal(providerPackage("@openrouter/ai-sdk-provider"), "@opencode/ai/providers/openrouter")
  assert.equal(providerPackage("@ai-sdk/something-new"), "aisdk:@ai-sdk/something-new")
  assert.equal(providerPackage(null), "@opencode/ai/providers/openai-compatible")
})

test("spells reasoning variants per protocol and only from the catalog's declared efforts", () => {
  const efforts = { reasoning_options: [{ type: "effort", values: ["low", "high"] }] }
  assert.deepEqual(reasoningVariants("@opencode/ai/providers/openai", efforts, "gpt-6"), [
    { id: "low", settings: { reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
    { id: "high", settings: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
  ])
  assert.deepEqual(reasoningVariants("@opencode/ai/providers/google", efforts, null)[0], {
    id: "low",
    settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
  })
  assert.deepEqual(reasoningVariants("@opencode/ai/providers/openai", {}, "gpt-6"), [])
  assert.deepEqual(reasoningVariants("@opencode/ai/providers/openai", { ...efforts, reasoning: false }, "gpt-6"), [])
  assert.deepEqual(reasoningVariants("@opencode/ai/providers/anthropic", efforts, "claude-sonnet-4-5"), [], "manual-budget Claude gets no effort variants")
})

test("an openai-compatible gateway provider names its provider-options namespace", () => {
  const record = toProviderRecord(
    { id: "ipr_x", providerId: "together", name: "Together", credentialStatus: "ready", providerConfig: { npm: "@ai-sdk/openai-compatible", api: "https://gw/api/v1/providers/ipr_x" }, models: [] },
    GATEWAY_KEY,
  )
  assert.equal(record.info.settings?.provider, "ipr_x")
})

test("skips providers without usable models and reports why", async () => {
  const den = createFakeDen()
  const original = den.fetch
  const fetcher: typeof den.fetch = async (input, init) => {
    if (new URL(input).pathname === "/v1/inference-providers") {
      return new Response(JSON.stringify({ inferenceProviders: [{ id: "ipr_y", providerId: "openai", name: "OpenAI", credentialStatus: "member_auth_required", providerConfig: {}, models: [] }] }), { status: 200 })
    }
    return original(input, init)
  }
  const inventory = await fetchGatewayInventory(fetcher, session)
  assert.deepEqual(inventory.providers, [])
  assert.deepEqual(inventory.skipped, [{ id: "ipr_y", name: "OpenAI", reason: "member_auth_required" }])
})

test("OpenAI catalog models with priority processing keep Fast mode, like the managed engine config", () => {
  const fastConfig = {
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
  }
  const provider = (npm: string, config: Record<string, unknown>) => ({
    id: "ipr_fast", providerId: "openai", name: "OpenAI", credentialStatus: "ready",
    providerConfig: { npm, api: "https://gw/api/v1/providers/ipr_fast" },
    models: [{ id: "gwm_fast", name: "GPT Fast", config, upstreamModelId: "gpt-6", modelGroupName: null, credentialSetName: null }],
  })
  const ids = (npm: string, config: Record<string, unknown>) =>
    toProviderRecord(provider(npm, config), GATEWAY_KEY).models[0]?.variants.map((variant) => variant.id)

  assert.deepEqual(ids("@ai-sdk/openai", fastConfig), [
    "low", "high", FAST_DEFAULT_VARIANT, "__openwork_fast_v1/variant/low", "__openwork_fast_v1/variant/high",
  ])
  const fastHigh = toProviderRecord(provider("@ai-sdk/openai", fastConfig), GATEWAY_KEY).models[0]?.variants
    .find((variant) => variant.id === "__openwork_fast_v1/variant/high")
  assert.equal(fastHigh?.settings?.serviceTier, "priority")
  assert.equal(fastHigh?.settings?.reasoningEffort, "high")

  assert.deepEqual(ids("@ai-sdk/openai", { reasoning_options: fastConfig.reasoning_options }), ["low", "high"], "no Fast without the catalog's priority mode")
  assert.deepEqual(ids("@ai-sdk/openai-compatible", fastConfig), ["low", "high"], "Fast is OpenAI-only")
  assert.deepEqual(ids("@ai-sdk/openai", { ...fastConfig, experimental: { modes: { fast: { provider: { body: { service_tier: "flex" } } } } } }), ["low", "high"])
})
