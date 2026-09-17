import { expect } from "vitest";
import { denFetch, grantOpenWorkWebAccess, readAvailableModels } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { addInitScript, navigate } from "@openwork/cdp";
import { checkedExec, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { browserScript, eventually, spec } from "@openwork/testkit";
import type { Seed } from "@openwork/testkit";

const PROVIDER_NAME = "Anthropic via OpenWork Gateway";
const PROVIDER_ID = "anthropic";
const UPSTREAM_SECRET = "sk-ant-fake-upstream-key-never-reaches-a-worker";
const GATEWAY_ORIGIN = "http://127.0.0.1:18791";
const REQUEST_TIMEOUT_MS = 30_000;
const UNAVAILABLE_COPY = "The model you were using is no longer available, please select a different model for this session.";

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

async function firstCatalogModel(admin: DenSession, orgId: string) {
  const result = await denFetch(admin, `/v1/llm-provider-catalog/${PROVIDER_ID}`, {
    headers: orgHeaders(admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.provider) ? result.body.provider : null;
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
  const id = stringAt(models[0] ?? null, "id");
  const name = stringAt(models[0] ?? null, "name");
  if (!result.response.ok || !id || !name) throw new Error(`The ${PROVIDER_ID} catalog entry was unavailable: HTTP ${result.response.status}`);
  return { id, name };
}

async function createProvider(admin: DenSession, orgId: string, modelId: string): Promise<string> {
  const result = await denFetch(admin, "/v1/inference-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: PROVIDER_NAME,
      providerId: PROVIDER_ID,
      modelIds: [modelId],
      credential: { kind: "api_key", secret: UPSTREAM_SECRET },
      allMembers: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const id = stringAt(provider, "id");
  if (result.response.status !== 201 || !id) throw new Error(`Creating Gateway provider failed: HTTP ${result.response.status}`);
  return id;
}

async function connectProvider(member: DenSession, orgId: string, providerId: string, upstreamModelId: string) {
  const result = await denFetch(member, `/v1/inference-providers/${providerId}/connect`, {
    headers: orgHeaders(member, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.inferenceProvider) ? result.body.inferenceProvider : null;
  const models = Array.isArray(provider?.models) ? provider.models.filter(isRecord) : [];
  const model = models.find((entry) => stringAt(entry, "upstreamModelId") === upstreamModelId);
  const id = stringAt(model ?? null, "id");
  const name = stringAt(model ?? null, "name");
  if (result.response.status !== 200 || !id || !name) throw new Error(`Connecting Gateway provider failed: HTTP ${result.response.status}`);
  return { id, name };
}

async function resolveGateway(member: DenSession, orgId: string) {
  const result = await denFetch(member, "/v1/cloud/gateway/resolve", {
    headers: { ...orgHeaders(member, orgId), "x-openwork-gateway-key": "synthetic-cloud-gateway-key" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: result.response.status, body: isRecord(result.body) ? result.body : {}, text: result.text };
}

async function gatewayWebPicker(seed: Seed) {
  const den = await seed.den({
    web: false,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      GATEWAY_ENABLED: "true",
      GATEWAY_PROXY_BASE_URL: GATEWAY_ORIGIN,
      GATEWAY_PUBLIC_BASE_URL: GATEWAY_ORIGIN,
      DEN_GATEWAY_KEY: "synthetic-cloud-gateway-key",
      DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_BOOTSTRAP_ADMIN_EMAILS: "gateway-picker-admin@openwork.test",
      STRIPE_OPENWORK_WEB_PRICE_ID: "price_gateway_picker_witness",
      PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
      DAYTONA_API_URL: process.env.DAYTONA_API_URL,
      DAYTONA_SNAPSHOT: process.env.DAYTONA_SNAPSHOT,
      DAYTONA_SHARED_VOLUME_NAME: `gateway-picker-${process.pid}`,
      DAYTONA_USE_DEPRECATED_POLLING: "false",
      DAYTONA_HEALTHCHECK_TIMEOUT_MS: "120000",
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0",
      CLOUD_IDLE_LOOP_SECONDS: "0",
    },
    org: {
      name: "Inference Gateway Web Picker",
      admin: { name: "Gateway Picker Admin", email: "gateway-picker-admin@openwork.test" },
      members: { member: { name: "Gateway Picker Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The isolated Den did not provision its member.");
  const orgId = await organizationId(den.admin);
  await grantOpenWorkWebAccess(den.admin, orgId, "Synthetic hosted-web Gateway picker coverage");
  const catalogModel = await firstCatalogModel(den.admin, orgId);
  const providerId = await createProvider(den.admin, orgId, catalogModel.id);
  const model = await connectProvider(member, orgId, providerId, catalogModel.id);
  const resolution = await eventually(() => resolveGateway(member, orgId), {
    within: 300_000,
    intervalMs: 5_000,
    label: "hosted-web worker ready for gateway browser",
    until: (value) => value.status === 200 && (value.body.status === "ready" || value.body.status === "failed"),
  });
  if (resolution.body.status !== "ready") throw new Error(`Hosted-web worker failed before browser launch: ${resolution.text}`);

  const app = await seed.appWeb({ name: "gateway-web-picker", workspacePath: seed.tmpPath("gateway-web-picker") });
  const sandboxId = app.handle.sandboxId;
  if (!sandboxId) throw new Error("The appWeb surface did not expose its Daytona sandbox.");
  const command = `pnpm --filter @openwork/app build:web >/tmp/gateway-picker-app-build.log 2>&1 && pnpm --filter @openwork-ee/utils build >/tmp/gateway-picker-utils-build.log 2>&1 && pnpm --filter @openwork-ee/den-gateway build >/tmp/gateway-picker-build.log 2>&1 || exit 1; nohup env PORT=8789 DEN_API_BASE=${den.ref.apiUrl} DEN_GATEWAY_KEY=synthetic-cloud-gateway-key DEN_GATEWAY_WEB_ROOT=/workspace/apps/app/dist DEN_GATEWAY_RESOLVE_TTL_MS=1000 node /workspace/ee/apps/den-gateway/dist/server.js </dev/null >/tmp/gateway-picker.log 2>&1 &`;
  await execInSandbox(defaultDaytonaExec, sandboxId, command, { context: "build and start hosted-web gateway", timeoutMs: 240_000 });
  await execInSandbox(defaultDaytonaExec, sandboxId, `for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:8789/__gw/health >/dev/null && exit 0; sleep 1; done; grep -E Error\\|error\\|Cannot\\|ERR_ /tmp/gateway-picker.log || true; exit 1`, { context: "hosted-web gateway loopback health", timeoutMs: 45_000 });
  const preview = await checkedExec(defaultDaytonaExec, ["preview-url", sandboxId, "-p", "8789"], "hosted-web gateway preview URL", { timeoutMs: 30_000 });
  const gatewayUrl = preview.stdout.split(/\s+/).find((value) => value.startsWith("https://"));
  if (!gatewayUrl) throw new Error("The hosted-web gateway preview URL was missing.");
  await eventually(async () => (await fetch(`${gatewayUrl}/__gw/health`, { signal: AbortSignal.timeout(10_000) })).status, {
    within: 60_000, intervalMs: 1_000, label: "hosted-web gateway health", until: (status) => status === 200,
  });
  await addInitScript(app.client, browserScript((input) => {
    window.localStorage.setItem("openwork.den.authToken", input.token);
    window.localStorage.setItem("openwork.den.activeOrgId", input.orgId);
  }, [{ token: member.token, orgId }]));
  await navigate(app.client, gatewayUrl);

  async function revoke() {
    const grants = await denFetch(den.admin, `/v1/inference-providers/${providerId}/access-grants`, {
      headers: orgHeaders(den.admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rows = isRecord(grants.body) && Array.isArray(grants.body.accessGrants) ? grants.body.accessGrants.filter(isRecord) : [];
    const grantId = stringAt(rows[0] ?? null, "id");
    if (!grantId) throw new Error("The Gateway provider access grant was missing.");
    const removed = await denFetch(den.admin, `/v1/inference-providers/${providerId}/access-grants/${grantId}`, {
      method: "DELETE", headers: orgHeaders(den.admin, orgId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (removed.response.status !== 204) throw new Error(`Revoking Gateway access failed: HTTP ${removed.response.status}`);
    await resolveGateway(member, orgId);
  }

  return { app, model, providerId, revoke };
}

const test = spec.world(gatewayWebPicker, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { env: ["DAYTONA_API_KEY", "DAYTONA_SNAPSHOT"] },
});

test("GATEWAY-WEB-02 an entitled Gateway model stays selectable in the hosted-web picker", async ({ world, user, step }) => {
  await user.see("Run task", { timeoutMs: 120_000 });
  await step("the actual hosted-web picker lists the worker's Gateway model", async () => {
    const models = await eventually(() => readAvailableModels(world.app), {
      within: 90_000,
      intervalMs: 2_000,
      label: "Gateway model in hosted-web picker",
      until: (entries) => entries.some((entry) => entry.id === world.model.id),
    });
    expect(models.find((entry) => entry.id === world.model.id), JSON.stringify(models)).toMatchObject({ selectable: true, providerName: PROVIDER_NAME });
    await user.see({ text: PROVIDER_NAME });
    await user.notSee({ text: UNAVAILABLE_COPY });
    await user.looks([
      `The Models dialog shows a provider group named ${PROVIDER_NAME} with an available Claude Fable 5 model row.`,
      "No unavailable-model warning or crash is visible.",
    ]);
  });
  await user.click({ role: "button", label: new RegExp(`^Model\\s+${world.model.name}`) });
  await user.click({ role: "button", label: "Done" });
  await user.reload();
  await user.see("Run task", { timeoutMs: 120_000 });
  await user.see({ role: "button", label: "Change model" }, { text: world.model.name });
  await user.notSee({ text: UNAVAILABLE_COPY });
  await user.looks([
    `After reload, the composer model control still names ${world.model.name}.`,
    "No message says that the selected model is no longer available.",
  ]);

  await world.revoke();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await user.reload();
  await user.see({ text: UNAVAILABLE_COPY }, { timeoutMs: 120_000 });
  await user.looks([
    "After access is revoked, the composer truthfully reports that the previous model is no longer available.",
    `The ${PROVIDER_NAME} model is no longer presented as selectable.`,
  ]);
});
