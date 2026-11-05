import assert from "node:assert/strict"
import { test } from "node:test"
import { CustomProviderConfigError, normalizeCustomProviderConfig } from "../src/llm/custom-provider.ts"

const base = { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", env: ["ACME_API_KEY"] }

test("custom provider config with unique model ids normalizes every model", () => {
  const result = normalizeCustomProviderConfig({ customConfig: { ...base, models: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } })
  assert.deepEqual(result.models.map((model) => model.id), ["a", "b"])
})

test("custom provider config rejects duplicate model ids in an array", () => {
  assert.throws(
    () => normalizeCustomProviderConfig({ customConfig: { ...base, models: [{ id: "m1", name: "A" }, { id: "m1", name: "B" }] } }),
    (error: unknown) => error instanceof CustomProviderConfigError && error.message.includes("m1"),
  )
})

test("custom provider config rejects model map entries that resolve to the same id", () => {
  assert.throws(
    () => normalizeCustomProviderConfig({ customConfig: { ...base, models: { a: { id: "m1" }, b: { id: "m1" } } } }),
    CustomProviderConfigError,
  )
})

test("custom provider config rejects model ids that differ only by case or whitespace", () => {
  assert.throws(
    () => normalizeCustomProviderConfig({ customConfig: { ...base, models: [{ id: "GPT-4", name: "A" }, { id: " gpt-4 ", name: "B" }] } }),
    CustomProviderConfigError,
  )
})
