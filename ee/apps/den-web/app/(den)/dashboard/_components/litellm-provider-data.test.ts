import assert from "node:assert/strict";
import { test } from "node:test";
import { signInBrand } from "./library-models";
import {
  EMPTY_LITELLM_ENTRA, buildLiteLlmCreateBody, buildLiteLlmEntraUpdateBody, liteLlmAccessGroupId, liteLlmAccessTitle, liteLlmCreateError, liteLlmEntraError,
  liteLlmEntraUpdateSignsPeopleOut, liteLlmModeLabel, liteLlmSpendLabel, liteLlmStatusMode, parseLiteLlmModelList, type LiteLlmCreateInput, type LiteLlmEntraInput,
} from "./litellm-provider-data";

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const entra: LiteLlmEntraInput = { tenantId: TENANT, clientId: CLIENT, clientSecret: "client-secret-fixture", scope: `api://${CLIENT}/access`, models: "gpt-fixture\nclaude-fixture" };
const everyone = { allMembers: true, memberIds: [], teamIds: [] };

function keyInput(mode: "org" | "member" | "issued"): LiteLlmCreateInput {
  return { name: "LiteLLM", baseUrl: " https://litellm.example.com ", mode, apiKey: " sk-fixture ", access: everyone, issueStrategy: "mirror", mirrorFallback: "error" };
}

test("the three key modes send exactly what they sent before Microsoft sign-in existed", () => {
  assert.deepEqual(buildLiteLlmCreateBody(keyInput("org")), { name: "LiteLLM", baseUrl: "https://litellm.example.com", mode: "org", apiKey: "sk-fixture", allMembers: true });
  assert.deepEqual(buildLiteLlmCreateBody(keyInput("member")), { name: "LiteLLM", baseUrl: "https://litellm.example.com", mode: "member", apiKey: "sk-fixture", allMembers: true });
  assert.deepEqual(buildLiteLlmCreateBody(keyInput("issued")), { name: "LiteLLM", baseUrl: "https://litellm.example.com", mode: "issued", issueStrategy: "mirror", mirrorFallback: "error", apiKey: "sk-fixture", allMembers: true });
  // Unsaved Microsoft sign-in fields never leak into a key mode's request.
  assert.deepEqual(buildLiteLlmCreateBody({ ...keyInput("member"), entra }), buildLiteLlmCreateBody(keyInput("member")));
  assert.equal(liteLlmCreateError(keyInput("org")), null);
  assert.equal(liteLlmCreateError({ ...keyInput("member"), apiKey: " " }), "Paste a LiteLLM admin key so OpenWork can read your models and teams.");
});

test("Microsoft sign-in sends the app registration, one scope and the model list, and no LiteLLM key", () => {
  const body = buildLiteLlmCreateBody({ ...keyInput("org"), mode: "entra", access: { allMembers: false, memberIds: ["om_1", "om_1"], teamIds: ["tm_1"] },
    entra: { tenantId: ` ${TENANT.toUpperCase()} `, clientId: ` ${CLIENT} `, clientSecret: " client-secret-fixture ", scope: ` api://${CLIENT}/access `, models: "gpt-fixture\n\n claude-fixture ,gpt-fixture" } });
  assert.deepEqual(body, {
    name: "LiteLLM", baseUrl: "https://litellm.example.com", mode: "entra", oauthTenantId: TENANT, oauthClientId: CLIENT, oauthClientSecret: "client-secret-fixture",
    oauthScope: `api://${CLIENT}/access`, modelIds: ["gpt-fixture", "claude-fixture"], memberIds: ["om_1"], teamIds: ["tm_1"],
  });
  assert.equal("apiKey" in body, false);
});

