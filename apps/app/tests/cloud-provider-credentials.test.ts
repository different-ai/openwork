import { describe, expect, test } from "bun:test";

import { resolveCloudProviderCredentials } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

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

  test("multi-env payloads become env entries with env[0] as the auth key", () => {
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

  test("no credential at all yields empty results", () => {
    expect(
      resolveCloudProviderCredentials({
        apiKey: null,
        apiKeys: null,
        providerConfig: { env: AWS_ENV },
      }),
    ).toEqual({ envEntries: [], primaryApiKey: "" });
  });
});
