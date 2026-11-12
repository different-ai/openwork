import assert from "node:assert/strict"
import test from "node:test"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-truefoundry-models-test-key-0000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-truefoundry-models-test-secret-00"
process.env.DEN_BASE_URL ??= "https://console.example.test"
import type { ModelsDevProvider } from "../src/llm/models-dev.js"
import { matchInProvider, matchTrueFoundryModel, splitTrueFoundryModelId, trueFoundryModelConfig, trueFoundrySearchOrder } from "../src/llm/truefoundry-models.js"
import { trueFoundryCatalogModels } from "../src/llm/truefoundry.js"

const facts = { attachment: true, reasoning: true, tool_call: true, temperature: false, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 400000, output: 128000 }, cost: { input: 1.25, output: 10 } }
function provider(id: string, models: Array<[string, string, Record<string, unknown>?]>): ModelsDevProvider {
  return { id, name: id, npm: null, env: [], doc: null, api: null, config: {}, models: models.map(([modelId, name, config]) => ({ id: modelId, name, config: { id: modelId, name, ...(config ?? facts) } })) }
}
const catalog = [
  provider("aaa-reseller", [["gpt-5.5", "Reseller GPT-5.5", { limit: { context: 1, output: 1 } }], ["grok-legacy", "Grok Legacy"]]),
  provider("openai", [["gpt-5.5", "GPT-5.5"], ["gpt-5.5-mini", "GPT-5.5 mini"]]),
  provider("anthropic", [["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"], ["claude-opus-4-1", "Claude Opus 4.1"]]),
  provider("azure", [["gpt-4o", "GPT-4o (Azure)"]]),
  provider("openrouter", [["openai/gpt-4o", "GPT-4o (OpenRouter)"], ["meta-llama/llama-4", "Llama 4"]]),
  provider("zzz-other", [["house-a", "House A"], ["house-a-v2", "House A v2"]]),
]

test("ids split into the TrueFoundry account and the model", () => {
  assert.deepEqual(splitTrueFoundryModelId("openai/gpt-5.5"), { account: "openai", model: "gpt-5.5" })
  assert.deepEqual(splitTrueFoundryModelId("vertex/publishers/google/gemini"), { account: "vertex", model: "publishers/google/gemini" })
  assert.deepEqual(splitTrueFoundryModelId("gpt-5.5"), { account: null, model: "gpt-5.5" })
})

test("the search goes account hints first, then first-party vendors and OpenRouter, then everything else", () => {
  assert.deepEqual(trueFoundrySearchOrder("azure-prod", catalog), ["azure", "openai", "anthropic", "openrouter", "aaa-reseller", "zzz-other"])
  assert.deepEqual(trueFoundrySearchOrder("my-team", catalog), ["openai", "anthropic", "azure", "openrouter", "aaa-reseller", "zzz-other"])
})

test("the first provider in the search order wins over an earlier name in the file", () => {
  assert.equal(matchTrueFoundryModel("openai/gpt-5.5", catalog)?.model.name, "GPT-5.5")
  assert.equal(matchTrueFoundryModel("team-x/gpt-5.5", catalog)?.provider.id, "openai", "first-party vendors come before the rest of the file")
  assert.equal(matchTrueFoundryModel("azure-prod/gpt-4o", catalog)?.provider.id, "azure")
})

test("dates, case and punctuation are ignored only when the match stays unique", () => {
  assert.equal(matchTrueFoundryModel("my-claude/Claude-Sonnet-4.5-20250929", catalog)?.model.id, "claude-sonnet-4-5-20250929")
  assert.equal(matchTrueFoundryModel("anthropic/claude-opus-4-1-20250805", catalog)?.model.id, "claude-opus-4-1")
  assert.equal(matchInProvider("house-a", catalog[5].models)?.id, "house-a")
  assert.equal(matchInProvider("HOUSE_A", catalog[5].models)?.id, "house-a")
})

test("models only the rest of the file knows are still found, and OpenRouter ids match whole", () => {
  assert.equal(matchTrueFoundryModel("xai/grok-legacy", catalog)?.provider.id, "aaa-reseller")
  assert.equal(matchTrueFoundryModel("openrouter/meta-llama/llama-4", catalog)?.model.id, "meta-llama/llama-4")
  assert.equal(matchTrueFoundryModel("internal/unknown-model", catalog), null)
})

test("a matched model keeps its TrueFoundry id, takes the catalog name, capabilities and limits, never prices", () => {
  const config = trueFoundryModelConfig("openai/gpt-5.5", matchTrueFoundryModel("openai/gpt-5.5", catalog))
  assert.deepEqual(config, { id: "openai/gpt-5.5", name: "GPT-5.5", attachment: true, reasoning: true, tool_call: true, temperature: false, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 400000, output: 128000 } })
  assert.deepEqual(trueFoundryCatalogModels(["openai/gpt-5.5", "internal/x"], catalog).map((model) => [model.id, model.name]), [["openai/gpt-5.5", "GPT-5.5"], ["internal/x", "internal/x"]])
})

test("when models.dev can't be read, a sync keeps what the previous sync learned", async () => {
  const { planTrueFoundryCatalog } = await import("../src/llm/truefoundry-sync.js")
  const client = { requireAdmin: async () => undefined, listModels: async () => ["openai/gpt-5.5", "openai/new-model"] }
  const previous = [{ id: "openai/gpt-5.5", name: "GPT-5.5", config: { id: "openai/gpt-5.5", name: "GPT-5.5", limit: { context: 1, output: 1 } } }]
  const models = await planTrueFoundryCatalog(client, "tfy_va_admin", async () => { throw new Error("offline") }, previous)
  assert.deepEqual(models.map((model) => model.name), ["GPT-5.5", "openai/new-model"])
  const fresh = await planTrueFoundryCatalog(client, "tfy_va_admin", async () => catalog, previous)
  assert.equal(fresh[0]?.name, "GPT-5.5")
  assert.equal(fresh[1]?.name, "openai/new-model")
})
