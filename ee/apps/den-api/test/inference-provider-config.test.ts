import { expect, test } from "bun:test"
import {
  buildGatewayProviderConfig,
  buildProviderConfigSnapshot,
  isSupportedGatewayNpm,
  gatewayProviderUrl,
  nonSecretProviderConfig,
  upstreamBaseUrlSettingError,
  gatewayConfigurationError,
  gatewayModelConfigurationError,
  hasUnresolvedGatewayTemplate,
} from "../src/llm/inference-provider-config.js"
import { inferenceCredentialEnvNames, pickInferenceApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"

const baseUrl = "https://inference.example.test/"

test("unresolved provider templates are rejected before URL encoding; only a concrete endpoint override resolves them", () => {
  for (const api of [
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1",
    "https://api.example/%24%7BACCOUNT_ID%7D/v1",
    "https://api.example/%2524%257BACCOUNT_ID%257D/v1",
    "https://api.example/%24%7BACCOUNT_ID%7D/%broken",
    "https://api.example/{env:ACCOUNT_ID}/v1",
    "https://api.example/$ACCOUNT_ID/v1",
  ]) {
    expect(hasUnresolvedGatewayTemplate(api)).toBe(true)
    expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: api })).not.toBeNull()
    expect(gatewayConfigurationError({ api }, {})).not.toBeNull()
    expect(gatewayConfigurationError({ api }, { upstreamBaseUrl: "https://configured.example/v1" })).toBeNull()
  }
  expect(gatewayConfigurationError({ options: { account: "${ACCOUNT_ID}" } }, { upstreamBaseUrl: "https://configured.example/v1" })).not.toBeNull()
})

test("gateway model SDK overrides must match the resource SDK without stripping compatible metadata", () => {
  const config = { npm: "@ai-sdk/google-vertex" }
  const compatible = { id: "gemini", provider: { npm: "@ai-sdk/google-vertex" }, limit: { output: 1234 } }
  expect(gatewayModelConfigurationError(config, [compatible])).toBeNull()
  expect(gatewayModelConfigurationError(config, [{ provider: { npm: "@ai-sdk/google-vertex/anthropic" } }])).not.toBeNull()
  expect(gatewayModelConfigurationError({ npm: "@ai-sdk/google-vertex/anthropic" }, [{ provider: { npm: "@ai-sdk/google-vertex/anthropic" } }])).toBeNull()
  expect(compatible.limit.output).toBe(1234)
})

test("trusted catalog credential selection supports Azure Cognitive Services, Alibaba and Moonshot, never arbitrary fields", () => {
  for (const name of ["AZURE_COGNITIVE_SERVICES_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_API_KEY", "MOONSHOT_API_KEY", "CLOUDFLARE_API_TOKEN"]) {
    expect(pickInferenceApiKeyFromMap({ [name]: "key" }, [name])).toBe("key")
    expect(pickInferenceApiKeyFromMap({ [name]: "key" }, ["OTHER_API_KEY"])).toBeNull()
  }
  const settings = ["AZURE_RESOURCE_NAME", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "CLOUDFLARE_ACCOUNT_ID", "INFOMANIAK_PRODUCT_ID", "AWS_REGION", "API_BASE_URL", "INPUT_API_KEY", "OUTPUT_API_KEY", "SETTINGS_API_TOKEN", "RANDOM_TOKEN", "AWS_SECRET_ACCESS_KEY"]
  expect(inferenceCredentialEnvNames(settings)).toEqual([])
  for (const name of settings) expect(pickInferenceApiKeyFromMap({ [name]: "not-a-key" }, settings)).toBeNull()
  const trusted = ["API_TOKEN", "AZURE_RESOURCE_NAME", "PRIMARY_API_KEY", "SECONDARY_API_KEY"]
  expect(pickInferenceApiKeyFromMap({ PRIMARY_API_KEY: "primary", API_TOKEN: "secondary", AZURE_RESOURCE_NAME: "resource" }, trusted)).toBe("primary")
  expect(pickInferenceApiKeyFromMap({ PRIMARY_API_KEY: "primary", SECONDARY_API_KEY: "competing" }, trusted)).toBeNull()
  expect(pickInferenceApiKeyFromMap({ PRIMARY_API_KEY: "primary", ATTACKER_API_KEY: "injected" }, trusted)).toBeNull()
})

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
    env: ["IPR_01JTESTPROVIDER_ANTHROPIC_API_KEY"],
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
  expect(vertex.env).toEqual(["IPR_01JVERTEX_GOOGLE_GENERATIVE_AI_API_KEY"])

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
  expect(vertexAnthropic.env).toEqual(["IPR_01JVERTEXANTHROPIC_ANTHROPIC_API_KEY"])
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

