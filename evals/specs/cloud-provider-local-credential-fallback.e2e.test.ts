import { expect, onTestFinished } from "vitest";
import { denFetch, evalIn, go, readAvailableModels, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, eventually, needs, server, test } from "@openwork/testkit";

const ORGANIZATION_NAME = "Cloud Provider Local Credential Fallback";
const PROVIDER_NAME = "Local Credential Models";
const PROVIDER_KEY = "local-credential-models";
const PROVIDER_ENV = "LOCAL_CREDENTIAL_FALLBACK_API_KEY";
const ALLOWED_MODEL_ID = "local-credential-allowed-model";
const DENIED_PROVIDER_NAME = "Unassigned Local Credential Models";
const DENIED_PROVIDER_KEY = "unassigned-local-credential-models";
const DENIED_MODEL_ID = "local-credential-denied-model";
const LOCAL_SECRET = "sk-local-credential-eval-only";
const MISMATCHED_ENV = "MISMATCHED_LOCAL_CREDENTIAL_API_KEY";
const REQUEST_TIMEOUT_MS = 10_000;

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
  if (!result.response.ok || !id) throw new Error(`Finding the test organization failed with HTTP ${result.response.status}.`);
  return id;
}

async function createProvider(
  admin: DenSession,
  orgId: string,
  input: { name: string; providerKey: string; modelId: string; allMembers: boolean },
): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name: input.name,
      source: "custom",
      customConfig: {
        id: input.providerKey,
        name: input.name,
        npm: "@ai-sdk/openai-compatible",
        env: [PROVIDER_ENV],
        models: [{ id: input.modelId, name: input.modelId }],
      },
      allMembers: input.allMembers,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider) ? result.body.llmProvider : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating ${input.name} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
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

async function memberProviderList(member: DenSession, orgId: string): Promise<Record<string, unknown>[]> {
  const result = await denFetch(member, "/v1/llm-providers", {
    headers: { ...auth(member), "x-openwork-org-id": orgId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) throw new Error(`Listing member providers failed with HTTP ${result.response.status}.`);
  return isRecord(result.body) && Array.isArray(result.body.llmProviders)
    ? result.body.llmProviders.filter(isRecord)
    : [];
}

async function localServerRequest(
  surface: Parameters<typeof evalIn>[0],
  path: string,
  input: { method?: string; body?: Record<string, unknown>; host?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const value = await evalIn(surface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { status: 0, body: { error: "local_server_unavailable" } };
    const headers = { "content-type": "application/json" };
    if (${input.host === true}) headers["x-openwork-host-token"] = String(info.hostToken ?? "");
    else headers.authorization = "Bearer " + String(info.ownerToken ?? info.clientToken ?? "");
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(input.method ?? "GET")},
      headers,
      body: ${input.body ? JSON.stringify(JSON.stringify(input.body)) : "undefined"},
    });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(value) || typeof value.status !== "number") {
    throw new Error(`Invalid local server response for ${path}: ${JSON.stringify(value)}`);
  }
  return { status: value.status, body: value.body };
}

