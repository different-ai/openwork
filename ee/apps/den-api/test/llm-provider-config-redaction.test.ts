import assert from "node:assert/strict"
import { test } from "node:test"
import { viewOnlyLlmModelConfig, viewOnlyLlmProviderConfig } from "../src/llm/llm-provider-config-redaction.ts"

const SECRET = "sk-inline-secret"

test("the view-only provider config is only id, name and npm, whatever else a custom provider stores", () => {
  const stored = {
    id: "acme",
    name: "Acme gateway",
    npm: "@ai-sdk/openai-compatible",
    env: ["ACME_API_KEY", `ENV_${SECRET}`],
    doc: `https://docs.example.test/${SECRET}`,
    api: `https://${SECRET}.llm.example.test/v1`,
    apiKey: SECRET,
    bearer: SECRET,
    customField: SECRET,
    nested: [[{ apiKey: SECRET }], [[SECRET]]],
    options: {
      baseURL: `https://${SECRET}.llm.example.test/v1`,
      apiKey: SECRET,
      headers: { Authorization: `Bearer ${SECRET}` },
    },
  }

  const view = viewOnlyLlmProviderConfig(stored)
  assert.deepEqual(view, { id: "acme", name: "Acme gateway", npm: "@ai-sdk/openai-compatible" })
  const serialized = JSON.stringify(view)
  for (const planted of [SECRET, "example.test", "ACME_API_KEY", "https://"]) assert.equal(serialized.includes(planted), false, planted)
})

test("the view-only model config is only id, name and numeric limits", () => {
  const stored = {
    id: "model-a",
    name: "Model A",
    family: SECRET,
    reasoning: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 128000, output: 8192, input: "lots", bearer: SECRET },
    cost: { input: 1.5 },
    options: { apiKey: SECRET, baseURL: `https://${SECRET}.example.test` },
    bearer: SECRET,
    providerOptions: [[SECRET], [{ token: SECRET }]],
  }

  const view = viewOnlyLlmModelConfig(stored)
  assert.deepEqual(view, { id: "model-a", name: "Model A", limit: { context: 128000, output: 8192 } })
  assert.equal(JSON.stringify(view).includes(SECRET), false)
})

test("missing or malformed fields are dropped, and the stored config is not mutated", () => {
  const stored = { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], doc: "https://platform.openai.com/docs/models" }
  const before = structuredClone(stored)
  assert.deepEqual(viewOnlyLlmProviderConfig(stored), { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai" })
  assert.deepEqual(stored, before)
  assert.deepEqual(viewOnlyLlmProviderConfig({ id: 42, name: ["x"], npm: { a: 1 } }), {})
  assert.deepEqual(viewOnlyLlmModelConfig({ limit: "lots" }), {})
  assert.deepEqual(viewOnlyLlmModelConfig({ id: "m", limit: { context: Number.POSITIVE_INFINITY } }), { id: "m" })
})
