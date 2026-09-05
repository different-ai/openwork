import { describe, expect, test } from "bun:test";

import {
  buildCloudProviderConfig,
  resolveCloudProviderCredentials,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

const AWS_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
];

describe("resolveCloudProviderCredentials", () => {
  test("legacy single-credential payloads keep auth-only behaviour", () => {
    expect(
      resolveCloudProviderCredentials({
        apiKey: " sk-test ",
        apiKeys: null,
        providerConfig: { env: ["OPENROUTER_API_KEY"] },
      }),
    ).toEqual({ envEntries: [], primaryApiKey: "sk-test" });
  });

  test("multi-env payloads become env entries with the credential env as the auth key", () => {
    const { envEntries, primaryApiKey } = resolveCloudProviderCredentials({
      apiKey: null,
      apiKeys: {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "shhh",
      },
      providerConfig: { env: AWS_ENV },
    });

    expect(envEntries).toEqual([
      { key: "AWS_ACCESS_KEY_ID", value: "AKIA" },
      { key: "AWS_SECRET_ACCESS_KEY", value: "shhh" },
      { key: "AWS_REGION", value: "us-east-1" },
    ]);
    expect(primaryApiKey).toBe("AKIA");
  });

  test("the first env name with a value wins when env[0] has none", () => {
    const { primaryApiKey } = resolveCloudProviderCredentials({
      apiKey: null,
      apiKeys: { AWS_BEARER_TOKEN_BEDROCK: "bearer-token" },
      providerConfig: { env: AWS_ENV },
    });
    expect(primaryApiKey).toBe("bearer-token");
  });

  test("Azure multi-env payloads use AZURE_API_KEY as auth and keep the resource env", () => {
    const { envEntries, primaryApiKey } = resolveCloudProviderCredentials({
      apiKey: null,
      apiKeys: {
        AZURE_RESOURCE_NAME: "resource-name",
        AZURE_API_KEY: "real-api-key",
      },
      providerConfig: { env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
    });

    expect(envEntries).toEqual([
      { key: "AZURE_RESOURCE_NAME", value: "resource-name" },
      { key: "AZURE_API_KEY", value: "real-api-key" },
    ]);
    expect(primaryApiKey).toBe("real-api-key");
  });

  test("Azure resource-only payloads are not treated as authenticated", () => {
    const { envEntries, primaryApiKey } = resolveCloudProviderCredentials({
      apiKey: null,
      apiKeys: { AZURE_RESOURCE_NAME: "resource-name" },
      providerConfig: { env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
    });

    expect(envEntries).toEqual([{ key: "AZURE_RESOURCE_NAME", value: "resource-name" }]);
    expect(primaryApiKey).toBe("");
  });

  test("Azure provider config names both resource and API key env vars for OpenCode", () => {
    const config = buildCloudProviderConfig({
      id: "lpr_azure",
      source: "models_dev",
      providerId: "azure",
      name: "Azure",
      providerConfig: {
        id: "azure",
        name: "Azure",
        npm: "@ai-sdk/azure",
        env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      },
      hasApiKey: true,
      models: [
        {
          id: "deployment",
          name: "deployment",
          config: {},
          createdAt: null,
        },
      ],
      createdAt: null,
      updatedAt: null,
      apiKey: null,
      apiKeys: {
        AZURE_RESOURCE_NAME: "resource-name",
        AZURE_API_KEY: "real-api-key",
      },
    });

    expect(config).toMatchObject({
      id: "azure",
      env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
    });
  });

  test("map keys outside the config env list are still applied, after env-ordered ones", () => {
    const { envEntries } = resolveCloudProviderCredentials({
      apiKey: null,
      apiKeys: { EXTRA_VAR: "x", AWS_REGION: "us-east-1" },
      providerConfig: { env: AWS_ENV },
    });
    expect(envEntries).toEqual([
      { key: "AWS_REGION", value: "us-east-1" },
      { key: "EXTRA_VAR", value: "x" },
    ]);
  });

  test("undeclared API-shaped map keys are not used as the auth credential", () => {
    const { primaryApiKey } = resolveCloudProviderCredentials({
      apiKey: null,
      apiKeys: { OPENAI_API_KEY: "unrelated-secret" },
      providerConfig: { env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
    });

    expect(primaryApiKey).toBe("");
  });

  test("no credential at all yields empty results", () => {
    expect(
      resolveCloudProviderCredentials({
        apiKey: null,
        apiKeys: null,
        providerConfig: { env: AWS_ENV },
      }),
    ).toEqual({ envEntries: [], primaryApiKey: "" });
  });

  test("whitespace credentials remain missing for automatic import status", () => {
    expect(
      resolveCloudProviderCredentials({
        apiKey: "  ",
        apiKeys: { AWS_ACCESS_KEY_ID: " " },
        providerConfig: { env: AWS_ENV },
      }),
    ).toEqual({ envEntries: [], primaryApiKey: "" });
  });
});
