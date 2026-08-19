import { expect } from "vitest";
import {
  createAndSelectWorkspace,
  denFetch,
  evalIn,
  fill,
  go,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  waitFor,
  waitForAssistantReply,
} from "@openwork/behaviors";
import type { DenSession, ModelFacts } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop as launchDesktop } from "@openwork/hosts";
import {
  eventually,
  liteLlm,
  needs,
  server,
  SkipError,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const ORGANIZATION_NAME = "Den Lab";
const PROVIDER_NAME = "LiteLLM Gateway";
const PROVIDER_KEY = "openwork-litellm-witness";
const MODEL_ID = "openwork-litellm-witness-model";
const MODEL_NAME = "Witness Model";
const PROVIDER_ENV = "LITELLM_WITNESS_API_KEY";
const REPLY = "The deterministic LiteLLM route is working.";
const REQUEST_TIMEOUT_MS = 10_000;
const TEST_CONNECTION_TIMEOUT_MS = 60_000;
const placementCommand = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1" ? "daytona" : "docker";
const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: [placementCommand] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Den LiteLLM provider route skipped — needs: ${missingRequirements.join(", ")}`
  : "a Den provider syncs to desktop and reaches its upstream through LiteLLM";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
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

async function testConnection(admin: DenSession, orgId: string, baseUrl: string, apiKey: string): Promise<Record<string, unknown>> {
  const response = await denFetch(admin, "/v1/llm-providers/test-connection", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({ api: baseUrl, apiKey, modelIds: [MODEL_ID] }),
    signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
  });
  if (!response.response.ok || !isRecord(response.body)) {
    throw new Error(`Testing the LiteLLM connection failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  return response.body;
}

