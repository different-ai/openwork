import { expect, test } from "bun:test"
import {
  buildGatewayProviderConfig,
  buildProviderConfigSnapshot,
  isSupportedGatewayNpm,
} from "../src/llm/inference-provider-config.js"

const baseUrl = "https://inference.example.test/"

test("buildGatewayProviderConfig points api and options.baseURL at the gateway and strips the trailing slash", () => {
  const config = buildGatewayProviderConfig(
    {
      id: "ipr_01jtestprovider",
      provider_config: {
        id: "anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        env: ["ANTHROPIC_API_KEY"],
        options: { headers: { "anthropic-beta": "x" } },
      },
    },
    baseUrl,
  )

  expect(config).toEqual({
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    api: "https://inference.example.test/api/v1/providers/ipr_01jtestprovider",
    options: {
      headers: { "anthropic-beta": "x" },
      baseURL: "https://inference.example.test/api/v1/providers/ipr_01jtestprovider",
    },
  })
})

test("buildGatewayProviderConfig overrides a catalog upstream api and adds options when missing", () => {
  const config = buildGatewayProviderConfig(
    {
      id: "ipr_01jopenrouter",
      provider_config: { id: "openrouter", npm: "@openrouter/ai-sdk-provider", env: ["OPENROUTER_API_KEY"], api: "https://openrouter.ai/api/v1" },
    },
    "https://inference.example.test",
  )
  expect(config.api).toBe("https://inference.example.test/api/v1/providers/ipr_01jopenrouter")
  expect(config.options).toEqual({ baseURL: "https://inference.example.test/api/v1/providers/ipr_01jopenrouter" })
})

test("buildGatewayProviderConfig swaps Vertex SDKs for their static-key equivalents", () => {
  const vertex = buildGatewayProviderConfig(
    {
      id: "ipr_01jvertex",
      provider_config: {
        id: "google-vertex",
        npm: "@ai-sdk/google-vertex",
        env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
      },
    },
    baseUrl,
  )
  expect(vertex.npm).toBe("@ai-sdk/google")
  expect(vertex.env).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY"])

  const vertexAnthropic = buildGatewayProviderConfig(
    {
      id: "ipr_01jvertexanthropic",
      provider_config: {
        id: "google-vertex-anthropic",
        npm: "@ai-sdk/google-vertex/anthropic",
        env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
      },
    },
    baseUrl,
  )
  expect(vertexAnthropic.npm).toBe("@ai-sdk/anthropic")
  expect(vertexAnthropic.env).toEqual(["ANTHROPIC_API_KEY"])
  expect(vertexAnthropic.api).toBe("https://inference.example.test/api/v1/providers/ipr_01jvertexanthropic")
})

test("buildProviderConfigSnapshot keeps only the opencode block fields", () => {
  const snapshot = buildProviderConfigSnapshot({
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENROUTER_API_KEY"],
    doc: "https://openrouter.ai/docs",
    api: "https://openrouter.ai/api/v1",
    config: { id: "openrouter", doc: "https://openrouter.ai/docs", options: { extra: true }, unrelated: "drop" },
    models: [],
  })
  expect(snapshot).toEqual({
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    options: { extra: true },
  })
})

test("isSupportedGatewayNpm accepts the proxied SDK families and rejects Bedrock and unknown packages", () => {
  for (const npm of [
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/azure",
    "@ai-sdk/openai-compatible",
    "@openrouter/ai-sdk-provider",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex",
    "@ai-sdk/google-vertex/anthropic",
  ]) {
    expect(isSupportedGatewayNpm(npm)).toBe(true)
  }
  expect(isSupportedGatewayNpm("@ai-sdk/amazon-bedrock")).toBe(false)
  expect(isSupportedGatewayNpm("@ai-sdk/mistral")).toBe(false)
  expect(isSupportedGatewayNpm(null)).toBe(false)
})
