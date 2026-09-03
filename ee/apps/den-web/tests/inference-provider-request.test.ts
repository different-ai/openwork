import { describe, expect, test } from "bun:test";

import {
  asInferenceProvider,
  buildInferenceProviderRequestBody,
  buildMigrateFromLlmProviderBody,
  getCredentialStatusLabel,
  getRequiredSettingKeys,
  isSupportedGatewayNpm,
  readInferenceProvidersFromPayload,
  validateInferenceProviderForm,
  type InferenceProviderFormInput,
} from "../app/(den)/dashboard/_components/inference-provider-request";

const baseInput: InferenceProviderFormInput = {
  name: " Anthropic ",
  providerId: "anthropic",
  modelIds: ["claude-sonnet-4", "claude-sonnet-4"],
  credentialMode: "org",
  status: "active",
  settings: {},
  envNames: ["ANTHROPIC_API_KEY"],
  apiKey: " sk-ant-123 ",
  apiKeyValues: {},
  serviceAccountJson: "",
  access: { allMembers: false, memberIds: ["mem_1", "mem_1"], teamIds: ["team_1"] },
};

describe("buildInferenceProviderRequestBody", () => {
  test("anthropic org api key posts a raw api_key credential and deduped ids", () => {
    expect(buildInferenceProviderRequestBody(baseInput)).toEqual({
      name: "Anthropic",
      providerId: "anthropic",
      modelIds: ["claude-sonnet-4"],
      credentialMode: "org",
      status: "active",
      settings: {},
      credential: { kind: "api_key", secret: "sk-ant-123" },
      allMembers: false,
      memberIds: ["mem_1"],
      teamIds: ["team_1"],
    });
  });

  test("google-vertex member mode sends settings and never a credential", () => {
    const body = buildInferenceProviderRequestBody({
      ...baseInput,
      name: "Vertex",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      credentialMode: "member",
      settings: { project: " my-project ", location: "us-central1" },
      envNames: ["GOOGLE_APPLICATION_CREDENTIALS"],
      apiKey: "should-be-ignored",
      serviceAccountJson: '{"type":"service_account"}',
      access: { allMembers: true, memberIds: ["mem_1"], teamIds: ["team_1"] },
    });
    expect(body).toEqual({
      name: "Vertex",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      credentialMode: "member",
      status: "active",
      settings: { project: "my-project", location: "us-central1" },
      allMembers: true,
      memberIds: [],
      teamIds: [],
    });
    expect(body).not.toHaveProperty("credential");
    expect(body).not.toHaveProperty("apiKeys");
  });

  test("google-vertex org mode sends the service account JSON as a gcp_service_account credential", () => {
    const json = '{"type":"service_account","project_id":"p"}';
    const body = buildInferenceProviderRequestBody({
      ...baseInput,
      providerId: "google-vertex",
      settings: { project: "p", location: "europe-west1" },
      apiKey: "",
      serviceAccountJson: `  ${json}\n`,
    });
    expect(body.credential).toEqual({ kind: "gcp_service_account", secret: json });
    expect(body).not.toHaveProperty("apiKeys");
  });

  test("multi-env providers send apiKeys like the BYOK editor and skip blanks", () => {
    const body = buildInferenceProviderRequestBody({
      ...baseInput,
      providerId: "azure",
      envNames: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      apiKey: "",
      apiKeyValues: { AZURE_RESOURCE_NAME: "", AZURE_API_KEY: " key " },
      settings: { resourceName: "my-resource" },
    });
    expect(body.apiKeys).toEqual({ AZURE_API_KEY: "key" });
    expect(body).not.toHaveProperty("credential");
  });

  test("blank credential fields keep the stored credential (no credential/apiKeys in PATCH)", () => {
    const body = buildInferenceProviderRequestBody({ ...baseInput, apiKey: "   " });
    expect(body).not.toHaveProperty("credential");
    expect(body).not.toHaveProperty("apiKeys");
  });
});

describe("buildMigrateFromLlmProviderBody", () => {
  test("posts the llmProviderId", () => {
    expect(buildMigrateFromLlmProviderBody("llmp_123")).toEqual({ llmProviderId: "llmp_123" });
  });
});

describe("gateway provider support + settings", () => {
  test("matches den-api's supported SDK list", () => {
    expect(isSupportedGatewayNpm("@ai-sdk/anthropic")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/google-vertex/anthropic")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/amazon-bedrock")).toBe(false);
    expect(isSupportedGatewayNpm(null)).toBe(false);
  });

  test("requires vertex project+location and azure resourceName", () => {
    expect(getRequiredSettingKeys("@ai-sdk/google-vertex")).toEqual(["project", "location"]);
    expect(getRequiredSettingKeys("@ai-sdk/azure")).toEqual(["resourceName"]);
    expect(getRequiredSettingKeys("@ai-sdk/openai")).toEqual([]);
  });

  test("validation rejects unsupported providers and missing settings", () => {
    const valid = {
      npm: "@ai-sdk/google-vertex",
      name: "Vertex",
      providerId: "google-vertex",
      modelIds: ["m"],
      settings: { project: "p", location: "l" },
      serviceAccountJson: "",
    };
    expect(validateInferenceProviderForm(valid)).toBeNull();
    expect(validateInferenceProviderForm({ ...valid, settings: { project: "p" } })).toContain("Region is required");
    expect(validateInferenceProviderForm({ ...valid, npm: "@ai-sdk/amazon-bedrock" })).toContain("cannot be routed");
    expect(validateInferenceProviderForm({ ...valid, serviceAccountJson: "{" })).toContain("could not be parsed");
    expect(validateInferenceProviderForm({ ...valid, serviceAccountJson: '{"type":"user"}' })).toContain("service_account");
  });
});

describe("credential status labels", () => {
  test("maps api statuses to admin-friendly labels", () => {
    expect(getCredentialStatusLabel({ credentialMode: "org", credentialStatus: "ready" })).toBe("Ready");
    expect(getCredentialStatusLabel({ credentialMode: "org", credentialStatus: "org_credential_missing" })).toBe(
      "Org credential missing",
    );
    expect(getCredentialStatusLabel({ credentialMode: "member", credentialStatus: "member_auth_required" })).toBe(
      "Members authorize individually",
    );
  });
});

describe("response parsing", () => {
  test("parses the manageable list shape including access and credentials", () => {
    const providers = readInferenceProvidersFromPayload({
      inferenceProviders: [
        {
          id: "infp_1",
          providerId: "anthropic",
          name: "Anthropic",
          source: "openwork_gateway",
          credentialMode: "org",
          status: "active",
          updatedAt: "2026-09-01T00:00:00.000Z",
          providerConfig: { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
          settings: "{}",
          models: [{ id: "claude", name: "Claude", config: {} }],
          credentialStatus: "ready",
          authUrl: null,
          access: { allMembers: true, memberIds: ["mem_1"], teamIds: [] },
          credentials: [{ subject: "org", kind: "api_key", status: "active", expiresAt: null }],
        },
        { id: "broken" },
      ],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].access).toEqual({ allMembers: true, memberIds: ["mem_1"], teamIds: [] });
    expect(providers[0].credentials).toEqual([{ subject: "org", kind: "api_key", status: "active", expiresAt: null }]);
    expect(providers[0].models[0].name).toBe("Claude");
  });

  test("drops rows with unknown modes or statuses", () => {
    expect(asInferenceProvider({ id: "x", providerId: "p", name: "n", credentialMode: "weird", status: "active" })).toBeNull();
  });
});
