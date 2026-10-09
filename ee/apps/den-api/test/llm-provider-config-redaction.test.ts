import assert from "node:assert/strict"
import { test } from "node:test"
import { redactLlmProviderConfig } from "../src/llm/llm-provider-config-redaction.ts"

test("redactLlmProviderConfig removes inline credentials from a custom provider at any depth", () => {
  const stored = {
    npm: "@ai-sdk/openai-compatible",
    name: "Acme gateway",
    env: ["ACME_API_KEY"],
    api: "https://llm.example.test/v1",
    apiKey: "sk-top",
    api_key: "sk-snake",
    token: "tok",
    authToken: "auth-tok",
    bearer_token: "bearer",
    secret: "s",
    clientSecret: "cs",
    password: "pw",
    credentials: { client_email: "svc@example.test", private_key: "-----BEGIN-----" },
    privateKey: "pk",
    auth: { username: "u", password: "p" },
    options: {
      baseURL: "https://llm.example.test/v1",
      apiKey: "sk-nested",
      headers: {
        Authorization: "Bearer sk-header",
        "x-api-key": "sk-x",
        "X-Custom-Secret-Thing": "custom",
        "anthropic-version": "2023-06-01",
      },
      fetchOptions: { access_token: "at", refreshToken: "rt", timeout: 30 },
    },
    models: {
      "model-a": { name: "Model A", options: { apiKey: "sk-model" }, limit: { context: 1000, output: 100 } },
    },
    providers: [{ id: "p", token: "array-token", url: "https://a.example.test" }],
  }

  assert.deepEqual(redactLlmProviderConfig(stored), {
    npm: "@ai-sdk/openai-compatible",
    name: "Acme gateway",
    env: ["ACME_API_KEY"],
    api: "https://llm.example.test/v1",
    options: {
      baseURL: "https://llm.example.test/v1",
      headers: { "anthropic-version": "2023-06-01" },
      fetchOptions: { timeout: 30 },
    },
    models: {
      "model-a": { name: "Model A", options: {}, limit: { context: 1000, output: 100 } },
    },
    providers: [{ id: "p", url: "https://a.example.test" }],
  })
})

test("redactLlmProviderConfig keeps a catalog provider's non-secret fields and does not mutate its input", () => {
  const stored = { id: "openai", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], doc: "https://example.test/docs", options: { maxTokens: 4096 } }
  const before = structuredClone(stored)
  assert.deepEqual(redactLlmProviderConfig(stored), stored)
  assert.deepEqual(stored, before)
})
