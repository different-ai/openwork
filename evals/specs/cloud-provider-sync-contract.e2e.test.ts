import { expect, onTestFinished } from "vitest";
import { denFetch, evalIn, go, readAvailableModels, waitFor } from "@openwork/behaviors";
import type { DenSession, ModelFacts } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { app, eventually, needs, server, sleep, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

/**
 * ACCEPTANCE TEST for #3671: org-published LLM providers never finish syncing
 * to member desktops — the settings row sits on "Syncing" forever (suspect:
 * commit 316d364d0's engine-reload guard deferring reloads indefinitely).
 *
 * EXPECTED RED on dev as of 2026-08-11, at claim 1 or claim 2. Every failure
 * message embeds the per-provider /cloud-provider-sync/status payload so a red
 * run discriminates the three failure modes on its own:
 *   - stuck-syncing            -> claim 1 times out; the payload shows which
 *                                 provider never reached a terminal outcome.
 *   - applied-but-engine-empty -> claim 1 green, claim 2 red; status lists the
 *                                 provider (fingerprint recorded as done) but
 *                                 the engine never served its model — the
 *                                 settings row derives "Syncing" from exactly
 *                                 this gap (entitled && !available).
 *   - silent-skip              -> a published provider is absent from status
 *                                 with no failure message anywhere (claims 1/3).
 *
 * Terminal per-provider outcome, derived from the real schema
 * (apps/server/src/cloud-provider-sync.ts:33-69): CloudProviderSyncStatus has
 * hasSession, lastRun { at, status: "applied"|"noop"|"failed", message?,
 * detail? } and providers[] (CloudProviderSyncStatusProvider: cloudProviderId,
 * providerId, sourceProviderId, name, source, updatedAt, modelIds, importedAt).
 * A provider entry only materializes after a successful pass
 * (updateProviderStatus, cloud-provider-sync.ts:781-801), so "terminal" here
 * means: the provider's cloudProviderId is listed AND lastRun settled as
 * applied|noop. Repeated "failed" (or absence) is permanently non-terminal.
 */

const ORGANIZATION_NAME = "Cloud Provider Sync Contract";
const CUSTOM_PROVIDER_NAME = "Sync Contract Custom Models";
const CUSTOM_PROVIDER_KEY = "sync-contract-custom-models";
const CUSTOM_MODEL_ID = "sync-contract-custom-model";
const CATALOG_PROVIDER_NAME = "Sync Contract Catalog Models";
// Same real models.dev catalog entry models-available.e2e.test.ts:37 publishes.
const CATALOG_MODEL_ID = "gpt-5.4";
const REQUEST_TIMEOUT_MS = 10_000;

const TERMINAL_BUDGET_MS = 120_000;
const MODEL_BUDGET_MS = 30_000;
const QUIET_DELAY_MS = 30_000;
const OBSERVATION_WINDOW_MS = 60_000;
// Intended poll cadence: one sync pass per 5 minutes (defaultIntervalMs =
// 5 * 60 * 1_000, apps/server/src/cloud-provider-sync.ts:132; the testkit
// desktop sets no OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS override, so the
// env branch at cloud-provider-sync.ts:481-484 stays on the default). Each
// pass issues exactly ONE GET /v1/llm-providers/:llmProviderId/connect per
// provider (fetchProviders, cloud-provider-sync.ts:294-306), so a 60s window
// holds at most one intended pass -> <=1 connect per provider. 3x headroom:
const CONNECT_BOUND_PER_PROVIDER = 3;
// den-api's access log normalizes the path to the parameterized route
// (ee/apps/den-api/src/observability/hono.ts:66-72), so connect calls cannot
// be split per provider id; every pass touches every provider exactly once,
// which makes per-provider rate = total / provider count.
const CONNECT_ROUTE = "/v1/llm-providers/:llmProviderId/connect";

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `cloud provider sync contract skipped — needs: ${missingRequirements.join(", ")}`
  : "an org-published provider's desktop sync reaches a terminal, truthful status";

interface PublishedProvider {
  cloudId: string;
  name: string;
  modelId: string;
}

interface ProviderStatusEntry {
  cloudProviderId: string;
  providerId: string;
  sourceProviderId: string;
  name: string;
  source: string;
  modelIds: string[];
}

interface SyncStatusFacts {
  hasSession: boolean;
  lastRunStatus: "applied" | "noop" | "failed" | "none";
  lastRunAt: string;
  lastRunMessage: string;
  reloadDeferred: boolean;
  providers: ProviderStatusEntry[];
  raw: Record<string, unknown>;
}

interface ConnectLogEntry {
  timestamp: string;
}

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

async function createProvider(admin: DenSession, orgId: string, body: Record<string, unknown>): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider) ? result.body.llmProvider : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating provider ${JSON.stringify(body.name)} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
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

