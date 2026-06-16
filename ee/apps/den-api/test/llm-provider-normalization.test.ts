import { expect, test } from "bun:test"
import { CustomProviderConfigError, normalizeCustomProviderConfig } from "../src/llm/custom-provider.js"

test("normalizes a full opencode JSONC config with provider and models maps", () => {
  const normalized = normalizeCustomProviderConfig({
    customConfigText: `{
      // Support attachment format: full opencode config, not a bare provider.
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "meettie": {
          "id": "meettie-gateway",
          "api": "https://llm.meettie.com/v1",
          "env": ["MEETTIE_GATEWAY_API_KEY"],
          "npm": "@ai-sdk/anthropic",
          "name": "Meettie LLM Gateway (Anthropic Protocol)",
          "models": {
            "tie-auto": {
              "name": "Meettie Claude 3 Haiku (2024-03-07)",
              "limit": { "input": 200000, "output": 8192, "context": 200000 },
            },
          },
        },
      },
    }`,
  })

  expect(normalized.providerId).toBe("meettie-gateway")
  expect(normalized.providerConfig).toEqual({
    id: "meettie-gateway",
    api: "https://llm.meettie.com/v1",
    env: ["MEETTIE_GATEWAY_API_KEY"],
    npm: "@ai-sdk/anthropic",
    name: "Meettie LLM Gateway (Anthropic Protocol)",
  })
  expect(normalized.models).toEqual([
    {
      id: "tie-auto",
      name: "Meettie Claude 3 Haiku (2024-03-07)",
      config: {
        id: "tie-auto",
        name: "Meettie Claude 3 Haiku (2024-03-07)",
        limit: { input: 200000, output: 8192, context: 200000 },
      },
    },
  ])
})

test("accepts MCP object input without JSON string escaping", () => {
  const normalized = normalizeCustomProviderConfig({
    customConfig: {
      provider: {
        meettie: {
          id: "meettie-gateway",
          api: "https://llm.meettie.com/v1",
          env: ["MEETTIE_GATEWAY_API_KEY"],
          npm: "@ai-sdk/anthropic",
          name: "Meettie LLM Gateway (Anthropic Protocol)",
          models: {
            "tie-auto": { name: "Tie Auto" },
          },
        },
      },
    },
  })

  expect(normalized.models[0]?.id).toBe("tie-auto")
  expect(normalized.models[0]?.name).toBe("Tie Auto")
})

test("keeps accepting models.dev-style provider configs without doc", () => {
  const normalized = normalizeCustomProviderConfig({
    customConfigText: JSON.stringify({
      id: "meettie-gateway",
      api: "https://llm.meettie.com/v1",
      env: ["MEETTIE_GATEWAY_API_KEY"],
      npm: "@ai-sdk/anthropic",
      name: "Meettie LLM Gateway (Anthropic Protocol)",
      models: [{ id: "tie-auto", name: "Tie Auto" }],
    }),
  })

  expect(normalized.providerId).toBe("meettie-gateway")
  expect(normalized.providerConfig.doc).toBeUndefined()
})

test("returns field paths for invalid custom provider configs", () => {
  expect(() => normalizeCustomProviderConfig({ customConfigText: JSON.stringify({ models: [] }) })).toThrow(
    new CustomProviderConfigError("id: Invalid input: expected string, received undefined; name: Invalid input: expected string, received undefined; npm: Invalid input: expected string, received undefined"),
  )
})

test("rejects full opencode configs with multiple providers", () => {
  expect(() => normalizeCustomProviderConfig({
    customConfig: {
      provider: {
        first: { id: "first", name: "First", npm: "@ai-sdk/anthropic", env: ["FIRST_KEY"], models: ["first-model"] },
        second: { id: "second", name: "Second", npm: "@ai-sdk/anthropic", env: ["SECOND_KEY"], models: ["second-model"] },
      },
    },
  })).toThrow(new CustomProviderConfigError("Custom provider config contains multiple providers. Paste one provider block or remove the others."))
})
