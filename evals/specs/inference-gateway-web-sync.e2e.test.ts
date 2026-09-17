import { expect, onTestFinished } from "vitest";
import { denFetch, grantOpenWorkWebAccess } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { eventually, needs, server, SkipError, test } from "@openwork/testkit";

const PROVIDER_NAME = "Anthropic via OpenWork Gateway";
const PROVIDER_ID = "anthropic";
const UPSTREAM_SECRET = "sk-ant-fake-upstream-key-never-reaches-a-worker";
const GATEWAY_ORIGIN = "http://127.0.0.1:18791";
const REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = stringAt(organizations[0] ?? null, "id");
  if (!result.response.ok || !id) throw new Error(`Finding the test organization failed: HTTP ${result.response.status}`);
  return id;
}

async function firstCatalogModelId(admin: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(admin, `/v1/llm-provider-catalog/${PROVIDER_ID}`, {
    headers: orgHeaders(admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.provider) ? result.body.provider : null;
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const id = stringAt(models[0] ?? null, "id");
  if (!result.response.ok || !id) throw new Error(`The ${PROVIDER_ID} catalog entry was unavailable: HTTP ${result.response.status}`);
  return id;
}

async function createProvider(admin: DenSession, orgId: string, modelId: string, input: {
  name: string;
  allMembers: boolean;
  status?: "active" | "disabled";
}): Promise<string> {
  const result = await denFetch(admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: input.name,
      providerId: PROVIDER_ID,
      modelIds: [modelId],
      credential: { kind: "api_key", secret: UPSTREAM_SECRET },
      allMembers: input.allMembers,
      status: input.status,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const id = stringAt(provider, "id");
  if (result.response.status !== 201 || !id) throw new Error(`Creating ${input.name} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  return id;
}

async function deleteProvider(admin: DenSession, orgId: string, providerId: string): Promise<void> {
  await denFetch(admin, `/v1/inference-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE", headers: orgHeaders(admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function memberConnect(member: DenSession, orgId: string, providerId: string, upstreamModelId: string) {
  const result = await denFetch(member, `/v1/inference-providers/${encodeURIComponent(providerId)}/connect`, {
    headers: orgHeaders(member, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const providerConfig = isRecord(provider?.providerConfig) ? provider.providerConfig : null;
  const models = Array.isArray(provider?.models) ? provider.models.filter(isRecord) : [];
  const key = stringAt(provider, "apiKey");
  const envNames = Array.isArray(providerConfig?.env) ? providerConfig.env.filter((value): value is string => typeof value === "string") : [];
  const model = models.find((value) => stringAt(value, "upstreamModelId") === upstreamModelId);
  const wireModelId = stringAt(model ?? null, "id");
  if (result.response.status !== 200 || !key || envNames.length !== 1 || !wireModelId) {
    throw new Error(`Member connect failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  }
  return { key, envName: envNames[0], wireModelId };
}

async function resolveGateway(member: DenSession, orgId: string) {
  const response = await denFetch(member, "/v1/cloud/gateway/resolve", {
    headers: { ...orgHeaders(member, orgId), "x-openwork-gateway-key": "synthetic-cloud-gateway-key" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.response.status, body: isRecord(response.body) ? response.body : {}, text: response.text };
}

async function runtimeProviders(resolution: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = stringAt(resolution, "url");
  const token = stringAt(resolution, "clientToken");
  if (!url || !token) throw new Error("The trusted gateway resolution omitted the worker URL or client token.");
  const response = await fetch(`${url.replace(/\/$/, "")}/opencode/config`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error",
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload)) throw new Error(`Reading worker model inventory failed: HTTP ${response.status}`);
  return isRecord(payload.provider) ? payload.provider : {};
}

async function runtimeEnvMatches(resolution: Record<string, unknown>, key: string, expected: string): Promise<boolean> {
  const url = stringAt(resolution, "url");
  const token = stringAt(resolution, "hostToken");
  if (!url || !token) throw new Error("The trusted gateway resolution omitted the worker URL or host token.");
  const response = await fetch(`${url.replace(/\/$/, "")}/env/${encodeURIComponent(key)}`, {
    headers: { "x-openwork-host-token": token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error",
  });
  const payload: unknown = await response.json();
  return response.ok && isRecord(payload) && isRecord(payload.item) && payload.item.value === expected;
}

test("GATEWAY-WEB-01 a hosted-web worker receives only the member's usable Gateway inventory", { timeout: 600_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], env: ["DAYTONA_API_KEY", "DAYTONA_SNAPSHOT"] });
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) throw new SkipError("Gateway worker materialization requires an isolated Den, not an attached service");
  await using den = await server({
    place,
    web: false,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      GATEWAY_ENABLED: "true",
      GATEWAY_PROXY_BASE_URL: GATEWAY_ORIGIN,
      GATEWAY_PUBLIC_BASE_URL: GATEWAY_ORIGIN,
      DEN_GATEWAY_KEY: "synthetic-cloud-gateway-key",
      DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_BOOTSTRAP_ADMIN_EMAILS: "gateway-admin@openwork.test",
      STRIPE_OPENWORK_WEB_PRICE_ID: "price_gateway_worker_witness",
      PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
      DAYTONA_API_URL: process.env.DAYTONA_API_URL,
      DAYTONA_SNAPSHOT: process.env.DAYTONA_SNAPSHOT,
      DAYTONA_SHARED_VOLUME_NAME: `gateway-web-${process.pid}`,
      DAYTONA_USE_DEPRECATED_POLLING: "false",
      DAYTONA_HEALTHCHECK_TIMEOUT_MS: "120000",
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0",
      CLOUD_IDLE_LOOP_SECONDS: "0",
    },
    org: {
      name: "Inference Gateway Web Worker Sync",
      admin: { name: "Gateway Admin", email: "gateway-admin@openwork.test" },
      members: { member: { name: "Gateway Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The isolated Den did not provision its member.");

  const orgId = await organizationId(den.admin);
  await grantOpenWorkWebAccess(den.admin, orgId, "Synthetic hosted-web Gateway worker coverage");
  const modelId = await firstCatalogModelId(den.admin, orgId);
  const usableProviderId = await createProvider(den.admin, orgId, modelId, { name: PROVIDER_NAME, allMembers: true });
  const unassignedProviderId = await createProvider(den.admin, orgId, modelId, { name: "Unassigned Gateway Provider", allMembers: false });
  const disabledProviderId = await createProvider(den.admin, orgId, modelId, { name: "Disabled Gateway Provider", allMembers: true, status: "disabled" });
  onTestFinished(async () => {
    await Promise.all([usableProviderId, unassignedProviderId, disabledProviderId]
      .map((id) => deleteProvider(den.admin, orgId, id).catch(() => undefined)));
  });
  const { key: memberKey, envName, wireModelId } = await memberConnect(member, orgId, usableProviderId, modelId);

  const resolved = await eventually(() => resolveGateway(member, orgId), {
    within: 300_000,
    intervalMs: 5_000,
    label: "hosted-web worker ready with server-side provider materialization",
    until: (value) => value.status === 200 && (value.body.status === "ready" || value.body.status === "failed"),
  });
  expect(resolved.status, resolved.text).toBe(200);
  expect(resolved.body.status, resolved.text).toBe("ready");
  expect(resolved.body.providerSync).toBeUndefined();
  const providers = await eventually(() => runtimeProviders(resolved.body), {
    within: 60_000,
    intervalMs: 2_000,
    label: "Gateway provider visible in hosted worker model inventory",
    until: (value) => usableProviderId in value,
  });
  expect(Object.keys(providers).filter((id) => id.startsWith("ipr_")).sort()).toEqual([usableProviderId]);
  expect(providers[usableProviderId]).toMatchObject({
    api: `${GATEWAY_ORIGIN}/api/v1/providers/${usableProviderId}`,
    env: [envName],
    models: { [wireModelId]: { id: wireModelId } },
  });
  expect(await runtimeEnvMatches(resolved.body, envName, memberKey)).toBe(true);
  expect(providers).not.toHaveProperty(unassignedProviderId);
  expect(providers).not.toHaveProperty(disabledProviderId);
  evidence.recordAssertionEvidence(
    "Hosted web materializes only the worker member's usable Gateway inventory",
    `The member-owned worker received one ${usableProviderId} runtime block with model identity ${wireModelId}; an unassigned provider and a disabled provider were absent. Credential values were checked in memory and excluded from evidence.`,
    true,
  );

  const grants = await denFetch(den.admin, `/v1/inference-providers/${usableProviderId}/access-grants`, {
    headers: orgHeaders(den.admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const accessGrants = isRecord(grants.body) && Array.isArray(grants.body.accessGrants) ? grants.body.accessGrants.filter(isRecord) : [];
  const grantId = stringAt(accessGrants[0] ?? null, "id");
  if (!grantId) throw new Error(`The usable provider's access grant was missing: ${grants.text.slice(0, 300)}`);
  const revoked = await denFetch(den.admin, `/v1/inference-providers/${usableProviderId}/access-grants/${grantId}`, {
    method: "DELETE", headers: orgHeaders(den.admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(revoked.response.status, revoked.text).toBe(204);
  await eventually(async () => {
    const refreshed = await resolveGateway(member, orgId);
    if (refreshed.body.status !== "ready") return [usableProviderId];
    return Object.keys(await runtimeProviders(refreshed.body)).filter((id) => id.startsWith("ipr_"));
  }, { within: 60_000, intervalMs: 2_000, label: "revoked Gateway provider removed from hosted worker", until: (ids) => ids.length === 0 });
  evidence.recordAssertionEvidence(
    "Revoked Gateway access is removed from the hosted worker",
    "After the member's access grant was deleted, the next trusted gateway resolve removed the provider block instead of broadly retaining organization providers.",
    true,
  );
});
