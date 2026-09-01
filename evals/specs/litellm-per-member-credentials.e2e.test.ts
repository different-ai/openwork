import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  liteLlm,
  inviteMember,
  needs,
  server,
  SkipError,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const ORGANIZATION_NAME = "LiteLLM Per-Member Credentials";
const PROVIDER_NAME = "Per-Member LiteLLM Gateway";
const PROVIDER_KEY = "openwork-litellm-per-member";
const PROVIDER_ENV = "LITELLM_PER_MEMBER_API_KEY";
const MODEL_ID = "openwork-litellm-per-member-model";
const MODEL_NAME = "Per-Member Witness Model";
const REPLY = "The per-member LiteLLM credential is valid.";
const REQUEST_TIMEOUT_MS = 30_000;
const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["docker"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `LiteLLM per-member credential proof skipped — needs: ${missingRequirements.join(", ")}`
  : "a third-party provisioner reconciles and offboards per-member LiteLLM keys";

interface ProvisionerConfig {
  denApiUrl: string;
  denToken: string;
  orgId: string;
  providerId: string;
  liteLlmBaseUrl: string;
  liteLlmMasterKey: string;
  models: string[];
  dryRun?: boolean;
  keyDuration?: string;
  renewBeforeSeconds?: number;
}

interface ProvisionerModule {
  syncProviderModelMetadata(input: ProvisionerConfig): Promise<ModelMetadataResult>;
  reconcileMemberKeys(input: ProvisionerConfig): Promise<ReconcileResult>;
  offboardMember(input: ProvisionerConfig & { orgMembershipId: string }): Promise<unknown>;
  markStale(input: ProvisionerConfig & { orgMembershipId: string }): Promise<unknown>;
}

interface ModelMetadataResult {
  action: "unchanged" | "updated" | "planned";
  models: Array<{ id: string; maxInputTokens: number; maxOutputTokens: number }>;
}

interface ReconcileResult {
  modelMetadata: ModelMetadataResult;
  memberCredentials: MemberCredentialAction[];
  failures: number;
  planned: number;
  writes: { den: number; liteLlm: number };
}

interface MemberCredentialAction {
  orgMembershipId: string;
  action: string;
  outcome: string;
  externalCredentialId?: string;
  detail?: string;
}

interface UpstreamKey {
  key: string;
  tokenId: string;
}

interface LiveModelMetadata {
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: Record<string, boolean>;
}

interface ChatResult {
  status: number;
  reply: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvisionerModule(value: unknown): value is ProvisionerModule {
  return isRecord(value)
    && typeof value.syncProviderModelMetadata === "function"
    && typeof value.reconcileMemberKeys === "function"
    && typeof value.offboardMember === "function"
    && typeof value.markStale === "function";
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function memberIdByEmail(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding member ${email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function createProvider(admin: DenSession, orgId: string, baseUrl: string): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: [PROVIDER_ENV],
        api: baseUrl,
        models: [{
          id: MODEL_ID,
          name: MODEL_NAME,
          family: "preserved-witness-family",
          limit: { context: 32_000, input: 32_000, output: 32_000 },
        }],
      },
      credentialMode: "per_member",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating the per-member provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function connect(session: DenSession, orgId: string, providerId: string) {
  return denFetch(session, `/v1/llm-providers/${encodeURIComponent(providerId)}/connect`, {
    headers: orgHeaders(session, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function connectKey(value: unknown): string {
  const provider = isRecord(value) && isRecord(value.llmProvider) ? value.llmProvider : null;
  if (!provider || typeof provider.apiKey !== "string" || !provider.apiKey) {
    throw new Error("Provider connect response did not include an apiKey.");
  }
  return provider.apiKey;
}

function connectCredentialState(value: unknown): string {
  const provider = isRecord(value) && isRecord(value.llmProvider) ? value.llmProvider : null;
  const memberCredential = provider && isRecord(provider.memberCredential) ? provider.memberCredential : null;
  if (!memberCredential || typeof memberCredential.state !== "string") {
    throw new Error("Provider connect response did not include memberCredential.state.");
  }
  return memberCredential.state;
}

function memberCredentials(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.memberCredentials)) {
    throw new Error("Member credential response had an invalid shape.");
  }
  return value.memberCredentials.filter(isRecord);
}

async function listedMemberCredentials(
  admin: DenSession,
  orgId: string,
  providerId: string,
): Promise<Record<string, unknown>[]> {
  const result = await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials`, {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`Listing member credentials failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return memberCredentials(result.body);
}

function liteLlmAdminUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function upstreamKeys(baseUrl: string, apiKey: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${liteLlmAdminUrl(baseUrl)}/key/list?return_full_object=true&size=100`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json();
  const keys = isRecord(body) && Array.isArray(body.keys) ? body.keys.filter(isRecord) : [];
  if (!response.ok) throw new Error(`Listing LiteLLM keys failed with HTTP ${response.status}.`);
  return keys;
}

function upstreamKeyId(value: Record<string, unknown>): string {
  if (typeof value.token !== "string" || !value.token) throw new Error("LiteLLM key list entry did not include token.");
  return value.token;
}

async function generateUpstreamKey(
  baseUrl: string,
  apiKey: string,
  input: { alias: string; orgMembershipId: string; email: string; duration?: string },
): Promise<UpstreamKey> {
  const response = await fetch(`${liteLlmAdminUrl(baseUrl)}/key/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      models: [MODEL_ID],
      key_alias: input.alias,
      metadata: { openwork_org_membership_id: input.orgMembershipId, email: input.email },
      ...(input.duration ? { duration: input.duration } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json();
  if (!response.ok
    || !isRecord(body)
    || typeof body.key !== "string"
    || typeof body.token_id !== "string") {
    throw new Error(`Generating a LiteLLM key failed with HTTP ${response.status}.`);
  }
  return { key: body.key, tokenId: body.token_id };
}

async function upstreamKeyInfo(baseUrl: string, apiKey: string, tokenId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${liteLlmAdminUrl(baseUrl)}/key/info?key=${encodeURIComponent(tokenId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || !isRecord(body.info)) {
    throw new Error(`Reading LiteLLM key info failed with HTTP ${response.status}.`);
  }
  return body.info;
}

async function deleteUpstreamKey(baseUrl: string, apiKey: string, tokenId: string): Promise<void> {
  const response = await fetch(`${liteLlmAdminUrl(baseUrl)}/key/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ keys: [tokenId] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Deleting a LiteLLM key failed with HTTP ${response.status}.`);
}

async function setProviderMemberAccess(
  admin: DenSession,
  orgId: string,
  providerId: string,
  memberIds: string[],
): Promise<void> {
  const provider = await manageableProvider(admin, orgId, providerId);
  if (typeof provider.name !== "string" || !isRecord(provider.providerConfig) || !Array.isArray(provider.models)) {
    throw new Error("Manageable provider did not include the fields needed for access replacement.");
  }
  const models = provider.models.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.config)) throw new Error("Manageable provider included an invalid model.");
    return entry.config;
  });
  const result = await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: provider.name,
      source: "custom",
      customConfig: { ...provider.providerConfig, models },
      credentialMode: "per_member",
      allMembers: false,
      memberIds,
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`Replacing provider access failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function runProvisionerCli(
  args: string[],
  config: ProvisionerConfig,
): Promise<{ stdout: string; stderr: string }> {
  const provisionerPath = fileURLToPath(new URL(
    "../../examples/litellm-per-member-keys/provision.mjs",
    import.meta.url,
  ));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [provisionerPath, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        OPENWORK_DEN_API_URL: config.denApiUrl,
        OPENWORK_DEN_TOKEN: config.denToken,
        OPENWORK_ORG_ID: config.orgId,
        OPENWORK_LLM_PROVIDER_ID: config.providerId,
        LITELLM_BASE_URL: config.liteLlmBaseUrl,
        LITELLM_MASTER_KEY: config.liteLlmMasterKey,
        LITELLM_MODELS: config.models.join(","),
        OPENWORK_DRY_RUN: "",
        OPENWORK_KEY_DURATION: "",
        OPENWORK_RENEW_BEFORE_SECONDS: "",
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Provisioner CLI failed: ${error.message}\n${stderr.slice(0, 1_000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function structuredLines(stdout: string): Record<string, unknown>[] {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) throw new Error("Provisioner emitted a non-object JSON line.");
    return value;
  });
}

async function manageableProvider(admin: DenSession, orgId: string, providerId: string): Promise<Record<string, unknown>> {
  const result = await denFetch(admin, "/v1/llm-providers?scope=manageable", {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const providers = isRecord(result.body) && Array.isArray(result.body.llmProviders)
    ? result.body.llmProviders.filter(isRecord)
    : [];
  const provider = providers.find((entry) => entry.id === providerId);
  if (!result.response.ok || !provider) {
    throw new Error(`Finding manageable provider ${providerId} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return provider;
}

function providerModelConfig(provider: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const models = Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const model = models.find((entry) => entry.id === modelId);
  if (!model || !isRecord(model.config)) throw new Error(`Manageable provider did not include model config ${modelId}.`);
  return model.config;
}

async function liveModelMetadata(baseUrl: string, apiKey: string): Promise<LiveModelMetadata> {
  const adminBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetch(`${adminBaseUrl}/model_group/info`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json();
  const entries = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  const metadata = entries.find((entry) => entry.model_group === MODEL_ID);
  if (!response.ok
    || !metadata
    || typeof metadata.max_input_tokens !== "number"
    || typeof metadata.max_output_tokens !== "number") {
    throw new Error(`LiteLLM model-group metadata was unavailable for ${MODEL_ID}: HTTP ${response.status}.`);
  }
  const capabilities: Record<string, boolean> = {};
  if (typeof metadata.supports_function_calling === "boolean") capabilities.tool_call = metadata.supports_function_calling;
  if (typeof metadata.supports_reasoning === "boolean") capabilities.reasoning = metadata.supports_reasoning;
  if (typeof metadata.supports_vision === "boolean") capabilities.attachment = metadata.supports_vision;
  if (typeof metadata.supports_response_schema === "boolean") capabilities.structured_output = metadata.supports_response_schema;
  if (Array.isArray(metadata.supported_openai_params)) {
    capabilities.temperature = metadata.supported_openai_params.includes("temperature");
  }
  return {
    maxInputTokens: metadata.max_input_tokens,
    maxOutputTokens: metadata.max_output_tokens,
    capabilities,
  };
}

async function chat(baseUrl: string, apiKey: string): Promise<ChatResult> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: "user", content: "Confirm the deterministic per-member route." }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices.filter(isRecord) : [];
  const message = choices[0] && isRecord(choices[0].message) ? choices[0].message : null;
  return {
    status: response.status,
    reply: message && typeof message.content === "string" ? message.content : "",
  };
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("The LiteLLM per-member credential proof requires a cold managed Den");
  }

  await using gateway = await liteLlm({ place, modelId: MODEL_ID, reply: REPLY, database: true });
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Credential Admin" },
      members: {
        alice: { name: "Alice Credential Member" },
        bob: { name: "Bob Credential Member" },
      },
    },
  });
  const alice = den.members.alice;
  const bob = den.members.bob;
  if (!alice || !bob) throw new Error("The cold managed Den did not provision both members.");
  const orgId = await organizationId(den.admin);
  const [adminMemberId, aliceMemberId, bobMemberId] = await Promise.all([
    memberIdByEmail(den.admin, orgId, den.admin.email),
    memberIdByEmail(den.admin, orgId, alice.email),
    memberIdByEmail(den.admin, orgId, bob.email),
  ]);
  const providerId = await createProvider(den.admin, orgId, gateway.baseUrl);

  const aliceMissing = await connect(alice, orgId, providerId);
  expect(aliceMissing.response.status).toBe(200);
  expect(aliceMissing.body).toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "missing" } },
  });
  evidence.recordAssertionEvidence(
    "A granted member without a binding receives a compatible missing-credential payload",
    "Alice's connect request returned HTTP 200 with null credentials and memberCredential.state=missing.",
    aliceMissing.response.status === 200
      && isRecord(aliceMissing.body)
      && isRecord(aliceMissing.body.llmProvider)
      && aliceMissing.body.llmProvider.apiKey === null
      && aliceMissing.body.llmProvider.apiKeys === null
      && isRecord(aliceMissing.body.llmProvider.memberCredential)
      && aliceMissing.body.llmProvider.memberCredential.state === "missing",
  );

  const imported: unknown = await import(new URL(
    "../../examples/litellm-per-member-keys/provision.mjs",
    import.meta.url,
  ).href);
  if (!isProvisionerModule(imported)) throw new Error("The example provisioner did not export the expected functions.");
  const provisionerConfig: ProvisionerConfig = {
    denApiUrl: den.ref.apiUrl,
    denToken: den.admin.token,
    orgId,
    providerId,
    liteLlmBaseUrl: gateway.baseUrl,
    liteLlmMasterKey: gateway.apiKey,
    models: [MODEL_ID],
  };
  const gatewayMetadata = await liveModelMetadata(gateway.baseUrl, gateway.apiKey);
  expect(gatewayMetadata).toEqual({
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {
      tool_call: true,
      reasoning: false,
      attachment: true,
      temperature: true,
    },
  });
  const reconcileSummary = await imported.reconcileMemberKeys(provisionerConfig);
  expect(reconcileSummary.modelMetadata).toEqual({
    action: "updated",
    models: [{ id: MODEL_ID, maxInputTokens: 128_000, maxOutputTokens: 16_384 }],
  });
  expect(reconcileSummary.memberCredentials.length).toBeGreaterThanOrEqual(2);

  const syncedProvider = await manageableProvider(den.admin, orgId, providerId);
  const syncedModel = providerModelConfig(syncedProvider, MODEL_ID);
  expect(syncedModel).toMatchObject({
    family: "preserved-witness-family",
    limit: { context: 128_000, input: 128_000, output: 16_384 },
    ...gatewayMetadata.capabilities,
  });
  expect(syncedProvider.access).toMatchObject({ allMembers: true });
  const syncedLimit = isRecord(syncedModel.limit) ? syncedModel.limit : null;
  const metadataCameFromGateway = syncedLimit?.context === gatewayMetadata.maxInputTokens
    && syncedLimit.input === gatewayMetadata.maxInputTokens
    && syncedLimit.output === gatewayMetadata.maxOutputTokens
    && Object.entries(gatewayMetadata.capabilities).every(([key, value]) => syncedModel[key] === value)
    && syncedModel.family === "preserved-witness-family";
  expect(metadataCameFromGateway).toBe(true);
  evidence.recordAssertionEvidence(
    "The provisioner synchronizes model limits and capabilities from the live LiteLLM gateway without dropping existing model fields or access",
    "LiteLLM /model_group/info reported 128000 input and 16384 output tokens plus capability facts; Den replaced the intentionally wrong 32000 limits with those exact values, preserved the witness family, and retained all-member access.",
    metadataCameFromGateway
      && isRecord(syncedProvider.access)
      && syncedProvider.access.allMembers === true,
  );

  const secondReconcile = await imported.reconcileMemberKeys(provisionerConfig);
  expect(secondReconcile.modelMetadata).toEqual({
    action: "unchanged",
    models: [{ id: MODEL_ID, maxInputTokens: 128_000, maxOutputTokens: 16_384 }],
  });
  expect(secondReconcile.memberCredentials).toEqual([]);
  evidence.recordAssertionEvidence(
    "Repeated reconciliation does not rewrite model metadata that is already synchronized",
    "The second real provisioner run returned modelMetadata.action=unchanged and provisioned no additional member credentials.",
    secondReconcile.modelMetadata.action === "unchanged"
      && secondReconcile.memberCredentials.length === 0,
  );

  const [aliceConnect, bobConnect] = await Promise.all([
    connect(alice, orgId, providerId),
    connect(bob, orgId, providerId),
  ]);
  expect(aliceConnect.response.status).toBe(200);
  expect(bobConnect.response.status).toBe(200);
  expect(connectCredentialState(aliceConnect.body)).toBe("active");
  expect(connectCredentialState(bobConnect.body)).toBe("active");
  const aliceKey = connectKey(aliceConnect.body);
  const bobKey = connectKey(bobConnect.body);
  expect(aliceKey).toMatch(/^sk-/);
  expect(bobKey).toMatch(/^sk-/);
  expect(aliceKey).not.toBe(gateway.apiKey);
  expect(bobKey).not.toBe(gateway.apiKey);
  expect(aliceKey).not.toBe(bobKey);

  const listed = await denFetch(den.admin, `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials`, {
    headers: orgHeaders(den.admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(listed.response.status).toBe(200);
  expect(listed.text).not.toContain(aliceKey);
  expect(listed.text).not.toContain(bobKey);
  const credentials = memberCredentials(listed.body);
  const aliceBinding = credentials.find((entry) => entry.orgMembershipId === aliceMemberId);
  const bobBinding = credentials.find((entry) => entry.orgMembershipId === bobMemberId);
  const bindingsActive = aliceBinding?.state === "active"
    && typeof aliceBinding.externalCredentialId === "string"
    && aliceBinding.externalCredentialId.length > 0
    && bobBinding?.state === "active"
    && typeof bobBinding.externalCredentialId === "string"
    && bobBinding.externalCredentialId.length > 0;
  expect(bindingsActive).toBe(true);
  evidence.recordAssertionEvidence(
    "The provisioner creates distinct write-only LiteLLM bindings for granted members",
    "Alice and Bob received distinct sk- virtual keys; the admin list showed active external credential ids and contained neither key.",
    bindingsActive
      && aliceKey.startsWith("sk-")
      && bobKey.startsWith("sk-")
      && aliceKey !== bobKey
      && aliceKey !== gateway.apiKey
      && bobKey !== gateway.apiKey
      && !listed.text.includes(aliceKey)
      && !listed.text.includes(bobKey),
  );

  const aliceCheckpoint = await gateway.checkpoint();
  const aliceChat = await chat(gateway.baseUrl, aliceKey);
  expect(aliceChat.status).toBe(200);
  expect(aliceChat.reply).toContain(REPLY);
  const aliceUpstream = await gateway.waitForUpstreamRequest({
    after: aliceCheckpoint,
    model: MODEL_ID,
    key: gateway.upstreamKey,
    timeoutMs: 120_000,
  });
  const aliceUpstreamRequests = await gateway.upstreamRequests({ after: aliceCheckpoint });
  const aliceKeyReachedUpstream = aliceUpstreamRequests.some((request) => request.tokenId === gateway.tokenId(aliceKey));
  const masterKeyReachedUpstream = aliceUpstreamRequests.some((request) => request.tokenId === gateway.tokenId(gateway.apiKey));
  expect(aliceUpstream.tokenId).toBe(gateway.tokenId(gateway.upstreamKey));
  expect(aliceKeyReachedUpstream).toBe(false);
  expect(masterKeyReachedUpstream).toBe(false);
  evidence.recordAssertionEvidence(
    "LiteLLM validates a database-backed member key and rewrites it for the upstream",
    `Alice received the deterministic reply and upstream sequence ${aliceUpstream.sequence} carried only the configured upstream token fingerprint.`,
    aliceChat.status === 200
      && aliceChat.reply.includes(REPLY)
      && aliceUpstream.tokenId === gateway.tokenId(gateway.upstreamKey)
      && !aliceKeyReachedUpstream
      && !masterKeyReachedUpstream,
  );

  await imported.offboardMember({ ...provisionerConfig, orgMembershipId: bobMemberId });
  const bobRejected = await chat(gateway.baseUrl, bobKey);
  expect(bobRejected.status).not.toBe(200);
  const bobBlocked = await connect(bob, orgId, providerId);
  expect(bobBlocked.response.status).toBe(200);
  expect(bobBlocked.body).toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "blocked" } },
  });
  const bobSelfWrite = await denFetch(bob, `/v1/llm-providers/${encodeURIComponent(providerId)}/my-credential`, {
    method: "PUT",
    headers: orgHeaders(bob, orgId),
    body: JSON.stringify({ apiKey: "sk-member-cannot-unblock" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(bobSelfWrite.response.status).toBe(409);
  expect(bobSelfWrite.body).toEqual({ error: "credential_blocked" });
  const aliceStillWorks = await chat(gateway.baseUrl, aliceKey);
  expect(aliceStillWorks.status).toBe(200);
  expect(aliceStillWorks.reply).toContain(REPLY);
  evidence.recordAssertionEvidence(
    "Offboarding revokes only the selected upstream key and leaves the block admin-owned",
    "Bob's LiteLLM key was rejected, Den returned a blocked credential state, Bob could not self-unblock, and Alice's key still received the deterministic reply.",
    bobRejected.status !== 200
      && bobBlocked.response.status === 200
      && connectCredentialState(bobBlocked.body) === "blocked"
      && bobSelfWrite.response.status === 409
      && isRecord(bobSelfWrite.body)
      && bobSelfWrite.body.error === "credential_blocked"
      && aliceStillWorks.status === 200
      && aliceStillWorks.reply.includes(REPLY),
  );

  const charlie = await inviteMember(den, "charlie", {
    email: `charlie-lifecycle-${Date.now()}@openwork.test`,
    name: "Charlie Credential Member",
    password: "OpenWorkEval123!",
  });
  const charlieMemberId = await memberIdByEmail(den.admin, orgId, charlie.email);
  const credentialsBeforeDryRun = await listedMemberCredentials(den.admin, orgId, providerId);
  const keysBeforeDryRun = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const dryRun = await runProvisionerCli(["reconcile", "--dry-run"], provisionerConfig);
  const dryRunLines = structuredLines(dryRun.stdout);
  const credentialsAfterDryRun = await listedMemberCredentials(den.admin, orgId, providerId);
  const keysAfterDryRun = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const dryRunSummary = dryRunLines.find((line) => line.action === "reconcile.summary");
  expect(dryRun.stderr).toBe("");
  expect(credentialsAfterDryRun).toEqual(credentialsBeforeDryRun);
  expect(keysAfterDryRun.map(upstreamKeyId).sort()).toEqual(keysBeforeDryRun.map(upstreamKeyId).sort());
  expect(dryRunLines).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "member.provision", orgMembershipId: charlieMemberId, outcome: "planned" }),
  ]));
  expect(dryRunSummary).toMatchObject({ outcome: "planned" });
  expect(dryRunSummary?.detail).toContain("denWrites=0 liteLlmWrites=0");
  expect(dryRun.stdout).not.toContain(provisionerConfig.denToken);
  expect(dryRun.stdout).not.toContain(provisionerConfig.liteLlmMasterKey);
  evidence.recordAssertionEvidence(
    "Dry-run computes a missing-member plan without writing to Den or LiteLLM",
    "The CLI emitted JSON plan lines for Charlie, while the complete Den binding list and LiteLLM key identifiers stayed byte-for-byte equivalent and neither admin secret appeared in output.",
    JSON.stringify(credentialsAfterDryRun) === JSON.stringify(credentialsBeforeDryRun)
      && keysAfterDryRun.map(upstreamKeyId).sort().join(",") === keysBeforeDryRun.map(upstreamKeyId).sort().join(",")
      && dryRunLines.some((line) => line.action === "member.provision" && line.orgMembershipId === charlieMemberId && line.outcome === "planned")
      && dryRunSummary?.outcome === "planned"
      && typeof dryRunSummary.detail === "string"
      && dryRunSummary.detail.includes("denWrites=0 liteLlmWrites=0")
      && !dryRun.stdout.includes(provisionerConfig.denToken)
      && !dryRun.stdout.includes(provisionerConfig.liteLlmMasterKey),
  );

  const preexistingCharlieKey = await generateUpstreamKey(gateway.baseUrl, gateway.apiKey, {
    alias: `openwork-${charlieMemberId}`,
    orgMembershipId: charlieMemberId,
    email: charlie.email,
  });
  const keysBeforeAdoption = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const adoption = await imported.reconcileMemberKeys(provisionerConfig);
  const credentialsAfterAdoption = await listedMemberCredentials(den.admin, orgId, providerId);
  const charlieBinding = credentialsAfterAdoption.find((entry) => entry.orgMembershipId === charlieMemberId);
  const adoptedCredentialId = typeof charlieBinding?.externalCredentialId === "string"
    ? charlieBinding.externalCredentialId
    : "";
  const keysAfterAdoption = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const adoptedUpstream = keysAfterAdoption.find((entry) => upstreamKeyId(entry) === adoptedCredentialId);
  expect(adoption.failures).toBe(0);
  expect(adoption.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: charlieMemberId, action: "adopted", outcome: "succeeded" }),
  ]));
  expect(charlieBinding?.state).toBe("active");
  expect(adoptedCredentialId).not.toBe("");
  expect(adoptedCredentialId).not.toBe(preexistingCharlieKey.tokenId);
  expect(keysAfterAdoption).toHaveLength(keysBeforeAdoption.length);
  expect(keysAfterAdoption.some((entry) => upstreamKeyId(entry) === preexistingCharlieKey.tokenId)).toBe(false);
  expect(adoptedUpstream?.key_alias).toBe(`openwork-${charlieMemberId}`);
  evidence.recordAssertionEvidence(
    "A pre-existing LiteLLM identity is adopted without leaving a second upstream key",
    "LiteLLM Community could not return Charlie's plaintext key, so reconciliation alias-swapped one replacement into Den, deleted the old hash, retained the stable alias, and left the total key count unchanged.",
    charlieBinding?.state === "active"
      && adoptedCredentialId.length > 0
      && adoptedCredentialId !== preexistingCharlieKey.tokenId
      && keysAfterAdoption.length === keysBeforeAdoption.length
      && !keysAfterAdoption.some((entry) => upstreamKeyId(entry) === preexistingCharlieKey.tokenId)
      && adoptedUpstream?.key_alias === `openwork-${charlieMemberId}`,
  );

  const credentialsBeforeIdempotence = await listedMemberCredentials(den.admin, orgId, providerId);
  const keysBeforeIdempotence = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const adoptionIdempotence = await imported.reconcileMemberKeys(provisionerConfig);
  const credentialsAfterIdempotence = await listedMemberCredentials(den.admin, orgId, providerId);
  const keysAfterIdempotence = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  expect(adoptionIdempotence.failures).toBe(0);
  expect(adoptionIdempotence.memberCredentials).toEqual([]);
  expect(adoptionIdempotence.writes).toEqual({ den: 0, liteLlm: 0 });
  expect(credentialsAfterIdempotence).toEqual(credentialsBeforeIdempotence);
  expect(keysAfterIdempotence.map(upstreamKeyId).sort()).toEqual(keysBeforeIdempotence.map(upstreamKeyId).sort());
  evidence.recordAssertionEvidence(
    "Reconciliation is idempotent after adoption",
    "The next pass reported zero Den writes, zero LiteLLM writes, and no member actions; both inventories remained unchanged.",
    adoptionIdempotence.memberCredentials.length === 0
      && adoptionIdempotence.writes.den === 0
      && adoptionIdempotence.writes.liteLlm === 0
      && JSON.stringify(credentialsAfterIdempotence) === JSON.stringify(credentialsBeforeIdempotence)
      && keysAfterIdempotence.map(upstreamKeyId).sort().join(",") === keysBeforeIdempotence.map(upstreamKeyId).sort().join(","),
  );

  const dana = await inviteMember(den, "dana", {
    email: `dana-lifecycle-${Date.now()}@openwork.test`,
    name: "Dana Credential Member",
    password: "OpenWorkEval123!",
  });
  const danaMemberId = await memberIdByEmail(den.admin, orgId, dana.email);
  const keysBeforeDurationMint = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const durationMint = await runProvisionerCli([
    "reconcile",
    "--key-duration",
    "1h",
    "--renew-before",
    "0",
  ], provisionerConfig);
  const durationLines = structuredLines(durationMint.stdout);
  const credentialsAfterDurationMint = await listedMemberCredentials(den.admin, orgId, providerId);
  const danaInitialBinding = credentialsAfterDurationMint.find((entry) => entry.orgMembershipId === danaMemberId);
  const danaInitialCredentialId = typeof danaInitialBinding?.externalCredentialId === "string"
    ? danaInitialBinding.externalCredentialId
    : "";
  const danaInitialVersion = typeof danaInitialBinding?.version === "number" ? danaInitialBinding.version : 0;
  const danaInitialInfo = await upstreamKeyInfo(gateway.baseUrl, gateway.apiKey, danaInitialCredentialId);
  const keysAfterDurationMint = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  expect(durationMint.stderr).toBe("");
  expect(durationLines).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "member.provision", orgMembershipId: danaMemberId, outcome: "succeeded" }),
  ]));
  expect(keysAfterDurationMint).toHaveLength(keysBeforeDurationMint.length + 1);
  expect(typeof danaInitialInfo.expires).toBe("string");
  expect(Date.parse(String(danaInitialInfo.expires))).toBeGreaterThan(Date.now());

  const renewal = await imported.reconcileMemberKeys({
    ...provisionerConfig,
    keyDuration: "1h",
    renewBeforeSeconds: 7_200,
  });
  const credentialsAfterRenewal = await listedMemberCredentials(den.admin, orgId, providerId);
  const danaRenewedBinding = credentialsAfterRenewal.find((entry) => entry.orgMembershipId === danaMemberId);
  const danaRenewedCredentialId = typeof danaRenewedBinding?.externalCredentialId === "string"
    ? danaRenewedBinding.externalCredentialId
    : "";
  expect(renewal.failures).toBe(0);
  expect(renewal.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: danaMemberId, action: "renewed", outcome: "succeeded" }),
  ]));
  expect(danaRenewedCredentialId).not.toBe(danaInitialCredentialId);
  expect(danaRenewedBinding?.version).toBe(danaInitialVersion + 1);
  expect((await upstreamKeys(gateway.baseUrl, gateway.apiKey)).length).toBe(keysAfterDurationMint.length);
  evidence.recordAssertionEvidence(
    "Expiring keys are minted with a duration and replaced inside the renewal window",
    "Dana's first key had a future LiteLLM expiry; a 7200-second threshold re-minted it, changed the external key identifier, incremented Den's optimistic version exactly once, and did not grow the key inventory.",
    typeof danaInitialInfo.expires === "string"
      && Date.parse(danaInitialInfo.expires) > Date.now()
      && danaRenewedCredentialId.length > 0
      && danaRenewedCredentialId !== danaInitialCredentialId
      && danaRenewedBinding?.version === danaInitialVersion + 1
      && (await upstreamKeys(gateway.baseUrl, gateway.apiKey)).length === keysAfterDurationMint.length,
  );

  const everyMemberId = [adminMemberId, aliceMemberId, bobMemberId, charlieMemberId, danaMemberId];
  await setProviderMemberAccess(
    den.admin,
    orgId,
    providerId,
    everyMemberId.filter((memberId) => memberId !== charlieMemberId),
  );
  const autoOffboard = await imported.reconcileMemberKeys(provisionerConfig);
  expect(autoOffboard.failures).toBe(0);
  expect(autoOffboard.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: charlieMemberId, action: "offboarded", outcome: "succeeded" }),
  ]));
  const charlieUpstreamAfterOffboard = await upstreamKeyInfo(gateway.baseUrl, gateway.apiKey, adoptedCredentialId);
  expect(charlieUpstreamAfterOffboard.blocked).toBe(true);
  await setProviderMemberAccess(den.admin, orgId, providerId, everyMemberId);
  const charlieBlockedConnect = await connect(charlie, orgId, providerId);
  const charlieBlockedBinding = (await listedMemberCredentials(den.admin, orgId, providerId))
    .find((entry) => entry.orgMembershipId === charlieMemberId);
  expect(charlieBlockedBinding?.state).toBe("blocked");
  expect(charlieBlockedConnect.response.status).toBe(200);
  expect(connectCredentialState(charlieBlockedConnect.body)).toBe("blocked");
  evidence.recordAssertionEvidence(
    "Reconciliation automatically offboards a removed provider grant in upstream-first order",
    "After Charlie's grant disappeared, LiteLLM reported blocked=true and Den persisted blocked; re-granting access exposed HTTP 200 with null material and memberCredential.state=blocked.",
    charlieUpstreamAfterOffboard.blocked === true
      && charlieBlockedBinding?.state === "blocked"
      && charlieBlockedConnect.response.status === 200
      && connectCredentialState(charlieBlockedConnect.body) === "blocked",
  );

  const danaBeforeSyntheticFailure = await connect(dana, orgId, providerId);
  const danaCurrentKey = connectKey(danaBeforeSyntheticFailure.body);
  const danaBindingBeforeSyntheticFailure = (await listedMemberCredentials(den.admin, orgId, providerId))
    .find((entry) => entry.orgMembershipId === danaMemberId);
  const danaVersionBeforeSyntheticFailure = typeof danaBindingBeforeSyntheticFailure?.version === "number"
    ? danaBindingBeforeSyntheticFailure.version
    : 0;
  const nonexistentCredentialId = `missing-upstream-${danaMemberId}`;
  const syntheticBinding = await denFetch(
    den.admin,
    `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials/${encodeURIComponent(danaMemberId)}`,
    {
      method: "PUT",
      headers: orgHeaders(den.admin, orgId),
      body: JSON.stringify({
        apiKey: danaCurrentKey,
        externalCredentialId: nonexistentCredentialId,
        expectedVersion: danaVersionBeforeSyntheticFailure,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  expect(syntheticBinding.response.status).toBe(200);
  const syntheticInventoryPass = await imported.reconcileMemberKeys(provisionerConfig);
  expect(syntheticInventoryPass.failures).toBe(0);
  expect(syntheticInventoryPass.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: danaMemberId, action: "stale", outcome: "succeeded" }),
  ]));
  const danaSelfRepair = await denFetch(dana, `/v1/llm-providers/${encodeURIComponent(providerId)}/my-credential`, {
    method: "PUT",
    headers: orgHeaders(dana, orgId),
    body: JSON.stringify({ apiKey: danaCurrentKey }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(danaSelfRepair.response.status).toBe(200);
  expect(danaSelfRepair.body).toMatchObject({ state: "active" });

  await setProviderMemberAccess(
    den.admin,
    orgId,
    providerId,
    everyMemberId.filter((memberId) => memberId !== danaMemberId),
  );
  const failedAutoOffboard = await imported.reconcileMemberKeys(provisionerConfig);
  expect(failedAutoOffboard.failures).toBeGreaterThan(0);
  expect(failedAutoOffboard.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: danaMemberId, action: "failed", outcome: "failed" }),
  ]));
  const danaActualUpstreamAfterFailure = await upstreamKeyInfo(gateway.baseUrl, gateway.apiKey, danaRenewedCredentialId);
  expect(danaActualUpstreamAfterFailure.blocked).not.toBe(true);
  await setProviderMemberAccess(den.admin, orgId, providerId, everyMemberId);
  const danaBindingAfterFailure = (await listedMemberCredentials(den.admin, orgId, providerId))
    .find((entry) => entry.orgMembershipId === danaMemberId);
  const danaConnectAfterFailure = await connect(dana, orgId, providerId);
  expect(danaBindingAfterFailure).toMatchObject({ state: "active", externalCredentialId: nonexistentCredentialId });
  expect(danaConnectAfterFailure.response.status).toBe(200);
  expect(connectCredentialState(danaConnectAfterFailure.body)).toBe("active");
  expect(connectKey(danaConnectAfterFailure.body)).toBe(danaCurrentKey);
  evidence.recordAssertionEvidence(
    "An upstream auto-offboard failure leaves the Den binding active and reports a nonzero failure summary",
    "Dana's synthetic missing LiteLLM identifier made the upstream-first block fail; the summary reported failure, the real upstream key stayed unblocked, and re-granted Den access still returned the unchanged active credential.",
    failedAutoOffboard.failures > 0
      && failedAutoOffboard.memberCredentials.some((action) => action.orgMembershipId === danaMemberId && action.outcome === "failed")
      && danaActualUpstreamAfterFailure.blocked !== true
      && danaBindingAfterFailure?.state === "active"
      && danaBindingAfterFailure.externalCredentialId === nonexistentCredentialId
      && danaConnectAfterFailure.response.status === 200
      && connectCredentialState(danaConnectAfterFailure.body) === "active"
      && connectKey(danaConnectAfterFailure.body) === danaCurrentKey,
  );

  const danaVersionAfterFailure = typeof danaBindingAfterFailure?.version === "number"
    ? danaBindingAfterFailure.version
    : 0;
  const restoreDanaIdentifier = await denFetch(
    den.admin,
    `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials/${encodeURIComponent(danaMemberId)}`,
    {
      method: "PUT",
      headers: orgHeaders(den.admin, orgId),
      body: JSON.stringify({
        apiKey: danaCurrentKey,
        externalCredentialId: danaRenewedCredentialId,
        expectedVersion: danaVersionAfterFailure,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  expect(restoreDanaIdentifier.response.status).toBe(200);

  const credentialsBeforeStale = await listedMemberCredentials(den.admin, orgId, providerId);
  const aliceBeforeStale = credentialsBeforeStale.find((entry) => entry.orgMembershipId === aliceMemberId);
  const danaBeforeStale = credentialsBeforeStale.find((entry) => entry.orgMembershipId === danaMemberId);
  const aliceCredentialId = typeof aliceBeforeStale?.externalCredentialId === "string"
    ? aliceBeforeStale.externalCredentialId
    : "";
  const aliceVersionBeforeStale = typeof aliceBeforeStale?.version === "number" ? aliceBeforeStale.version : 0;
  const danaVersionBeforeStale = typeof danaBeforeStale?.version === "number" ? danaBeforeStale.version : 0;
  await deleteUpstreamKey(gateway.baseUrl, gateway.apiKey, aliceCredentialId);

  const brokenKeysBeforeDryRun = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  const staleDryRun = await imported.reconcileMemberKeys({ ...provisionerConfig, dryRun: true });
  const credentialsAfterStaleDryRun = await listedMemberCredentials(den.admin, orgId, providerId);
  const brokenKeysAfterDryRun = await upstreamKeys(gateway.baseUrl, gateway.apiKey);
  expect(staleDryRun.failures).toBe(0);
  expect(staleDryRun.writes).toEqual({ den: 0, liteLlm: 0 });
  expect(staleDryRun.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: aliceMemberId, action: "planned", outcome: "planned", detail: "mark stale" }),
  ]));
  expect(credentialsAfterStaleDryRun).toEqual(credentialsBeforeStale);
  expect(brokenKeysAfterDryRun.map(upstreamKeyId).sort()).toEqual(brokenKeysBeforeDryRun.map(upstreamKeyId).sort());

  const staleReconcile = await imported.reconcileMemberKeys(provisionerConfig);
  const credentialsAfterStale = await listedMemberCredentials(den.admin, orgId, providerId);
  const aliceAfterStale = credentialsAfterStale.find((entry) => entry.orgMembershipId === aliceMemberId);
  const danaAfterStale = credentialsAfterStale.find((entry) => entry.orgMembershipId === danaMemberId);
  const aliceStaleConnect = await connect(alice, orgId, providerId);
  expect(staleReconcile.failures).toBe(0);
  expect(staleReconcile.memberCredentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgMembershipId: aliceMemberId, action: "stale", outcome: "succeeded" }),
  ]));
  expect(aliceAfterStale).toMatchObject({ state: "stale", version: aliceVersionBeforeStale + 1 });
  expect(aliceStaleConnect.response.status).toBe(200);
  expect(aliceStaleConnect.body).toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "stale" } },
  });
  expect(danaAfterStale).toMatchObject({ state: "active", version: danaVersionBeforeStale });

  const staleIdempotence = await imported.reconcileMemberKeys(provisionerConfig);
  const aliceAfterStaleIdempotence = (await listedMemberCredentials(den.admin, orgId, providerId))
    .find((entry) => entry.orgMembershipId === aliceMemberId);
  expect(staleIdempotence.failures).toBe(0);
  expect(staleIdempotence.memberCredentials).toEqual([]);
  expect(staleIdempotence.writes).toEqual({ den: 0, liteLlm: 0 });
  expect(aliceAfterStaleIdempotence?.version).toBe(aliceVersionBeforeStale + 1);
  evidence.recordAssertionEvidence(
    "A missing upstream key becomes stale without automatic re-minting or collateral writes",
    "Dry-run planned Alice's stale transition with zero Den or LiteLLM writes. The real pass incremented only Alice's binding version, connect returned null credentials with state=stale, Dana stayed active at the same version, and a later pass performed no re-mint or repeat stale write.",
    staleDryRun.writes.den === 0
      && staleDryRun.writes.liteLlm === 0
      && JSON.stringify(credentialsAfterStaleDryRun) === JSON.stringify(credentialsBeforeStale)
      && brokenKeysAfterDryRun.map(upstreamKeyId).sort().join(",") === brokenKeysBeforeDryRun.map(upstreamKeyId).sort().join(",")
      && aliceAfterStale?.state === "stale"
      && aliceAfterStale.version === aliceVersionBeforeStale + 1
      && aliceStaleConnect.response.status === 200
      && connectCredentialState(aliceStaleConnect.body) === "stale"
      && isRecord(aliceStaleConnect.body)
      && isRecord(aliceStaleConnect.body.llmProvider)
      && aliceStaleConnect.body.llmProvider.apiKey === null
      && aliceStaleConnect.body.llmProvider.apiKeys === null
      && danaAfterStale?.state === "active"
      && danaAfterStale.version === danaVersionBeforeStale
      && staleIdempotence.memberCredentials.length === 0
      && staleIdempotence.writes.den === 0
      && staleIdempotence.writes.liteLlm === 0
      && aliceAfterStaleIdempotence?.version === aliceVersionBeforeStale + 1,
  );
});
