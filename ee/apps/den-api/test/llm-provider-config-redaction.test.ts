import assert from "node:assert/strict"
import { test } from "node:test"
import { credentialFreeUrl, viewOnlyLlmModelConfig, viewOnlyLlmProviderConfig } from "../src/llm/llm-provider-config-redaction.ts"

const SECRET = "sk-inline-secret"

test("the view-only provider config keeps only allowlisted fields, whatever else a custom provider stores", () => {
  const stored = {
    id: "acme",
    name: "Acme gateway",
    npm: "@ai-sdk/openai-compatible",
    env: ["ACME_API_KEY", SECRET + " not an env name", 42],
    doc: "https://docs.example.test/acme?token=" + SECRET,
    api: `https://user:${SECRET}@llm.example.test/v1?api_key=${SECRET}#frag`,
    apiKey: SECRET,
    bearer: SECRET,
    customField: SECRET,
    nested: [[{ apiKey: SECRET }], [[SECRET]]],
    options: {
      baseURL: `https://${SECRET}@llm.example.test/v1/?key=${SECRET}`,
      apiKey: SECRET,
      bearer: SECRET,
      headers: { Authorization: `Bearer ${SECRET}`, "anthropic-version": "2023-06-01" },
      extra: [[{ token: SECRET }]],
    },
  }

  const view = viewOnlyLlmProviderConfig(stored)
  assert.deepEqual(view, {
    id: "acme",
    name: "Acme gateway",
    npm: "@ai-sdk/openai-compatible",
    env: ["ACME_API_KEY"],
    doc: "https://docs.example.test/acme",
    api: "https://llm.example.test/v1",
    options: { baseURL: "https://llm.example.test/v1/" },
  })
  assert.equal(JSON.stringify(view).includes(SECRET), false)
})

test("the view-only model config keeps metadata, modalities and limits and drops everything else", () => {
  const stored = {
    id: "model-a",
    name: "Model A",
    family: "acme",
    reasoning: true,
    tool_call: "yes",
    release_date: "2026-01-01",
    modalities: { input: ["text", "image", SECRET + "!"], output: ["text"], secret: [SECRET] },
    limit: { context: 128000, output: 8192, bearer: SECRET },
    cost: { input: 1.5, output: "2", cache_read: 0.1 },
    options: { apiKey: SECRET, headers: { Authorization: SECRET } },
    bearer: SECRET,
    providerOptions: [[SECRET], [{ token: SECRET }]],
    unknownKey: { deep: [[{ value: SECRET }]] },
  }

  const view = viewOnlyLlmModelConfig(stored)
  assert.deepEqual(view, {
    id: "model-a",
    name: "Model A",
    family: "acme",
    reasoning: true,
    release_date: "2026-01-01",
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 128000, output: 8192 },
    cost: { input: 1.5, cache_read: 0.1 },
  })
  assert.equal(JSON.stringify(view).includes(SECRET), false)
})

test("a catalog provider keeps what the dashboard shows, and the stored config is not mutated", () => {
  const stored = { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], doc: "https://platform.openai.com/docs/models" }
  const before = structuredClone(stored)
  assert.deepEqual(viewOnlyLlmProviderConfig(stored), stored)
  assert.deepEqual(stored, before)
  assert.deepEqual(viewOnlyLlmProviderConfig({}), {})
  assert.deepEqual(viewOnlyLlmModelConfig({ limit: "lots", modalities: [] }), {})
})

test("credentialFreeUrl strips userinfo, query and fragment and rejects anything that is not http(s)", () => {
  assert.equal(credentialFreeUrl(`https://u:${SECRET}@host.example.test:8443/a/b?token=${SECRET}#x`), "https://host.example.test:8443/a/b")
  assert.equal(credentialFreeUrl("http://localhost:11434/v1"), "http://localhost:11434/v1")
  assert.equal(credentialFreeUrl(`javascript:alert('${SECRET}')`), undefined)
  assert.equal(credentialFreeUrl(`data:text/plain,${SECRET}`), undefined)
  assert.equal(credentialFreeUrl("not a url"), undefined)
  assert.equal(credentialFreeUrl(42), undefined)
})
