import { expect, test } from "vitest";
import { withProviderSettingsFromEnv } from "../../apps/server/src/provider-settings-from-env.ts";

test("Bedrock: LPR_*_AWS_REGION → options.region", () => {
  expect(
    withProviderSettingsFromEnv(
      { npm: "@ai-sdk/amazon-bedrock", options: {} },
      [{ key: "LPR_NCEED_AWS_REGION", value: "us-east-1" }],
    ),
  ).toMatchObject({ options: { region: "us-east-1" } });
});

test("Bedrock Mantle: same", () => {
  expect(
    withProviderSettingsFromEnv(
      { npm: "@ai-sdk/amazon-bedrock/mantle", options: {} },
      [{ key: "LPR_ABCDE_AWS_REGION", value: "eu-west-1" }],
    ),
  ).toMatchObject({ options: { region: "eu-west-1" } });
});

test("Bedrock: invalid region ignored", () => {
  expect(
    withProviderSettingsFromEnv(
      { npm: "@ai-sdk/amazon-bedrock", options: {} },
      [{ key: "LPR_NCEED_AWS_REGION", value: "not-a-region" }],
    ),
  ).toEqual({ npm: "@ai-sdk/amazon-bedrock", options: {} });
});

test("Azure: namespaced resource name → options.resourceName", () => {
  expect(
    withProviderSettingsFromEnv(
      { npm: "@ai-sdk/azure", options: {} },
      [{ key: "LPR_ZZZZZ_AZURE_RESOURCE_NAME", value: "my-aoai" }],
    ),
  ).toMatchObject({ options: { resourceName: "my-aoai" } });
});

test("non-AWS npm unchanged", () => {
  const before = { npm: "@ai-sdk/openai", options: { baseURL: "https://example.com" } };
  expect(
    withProviderSettingsFromEnv(before, [{ key: "LPR_NCEED_AWS_REGION", value: "us-east-1" }]),
  ).toEqual(before);
});