async function memberVisibleProviderIds(member: DenSession, orgId: string): Promise<string[]> {
  const result = await denFetch(member, "/v1/llm-providers", {
    headers: { ...auth(member), "x-openwork-org-id": orgId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`Listing member-visible providers failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const providers = isRecord(result.body) && Array.isArray(result.body.llmProviders)
    ? result.body.llmProviders.filter(isRecord)
    : [];
  return providers.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
}

function parseSyncStatus(payload: Record<string, unknown>): SyncStatusFacts {
  const lastRun = isRecord(payload.lastRun) ? payload.lastRun : {};
  const detail = isRecord(lastRun.detail) ? lastRun.detail : {};
  const lastRunStatus = lastRun.status === "applied" || lastRun.status === "noop" || lastRun.status === "failed"
    ? lastRun.status
    : "none";
  const providers = Array.isArray(payload.providers) ? payload.providers.filter(isRecord) : [];
  return {
    hasSession: payload.hasSession === true,
    lastRunStatus,
    lastRunAt: typeof lastRun.at === "string" ? lastRun.at : "",
    lastRunMessage: typeof lastRun.message === "string" ? lastRun.message : "",
    reloadDeferred: detail.reloadDeferred === true,
    providers: providers.map((entry) => ({
      cloudProviderId: typeof entry.cloudProviderId === "string" ? entry.cloudProviderId : "",
      providerId: typeof entry.providerId === "string" ? entry.providerId : "",
      sourceProviderId: typeof entry.sourceProviderId === "string" ? entry.sourceProviderId : "",
      name: typeof entry.name === "string" ? entry.name : "",
      source: typeof entry.source === "string" ? entry.source : "",
      modelIds: Array.isArray(entry.modelIds)
        ? entry.modelIds.filter((id): id is string => typeof id === "string")
        : [],
    })),
    raw: payload,
  };
}

// The desktop local server's GET /cloud-provider-sync/status is registered
// with "client" auth (apps/server/src/server.ts:2108), so the renderer's own
// persisted credentials (localStorage openwork.server.port/openwork.server.token)
// reach it with a plain Bearer fetch to 127.0.0.1 — the same access pattern
// subagent-run-survives-provider-sync-storm.e2e.test.ts uses.
async function readSyncStatusPayload(surface: Parameters<typeof evalIn>[0]): Promise<Record<string, unknown>> {
  const value = await evalIn(surface, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return { specProbeError: "missing local server credentials" };
    const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) return { specProbeError: "HTTP " + response.status + " " + (await response.text()).slice(0, 200) };
    return await response.json();
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(value)) {
    throw new Error(`GET /cloud-provider-sync/status returned a non-object: ${JSON.stringify(value)}`);
  }
  if (typeof value.specProbeError === "string") {
    throw new Error(`GET /cloud-provider-sync/status unreachable: ${value.specProbeError}`);
  }
  return value;
}

function connectLogEntries(logText: string): ConnectLogEntry[] {
  const entries: ConnectLogEntry[] = [];
  for (const line of logText.split(/\r?\n/)) {
    // Local-lane api.log interleaves pnpm/tsx chatter with the JSON lines, so
    // parse from the first brace and skip anything that is not a JSON object.
    const start = line.indexOf("{");
    if (start === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.http_route !== CONNECT_ROUTE) continue;
    entries.push({ timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "" });
  }
  return entries;
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Sync Admin" },
      members: { member: { name: "Sync Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The testkit did not provision the organization member.");
  const orgId = await organizationId(den.admin);

  // Both org-wide providers are published BEFORE the desktop boots, so the
  // very first sign-in sync owes the member both of them.
  const customProviderId = await createProvider(den.admin, orgId, {
    name: CUSTOM_PROVIDER_NAME,
    source: "custom",
    customConfig: {
      id: CUSTOM_PROVIDER_KEY,
      name: CUSTOM_PROVIDER_NAME,
      npm: "@ai-sdk/openai-compatible",
      env: ["SYNC_CONTRACT_PROVIDER_API_KEY"],
      models: [{ id: CUSTOM_MODEL_ID, name: "Sync Contract Custom Model" }],
    },
    apiKey: "sk-openwork-sync-contract-eval-only",
    allMembers: true,
    memberIds: [],
    teamIds: [],
  });
  onTestFinished(async () => {
    await deleteProvider(den.admin, orgId, customProviderId).catch(() => undefined);
  });
  const catalogProviderId = await createProvider(den.admin, orgId, {
    name: CATALOG_PROVIDER_NAME,
    source: "models_dev",
    providerId: "openai",
    modelIds: [CATALOG_MODEL_ID],
    apiKey: "sk-openwork-sync-contract-eval-only",
    allMembers: true,
    memberIds: [],
    teamIds: [],
  });
  onTestFinished(async () => {
    await deleteProvider(den.admin, orgId, catalogProviderId).catch(() => undefined);
  });
  const published: PublishedProvider[] = [
    { cloudId: customProviderId, name: CUSTOM_PROVIDER_NAME, modelId: CUSTOM_MODEL_ID },
    { cloudId: catalogProviderId, name: CATALOG_PROVIDER_NAME, modelId: CATALOG_MODEL_ID },
  ];

  // Access-wiring gate, so a red claim 1 can only mean sync: Den itself must
  // already list both providers for this member.
  const grantedIds = await memberVisibleProviderIds(member, orgId);
  for (const provider of published) {
    if (!grantedIds.includes(provider.cloudId)) {
      throw new Error(
        `Setup failed before any sync claim: Den does not list ${provider.name} (${provider.cloudId}) for the member. `
        + `Member-visible provider ids: ${JSON.stringify(grantedIds)}`,
      );
    }
  }

  await using desktopApp = await app({ den, as: "member", place });

  // ── Claim 1: terminal status ────────────────────────────────────────────
  const isTerminal = (status: SyncStatusFacts): boolean =>
    published.every((provider) => status.providers.some((entry) => entry.cloudProviderId === provider.cloudId))
    && (status.lastRunStatus === "applied" || status.lastRunStatus === "noop");
  const terminalDeadline = Date.now() + TERMINAL_BUDGET_MS;
  let latestStatus: SyncStatusFacts | null = null;
  let terminalReached = false;
  let lastStatusReadError = "";
  while (Date.now() < terminalDeadline) {
    try {
      latestStatus = parseSyncStatus(await readSyncStatusPayload(desktopApp));
      if (isTerminal(latestStatus)) {
        terminalReached = true;
        break;
      }
    } catch (error) {
      lastStatusReadError = error instanceof Error ? error.message : String(error);
    }
    await sleep(3_000);
  }
  const terminalSettledAtMs = Date.now();
  const settledStatus = latestStatus;
  if (!settledStatus) {
    throw new Error(
      `GET /cloud-provider-sync/status never returned a readable payload within ${TERMINAL_BUDGET_MS / 1000}s of desktop sign-in`
      + `${lastStatusReadError ? ` (last error: ${lastStatusReadError})` : ""}; no sync claim was reached.`,
    );
  }
  const absentFromStatus = published
    .filter((provider) => !settledStatus.providers.some((entry) => entry.cloudProviderId === provider.cloudId))
    .map((provider) => `${provider.name} (${provider.cloudId})`);
  evidence.recordAssertionEvidence(
    "Both org-published providers reach a terminal per-provider sync outcome within 120s",
    `Published ${JSON.stringify(published.map((provider) => provider.cloudId))}; latest /cloud-provider-sync/status: ${JSON.stringify(settledStatus.raw)}`,
    terminalReached,
  );
  expect(terminalReached, [
    "Claim 1 (terminal status): every Den-granted provider must appear in /cloud-provider-sync/status providers[] with a settled run (lastRun applied|noop) within 120s; a provider may not stay absent or permanently non-terminal.",
    `Still absent from status: ${JSON.stringify(absentFromStatus)}; lastRun status: ${settledStatus.lastRunStatus}${settledStatus.lastRunMessage ? ` (${settledStatus.lastRunMessage})` : ""}.`,
    `Latest status payload: ${JSON.stringify(settledStatus.raw)}`,
  ].join("\n")).toBe(true);

  // ── Claim 2: truthfulness — a status entry means the engine serves it ───
  const syncedProviders = published.filter((provider) =>
    settledStatus.providers.some((entry) => entry.cloudProviderId === provider.cloudId));
  const expectedModelIds = syncedProviders.map((provider) => provider.modelId);
  let lastModels: ModelFacts[] = [];
  const modelsArrived = await eventually(async () => {
    lastModels = await readAvailableModels(desktopApp);
    return lastModels;
  }, {
    within: MODEL_BUDGET_MS,
    intervalMs: 3_000,
    label: "engine models for status-synced providers",
    until: (models) => expectedModelIds.every((id) => models.some((model) => model.id === id)),
  }).then(() => true, () => false);
  const missingModelIds = expectedModelIds.filter((id) => !lastModels.some((model) => model.id === id));
  evidence.recordAssertionEvidence(
    "Every provider the sync status lists actually contributes its model to the engine within 30s",
    `Status-synced providers claim ${JSON.stringify(expectedModelIds)}; engine picker ids: ${JSON.stringify(lastModels.map((model) => model.id))}`,
    modelsArrived,
  );
  expect(modelsArrived, [
    "Claim 2 (truthfulness): the sync status lists these providers, but the engine never served their models within 30s — the fingerprint was recorded as done while the engine was never reloaded (the stuck-'Syncing' settings row).",
    `Missing model ids: ${JSON.stringify(missingModelIds)}.`,
    `Status entries for the published providers: ${JSON.stringify(settledStatus.providers.filter((entry) => published.some((provider) => provider.cloudId === entry.cloudProviderId)))}.`,
    `Latest status payload: ${JSON.stringify(settledStatus.raw)}`,
    `Engine picker models: ${JSON.stringify(lastModels)}`,
  ].join("\n")).toBe(true);

  // readAvailableModels leaves the picker dialog open; close it through its
  // own close control so later claims observe a calm, unobstructed app.
  await evalIn(desktopApp, `(() => {
    const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (close instanceof HTMLElement) close.click();
    return true;
  })()`);
  await waitFor(desktopApp, `!document.querySelector('[data-slot="dialog-content"]')`, {
    timeoutMs: 15_000,
    label: "model picker dialog closed",
  });

  // ── Claim 3: loud skips — a dropped provider must name itself ───────────
  // The schema (apps/server/src/cloud-provider-sync.ts:38-69) carries no
  // per-provider skipped/errored state: its only error carrier is
  // lastRun.status="failed" plus lastRun.message, and a skipped provider
  // manifests as absence from providers[] (prepareMaterialization silently
  // drops entries without env matches, cloud-provider-sync.ts:414-426). The
  // loud-skip contract at this schema is therefore: a failed run must carry a
  // non-empty message, and a published provider absent from status is only
  // acceptable when such an explaining failure exists.
  const currentStatus = parseSyncStatus(await readSyncStatusPayload(desktopApp));
  const droppedNow = published
    .filter((provider) => !currentStatus.providers.some((entry) => entry.cloudProviderId === provider.cloudId))
    .map((provider) => `${provider.name} (${provider.cloudId})`);
  const failureExplained = currentStatus.lastRunStatus !== "failed" || currentStatus.lastRunMessage.trim().length > 0;
  const dropsExplained = droppedNow.length === 0
    || (currentStatus.lastRunStatus === "failed" && currentStatus.lastRunMessage.trim().length > 0);
  const loudSkips = failureExplained && dropsExplained;
  evidence.recordAssertionEvidence(
    "No provider is skipped or errored silently: failures carry a reason and drops are explained",
    `Dropped from status: ${JSON.stringify(droppedNow)}; lastRun: ${currentStatus.lastRunStatus}${currentStatus.lastRunMessage ? ` (${currentStatus.lastRunMessage})` : " (no message)"}; payload: ${JSON.stringify(currentStatus.raw)}`,
    loudSkips,
  );
  expect(loudSkips, [
    "Claim 3 (loud skips): a failed sync run must carry a non-empty message, and a published provider missing from status must be accompanied by such an explained failure — never silently dropped.",
    `Dropped without explanation: ${JSON.stringify(droppedNow)}; lastRun status: ${currentStatus.lastRunStatus}; message: ${JSON.stringify(currentStatus.lastRunMessage)}.`,
    `Latest status payload: ${JSON.stringify(currentStatus.raw)}`,
  ].join("\n")).toBe(true);

  // ── Claim 4: calm loop — the settled sync must not hammer den-api ───────
  // Observation window: >=30s after claim 1 settled, then 60s wide. The
  // window is bounded by two den.apiLog() snapshots (count diffing), so the
  // sandbox/driver clock skew cannot bend it; the JSON lines' own timestamps
  // travel into the failure message to pin any ~500ms hammering bursts.
  const sinceSettleMs = Date.now() - terminalSettledAtMs;
  if (sinceSettleMs < QUIET_DELAY_MS) await sleep(QUIET_DELAY_MS - sinceSettleMs);
  const connectsBefore = connectLogEntries(await den.apiLog());
  await sleep(OBSERVATION_WINDOW_MS);
  const connectsAfter = connectLogEntries(await den.apiLog());
  const windowConnectCount = connectsAfter.length - connectsBefore.length;
  const windowTimestamps = connectsAfter.slice(connectsBefore.length).map((entry) => entry.timestamp);
  const connectBound = CONNECT_BOUND_PER_PROVIDER * published.length;
  const calmLoop = windowConnectCount >= 0 && windowConnectCount <= connectBound;
  const statusAfterWindow = parseSyncStatus(await readSyncStatusPayload(desktopApp));
  evidence.recordAssertionEvidence(
    "The settled sync loop polls at its intended cadence instead of hammering /connect",
    `${windowConnectCount} ${CONNECT_ROUTE} calls in a ${OBSERVATION_WINDOW_MS / 1000}s window across ${published.length} providers `
    + `(bound ${connectBound} = ${CONNECT_BOUND_PER_PROVIDER}/provider from the 5-minute cadence at apps/server/src/cloud-provider-sync.ts:132); `
    + `window call timestamps: ${JSON.stringify(windowTimestamps)}`,
    calmLoop,
  );
  expect(calmLoop, [
    `Claim 4 (calm loop): a settled sync intends <=1 pass (one /connect per provider) per 60s window at the 5-minute cadence (apps/server/src/cloud-provider-sync.ts:132); observed ${windowConnectCount} connect calls against a 3x-headroom bound of ${connectBound} (log counts ${connectsBefore.length} -> ${connectsAfter.length}).`,
    `Window call timestamps (pins list+connect rounds landing within ~500ms): ${JSON.stringify(windowTimestamps)}.`,
    `Latest status payload: ${JSON.stringify(statusAfterWindow.raw)}`,
  ].join("\n")).toBe(true);

  // ── Claim 5: the settings surface stands, bug present or fixed ──────────
  const settingsRoute = `/workspace/${desktopApp.workspaceId}/settings/cloud-providers`;
  await go(desktopApp, settingsRoute);
  await waitFor(desktopApp, `(() => {
    if (!window.location.hash.includes('/settings/cloud-providers')) {
      window.location.hash = ${JSON.stringify(`#${settingsRoute}`)};
      return false;
    }
    return /provider/i.test(document.body.innerText);
  })()`, { timeoutMs: 60_000, label: "cloud providers settings surface" });
  const shot = await screenshot(desktopApp);
  const seen = await validate(shot, [
    "The workspace settings cloud providers surface is visible",
    "No crash text such as 'Something went wrong' is visible",
  ]);
  evidence.recordAssertionEvidence(
    "The cloud providers settings surface renders without crashing",
    `Validated at ${settingsRoute}: ${seen.ok ? "ok" : seen.why}`,
    seen.ok,
  );
  expect(seen.ok, `${seen.why}\nLatest status payload: ${JSON.stringify(statusAfterWindow.raw)}`).toBe(true);
});
