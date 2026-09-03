import { expect, onTestFinished } from "vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import { denFetch, evalIn, go, readAvailableModels } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, eventually, needs, server, test } from "@openwork/testkit";

/**
 * Desktop half of the inference gateway (plan §3 #2): after cloud provider
 * sync, one runtime opencode provider exists per `inference_providers` row —
 * id = the `ipr_` id, `api`/`options.baseURL` = the gateway URL, the env var
 * named by the catalog set to the member's `ow_inf_` key — and the model
 * picker badges that provider group "via OpenWork Gateway".
 *
 * The inference app is not booted here: materialization depends only on
 * den-api's connect payload. The gateway round-trip is proved by
 * inference-gateway-org-provider.test.ts.
 */

const ORGANIZATION_NAME = "Inference Gateway Desktop Sync";
const PROVIDER_NAME = "Anthropic via OpenWork Gateway";
const CATALOG_PROVIDER_ID = "anthropic";
const ENV_KEY = "ANTHROPIC_API_KEY";
const GATEWAY_KEY_PREFIX = "ow_inf_";
const GATEWAY_BADGE_LABEL = "via OpenWork Gateway";
const FAKE_UPSTREAM_KEY = "sk-ant-fake-upstream-key-never-reaches-a-device";
// Nothing listens here on purpose: the desktop must materialize the URL as given, not probe it.
const GATEWAY_ORIGIN = "http://127.0.0.1:18791";
const REQUEST_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 180_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

