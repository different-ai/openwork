import { describe, expect, test } from "bun:test"

import { normalizeCustomProviderConfig } from "../src/llm/custom-provider.js"
import { buildGuidedCustomProviderConfig } from "../../den-web/app/(den)/dashboard/_components/llm-provider-guided"

describe("guided custom provider form contract", () => {
  test("a form-generated config normalizes without errors", () => {
    const customConfig = buildGuidedCustomProviderConfig({
      providerId: "azure-foundry",
      name: "Azure AI Foundry",
      baseUrl: "https://my-resource.openai.azure.com/openai/v1",
      modelIds: ["gpt-5.2", "my-deployment-name"],
    })

    const normalized = normalizeCustomProviderConfig({ customConfig })

    expect(normalized.providerId).toBe("azure-foundry")
    expect(normalized.providerConfig.npm).toBe("@ai-sdk/openai-compatible")
    expect(normalized.providerConfig.api).toBe("https://my-resource.openai.azure.com/openai/v1")
    expect(normalized.providerConfig.env).toEqual(["AZURE_FOUNDRY_API_KEY"])
    expect(normalized.models.map((model) => model.id)).toEqual([
      "gpt-5.2",
      "my-deployment-name",
    ])
  })

  test("a form-generated config with several env keys keeps them all", () => {
    const customConfig = buildGuidedCustomProviderConfig({
      providerId: "bedrock-gateway",
      name: "Bedrock Gateway",
      baseUrl: "https://bedrock.example.com/v1",
      modelIds: ["claude-fable-5"],
      envNames: [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
        "AWS_BEARER_TOKEN_BEDROCK",
      ],
    })

    const normalized = normalizeCustomProviderConfig({ customConfig })

    expect(normalized.providerConfig.env).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
    ])
  })
})