async function createProvider(admin: DenSession, orgId: string, baseUrl: string, apiKey: string): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
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
      apiKey,
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider) ? result.body.llmProvider : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating the LiteLLM provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function deleteProvider(admin: DenSession, orgId: string, providerId: string): Promise<void> {
  await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

interface SyncFacts {
  lastRunStatus: string;
  lastRunMessage: string;
  providerIds: string[];
  skippedProviders: unknown[];
  raw: Record<string, unknown>;
}

async function readSyncStatus(desktop: Parameters<typeof evalIn>[0]): Promise<SyncFacts> {
  const value = await evalIn(desktop, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return { error: "missing local server credentials" };
    const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { error: "HTTP " + response.status };
    return await response.json();
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  if (!isRecord(value) || typeof value.error === "string") {
    throw new Error(`Reading cloud provider sync status failed: ${JSON.stringify(value)}`);
  }
  const lastRun = isRecord(value.lastRun) ? value.lastRun : {};
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : [];
  return {
    lastRunStatus: typeof lastRun.status === "string" ? lastRun.status : "",
    lastRunMessage: typeof lastRun.message === "string" ? lastRun.message : "",
    providerIds: providers.flatMap((provider) => typeof provider.cloudProviderId === "string" ? [provider.cloudProviderId] : []),
    skippedProviders: Array.isArray(value.skippedProviders) ? value.skippedProviders : [],
    raw: value,
  };
}

async function runDirectProviderSync(
  desktop: Parameters<typeof evalIn>[0],
  input: { baseUrl: string; token: string; orgId: string },
): Promise<Record<string, unknown>> {
  const value = await evalIn(desktop, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl || !info.hostToken) return { error: "local_server_unavailable" };
    const request = async (path, method, body) => {
      const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + path, {
        method,
        headers: {
          Authorization: "Bearer " + String(info.hostToken),
          "Content-Type": "application/json",
          "x-openwork-host-token": String(info.hostToken),
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let payload = text;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      return { status: response.status, body: payload };
    };
    const session = await request("/den-session", "PUT", ${JSON.stringify(input)});
    if (session.status !== 204) return { error: "den_session_failed", session };
    const sync = await request("/cloud-provider-sync/run", "POST", { reason: "eval_litellm_provider" });
    if (sync.status !== 200) return { error: "sync_run_failed", sync };
    return sync.body;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(value) || typeof value.error === "string") {
    throw new Error(`Triggering direct provider sync failed: ${JSON.stringify(value)}`);
  }
  return value;
}

async function seedRendererDenSession(
  desktop: Parameters<typeof evalIn>[0],
  input: { token: string; orgId: string; webUrl: string },
): Promise<void> {
  const value = await evalIn(desktop, `(async () => {
    const { seedDenDesktopConfigConnectPolicy, writeDenSettings } = await import("/src/app/lib/den.ts");
    const { dispatchDenSessionUpdated } = await import("/src/app/lib/den-session-events.ts");
    writeDenSettings({
      baseUrl: ${JSON.stringify(input.webUrl)},
      authToken: ${JSON.stringify(input.token)},
      activeOrgId: ${JSON.stringify(input.orgId)},
      activeOrgSlug: null,
      activeOrgName: ${JSON.stringify(ORGANIZATION_NAME)},
    });
    seedDenDesktopConfigConnectPolicy({
      organizationId: ${JSON.stringify(input.orgId)},
      connectEnabled: true,
    });
    dispatchDenSessionUpdated({
      status: "success",
      baseUrl: ${JSON.stringify(input.webUrl)},
      token: ${JSON.stringify(input.token)},
      user: null,
      email: null,
    });
    return { ok: true };
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (!isRecord(value) || value.ok !== true) {
    throw new Error(`Seeding the renderer Den session failed: ${JSON.stringify(value)}`);
  }
  await waitFor(desktop, "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 45_000,
    label: "persisted Den auth token after session seed",
  });
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("The LiteLLM provider proof requires a cold managed Den");
  }

  await using gateway = await liteLlm({ place, modelId: MODEL_ID, reply: REPLY });
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Provider Admin" },
      members: { member: { name: "Provider Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The cold managed Den did not provision the member.");
  const orgId = await organizationId(den.admin);
  const probeCheckpoint = await gateway.checkpoint();
  const probeResponse = await testConnection(den.admin, orgId, gateway.baseUrl, gateway.apiKey);
  const probeResult = isRecord(probeResponse.result) ? probeResponse.result : {};
  const discoveredModels = Array.isArray(probeResult.models) ? probeResult.models.filter(isRecord) : [];
  const verifications = Array.isArray(probeResponse.verifications) ? probeResponse.verifications.filter(isRecord) : [];
  const verification = verifications.find((entry) => entry.id === MODEL_ID);
  expect(probeResult.ok).toBe(true);
  expect(discoveredModels.some((entry) => entry.id === MODEL_ID)).toBe(true);
  expect(verification?.status).toBe("ok");

  const probeRequest = await gateway.waitForUpstreamRequest({
    after: probeCheckpoint,
    model: MODEL_ID,
    key: gateway.upstreamKey,
    timeoutMs: 120_000,
  });
  const probeRequests = await gateway.upstreamRequests({ after: probeCheckpoint });
  const probeUsedUpstreamKey = probeRequest.tokenId === gateway.tokenId(gateway.upstreamKey);
  const probeMasterKeyReachedUpstream = probeRequests
    .some((request) => request.tokenId === gateway.tokenId(gateway.apiKey));
  evidence.recordAssertionEvidence(
    "Den verified the discovered LiteLLM model through the deterministic upstream",
    `The endpoint probe discovered ${MODEL_ID}, verification was ${String(verification?.status)}, and upstream sequence ${probeRequest.sequence} carried only the rewritten token fingerprint.`,
    probeResult.ok === true
      && discoveredModels.some((entry) => entry.id === MODEL_ID)
      && verification?.status === "ok"
      && probeUsedUpstreamKey
      && !probeMasterKeyReachedUpstream,
  );
  expect(probeUsedUpstreamKey).toBe(true);
  expect(probeMasterKeyReachedUpstream).toBe(false);

  const cloudProviderId = await createProvider(den.admin, orgId, gateway.baseUrl, gateway.apiKey);
  await using publishedProvider = {
    async [Symbol.asyncDispose]() {
      await deleteProvider(den.admin, orgId, cloudProviderId).catch(() => undefined);
    },
  };
  await using desktop = await launchDesktop({
    name: "den-litellm-provider",
    host: place.host(),
    bootstrap: {
      baseUrl: den.ref.webUrl,
      apiBaseUrl: den.ref.webUrl,
      requireSignin: false,
    },
  });
  await seedRendererDenSession(desktop, {
    token: member.token,
    orgId,
    webUrl: den.ref.webUrl,
  });
  await runDirectProviderSync(desktop, { baseUrl: den.ref.apiUrl, token: member.token, orgId });

  const sync = await eventually(() => readSyncStatus(desktop), {
    within: 120_000,
    intervalMs: 2_000,
    label: "terminal LiteLLM provider sync",
    until: (status) => status.lastRunStatus === "failed"
      || (status.providerIds.includes(cloudProviderId)
        && (status.lastRunStatus === "applied" || status.lastRunStatus === "noop")),
  });
  const synced = sync.providerIds.includes(cloudProviderId)
    && (sync.lastRunStatus === "applied" || sync.lastRunStatus === "noop");
  evidence.recordAssertionEvidence(
    "Den's custom provider reached a terminal desktop sync outcome",
    `Provider appeared in sync status with lastRun=${sync.lastRunStatus}; payload: ${JSON.stringify(sync.raw)}`,
    synced,
  );
  expect(synced, `Cloud provider sync failed: ${sync.lastRunMessage || "no message"}; skipped: ${JSON.stringify(sync.skippedProviders)}; payload: ${JSON.stringify(sync.raw)}`).toBe(true);
  const { workspaceId } = await createAndSelectWorkspace(desktop, { path: "/tmp/litellm-demo" });
  await desktop.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await go(desktop, `/workspace/${workspaceId}/session`);
  await waitFor(desktop, "Boolean(window.__openworkControl)", {
    timeoutMs: 120_000,
    label: "desktop session control",
  });

  const models = await eventually(() => readAvailableModels(desktop), {
    within: 60_000,
    intervalMs: 2_000,
    label: "selectable LiteLLM witness model",
    until: (available) => available.some((model) => model.selectable && (model.id === MODEL_ID || model.id.endsWith(`/${MODEL_ID}`))),
  });
  const model = models.find((candidate) => candidate.selectable && (candidate.id === MODEL_ID || candidate.id.endsWith(`/${MODEL_ID}`)));
  const modelAvailable = model !== undefined;
  evidence.recordAssertionEvidence(
    "The synced provider's model became selectable in the desktop",
    `Selectable model ids: ${JSON.stringify(models.filter((candidate) => candidate.selectable).map((candidate) => candidate.id))}`,
    modelAvailable,
  );
  expect(modelAvailable).toBe(true);
  if (!model) throw new Error("The LiteLLM witness model was not selectable.");
  await fill(desktop, 'input[placeholder="Search providers and models..."]', MODEL_NAME);
  await waitFor(desktop, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    return Boolean(dialog
      && dialog.innerText.includes(${JSON.stringify(PROVIDER_NAME)})
      && dialog.innerText.includes(${JSON.stringify(MODEL_NAME)}));
  })()`, { timeoutMs: 30_000, label: "LiteLLM provider and model in picker" });
  const pickerLayout = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const model = [...(dialog?.querySelectorAll("button") ?? [])].find((element) =>
      (element.textContent ?? "").includes(${JSON.stringify(MODEL_NAME)}));
    const rect = model?.getBoundingClientRect();
    return {
      dialogVisible: Boolean(dialog && dialog.getBoundingClientRect().height > 100),
      modelVisible: Boolean(rect && rect.width > 0 && rect.height > 0
        && rect.top >= 0 && rect.bottom <= window.innerHeight),
    };
  })()`);
  const pickerReady = isRecord(pickerLayout)
    && pickerLayout.dialogVisible === true
    && pickerLayout.modelVisible === true;
  evidence.recordAssertionEvidence(
    "The Den-managed LiteLLM model is structurally visible in the model picker",
    `Model picker layout probe: ${JSON.stringify(pickerLayout)}`,
    pickerReady,
  );
  expect(pickerReady).toBe(true);
  const pickerShot = await screenshot(desktop);
  const pickerSeen = await validate(pickerShot, [
    `The model picker visibly shows provider ${PROVIDER_NAME} and model ${MODEL_NAME}`,
    "The LiteLLM model is presented as selectable, without unavailable, credential, syncing, or error text",
    "The model picker is polished and legible with no overlap, clipping, blank panel, or stray overlay",
  ]);
  expect(pickerSeen.ok, pickerSeen.why).toBe(true);
  const selected: ModelFacts = await selectModel(desktop, model.id);
  expect(selected.selected).toBe(true);

  const prompt = "Please answer with one short sentence confirming this test route works.";
  expect(prompt).not.toContain(PROVIDER_KEY);
  expect(prompt).not.toContain(MODEL_ID);
  expect(prompt).not.toContain(orgId);
  const desktopCheckpoint = await gateway.checkpoint();
  await sendComposerMessage(desktop, prompt);
  const upstreamRequest = await gateway.waitForUpstreamRequest({
    after: desktopCheckpoint,
    model: MODEL_ID,
    key: gateway.upstreamKey,
    timeoutMs: 120_000,
  });
  const requestUsedUpstreamKey = upstreamRequest.tokenId === gateway.tokenId(gateway.upstreamKey);
  const requestContainsPrompt = upstreamRequest.bodyText.includes(prompt);
  const masterKeyReachedUpstream = (await gateway.upstreamRequests({ after: desktopCheckpoint }))
    .some((request) => request.tokenId === gateway.tokenId(gateway.apiKey));
  evidence.recordAssertionEvidence(
    "The desktop request traversed LiteLLM and LiteLLM rewrote the bearer key for the deterministic upstream",
    `Upstream saw model ${upstreamRequest.model}, token fingerprint ${upstreamRequest.tokenId}, and no master-key fingerprint after submission.`,
    requestUsedUpstreamKey && requestContainsPrompt && !masterKeyReachedUpstream,
  );
  expect(requestContainsPrompt).toBe(true);
  expect(requestUsedUpstreamKey).toBe(true);
  expect(masterKeyReachedUpstream).toBe(false);

  await waitFor(desktop, `([...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => (message.innerText ?? "").includes(${JSON.stringify(REPLY)})))`, {
    timeoutMs: 120_000,
    label: "complete deterministic LiteLLM reply",
  });
  const assistant = await waitForAssistantReply(desktop, { timeoutMs: 10_000 });
  const rendered = assistant.text.includes(REPLY);
  evidence.recordAssertionEvidence(
    "The deterministic upstream reply rendered in the desktop conversation",
    `Latest assistant message contained ${JSON.stringify(REPLY)}.`,
    rendered,
  );
  expect(rendered).toBe(true);
});