test("Microsoft sign-in settings are checked before they are sent", () => {
  const input = (overrides: Partial<LiteLlmEntraInput>): LiteLlmCreateInput => ({ ...keyInput("org"), mode: "entra", apiKey: "", entra: { ...entra, ...overrides } });
  assert.equal(liteLlmCreateError(input({})), null);
  assert.equal(liteLlmCreateError({ ...keyInput("org"), mode: "entra", apiKey: "" }), liteLlmEntraError(EMPTY_LITELLM_ENTRA));
  assert.match(liteLlmCreateError(input({ tenantId: "contoso.onmicrosoft.com" })) ?? "", /directory \(tenant\) ID/);
  assert.match(liteLlmCreateError(input({ clientId: " " })) ?? "", /application \(client\) ID/);
  assert.match(liteLlmCreateError(input({ clientSecret: "" })) ?? "", /client secret/);
  // Tokens LiteLLM cannot validate are refused with what to enter instead.
  for (const scope of ["User.Read", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/.default", "00000003-0000-0000-c000-000000000000/.default"]) {
    assert.match(liteLlmCreateError(input({ scope })) ?? "", /Microsoft Graph/, scope);
  }
  assert.match(liteLlmCreateError(input({ scope: "https://cognitiveservices.azure.com/.default" })) ?? "", /Azure Cognitive Services/);
  assert.match(liteLlmCreateError(input({ scope: "openid" })) ?? "", /OpenWork adds openid itself/);
  for (const scope of ["", `api://${CLIENT}`, `api://${CLIENT}/`, `api://${CLIENT}/access offline_access`]) {
    assert.notEqual(liteLlmCreateError(input({ scope })), null, scope);
  }
  for (const scope of [`api://${CLIENT}/access`, `api://${CLIENT}/.default`, "api://litellm-production/Models.Invoke", "https://contoso.onmicrosoft.com/litellm/user_impersonation"]) {
    assert.equal(liteLlmCreateError(input({ scope })), null, scope);
  }
  assert.match(liteLlmCreateError(input({ models: " \n " })) ?? "", /at least one LiteLLM model name/);
  assert.match(liteLlmCreateError(input({ models: "openai/*" })) ?? "", /not wildcards/);
  // A saved provider keeps its client secret unless a new one is typed.
  assert.equal(liteLlmEntraError({ ...entra, clientSecret: "" }, true), null);
});

test("a model list is one name per line, without blanks or repeats", () => {
  assert.deepEqual(parseLiteLlmModelList("gpt-fixture\r\n  claude-fixture \n\ngpt-fixture, sonnet-fixture"), ["gpt-fixture", "claude-fixture", "sonnet-fixture"]);
  assert.deepEqual(parseLiteLlmModelList("  "), []);
});

test("saving an edit sends only what changed, and says when it signs people out", () => {
  const saved: LiteLlmEntraInput = { ...entra, clientSecret: "" };
  assert.equal(buildLiteLlmEntraUpdateBody(saved, saved), null);
  assert.equal(buildLiteLlmEntraUpdateBody(saved, { ...saved, tenantId: TENANT.toUpperCase(), models: "gpt-fixture\nclaude-fixture\n" }), null);

  const models = buildLiteLlmEntraUpdateBody(saved, { ...saved, models: "gpt-fixture" });
  assert.deepEqual(models, { modelIds: ["gpt-fixture"] });
  assert.equal(liteLlmEntraUpdateSignsPeopleOut(models ?? {}), false);

  const secret = buildLiteLlmEntraUpdateBody(saved, { ...saved, clientSecret: " rotated-secret-fixture " });
  assert.deepEqual(secret, { oauthClientSecret: "rotated-secret-fixture" });
  assert.equal(liteLlmEntraUpdateSignsPeopleOut(secret ?? {}), true);

  const everything = buildLiteLlmEntraUpdateBody(saved, { tenantId: "99999999-2222-4333-8444-555555555555", clientId: "another-client", clientSecret: "", scope: "api://another-client/access", models: saved.models });
  assert.deepEqual(everything, { oauthTenantId: "99999999-2222-4333-8444-555555555555", oauthClientId: "another-client", oauthScope: "api://another-client/access" });
  assert.equal(liteLlmEntraUpdateSignsPeopleOut(everything ?? {}), true);
});

test("a saved provider is shown in the mode it was added with", () => {
  assert.equal(liteLlmStatusMode({ mode: "org", keySource: null }), "org");
  assert.equal(liteLlmStatusMode({ mode: "member", keySource: "personal" }), "member");
  assert.equal(liteLlmStatusMode({ mode: "member", keySource: null }), "member");
  assert.equal(liteLlmStatusMode({ mode: "member", keySource: "issued" }), "issued");
  assert.equal(liteLlmStatusMode({ mode: "member", keySource: "entra" }), "entra");

  assert.deepEqual((["org", "member", "issued", "entra"] as const).map(liteLlmModeLabel), ["One organization key", "Each person's own key", "OpenWork creates keys", "Microsoft sign-in"]);
  assert.deepEqual((["org", "member", "issued", "entra"] as const).map(liteLlmAccessTitle), ["Who can use it", "Who can connect a key", "Who gets a key", "Who can sign in"]);
  assert.equal(liteLlmSpendLabel({ spendTracking: true }), "Tracked, priced from LiteLLM");
  assert.equal(liteLlmSpendLabel({ spendTracking: false }), "Not tracked, LiteLLM budgets each key");
  assert.equal(liteLlmSpendLabel({ spendTracking: false, keySource: "personal" }), "Not tracked, LiteLLM budgets each key");
  assert.equal(liteLlmSpendLabel({ spendTracking: false, keySource: "entra" }), "Not tracked, LiteLLM budgets each person");
});

test("access to a Microsoft sign-in provider is the group that holds its model list", () => {
  const status = { mode: "member" as const, keySource: "entra" as const, issueStrategy: null, mirrorFallback: null, issuedMemberCount: 0, attentionCount: 0, attention: [], baseUrl: null, spendTracking: false,
    hasSyncKey: false, lastSyncedAt: null, lastSyncError: null, modelCount: 2, teamCount: 0, connectedMemberCount: 0 };
  const modelGroups = [{ id: "gmg_all", name: "All LiteLLM models", description: null, status: "active" as const, modelIds: ["gpt-fixture", "claude-fixture"] }];
  assert.equal(liteLlmAccessGroupId({ litellm: status, modelGroups }), "gmg_all");
});

test("the library names the account a person signs in with", () => {
  const microsoft = { providerId: "ipr_1", signInMethod: "microsoft" as const, credentialSetId: "gcs_1", providerName: "LiteLLM", name: "Microsoft sign-in", ready: false, hasAccess: true, hasCredential: false,
    configurationRequired: false, authorizationRevision: null, accountEmail: null };
  assert.equal(signInBrand({ providerKey: "litellm", memberSets: [microsoft] }), "Microsoft");
  assert.equal(signInBrand({ providerKey: "litellm", memberSets: [] }), "your account");
  assert.equal(signInBrand({ providerKey: "litellm" }), "your account");
  // Providers with one sign-in are named by the provider, as before.
  assert.equal(signInBrand({ providerKey: "google-vertex", memberSets: [microsoft] }), "Google");
  assert.equal(signInBrand({ providerKey: "amazon-bedrock" }), "AWS");
  assert.equal(signInBrand({ providerKey: "microsoft-foundry" }), "Microsoft");
});