function stringAt(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function firstCatalogModelId(admin: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(admin, `/v1/llm-provider-catalog/${CATALOG_PROVIDER_ID}`, {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.provider) ? result.body.provider : null;
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const modelId = stringAt(models[0] ?? null, "id");
  if (!result.response.ok || !modelId) {
    throw new Error(`The ${CATALOG_PROVIDER_ID} catalog entry was unavailable (HTTP ${result.response.status}): ${result.text.slice(0, 300)}`);
  }
  return modelId;
}

async function createGatewayProvider(admin: DenSession, orgId: string, modelId: string): Promise<string> {
  const result = await denFetch(admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: PROVIDER_NAME,
      providerId: CATALOG_PROVIDER_ID,
      modelIds: [modelId],
      credential: { kind: "api_key", secret: FAKE_UPSTREAM_KEY },
      allMembers: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const id = stringAt(provider, "id");
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating the gateway provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function deleteGatewayProvider(admin: DenSession, orgId: string, id: string): Promise<void> {
  await denFetch(admin, `/v1/inference-providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function memberConnect(member: DenSession, orgId: string, id: string): Promise<{ key: string; gatewayUrl: string }> {
  const result = await denFetch(member, `/v1/inference-providers/${encodeURIComponent(id)}/connect`, {
    headers: orgHeaders(member, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const key = stringAt(provider, "apiKey");
  const providerConfig = isRecord(provider?.providerConfig) ? provider.providerConfig : null;
  const gatewayUrl = stringAt(providerConfig, "api");
  if (result.response.status !== 200 || !key || !gatewayUrl) {
    throw new Error(`Member connect failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { key, gatewayUrl };
}

interface LocalServerSnapshot {
  provider: Record<string, unknown> | null;
  syncProviders: Record<string, unknown>[];
  syncStatusRaw: string;
  envValue: string | null;
  envDump: string;
}

/**
 * Reads the signed-in desktop's local server through the Electron bridge (the
 * same way readConnectState resolves it): runtime opencode providers, cloud
 * provider sync status, and the env store entry for the catalog's env name.
 */
async function readLocalServer(desktopApp: Parameters<typeof evalIn>[0], iprId: string): Promise<LocalServerSnapshot> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info || info.running !== true) return { error: "local server not running" };
    const baseUrl = String(info.baseUrl ?? "").replace(/\\/+$/, "");
    const hostHeaders = { "x-openwork-host-token": String(info.hostToken ?? "") };
    const clientHeaders = { authorization: "Bearer " + String(info.clientToken ?? info.ownerToken ?? "") };
    const readJson = async (path, headers) => {
      const response = await fetch(baseUrl + path, { headers });
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
    };
    const providers = await readJson("/runtime-config/providers", hostHeaders);
    const status = await readJson("/cloud-provider-sync/status", clientHeaders);
    const env = await readJson("/env", hostHeaders);
    const entry = await readJson(${JSON.stringify(`/env/${ENV_KEY}`)}, hostHeaders);
    return {
      provider: providers.body && providers.body.provider ? providers.body.provider[${JSON.stringify(iprId)}] ?? null : null,
      syncProviders: status.body && Array.isArray(status.body.providers) ? status.body.providers : [],
      syncStatusRaw: JSON.stringify({ status: status.status, body: status.body }).slice(0, 2000),
      envValue: entry.status === 200 && entry.body && entry.body.item ? entry.body.item.value : null,
      envDump: JSON.stringify(env.body ?? null),
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(value)) throw new Error("The desktop returned an invalid local server snapshot.");
  if (typeof value.error === "string") throw new Error(value.error);
  return {
    provider: isRecord(value.provider) ? value.provider : null,
    syncProviders: Array.isArray(value.syncProviders) ? value.syncProviders.filter(isRecord) : [],
    syncStatusRaw: typeof value.syncStatusRaw === "string" ? value.syncStatusRaw : "",
    envValue: typeof value.envValue === "string" ? value.envValue : null,
    envDump: typeof value.envDump === "string" ? value.envDump : "",
  };
}

test("a gateway provider materializes on the desktop as its own ipr_ provider with the member's OpenWork key and a gateway badge", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using den = await server({
    place,
    env: { INFERENCE_PROXY_BASE_URL: GATEWAY_ORIGIN },
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Gateway Admin" },
      members: { member: { name: "Gateway Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The testkit did not provision the organization member.");

  const orgId = await organizationId(den.admin);
  const modelId = await firstCatalogModelId(den.admin, orgId);
  const iprId = await createGatewayProvider(den.admin, orgId, modelId);
  onTestFinished(async () => {
    await deleteGatewayProvider(den.admin, orgId, iprId).catch(() => undefined);
  });
  // den-api derives the gateway origin from its own INFERENCE_PROXY_BASE_URL
  // (the spec only controls that env for a local Den), so the lane-independent
  // claim is: the desktop materializes exactly the URL den-api handed out, and
  // that URL is the provider-scoped gateway prefix.
  const { key: memberKey, gatewayUrl } = await memberConnect(member, orgId, iprId);
  expect(memberKey.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
  expect(gatewayUrl.endsWith(`/api/v1/providers/${iprId}`)).toBe(true);

  await using desktopApp = await app({ den, as: "member", place });

  // --- Runtime config: one provider per ipr_ row, pointed at the gateway. ---
  const local = await eventually(
    () => readLocalServer(desktopApp, iprId),
    {
      within: SYNC_TIMEOUT_MS,
      intervalMs: 3_000,
      label: `runtime provider ${iprId} materialized by cloud provider sync`,
      // Runtime config lands first; the sync status publishes its provider list once the engine reload settles.
      until: (snapshot) => snapshot.provider !== null
        && snapshot.envValue !== null
        && snapshot.syncProviders.some((entry) => entry.cloudProviderId === iprId),
    },
  );
  const runtimeProvider = local.provider;
  if (!runtimeProvider) throw new Error("The runtime provider was not materialized.");
  const runtimeOptions = isRecord(runtimeProvider.options) ? runtimeProvider.options : null;
  const runtimeEnv = Array.isArray(runtimeProvider.env) ? runtimeProvider.env : [];
  const runtimeModels = isRecord(runtimeProvider.models) ? runtimeProvider.models : {};
  const syncEntry = local.syncProviders.find((entry) => entry.cloudProviderId === iprId) ?? null;
  expect(runtimeProvider.npm).toBe("@ai-sdk/anthropic");
  expect(runtimeProvider.api).toBe(gatewayUrl);
  expect(stringAt(runtimeOptions, "baseURL")).toBe(gatewayUrl);
  expect(runtimeEnv).toContain(ENV_KEY);
  expect(Object.keys(runtimeModels)).toContain(modelId);
  expect(syncEntry?.providerId, local.syncStatusRaw).toBe(iprId);
  expect(syncEntry?.source).toBe("openwork_gateway");
  expect(syncEntry?.name).toBe(PROVIDER_NAME);
  evidence.recordAssertionEvidence(
    "Cloud provider sync materializes the gateway row as its own runtime provider pointed at the gateway",
    `runtime-config/providers[${iprId}] has npm=${String(runtimeProvider.npm)}, api=${String(runtimeProvider.api)}, options.baseURL=${stringAt(runtimeOptions, "baseURL")}, env=${JSON.stringify(runtimeEnv)}, models=${JSON.stringify(Object.keys(runtimeModels))}; sync status lists it with source=${String(syncEntry?.source)}.`,
    runtimeProvider.api === gatewayUrl
      && stringAt(runtimeOptions, "baseURL") === gatewayUrl
      && runtimeEnv.includes(ENV_KEY)
      && syncEntry?.source === "openwork_gateway",
  );

  // --- Env store: the member's ow_inf_ key, never the org's upstream key. ---
  expect(local.envValue).toBe(memberKey);
  expect(local.envValue?.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
  expect(local.envDump.includes(FAKE_UPSTREAM_KEY)).toBe(false);
  evidence.recordAssertionEvidence(
    "The device holds the member's OpenWork inference key and no upstream credential",
    `/env/${ENV_KEY} equals the key den-api returned from /connect (prefix ${GATEWAY_KEY_PREFIX}); the full env store does not contain the upstream secret.`,
    local.envValue === memberKey && !local.envDump.includes(FAKE_UPSTREAM_KEY),
  );

  // --- Picker: the model is selectable under a group badged "via OpenWork Gateway". ---
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  const models = await readAvailableModels(desktopApp);
  const gatewayModel = models.find((model) => model.id === modelId) ?? null;
  expect(gatewayModel?.selectable).toBe(true);
  expect(gatewayModel?.providerName).toBe(PROVIDER_NAME);

  const badgeState = await evalIn(desktopApp, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    if (!dialog) return { error: "dialog missing" };
    // Group headers read "<provider> <n> model(s) <badges…>"; badges follow the count.
    const headers = [...dialog.querySelectorAll("button")].filter((button) => /\\b\\d+ models?\\b/.test((button.textContent ?? "").replace(/\\s+/g, " ").trim()));
    const describe = (header) => ({
      text: (header.textContent ?? "").replace(/\\s+/g, " ").trim(),
      badged: [...header.querySelectorAll("span")].some((span) => (span.textContent ?? "").trim() === ${JSON.stringify(GATEWAY_BADGE_LABEL)}),
    });
    const groups = headers.map(describe);
    return {
      gatewayGroup: groups.find((group) => group.text.includes(${JSON.stringify(PROVIDER_NAME)})) ?? null,
      otherBadgedGroups: groups.filter((group) => !group.text.includes(${JSON.stringify(PROVIDER_NAME)}) && group.badged),
      unbadgedGroups: groups.filter((group) => !group.text.includes(${JSON.stringify(PROVIDER_NAME)}) && !group.badged),
      groupCount: groups.length,
    };
  })()`);
  const gatewayGroup = isRecord(badgeState) && isRecord(badgeState.gatewayGroup) ? badgeState.gatewayGroup : null;
  const otherBadged = isRecord(badgeState) && Array.isArray(badgeState.otherBadgedGroups) ? badgeState.otherBadgedGroups : [];
  const unbadged = isRecord(badgeState) && Array.isArray(badgeState.unbadgedGroups) ? badgeState.unbadgedGroups : [];
  expect(gatewayGroup?.badged, JSON.stringify(badgeState)).toBe(true);
  expect(otherBadged).toHaveLength(0);
  // Negative half needs a witness: at least one non-gateway group exists and is not badged.
  expect(unbadged.length).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "The picker badges only the gateway provider group as via OpenWork Gateway",
    `Model ${modelId} is selectable under ${String(gatewayModel?.providerName)}; group header ${JSON.stringify(gatewayGroup?.text)} carries the badge, ${otherBadged.length} other group(s) do, and ${unbadged.length} non-gateway group(s) do not.`,
    gatewayModel?.selectable === true && gatewayGroup?.badged === true && otherBadged.length === 0 && unbadged.length > 0,
  );
  {
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [
      `The open Models picker shows a provider group named ${PROVIDER_NAME}`,
      `That group header carries a "${GATEWAY_BADGE_LABEL}" badge`,
      "No error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
