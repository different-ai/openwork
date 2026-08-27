import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  liteLlm,
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
}

interface ProvisionerModule {
  reconcileMemberKeys(input: ProvisionerConfig): Promise<unknown[]>;
  offboardMember(input: ProvisionerConfig & { orgMembershipId: string }): Promise<unknown>;
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
    && typeof value.reconcileMemberKeys === "function"
    && typeof value.offboardMember === "function";
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
        models: [{ id: MODEL_ID, name: MODEL_NAME }],
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
  const [aliceMemberId, bobMemberId] = await Promise.all([
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
  const reconcileSummary = await imported.reconcileMemberKeys(provisionerConfig);
  expect(reconcileSummary.length).toBeGreaterThanOrEqual(2);

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
});
