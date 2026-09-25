import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { BadRequestError, ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { createClient } from "../src/app/lib/opencode";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { t } from "../src/i18n";
import {
  createProviderAuthStore,
  useProviderAuthStoreSnapshot,
  type ProviderAuthStore,
} from "../src/react-app/domains/connections/provider-auth/store";
import { AiSettingsView } from "../src/react-app/domains/settings/pages/ai-view";
import {
  clearProviderListQueries,
  ensureProviderListQuery,
  providerListQueryKey,
} from "../src/react-app/infra/provider-list-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const secret = "fixture-secret-do-not-display";
const privatePath = `/fixture/${secret}/opencode.jsonc`;
const incompatibleMessage = "V2 permissions are not supported by OpenCode V1";
const provider: ProviderListItem = { id: "openai", name: "OpenAI", source: "api", env: [], models: {} };
const stores: ProviderAuthStore[] = [];

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function deferredResponse() {
  let resolve: (value: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness() {
  const engine: {
    config: Record<string, unknown>;
    catalog: ProviderListResponse;
    readConfig: () => Response | Promise<Response>;
    readProviders: () => Response | Promise<Response>;
  } = {
    config: { disabled_providers: ["disabled-existing"], permission: { bash: "ask" } },
    catalog: { all: [provider], connected: [provider.id], default: { openai: "fixture-model" } },
    readConfig: () => json(engine.config),
    readProviders: () => json(engine.catalog),
  };
  const requests: Array<{ method: string; path: string }> = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    if (request.method === "GET" && path === "/config") return engine.readConfig();
    if (request.method === "GET" && path === "/provider") return engine.readProviders();
    throw new Error("Unexpected request during provider discovery");
  });
  const ui: {
    providers: ProviderListItem[];
    defaults: Record<string, string>;
    connected: string[];
    disabled: string[];
    reloads: number;
  } = { providers: [], defaults: {}, connected: [], disabled: [], reloads: 0 };
  const workspace: WorkspaceDisplay = {
    id: "provider-settings",
    name: "Provider settings",
    path: "/workspace/provider-settings",
    preset: "default",
    workspaceType: "local",
  };
  const baseUrl = "https://engine.example.test";
  const client = createClient(baseUrl, workspace.path);
  const queryInput = { client, baseUrl, directory: workspace.path };
  const store = createProviderAuthStore({
    client: () => client,
    providers: () => ui.providers,
    providerDefaults: () => ui.defaults,
    providerConnectedIds: () => ui.connected,
    disabledProviders: () => ui.disabled,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => baseUrl,
    selectedWorkspaceRoot: () => workspace.path,
    runtimeWorkspaceId: () => workspace.id,
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: "disconnected",
        openworkServerClient: null,
        openworkServerCapabilities: null,
      }),
    },
    setProviders: (value) => { ui.providers = value; },
    setProviderDefaults: (value) => { ui.defaults = value; },
    setProviderConnectedIds: (value) => { ui.connected = value; },
    setDisabledProviders: (value) => { ui.disabled = value; },
    markOpencodeConfigReloadRequired: () => { ui.reloads += 1; },
  });
  stores.push(store);
  return { engine, ui, store, requests, queryInput, queryKey: providerListQueryKey(queryInput) };
}

type Harness = ReturnType<typeof createHarness>;

function ProviderSettings({ harness }: { harness: Harness }) {
  const { ui, store } = harness;
  const snapshot = useProviderAuthStoreSnapshot(store);
  return (
    <AiSettingsView
      busy={false}
      providerAuthBusy={false}
      providerStatusLabel={ui.connected.length ? t("status.connected") : t("status.disconnected_label")}
      providerStatusStyle=""
      providerSummary={ui.connected.length
        ? t("status.providers_connected", { count: ui.connected.length })
        : t("settings.no_providers_connected")}
      providerLoadState={snapshot.providerLoadState}
      onRetryProviders={async () => { await store.refreshProviders({ force: true }); }}
      connectedProviders={ui.providers.filter((item) => ui.connected.includes(item.id) && !ui.disabled.includes(item.id))}
      disconnectingProviderId={null}
      providerConnectError={null}
      providerDisconnectStatus={null}
      providerDisconnectError={null}
      onOpenProviderAuth={() => undefined}
      onDisconnectProvider={() => undefined}
      canDisconnectProvider={() => true}
      canAddProviders={true}
    />
  );
}

const render = (harness: Harness) => renderToStaticMarkup(<ProviderSettings harness={harness} />);

function expectReadOnly(harness: Harness) {
  expect(harness.requests.every(({ method }) => method === "GET")).toBe(true);
  expect(harness.ui.reloads).toBe(0);
}

afterEach(() => {
  for (const store of stores) store.dispose();
  stores.length = 0;
  mock.restore();
  clearProviderListQueries(getReactQueryClient());
});