async function runSync(surface: Parameters<typeof evalIn>[0], reason: string): Promise<Record<string, unknown>> {
  const result = await localServerRequest(surface, "/cloud-provider-sync/run", {
    method: "POST",
    host: true,
    body: { reason },
  });
  if (result.status !== 200 || !isRecord(result.body)) {
    throw new Error(`Provider sync failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function readSyncStatus(surface: Parameters<typeof evalIn>[0]): Promise<Record<string, unknown>> {
  const result = await localServerRequest(surface, "/cloud-provider-sync/status");
  if (result.status !== 200 || !isRecord(result.body)) {
    throw new Error(`Reading provider sync status failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

function providerIds(status: Record<string, unknown>): string[] {
  return Array.isArray(status.providers)
    ? status.providers.filter(isRecord).flatMap((provider) => (
        typeof provider.cloudProviderId === "string" ? [provider.cloudProviderId] : []
      ))
    : [];
}

function skipReason(status: Record<string, unknown>, providerId: string): string | null {
  const skipped = Array.isArray(status.skippedProviders) ? status.skippedProviders.filter(isRecord) : [];
  const provider = skipped.find((entry) => entry.cloudProviderId === providerId);
  return provider && typeof provider.reason === "string" ? provider.reason : null;
}

async function waitForProviderRow(
  surface: Parameters<typeof evalIn>[0],
  workspaceId: string,
  statusLabel: string,
): Promise<void> {
  const route = `/workspace/${workspaceId}/settings/cloud-providers`;
  await go(surface, `/workspace/${workspaceId}/session`);
  await go(surface, route);
  await waitFor(surface, `(() => {
    const title = [...document.querySelectorAll("span")]
      .find((element) => (element.textContent ?? "").trim() === ${JSON.stringify(PROVIDER_NAME)});
    const row = title?.parentElement?.parentElement?.parentElement;
    return Boolean(row && (row.textContent ?? "").includes(${JSON.stringify(statusLabel)}));
  })()`, { timeoutMs: 120_000, label: `${PROVIDER_NAME} row shows ${statusLabel}` });
}

async function closeModelPicker(surface: Parameters<typeof evalIn>[0]): Promise<void> {
  await evalIn(surface, `(() => {
    const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (close instanceof HTMLElement) close.click();
    return true;
  })()`);
  await waitFor(surface, `!document.querySelector('[data-slot="dialog-content"]')`, {
    timeoutMs: 15_000,
    label: "model picker closed",
  });
}

test("a Den provider can use a matching local Desktop credential without giving Den ownership", {
  timeout: 15 * 60_000,
}, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Provider Admin" },
      members: { member: { name: "Provider Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The testkit did not provision the organization member.");
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, {
    name: PROVIDER_NAME,
    providerKey: PROVIDER_KEY,
    modelId: ALLOWED_MODEL_ID,
    allMembers: true,
  });
  const deniedProviderId = await createProvider(den.admin, orgId, {
    name: DENIED_PROVIDER_NAME,
    providerKey: DENIED_PROVIDER_KEY,
    modelId: DENIED_MODEL_ID,
    allMembers: false,
  });
  onTestFinished(async () => {
    await Promise.all([
      deleteProvider(den.admin, orgId, providerId),
      deleteProvider(den.admin, orgId, deniedProviderId),
    ]).catch(() => undefined);
  });

  const visibleProviders = await memberProviderList(member, orgId);
  const visibleProviderIds = visibleProviders.flatMap((provider) => (
    typeof provider.id === "string" ? [provider.id] : []
  ));
  const visibleProvider = visibleProviders.find((provider) => provider.id === providerId);
  expect(visibleProvider?.hasApiKey).toBe(false);
  expect(visibleProviderIds).toContain(providerId);
  expect(visibleProviderIds).not.toContain(deniedProviderId);

  await using desktopApp = await app({ den, as: "member", place });
  expect((await localServerRequest(desktopApp, "/den-session", {
    method: "PUT",
    host: true,
    body: { baseUrl: den.ref.apiUrl, token: member.token, orgId },
  })).status).toBe(204);
  await runSync(desktopApp, "initial-missing-local-credential");

  const initialStatus = await readSyncStatus(desktopApp);
  const initiallyMissing = !providerIds(initialStatus).includes(providerId)
    && skipReason(initialStatus, providerId) === "missing_credentials";
  evidence.recordAssertionEvidence(
    "A credential-less Den provider starts in the missing-credential state",
    `Provider materialized: ${providerIds(initialStatus).includes(providerId)}; skip reason: ${skipReason(initialStatus, providerId)}`,
    initiallyMissing,
  );
  expect(initiallyMissing).toBe(true);
  await waitForProviderRow(desktopApp, desktopApp.workspaceId, "Needs organization credential");

  expect((await localServerRequest(desktopApp, "/env", {
    method: "PUT",
    host: true,
    body: { entries: [{ key: MISMATCHED_ENV, value: "sk-mismatched-eval-only" }] },
  })).status).toBe(200);
  await runSync(desktopApp, "mismatched-local-credential");
  const mismatchedStatus = await readSyncStatus(desktopApp);
  const mismatchRejected = !providerIds(mismatchedStatus).includes(providerId)
    && skipReason(mismatchedStatus, providerId) === "missing_credentials";
  evidence.recordAssertionEvidence(
    "An unrelated local environment variable cannot unlock the provider",
    `Provider materialized: ${providerIds(mismatchedStatus).includes(providerId)}; skip reason: ${skipReason(mismatchedStatus, providerId)}`,
    mismatchRejected,
  );
  expect(mismatchRejected).toBe(true);

  expect((await localServerRequest(desktopApp, "/env", {
    method: "PUT",
    host: true,
    body: { entries: [{ key: PROVIDER_ENV, value: LOCAL_SECRET }] },
  })).status).toBe(200);
  await runSync(desktopApp, "matching-local-credential");
  const connectedStatus = await eventually(() => readSyncStatus(desktopApp), {
    within: 60_000,
    intervalMs: 2_000,
    label: "local credential provider materialized",
    until: (status) => providerIds(status).includes(providerId) && skipReason(status, providerId) === null,
  });
  await waitForProviderRow(desktopApp, desktopApp.workspaceId, "Connected");
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  const models = await eventually(() => readAvailableModels(desktopApp), {
    within: 60_000,
    intervalMs: 2_000,
    label: "Den-allowed local credential model",
    until: (candidates) => candidates.some((candidate) => candidate.id === ALLOWED_MODEL_ID && candidate.selectable),
  });
  const allowedModelPresent = models.some((model) => model.id === ALLOWED_MODEL_ID && model.selectable);
  const deniedModelAbsent = !models.some((model) => model.id === DENIED_MODEL_ID);
  evidence.recordAssertionEvidence(
    "The matching local credential connects only the provider and model granted by Den",
    `Allowed model selectable: ${allowedModelPresent}; unassigned model present: ${!deniedModelAbsent}`,
    providerIds(connectedStatus).includes(providerId) && allowedModelPresent && deniedModelAbsent,
  );
  expect(allowedModelPresent).toBe(true);
  expect(deniedModelAbsent).toBe(true);
  await closeModelPicker(desktopApp);

  const savedCredential = await localServerRequest(desktopApp, `/env/${PROVIDER_ENV}`, { host: true });
  const savedItem = isRecord(savedCredential.body) && isRecord(savedCredential.body.item)
    ? savedCredential.body.item
    : {};
  expect(savedItem.value).toBe(LOCAL_SECRET);
  expect(JSON.stringify(connectedStatus)).not.toContain(LOCAL_SECRET);
  expect(await den.apiLog()).not.toContain(LOCAL_SECRET);

  expect((await localServerRequest(desktopApp, "/den-session", { method: "DELETE", host: true })).status).toBe(204);
  const afterCloudCleanup = await localServerRequest(desktopApp, `/env/${PROVIDER_ENV}`, { host: true });
  const cleanupItem = isRecord(afterCloudCleanup.body) && isRecord(afterCloudCleanup.body.item)
    ? afterCloudCleanup.body.item
    : {};
  const localCredentialPreserved = cleanupItem.value === LOCAL_SECRET;
  evidence.recordAssertionEvidence(
    "Cloud cleanup neither rewrites nor removes the locally saved credential",
    `The exact local value remained present after DELETE /den-session: ${localCredentialPreserved}`,
    localCredentialPreserved,
  );
  expect(localCredentialPreserved).toBe(true);

  expect((await localServerRequest(desktopApp, "/den-session", {
    method: "PUT",
    host: true,
    body: { baseUrl: den.ref.apiUrl, token: member.token, orgId },
  })).status).toBe(204);
  await runSync(desktopApp, "restore-after-cloud-cleanup");
  expect(providerIds(await readSyncStatus(desktopApp))).toContain(providerId);

  expect((await localServerRequest(desktopApp, `/env/${PROVIDER_ENV}`, {
    method: "DELETE",
    host: true,
  })).status).toBe(200);
  await runSync(desktopApp, "matching-local-credential-removed");
  const removedStatus = await eventually(() => readSyncStatus(desktopApp), {
    within: 60_000,
    intervalMs: 2_000,
    label: "provider returns to missing credential",
    until: (status) => !providerIds(status).includes(providerId)
      && skipReason(status, providerId) === "missing_credentials",
  });
  await waitForProviderRow(desktopApp, desktopApp.workspaceId, "Needs organization credential");
  const returnedToMissing = !providerIds(removedStatus).includes(providerId)
    && skipReason(removedStatus, providerId) === "missing_credentials";
  evidence.recordAssertionEvidence(
    "Removing the local credential returns the provider to missing",
    `Provider materialized: ${providerIds(removedStatus).includes(providerId)}; skip reason: ${skipReason(removedStatus, providerId)}; UI label: Needs organization credential`,
    returnedToMissing,
  );
  expect(returnedToMissing).toBe(true);
});
