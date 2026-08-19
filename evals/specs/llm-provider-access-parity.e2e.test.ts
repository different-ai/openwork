import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { needs, server, test } from "@openwork/testkit";

const ORGANIZATION_NAME = "LLM Provider Access Parity";
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function providerId(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.llmProvider) || typeof payload.llmProvider.id !== "string") {
    throw new Error("LLM provider response did not include an id.");
  }
  return payload.llmProvider.id;
}

function providerIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    throw new Error("LLM provider list response did not include llmProviders.");
  }
  return payload.llmProviders.flatMap((provider) =>
    isRecord(provider) && typeof provider.id === "string" ? [provider.id] : []
  );
}

function resourceProviderIds(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.resources) || !isRecord(payload.resources.llmProviders)) {
    throw new Error("Resource snapshot did not include LLM providers.");
  }
  return Object.keys(payload.resources.llmProviders);
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

async function selectOrganization(session: DenSession, orgId: string): Promise<void> {
  const result = await denFetch(session, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ organizationId: orgId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`Selecting the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function organizationMemberIdByEmail(session: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    headers: {
      ...auth(session),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Resolving the invited member failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function createProvider(
  admin: DenSession,
  orgId: string,
  input: { name: string; providerKey: string; allMembers?: boolean; memberIds?: string[] },
): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: {
      ...auth(admin),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({
      name: input.name,
      source: "custom",
      customConfig: {
        id: input.providerKey,
        name: input.name,
        npm: "@ai-sdk/openai-compatible",
        env: ["EVAL_PROVIDER_API_KEY"],
        models: [{ id: `${input.providerKey}-model`, name: "Parity Model" }],
      },
      allMembers: input.allMembers,
      memberIds: input.memberIds,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status).toBe(201);
  return providerId(result.body);
}

test("LLM provider access has list, connect, and resource snapshot parity", async ({ evidence, place }) => {
  needs({});
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Provider Parity Admin" },
      members: {
        plain: { name: "Plain Invited Member" },
        grantee: { name: "Specific Provider Grantee" },
      },
    },
  });

  const plain = den.members.plain;
  const grantee = den.members.grantee;
  if (!plain || !grantee) throw new Error("The testkit did not provision both invited members.");

  const orgId = await organizationId(den.admin);
  await selectOrganization(den.admin, orgId);
  await selectOrganization(plain, orgId);
  await selectOrganization(grantee, orgId);
  const granteeMemberId = await organizationMemberIdByEmail(den.admin, orgId, grantee.email);

  const sharedProviderId = await createProvider(den.admin, orgId, {
    name: "Shared Parity Provider",
    providerKey: "shared-parity-provider",
    allMembers: true,
  });
  const restrictedProviderId = await createProvider(den.admin, orgId, {
    name: "Restricted Parity Provider",
    providerKey: "restricted-parity-provider",
    memberIds: [granteeMemberId],
  });

  const list = await denFetch(plain, "/v1/llm-providers", {
    headers: {
      ...auth(plain),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(list.response.status).toBe(200);
  const listedProviderIds = providerIds(list.body);
  evidence.recordAssertionEvidence(
    "Org-wide provider is usable by an invited member",
    "The invited member's usable provider list includes the org-wide provider.",
    listedProviderIds.includes(sharedProviderId),
  );
  evidence.recordAssertionEvidence(
    "Member-only provider stays hidden from other members",
    "The invited member's usable provider list excludes the provider granted to someone else.",
    !listedProviderIds.includes(restrictedProviderId),
  );
  expect(listedProviderIds).toContain(sharedProviderId);
  expect(listedProviderIds).not.toContain(restrictedProviderId);

  const sharedConnect = await denFetch(plain, `/v1/llm-providers/${encodeURIComponent(sharedProviderId)}/connect`, {
    headers: {
      ...auth(plain),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  evidence.recordAssertionEvidence(
    "Org-wide provider connection is authorized",
    "The invited member receives HTTP 200 when connecting to the org-wide provider.",
    sharedConnect.response.status === 200,
  );
  expect(sharedConnect.response.status).toBe(200);
  expect(sharedConnect.body).toMatchObject({ llmProvider: { id: sharedProviderId } });

  const restrictedConnect = await denFetch(plain, `/v1/llm-providers/${encodeURIComponent(restrictedProviderId)}/connect`, {
    headers: {
      ...auth(plain),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  evidence.recordAssertionEvidence(
    "Member-only provider connection is forbidden",
    "The invited member receives HTTP 403 when connecting to a provider granted to someone else.",
    restrictedConnect.response.status === 403,
  );
  expect(restrictedConnect.response.status).toBe(403);

  const resources = await denFetch(plain, "/v1/resources", {
    headers: {
      ...auth(plain),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(resources.response.status).toBe(200);
  const snapshotProviderIds = resourceProviderIds(resources.body);
  evidence.recordAssertionEvidence(
    "Resource snapshot includes the org-wide provider",
    "The invited member's resource snapshot includes the same org-wide provider exposed by list and connect.",
    snapshotProviderIds.includes(sharedProviderId),
  );
  evidence.recordAssertionEvidence(
    "Resource snapshot excludes the member-only provider",
    "The invited member's resource snapshot excludes the provider granted to someone else.",
    !snapshotProviderIds.includes(restrictedProviderId),
  );
  expect(snapshotProviderIds).toContain(sharedProviderId);
  expect(snapshotProviderIds).not.toContain(restrictedProviderId);
});