test("cold discovery waits, reports SDK failure, and only shows empty setup after a successful empty response", async () => {
  const harness = createHarness();
  expect(render(harness)).toContain(t("settings.loading_providers"));
  expect(render(harness)).not.toContain(t("settings.no_providers_connected"));
  const pending = deferredResponse();
  harness.engine.readProviders = () => pending.promise;
  const refresh = harness.store.refreshProviders();
  expect(harness.store.getSnapshot().providerLoadState.status).toBe("loading");
  expect(render(harness)).not.toContain("Subscribe");
  pending.resolve(json({ name: "UnknownError", data: { message: `${privatePath}: ${secret}` } }, 500));
  expect(await refresh).toBeNull();
  expect(getReactQueryClient().getQueryState(harness.queryKey)?.status).toBe("error");
  const failed = render(harness);
  expect(failed).toContain('role="alert"');
  expect(failed).toContain(t("settings.provider_load_error"));
  expect(failed).toContain("Retry");
  expect(failed).not.toContain(t("settings.no_providers_connected"));
  expect(failed).not.toContain(secret);
  expect(failed).not.toContain(privatePath);
  expect(failed).not.toContain("Subscribe");

  harness.engine.catalog = { all: [], connected: [], default: {} };
  harness.engine.readProviders = () => json(harness.engine.catalog);
  await harness.store.refreshProviders({ force: true });
  expect(harness.store.getSnapshot().providerLoadState).toEqual({ status: "ready", error: null });
  const empty = render(harness);
  expect(empty).toContain(t("settings.no_providers_connected"));
  expect(empty).not.toContain("Subscribe");
  expect(empty).not.toContain('role="alert"');
  expect(empty).not.toContain('disabled=""');
  expectReadOnly(harness);
});

test("a config discovery failure preserves known providers, defaults, and disabled rules despite a warm provider cache", async () => {
  const harness = createHarness();
  await harness.store.refreshProviders();
  const before = { ...harness.ui };
  const configBefore = JSON.stringify(harness.engine.config);
  const providerReadsBefore = harness.requests.filter(({ path }) => path === "/provider").length;
  harness.engine.readConfig = () => json({ name: "BadRequest", data: { message: `${privatePath}: invalid configuration ${secret}` } }, 400);
  expect(await harness.store.refreshProviders()).toBeNull();
  expect(harness.store.getSnapshot().providerLoadState.status).toBe("error");
  expect(harness.ui).toEqual(before);
  expect(harness.ui.providers).toBe(before.providers);
  expect(harness.ui.disabled).toBe(before.disabled);
  expect(harness.requests.filter(({ path }) => path === "/provider")).toHaveLength(providerReadsBefore);
  const html = render(harness);
  expect(html).toContain("OpenAI");
  expect(html).toContain(t("settings.providers_not_refreshed"));
  expect(html).not.toContain(t("settings.no_providers_connected"));
  expect(html).not.toContain(secret);
  expect(html).not.toContain(t("settings.provider_load_incompatible_permissions"));
  expect(JSON.stringify(harness.engine.config)).toBe(configBefore);
  expectReadOnly(harness);
});

test("Retry keeps stale rows and its error visible while pending, then uses a fresh SDK read to recover", async () => {
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register();
  const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const harness = createHarness();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await harness.store.refreshProviders();
    const before = { ...harness.ui };
    harness.engine.config.disabled_providers = [provider.id];
    harness.engine.readProviders = () => json({ name: "BadRequest", data: { message: secret } }, 400);
    await harness.store.refreshProviders({ force: true });
    expect(harness.ui).toEqual(before);
    expect(getReactQueryClient().getQueryState(harness.queryKey)?.status).toBe("error");
    await act(async () => root.render(<ProviderSettings harness={harness} />));
    expect(container.textContent).toContain("OpenAI");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(t("settings.providers_not_refreshed"));
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Retry");
    if (!retry) throw new Error("Missing Retry button");
    expect(retry.disabled).toBe(false);
    const disconnect = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === t("settings.disconnect"));
    expect(disconnect?.disabled).toBe(true);
    const pending = deferredResponse();
    harness.engine.readProviders = () => pending.promise;
    const readsBefore = harness.requests.filter(({ path }) => path === "/provider").length;
    await act(async () => retry.click());
    expect(harness.requests.filter(({ path }) => path === "/provider")).toHaveLength(readsBefore + 1);
    expect(retry.disabled).toBe(true);
    expect(container.textContent).toContain("OpenAI");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => pending.resolve(json({ all: [], connected: [], default: {} })));
    expect(harness.store.getSnapshot().providerLoadState).toEqual({ status: "ready", error: null });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("OpenAI");
    expect(container.textContent).toContain(t("settings.no_providers_connected"));
    expect(getReactQueryClient().getQueryState(harness.queryKey)?.status).toBe("success");
    expect(harness.ui.disabled).toEqual([provider.id]);
    expectReadOnly(harness);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (originalActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});

const sdkPermissionsError: BadRequestError = {
  name: "BadRequest",
  data: { message: `${incompatibleMessage}: ${privatePath} ${secret}` },
};