test("upstreamBaseUrlSettingError accepts public HTTPS URLs and rejects private/malformed destinations", () => {
  expect(upstreamBaseUrlSettingError({})).toBeNull()
  expect(upstreamBaseUrlSettingError({ project: "p" })).toBeNull()
  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "https://eu.anthropic.example/v1" })).toBeNull()
  for (const upstreamBaseUrl of ["http://127.0.0.1:4321/v1", "https://127.1/v1", "https://[::ffff:127.0.0.1]/v1", "https://localhost./v1", "https://169.254.169.254/v1", "https://10.0.0.1/v1"]) {
    expect(upstreamBaseUrlSettingError({ upstreamBaseUrl })).not.toBeNull()
  }

  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "" })).toContain("non-empty")
  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: 42 })).toContain("non-empty")
  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "not a url" })).toContain("absolute URL")
  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "ftp://files.example/v1" })).toContain("http or https")
  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "https://user:pw@host.example/v1" })).toContain("credentials")
  expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "https://host.example/v1?key=x" })).toContain("credentials")
})

test("gateway rows isolate credentials and retain non-secret options, not inline secrets", () => {
  const stored = { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"], options: { maxTokens: 2048, apiKey: "FAKE_SECRET", headers: { authorization: "FAKE_SECRET", "anthropic-beta": "safe-beta" } } }
  const first = buildGatewayProviderConfig({ id: "ipr_01kx4t3amgendr682dmp6120jv", provider_config: stored }, baseUrl)
  const second = buildGatewayProviderConfig({ id: "ipr_01kx4t3apjendr685c2r6120jv", provider_config: stored }, baseUrl)
  expect(first.env).not.toEqual(second.env)
  expect(first.env).toEqual(["IPR_01KX4T3AMGENDR682DMP6120JV_ANTHROPIC_API_KEY"])
  expect(second.env).toEqual(["IPR_01KX4T3APJENDR685C2R6120JV_ANTHROPIC_API_KEY"])
  expect(JSON.stringify(first)).not.toContain("FAKE_SECRET")
  expect(nonSecretProviderConfig(stored).options).toEqual({ maxTokens: 2048, headers: { "anthropic-beta": "safe-beta" } })
  expect(stored.options.apiKey).toBe("FAKE_SECRET")
})

test("Azure gateway config keeps source identity and non-secret options, with only a scoped API-key env", () => {
  const row = {
    id: "ipr_01kx4t3amgendr682dmp6120jv",
    provider_config: { id: "azure", npm: "@ai-sdk/azure", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"], options: { resourceName: "stale-resource", apiVersion: "stale-version", useDeploymentBasedUrls: true } },
    settings: { resourceName: "fixture-resource", apiVersion: "2025-04-01-preview", upstreamBaseUrl: "https://private-upstream.example/openai" },
  }
  expect(buildGatewayProviderConfig(row, baseUrl)).toEqual({
    id: "azure",
    npm: "@ai-sdk/azure",
    env: ["IPR_01KX4T3AMGENDR682DMP6120JV_AZURE_API_KEY"],
    api: `${baseUrl}api/v1/providers/${row.id}`,
    options: { baseURL: `${baseUrl}api/v1/providers/${row.id}`, resourceName: "fixture-resource", apiVersion: "2025-04-01-preview", useDeploymentBasedUrls: true },
  })
  expect(row.provider_config.options.resourceName).toBe("stale-resource")
  expect(row.provider_config.env).toEqual(["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])
})

test("deployment gateway base keeps path prefixes but rejects credential-bearing or non-HTTP bases", () => {
  expect(gatewayProviderUrl("https://gateway.example/prefix/", "ipr_test")).toBe("https://gateway.example/prefix/api/v1/providers/ipr_test")
  for (const base of ["javascript:alert(1)", "https://user:password@gateway.example", "https://gateway.example/?key=secret", "https://gateway.example/#fragment"]) {
    expect(() => gatewayProviderUrl(base, "ipr_test")).toThrow()
  }
})

test("private upstream exceptions belong to deployment configuration, not provider settings", () => {
  const previous = process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS
  try {
    process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = ""
    expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "http://127.0.0.1:43123/v1", allowPrivate: true })).not.toBeNull()
    process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = "http://127.0.0.1:43123"
    expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "http://127.0.0.1:43123/v1" })).toBeNull()
    expect(upstreamBaseUrlSettingError({ upstreamBaseUrl: "http://127.0.0.1:43124/v1" })).not.toBeNull()
  } finally {
    if (previous === undefined) delete process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS
    else process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = previous
  }
})
