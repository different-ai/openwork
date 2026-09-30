import { describe, expect, test } from "bun:test";
import { SUPPORTED_GATEWAY_NPM_PACKAGES as serverSupportedPackages } from "../../den-api/src/llm/inference-provider-config";

import {
  asInferenceProvider,
  buildInferenceProviderRequestBody,
  buildMigrateFromLlmProviderBody,
  getCredentialStatusLabel,
  getCredentialKindLabel,
  getOauthCallbackPath,
  getNewInferenceProviderSettings,
  getRequiredSettingKeys,
  getReusableAwsKeyProviders,
  isAmazonBedrockNpm,
  isGatewayOnlyNpm,
  isSupportedGatewayNpm,
  SUPPORTED_GATEWAY_NPM_PACKAGES,
  readInferenceProvidersFromPayload,
  supportsMemberCredentialMode,
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
  oauthClientId: "",
  oauthClientSecret: "",
  access: { allMembers: false, memberIds: ["mem_1", "mem_1"], teamIds: ["team_1"] },
};

describe("buildInferenceProviderRequestBody", () => {
  test("renames leave unchanged settings, credentials and blank map entries absent", () => {
    const body = buildInferenceProviderRequestBody({ ...baseInput, name: "Renamed", apiKey: "", settings: { project: "fixture", location: "global" }, previousSettings: { project: "fixture", location: "global" } });
    expect(body).not.toHaveProperty("credential");
    expect(body).not.toHaveProperty("apiKeys");
    expect(body).not.toHaveProperty("settings");
  });

  test("OAuth holders and server callback survive response parsing", () => {
    const provider = asInferenceProvider({ id: "ipr_fixture", providerId: "google-vertex", name: "Vertex", credentialMode: "member", status: "active", settings: { project: "fixture", location: "global" }, oauthCallbackUrl: "https://public-api.example.test/v1/inference-providers/oauth/callback", credentials: [{ subject: "mem_fixture", orgMembershipId: "mem_fixture", memberName: "Fixture Member", memberEmail: "member@example.test", kind: "oauth_google", status: "active", expiresAt: "2026-09-08T00:00:00Z" }] });
    expect(provider?.credentials).toHaveLength(1);
    expect(provider?.credentials?.[0]?.memberName).toBe("Fixture Member");
    expect(getCredentialKindLabel("oauth_google")).toBe("Google OAuth");
    expect(getCredentialKindLabel("oauth_azure")).toBe("Azure OAuth");
    expect(provider?.settings).toEqual({ project: "fixture", location: "global" });
    expect(provider?.oauthCallbackUrl).toBe("https://public-api.example.test/v1/inference-providers/oauth/callback");
  });
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

  test("google-vertex member mode sends settings and the OAuth client, never a credential", () => {
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
      oauthClientId: " 123.apps.googleusercontent.com ",
      oauthClientSecret: " GOCSPX-secret ",
      access: { allMembers: true, memberIds: ["mem_1"], teamIds: ["team_1"] },
    });
    expect(body).toEqual({
      name: "Vertex",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      credentialMode: "member",
      status: "active",
      settings: { project: "my-project", location: "us-central1" },
      oauthClientId: "123.apps.googleusercontent.com",
      oauthClientSecret: "GOCSPX-secret",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    });
    expect(body).not.toHaveProperty("credential");
    expect(body).not.toHaveProperty("apiKeys");
  });

  test("member mode with a blank secret keeps the stored one (secret omitted, id still sent)", () => {
    const body = buildInferenceProviderRequestBody({
      ...baseInput,
      providerId: "google-vertex",
      credentialMode: "member",
      oauthClientId: "123.apps.googleusercontent.com",
      oauthClientSecret: "   ",
    });
    expect(body.oauthClientId).toBe("123.apps.googleusercontent.com");
    expect(body).not.toHaveProperty("oauthClientSecret");
  });

  test("org mode never sends OAuth client fields", () => {
    const body = buildInferenceProviderRequestBody({
      ...baseInput,
      oauthClientId: "123.apps.googleusercontent.com",
      oauthClientSecret: "GOCSPX-secret",
    });
    expect(body).not.toHaveProperty("oauthClientId");
    expect(body).not.toHaveProperty("oauthClientSecret");
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

describe("new gateway provider settings", () => {
  test.each([
    ["google-vertex", "@ai-sdk/google-vertex"],
    ["google-vertex-anthropic", "@ai-sdk/google-vertex/anthropic"],
  ])("%s starts with an actual global region in the create request", (providerId, npm) => {
    const settings = getNewInferenceProviderSettings(npm);
    expect(settings).toEqual({ location: "global" });
    const body = buildInferenceProviderRequestBody({ ...baseInput, providerId, settings: { ...settings, project: "fixture" } });
    expect(body.settings).toEqual({ project: "fixture", location: "global" });
  });

  test.each([
    ["google-vertex", "@ai-sdk/google-vertex"],
    ["google-vertex-anthropic", "@ai-sdk/google-vertex/anthropic"],
  ])("%s keeps a user-entered region instead of reapplying the default", (providerId, npm) => {
    const settings = getNewInferenceProviderSettings(npm);
    settings.location = "europe-west1";
    expect(buildInferenceProviderRequestBody({ ...baseInput, providerId, settings }).settings).toEqual({ location: "europe-west1" });
    settings.location = "";
    expect(buildInferenceProviderRequestBody({ ...baseInput, providerId, settings }).settings).toEqual({});
    expect(getNewInferenceProviderSettings(npm)).toEqual({ location: "global" });
  });

  test.each(["google-vertex", "google-vertex-anthropic"])("%s preserves saved settings on edit without inserting defaults", (providerId) => {
    const savedSettings: Record<string, string>[] = [{ project: "fixture", location: "us-central1" }, { project: "fixture", location: "global" }, { project: "fixture", location: "" }, { project: "fixture" }];
    for (const settings of savedSettings) {
      const provider = asInferenceProvider({ id: "ipr_fixture", providerId, name: "Vertex", credentialMode: "org", status: "active", settings });
      if (!provider) throw new Error("Expected a saved provider");
      expect(provider.settings).toEqual(settings);
      const body = buildInferenceProviderRequestBody({ ...baseInput, providerId, settings: provider.settings, previousSettings: settings });
      expect(body).not.toHaveProperty("settings");
      expect(settings).toEqual(provider.settings);
    }
  });

  test.each([null, "@ai-sdk/google", "@ai-sdk/azure", "@ai-sdk/anthropic"])("%s does not receive a Vertex region default", (npm) => {
    expect(getNewInferenceProviderSettings(npm)).toEqual({});
  });
});

describe("Amazon Bedrock provider form", () => {
  const bedrockInput: InferenceProviderFormInput = {
    ...baseInput,
    name: "Bedrock",
    providerId: "amazon-bedrock",
    settings: { region: " us-east-1 " },
    envNames: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"],
    apiKey: "",
    awsKeys: { accessKeyId: " AKIDEXAMPLE ", secretAccessKey: " wJalrXUtnFEMI ", sessionToken: "" },
  };
  const bedrockValidation = {
    npm: "@ai-sdk/amazon-bedrock", name: "Bedrock", providerId: "amazon-bedrock", modelIds: ["m"],
    settings: { region: "eu-west-1" }, serviceAccountJson: "", credentialMode: "org" as const,
    oauthClientId: "", oauthClientSecret: "", hasOauthClientSecret: false,
    awsKeys: { accessKeyId: "", secretAccessKey: "", sessionToken: "" },
  };

  test("sends AWS keys as an aws_keys credential with the region as a setting, never as multi-env API keys", () => {
    const body = buildInferenceProviderRequestBody(bedrockInput);
    expect(body.settings).toEqual({ region: "us-east-1" });
    expect(body.apiKeys).toBeUndefined();
    expect(body.credential).toEqual({ kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI" }) });
    const withToken = buildInferenceProviderRequestBody({ ...bedrockInput, awsKeys: { accessKeyId: "a", secretAccessKey: "b", sessionToken: " tok " } });
    expect(withToken.credential).toEqual({ kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "a", secretAccessKey: "b", sessionToken: "tok" }) });
  });

  test("blank AWS keys keep the stored credential", () => {
    const body = buildInferenceProviderRequestBody({ ...bedrockInput, awsKeys: { accessKeyId: " ", secretAccessKey: "", sessionToken: "" } });
    expect(body.credential).toBeUndefined();
    expect(body.apiKeys).toBeUndefined();
  });

  test("Amazon Bedrock (OpenAI) uses the same region setting and AWS key fields, and is hidden from Bring your own keys", () => {
    expect(getRequiredSettingKeys("@ai-sdk/amazon-bedrock/mantle")).toEqual(["region"]);
    expect(isAmazonBedrockNpm("@ai-sdk/amazon-bedrock/mantle")).toBe(true);
    expect(isGatewayOnlyNpm("@ai-sdk/amazon-bedrock/mantle")).toBe(true);
    expect(isGatewayOnlyNpm("@ai-sdk/amazon-bedrock")).toBe(false);
    const mantle = { ...bedrockValidation, npm: "@ai-sdk/amazon-bedrock/mantle", providerId: "amazon-bedrock-mantle" };
    expect(validateInferenceProviderForm(mantle)).toBeNull();
    expect(validateInferenceProviderForm({ ...mantle, settings: { region: "bad" } })).toContain("AWS region code");
    const body = buildInferenceProviderRequestBody({ ...bedrockInput, providerId: "amazon-bedrock-mantle" });
    expect(body.credential?.kind).toBe("aws_keys");
  });

  test("reusing saved keys sends only the source provider id, never key material", () => {
    const body = buildInferenceProviderRequestBody({ ...bedrockInput, providerId: "amazon-bedrock-mantle", reuseCredentialFrom: "ipr_source" });
    expect(body.reuseCredentialFrom).toBe("ipr_source");
    expect(body.credential).toBeUndefined();
    expect(body.apiKeys).toBeUndefined();
    expect(buildInferenceProviderRequestBody({ ...bedrockInput, reuseCredentialFrom: null }).reuseCredentialFrom).toBeUndefined();
  });

  test("only active, ready, organization-key Bedrock providers are offered for key reuse", () => {
    const provider = (id: string, npm: string, overrides: Partial<{ status: "active" | "disabled"; credentialMode: "org" | "member"; credentialStatus: "ready" | "org_credential_missing" }> = {}) => ({
      id, name: id, status: "active" as const, credentialMode: "org" as const, credentialStatus: "ready" as const, providerConfig: { npm }, ...overrides,
    });
    expect(getReusableAwsKeyProviders([
      provider("bedrock", "@ai-sdk/amazon-bedrock"),
      provider("mantle", "@ai-sdk/amazon-bedrock/mantle"),
      provider("anthropic", "@ai-sdk/anthropic"),
      provider("disabled", "@ai-sdk/amazon-bedrock", { status: "disabled" }),
      provider("missing", "@ai-sdk/amazon-bedrock", { credentialStatus: "org_credential_missing" }),
    ])).toEqual([{ id: "bedrock", name: "bedrock" }, { id: "mantle", name: "mantle" }]);
  });

  test("validation requires a region code and complete key pairs", () => {
    expect(validateInferenceProviderForm(bedrockValidation)).toBeNull();
    expect(validateInferenceProviderForm({ ...bedrockValidation, settings: {} })).toContain("AWS region is required");
    for (const region of ["us-east", "US-EAST-1", "us-east-1.evil.test", "https://bedrock"]) {
      expect(validateInferenceProviderForm({ ...bedrockValidation, settings: { region } })).toContain("AWS region code");
    }
    expect(validateInferenceProviderForm({ ...bedrockValidation, awsKeys: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "" } })).toBeNull();
    expect(validateInferenceProviderForm({ ...bedrockValidation, awsKeys: { accessKeyId: "a", secretAccessKey: "", sessionToken: "" } })).toContain("both the AWS access key ID");
    expect(validateInferenceProviderForm({ ...bedrockValidation, awsKeys: { accessKeyId: "", secretAccessKey: "", sessionToken: "t" } })).toContain("both the AWS access key ID");
    expect(validateInferenceProviderForm({ ...bedrockValidation, credentialMode: "member" })).toContain("only available for Google Vertex");
  });
});

describe("gateway provider support + settings", () => {
  test("matches den-api's supported SDK list", () => {
    expect(SUPPORTED_GATEWAY_NPM_PACKAGES).toEqual(serverSupportedPackages);
    expect(isSupportedGatewayNpm("@ai-sdk/anthropic")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/mistral")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/cohere")).toBe(false);
    expect(isSupportedGatewayNpm("@ai-sdk/google-vertex/anthropic")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/amazon-bedrock")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/amazon-bedrock/mantle")).toBe(true);
    expect(isSupportedGatewayNpm("@ai-sdk/amazon-bedrock/unknown")).toBe(false);
    expect(isSupportedGatewayNpm(null)).toBe(false);
  });

  test("requires vertex project+location and azure resourceName", () => {
    expect(getRequiredSettingKeys("@ai-sdk/google-vertex")).toEqual(["project", "location"]);
    expect(getRequiredSettingKeys("@ai-sdk/azure")).toEqual(["resourceName"]);
    expect(getRequiredSettingKeys("@ai-sdk/amazon-bedrock")).toEqual(["region"]);
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
      credentialMode: "org" as const,
      oauthClientId: "",
      oauthClientSecret: "",
      hasOauthClientSecret: false,
    };
    expect(validateInferenceProviderForm(valid)).toBeNull();
    expect(validateInferenceProviderForm({ ...valid, npm: "@ai-sdk/mistral", providerId: "mistral", settings: {} })).toBeNull();
    expect(validateInferenceProviderForm({ ...valid, npm: "@ai-sdk/mistral", providerId: "mistral", credentialMode: "member" })).toContain("only available for Google Vertex");
    expect(validateInferenceProviderForm({ ...valid, settings: { project: "p" } })).toContain("Region is required");
    expect(validateInferenceProviderForm({ ...valid, npm: "@ai-sdk/amazon-bedrock/unknown" })).toContain("cannot be routed");
    expect(validateInferenceProviderForm({ ...valid, serviceAccountJson: "{" })).toContain("could not be parsed");
    expect(validateInferenceProviderForm({ ...valid, serviceAccountJson: '{"type":"user"}' })).toContain("service_account");
  });

  test("member mode requires a Google Vertex provider and both OAuth client fields", () => {
    const member = {
      npm: "@ai-sdk/google-vertex",
      name: "Vertex",
      providerId: "google-vertex",
      modelIds: ["m"],
      settings: { project: "p", location: "l" },
      serviceAccountJson: "",
      credentialMode: "member" as const,
      oauthClientId: "123.apps.googleusercontent.com",
      oauthClientSecret: "GOCSPX-secret",
      hasOauthClientSecret: false,
    };
    expect(validateInferenceProviderForm(member)).toBeNull();
    expect(validateInferenceProviderForm({ ...member, providerId: "google-vertex-anthropic", npm: "@ai-sdk/google-vertex/anthropic" })).toBeNull();
    expect(validateInferenceProviderForm({ ...member, oauthClientId: " " })).toContain("client ID and client secret");
    expect(validateInferenceProviderForm({ ...member, oauthClientSecret: "" })).toContain("client ID and client secret");
    // A stored secret satisfies the requirement when the field is left blank.
    expect(validateInferenceProviderForm({ ...member, oauthClientSecret: "", hasOauthClientSecret: true })).toBeNull();
    expect(validateInferenceProviderForm({ ...member, providerId: "anthropic", npm: "@ai-sdk/anthropic", settings: {} })).toContain(
      "only available for Google Vertex",
    );
    expect(supportsMemberCredentialMode("google-vertex")).toBe(true);
    expect(supportsMemberCredentialMode("google-vertex-anthropic")).toBe(true);
    expect(supportsMemberCredentialMode("anthropic")).toBe(false);
    expect(getOauthCallbackPath()).toBe("/v1/inference-providers/oauth/callback");
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
          oauthClientId: null,
          hasOauthClientSecret: false,
          credentials: [
            { subject: "org", orgMembershipId: null, memberName: null, memberEmail: null, kind: "api_key", status: "active", expiresAt: null },
          ],
        },
        { id: "broken" },
      ],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].access).toEqual({ allMembers: true, memberIds: ["mem_1"], teamIds: [] });
    expect(providers[0].credentials).toEqual([
      { subject: "org", orgMembershipId: null, memberName: null, memberEmail: null, kind: "api_key", status: "active", expiresAt: null, credentialSetId: null },
    ]);
    expect(providers[0].oauthClientId).toBeNull();
    expect(providers[0].hasOauthClientSecret).toBe(false);
    expect(providers[0].models[0].name).toBe("Claude");
  });

  test("parses the OAuth client state and member identity on credential rows", () => {
    const provider = asInferenceProvider({
      id: "infp_2",
      providerId: "google-vertex",
      name: "Vertex",
      credentialMode: "member",
      status: "active",
      oauthClientId: "123.apps.googleusercontent.com",
      hasOauthClientSecret: true,
      credentials: [
        {
          subject: "member:mem_1",
          orgMembershipId: "mem_1",
          memberName: "Ada Lovelace",
          memberEmail: "ada@example.com",
          kind: "api_key",
          status: "active",
          expiresAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    expect(provider?.oauthClientId).toBe("123.apps.googleusercontent.com");
    expect(provider?.hasOauthClientSecret).toBe(true);
    expect(provider?.credentials?.[0]).toMatchObject({
      orgMembershipId: "mem_1",
      memberName: "Ada Lovelace",
      memberEmail: "ada@example.com",
    });
  });

  test("drops rows with unknown modes or statuses", () => {
    expect(asInferenceProvider({ id: "x", providerId: "p", name: "n", credentialMode: "weird", status: "active" })).toBeNull();
  });
});