test.each([
  { shape: "SDK data.message", error: sdkPermissionsError },
  { shape: "serialized validation issues", error: { name: "ConfigInvalidError", data: { path: privatePath, issues: [{ path: ["permissions"], message: incompatibleMessage }], content: secret } } },
  { shape: "plain backend message", error: `${incompatibleMessage}\n${privatePath}\n${secret}` },
])("$shape explains incompatible plural permissions without echoing configuration or changing rules", async ({ error }) => {
  const harness = createHarness();
  harness.engine.config = { permissions: [{ permission: "bash", pattern: "*", action: "deny" }], provider: { options: { apiKey: secret } } };
  const configBefore = JSON.stringify(harness.engine.config);
  harness.engine.readConfig = () => json(error, 400);
  expect(await harness.store.refreshProviders()).toBeNull();
  expect(harness.store.getSnapshot().providerLoadState.error).toBe(t("settings.provider_load_incompatible_permissions"));
  const html = render(harness);
  expect(html).toContain("OpenCode V1");
  expect(html).toContain("permissions");
  expect(html).toContain("permission rules have not been changed");
  expect(html).not.toContain(secret);
  expect(html).not.toContain(privatePath);
  expect(html).not.toContain("ConfigInvalidError");
  expect(html).not.toContain("apiKey");
  expect(JSON.stringify(harness.engine.config)).toBe(configBefore);
  expectReadOnly(harness);

  harness.engine.readConfig = () => json(harness.engine.config);
  await harness.store.refreshProviders({ force: true });
  expect(harness.store.getSnapshot().providerLoadState).toEqual({ status: "ready", error: null });
  expect(render(harness)).toContain("OpenAI");
  expect(render(harness)).not.toContain('role="alert"');
  expect(JSON.stringify(harness.engine.config)).toBe(configBefore);
  expectReadOnly(harness);
});

test("a thrown SDK transport Error is sanitized rather than displayed as backend details", async () => {
  const harness = createHarness();
  harness.engine.readConfig = () => { throw new Error(`${privatePath}: permission denied ${secret}`); };
  expect(await harness.store.refreshProviders()).toBeNull();
  expect(harness.store.getSnapshot().providerLoadState.error).toBe(t("settings.provider_load_error"));
  expect(render(harness)).not.toContain(secret);
  expectReadOnly(harness);
});

test("an unrelated config error containing permissions or the signature inside raw config is not misclassified", async () => {
  const harness = createHarness();
  harness.engine.readConfig = () => json({
    name: "ConfigInvalidError",
    data: { path: privatePath, issues: [{ path: ["permissions"], message: "Invalid type" }], config: { message: incompatibleMessage, apiKey: secret } },
  }, 400);
  await harness.store.refreshProviders();
  expect(harness.store.getSnapshot().providerLoadState.error).toBe(t("settings.provider_load_error"));
  expect(render(harness)).not.toContain(secret);
  expectReadOnly(harness);
});

test("a shared failed query cannot turn cached provider data into an implicit successful refresh", async () => {
  const harness = createHarness();
  const queryClient = getReactQueryClient();
  await ensureProviderListQuery(queryClient, harness.queryInput);
  harness.engine.readProviders = () => json(sdkPermissionsError, 400);
  await expect(ensureProviderListQuery(queryClient, { ...harness.queryInput, force: true })).rejects.toThrow();
  await expect(ensureProviderListQuery(queryClient, harness.queryInput)).rejects.toThrow();
  expect(queryClient.getQueryState(harness.queryKey)?.status).toBe("error");
  expect(queryClient.getQueryData(harness.queryKey)).toEqual(harness.engine.catalog);
  expect(harness.requests.filter(({ path }) => path === "/provider")).toHaveLength(3);
});

test("an invalidated or actively refreshing query awaits new data instead of returning the cached list", async () => {
  const harness = createHarness();
  const queryClient = getReactQueryClient();
  await ensureProviderListQuery(queryClient, harness.queryInput);
  await queryClient.invalidateQueries({ queryKey: harness.queryKey, refetchType: "none" });
  const pending = deferredResponse();
  harness.engine.readProviders = () => pending.promise;
  const invalidated = ensureProviderListQuery(queryClient, harness.queryInput);
  const inFlight = ensureProviderListQuery(queryClient, harness.queryInput);
  const empty: ProviderListResponse = { all: [], connected: [], default: {} };
  pending.resolve(json(empty));
  expect(await invalidated).toEqual(empty);
  expect(await inFlight).toEqual(empty);
  expect(harness.requests.filter(({ path }) => path === "/provider")).toHaveLength(2);
});

test("a superseded read cannot replace a recovered inventory with an older failure", async () => {
  const harness = createHarness();
  const pending = deferredResponse();
  let configReads = 0;
  harness.engine.readConfig = () => ++configReads === 1 ? pending.promise : json(harness.engine.config);
  const older = harness.store.refreshProviders();
  await harness.store.refreshProviders({ force: true });
  pending.resolve(json(sdkPermissionsError, 400));
  await older;
  expect(harness.store.getSnapshot().providerLoadState).toEqual({ status: "ready", error: null });
  expect(render(harness)).toContain("OpenAI");
  expect(render(harness)).not.toContain('role="alert"');
  expectReadOnly(harness);
});
