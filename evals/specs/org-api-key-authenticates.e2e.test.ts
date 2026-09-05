import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  needs,
  server,
  SkipError,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const ORGANIZATION_NAME = "Org API Key Auth";
const API_KEY_NAME = "Enterprise Provisioner";
const PROVIDER_NAME = "API-Key Provisioned Gateway";
const PROVIDER_KEY = "openwork-api-key-auth";
const PROVIDER_ENV = "ORG_API_KEY_AUTH_PROVIDER_KEY";
const MODEL_ID = "openwork-api-key-auth-model";
const MEMBER_LLM_KEY = "sk-litellm-member-key-provisioned-over-api-key";
const REQUEST_TIMEOUT_MS = 30_000;
const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["docker"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Organization API key auth proof skipped — needs: ${missingRequirements.join(", ")}`
  : "an organization API key authenticates enterprise LLM-key provisioning against the Den API";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

/**
 * The enterprise wire shape under test: the request carries ONLY the
 * organization API key. No bearer token, no session cookie, no org header —
 * the key's own metadata scopes it to the organization (see
 * ee/apps/den-api/src/middleware/organization-context.ts).
 */
function apiKeyOnlyHeaders(key: string): Record<string, string> {
  return { "x-api-key": key };
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

async function createOrganizationApiKey(
  admin: DenSession,
  orgId: string,
): Promise<{ id: string; key: string }> {
  const result = await denFetch(admin, "/v1/api-keys", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({ name: API_KEY_NAME }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const created = isRecord(result.body) && isRecord(result.body.apiKey) ? result.body.apiKey : null;
  const id = created && typeof created.id === "string" ? created.id : "";
  const key = isRecord(result.body) && typeof result.body.key === "string" ? result.body.key : "";
  if (result.response.status !== 201 || !id || !key) {
    throw new Error(`Creating the organization API key failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { id, key };
}

async function createPerMemberProvider(admin: DenSession, orgId: string): Promise<string> {
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
        api: "https://litellm.api-key-auth.eval.invalid/v1",
        models: [{
          id: MODEL_ID,
          name: "API Key Auth Witness Model",
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
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider) ? result.body.llmProvider : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating the per-member provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("The organization API key proof requires a cold managed Den.");
  }

  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "API Key Admin" },
      members: { member: { name: "Enterprise Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The cold managed Den did not provision the member.");
  const orgId = await organizationId(den.admin);
  const memberId = await memberIdByEmail(den.admin, orgId, member.email);
  const providerId = await createPerMemberProvider(den.admin, orgId);

  // An admin mints the organization API key over their signed-in session.
  const minted = await createOrganizationApiKey(den.admin, orgId);
  expect(minted.key.startsWith("den_")).toBe(true);
  evidence.recordAssertionEvidence(
    "An organization admin can mint an organization API key",
    `POST /v1/api-keys returned HTTP 201 with key id ${minted.id} and a den_-prefixed secret.`,
    minted.key.startsWith("den_"),
  );

  // Regression witness — PR #3679 dropped x-api-key resolution from the Den
  // session middleware, so every API-key-only request resolves to no user.
  // The exact enterprise wire shape: only `x-api-key`, nothing else.
  const listWithKey = await denFetch(den.admin, "/v1/api-keys", {
    headers: apiKeyOnlyHeaders(minted.key),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const listedKeys = isRecord(listWithKey.body) && Array.isArray(listWithKey.body.apiKeys)
    ? listWithKey.body.apiKeys.filter(isRecord)
    : [];
  expect(listWithKey.response.status).toBe(200);
  expect(listedKeys.some((entry) => entry.id === minted.id)).toBe(true);
  evidence.recordAssertionEvidence(
    "An API-key-only request authenticates and is scoped to the key's organization",
    `GET /v1/api-keys with only x-api-key returned HTTP ${listWithKey.response.status} and listed the minted key without any bearer token, cookie, or org header.`,
    listWithKey.response.status === 200 && listedKeys.some((entry) => entry.id === minted.id),
  );

  // The incident scenario: an enterprise provisioner uses the org API key to
  // generate an LLM key for one of its members.
  const provisioned = await denFetch(
    den.admin,
    `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials/${encodeURIComponent(memberId)}`,
    {
      method: "PUT",
      headers: apiKeyOnlyHeaders(minted.key),
      body: JSON.stringify({
        apiKey: MEMBER_LLM_KEY,
        externalPrincipalId: "litellm-user-enterprise-member",
        externalCredentialId: "litellm-key-enterprise-member",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const provisionedState = isRecord(provisioned.body) && typeof provisioned.body.state === "string"
    ? provisioned.body.state
    : "";
  expect(provisioned.response.status).toBe(200);
  expect(provisionedState).toBe("active");
  evidence.recordAssertionEvidence(
    "An API-key-authenticated provisioner can generate a member LLM credential",
    `PUT /v1/llm-providers/:id/member-credentials/:memberId with only x-api-key returned HTTP ${provisioned.response.status} and state ${provisionedState || "(none)"}.`,
    provisioned.response.status === 200 && provisionedState === "active",
  );

  // The provisioned LLM key actually reaches the member it was generated for.
  const connect = await denFetch(member, `/v1/llm-providers/${encodeURIComponent(providerId)}/connect`, {
    headers: orgHeaders(member, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const connectProvider = isRecord(connect.body) && isRecord(connect.body.llmProvider) ? connect.body.llmProvider : null;
  const memberCredential = connectProvider && isRecord(connectProvider.memberCredential)
    ? connectProvider.memberCredential
    : null;
  expect(connect.response.status).toBe(200);
  expect(memberCredential?.state).toBe("active");
  expect(connectProvider?.apiKey).toBe(MEMBER_LLM_KEY);
  evidence.recordAssertionEvidence(
    "The member receives exactly the LLM key the API-key provisioner generated",
    `The member's connect call returned HTTP ${connect.response.status} with memberCredential.state=${String(memberCredential?.state)} and the provisioned secret.`,
    connect.response.status === 200
      && memberCredential?.state === "active"
      && connectProvider?.apiKey === MEMBER_LLM_KEY,
  );

  // Negative half: a forged key must not authenticate.
  const forged = await denFetch(den.admin, "/v1/api-keys", {
    headers: apiKeyOnlyHeaders("den_forged_key_that_was_never_minted"),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(forged.response.status).toBe(401);

  // Negative half: no credential at all must not authenticate.
  const anonymous = await denFetch(den.admin, "/v1/api-keys", {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(anonymous.response.status).toBe(401);
  evidence.recordAssertionEvidence(
    "Forged and missing API keys are rejected",
    `A never-minted x-api-key returned HTTP ${forged.response.status} and an unauthenticated request returned HTTP ${anonymous.response.status}.`,
    forged.response.status === 401 && anonymous.response.status === 401,
  );

  // Negative half: revocation ends access for the previously working key.
  const revoked = await denFetch(den.admin, `/v1/api-keys/${encodeURIComponent(minted.id)}`, {
    method: "DELETE",
    headers: orgHeaders(den.admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(revoked.response.status).toBe(204);
  const afterRevocation = await denFetch(den.admin, "/v1/api-keys", {
    headers: apiKeyOnlyHeaders(minted.key),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(afterRevocation.response.status).toBe(401);
  evidence.recordAssertionEvidence(
    "Deleting the organization API key revokes its access",
    `DELETE /v1/api-keys/:id returned HTTP ${revoked.response.status}; the same key then received HTTP ${afterRevocation.response.status}.`,
    revoked.response.status === 204 && afterRevocation.response.status === 401,
  );
});
