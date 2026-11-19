import assert from "node:assert/strict"
import { test } from "node:test"
import { liteLlmStaticModels } from "../src/llm/litellm.js"
import type { ModelsDevProvider } from "../src/llm/models-dev.js"

function provider(id: string, models: Array<{ id: string; config: Record<string, unknown> }>): ModelsDevProvider {
  return { id, name: id, npm: null, env: [], doc: null, api: null, config: {}, models: models.map((model) => ({ id: model.id, name: `${id} ${model.id}`, config: { id: model.id, ...model.config } })) }
}

const catalog = [
  provider("openai", [{ id: "gpt-4o-mini", config: { tool_call: true, attachment: true, limit: { context: 128_000, output: 16_384 }, modalities: { input: ["text", "image"], output: ["text"] }, cost: { input: 0.15, output: 0.6 } } }]),
  provider("azure", [{ id: "gpt-4o", config: { tool_call: true, limit: { context: 128_000, output: 16_384 } } }]),
]

test("a typed name the catalog knows takes its limits and capabilities", () => {
  const [model] = liteLlmStaticModels(["gpt-4o-mini"], catalog)
  assert.deepEqual(model, {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    config: { id: "gpt-4o-mini", name: "gpt-4o-mini", tool_call: true, attachment: true, limit: { context: 128_000, output: 16_384 }, modalities: { input: ["text", "image"], output: ["text"] } },
  })
})

test("prices are not copied: LiteLLM budgets people signing in with Microsoft", () => {
  const [model] = liteLlmStaticModels(["gpt-4o-mini"], catalog)
  assert.equal(model?.config.cost, undefined)
})

test("a provider-prefixed LiteLLM name matches its catalog model", () => {
  const [model] = liteLlmStaticModels(["azure/gpt-4o"], catalog)
  assert.deepEqual(model?.config.limit, { context: 128_000, output: 16_384 })
  assert.equal(model?.id, "azure/gpt-4o")
})

test("an unknown name keeps only its name", () => {
  assert.deepEqual(liteLlmStaticModels(["team-router-alias"], catalog), [{ id: "team-router-alias", name: "team-router-alias", config: { id: "team-router-alias", name: "team-router-alias" } }])
})

test("without a catalog, names stay bare", () => {
  assert.deepEqual(liteLlmStaticModels(["gpt-4o-mini"]), [{ id: "gpt-4o-mini", name: "gpt-4o-mini", config: { id: "gpt-4o-mini", name: "gpt-4o-mini" } }])
})
