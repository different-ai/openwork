/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI chooses its layout-effect shim at import time; portals need the DOM first.
const { createDenClient } = await import("../src/app/lib/den");
const server = await import("../src/app/lib/openwork-server");
const { isDesktopRuntime } = await import("../src/app/lib/runtime-env");
const automations = await import("../src/react-app/domains/automations/use-automations");
const connection = await import("../src/react-app/shell/openwork-connection");
const den = await import("../src/app/lib/den");
const { EngineMigrationOverlay, observeEngineMigration, requestEngineMigration, resetEngineMigrationForTest, useEngineMigrationStore } = await import("../src/react-app/shell/engine-migration");
const { useOpencodeEngineControls } = await import("../src/react-app/shell/opencode-engine-controls");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let queryClient: QueryClient;
let previousBridge: unknown;
let denClient: ReturnType<typeof createDenClient>;

const status: EngineV2PreviewStatus = {
  enabled: false, running: false, chatRouting: false, v1HistoryAvailable: true,
  mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
  migration: { state: "idle", imported: 0, skipped: 0, total: 2 },
};
const orgId = "org_test";

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  resetEngineMigrationForTest();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // This is the same cache entry populated by Calendar and other org-feature consumers.
  queryClient.setQueryData(["den", "org-features", orgId], { engineV2ForceUpgrade: true });
  denClient = createDenClient({ baseUrl: "https://den.example.test", token: "test-token" });
  spyOn(denClient, "getOrgFeatures").mockRejectedValue(new Error("Den offline"));
  spyOn(denClient, "getDeploymentFeatures").mockRejectedValue(new Error("Den offline"));
  spyOn(automations, "useAutomationsDenContext").mockReturnValue({
    client: denClient,
    organizationId: orgId, ready: true, queryRoot: ["den", "automations", orgId],
  });
  spyOn(den, "createDenClient").mockReturnValue(denClient);
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network offline"));
  spyOn(connection, "resolveOpenworkConnection").mockResolvedValue({
    normalizedBaseUrl: "http://localhost:8787", resolvedToken: "test-token", resolvedHostToken: "test-host",
    hostInfo: null, source: "stored-settings",
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  queryClient.clear();
  resetEngineMigrationForTest();
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
  document.body.innerHTML = "";
  mock.restore();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function engineClient() {
  const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token" });
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(status);
  spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue(status);
  spyOn(client, "migrateOpencodeHistory").mockResolvedValue(status);
  spyOn(client, "getEngineActivity").mockResolvedValue({
    v1: { verdict: "idle", busySessions: 0, waitingRequests: 0 }, v2: null,
  });
  spyOn(client, "switchOpencodeEngine").mockResolvedValue({ ...status, enabled: true, chatRouting: true });
  spyOn(server, "createOpenworkServerClient").mockReturnValue(client);
  return client;
}

async function renderOverlay(discoverRunningMigration?: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}><EngineMigrationOverlay discoverRunningMigration={discoverRunningMigration} /></QueryClientProvider>);
  });
}

test("restoring reports message counts rather than a stalled chat counter", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  const migration = { state: "running", phase: "restoring", imported: 0, skipped: 0, total: 2471, restored: 44000, restoreTotal: 208014 } satisfies EngineV2PreviewStatus["migration"];
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue({ ...status, migration });
  useEngineMigrationStore.setState({ progress: {
    client, migration, selected: "v1", view: "dialog", retrying: false, runningTasks: 0, switchWhenDone: true,
  } });
  await renderOverlay();
  expect(document.querySelector('[data-testid="engine-migration-count"]')?.textContent).toBe("Restoring messages: 44,000 of 208,014");
  expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("21");
});

test("web never upgrades the engine from another consumer's enabled feature cache", async () => {
  const client = engineClient();
  expect(isDesktopRuntime()).toBe(false);
  await renderOverlay();
  expect(queryClient.getQueryData(["den", "org-features", orgId])).toEqual({ engineV2ForceUpgrade: true });
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  // A render-only guard is insufficient: the feature hook must not start engine reads on web either.
  expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  expect(client.setEngineV2ForcePolicy).not.toHaveBeenCalled();
});

test("web palette omits the hidden engine settings destination, desktop retains it", async () => {
  const { buildCommandPaletteSettingsItems } = await import("../src/react-app/shell/command-palette-settings");
  const input = { developerMode: false, capabilities: { autoUpdate: false }, onOpenSettings: () => {}, onOpenExtensions: () => {} };
  expect(buildCommandPaletteSettingsItems(input).some(item => item.id === "settings:advanced/experimental-engine")).toBe(false);
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  expect(buildCommandPaletteSettingsItems(input).some(item => item.id === "settings:advanced/experimental-engine")).toBe(true);
});

test("desktop with the upgrade off still opens consent for a manual upgrade", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await setFeatures(false);
  await renderOverlay();
  expect(document.body.textContent).toBe("");
  await act(async () => requestEngineMigration(client, "upgrade"));
  expect(document.querySelector('[data-testid="engine-migration-consent"]')?.getAttribute("data-mode")).toBe("upgrade");
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
});

test("web hides consent and engine-switch prompts already in the shared store", async () => {
  const client = engineClient();
  useEngineMigrationStore.setState({
    consent: { client, mode: "upgrade", runningTasks: 0, submitting: false, error: null },
    switchPrompt: { engine: "v2", from: "v1", runningTasks: 1, resolve: () => {} },
  });
  await renderOverlay();
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  expect(document.querySelector('[data-testid="engine-switch-prompt"]')).toBeNull();
});

for (const view of ["dialog", "banner"] satisfies Array<"dialog" | "banner">) {
  test(`web hides stored migration ${view} and does not poll it`, async () => {
    const client = engineClient();
    useEngineMigrationStore.setState({ progress: {
      client, migration: { state: "running", phase: "copying", imported: 1, skipped: 0, total: 2 },
      selected: "v1", view, retrying: false, runningTasks: 0, switchWhenDone: true,
    } });
    await renderOverlay();
    expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  });
}

test("web does not finish an upgrade from stored completed progress", async () => {
  const client = engineClient();
  useEngineMigrationStore.setState({ progress: {
    client, migration: { state: "completed", imported: 2, skipped: 0, total: 2 },
    selected: "v1", view: "banner", retrying: false, runningTasks: 0, switchWhenDone: true,
  } });
  await renderOverlay();
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
  expect(client.getEngineActivity).not.toHaveBeenCalled();
});

test("web settings and palette controls ignore migration progress from the shared store", async () => {
  const client = engineClient();
  useEngineMigrationStore.setState({ progress: {
    client, migration: { state: "running", imported: 1, skipped: 0, total: 2 },
    selected: "v1", view: "banner", retrying: false, runningTasks: 0, switchWhenDone: false,
  } });
  function Controls() {
    const engine = useOpencodeEngineControls(client);
    return <div data-migrating={engine.migrating} data-disabled={engine.disabled}>{engine.message}</div>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<Controls />); });
  expect(host.firstElementChild?.getAttribute("data-migrating")).toBe("false");
  expect(host.firstElementChild?.getAttribute("data-disabled")).toBe("true");
  expect(host.textContent).toBe("");
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
});

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop retains" : "web omits"} engine switching and migration palette actions`, async () => {
    if (desktop) Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    const observed: { actions: string[] | null } = { actions: null };
    function Controls() {
      const engine = useOpencodeEngineControls(client);
      observed.actions = engine.items.map((item) => item.id);
      return <div>{engine.items.map((item) => <button key={item.id}>{item.title}</button>)}</div>;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Controls />); });
    expect(observed.actions).toEqual(desktop
      ? ["opencode.switch-v1", "opencode.switch-v2", "opencode.migrate-v2"] : []);
    expect(host.querySelectorAll("button").length).toBe(desktop ? 3 : 0);
    if (!desktop) expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  });
}

test("web omits the Advanced engine section entirely", async () => {
  const { AdvancedEngineV2PreviewSection } = await import("../src/react-app/domains/settings/pages/advanced-view-sections");
  const client = engineClient();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<AdvancedEngineV2PreviewSection client={client} />); });
  expect(host.innerHTML).toBe("");
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
});

async function setFeatures(upgrade: boolean) {
  await act(async () => {
    queryClient.setQueryData(["den", "org-features", orgId], { engineV2ForceUpgrade: upgrade });
    // TanStack observer notifications are scheduled, not synchronous with cache writes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function expectReadOnlyDiscovery(client: ReturnType<typeof engineClient>) {
  expect(automations.useAutomationsDenContext).not.toHaveBeenCalled();
  expect(den.createDenClient).not.toHaveBeenCalled();
  expect(denClient.getOrgFeatures).not.toHaveBeenCalled();
  expect(denClient.getDeploymentFeatures).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(client.setEngineV2ForcePolicy).not.toHaveBeenCalled();
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
}

const pendingStatus: EngineV2PreviewStatus = {
  ...status, engineOrigin: "manual", engineForced: false, forceUpgradePending: true,
  migration: { state: "running", phase: "copying", imported: 1, skipped: 0, total: 2 },
};

for (const signedOut of [false, true]) {
  test(`desktop discovers host-owned migration with legacy false cache and offline Den (${signedOut ? "signed out" : "signed in"})`, async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(pendingStatus);
    if (signedOut) spyOn(automations, "useAutomationsDenContext").mockReturnValue({
      client: null, organizationId: orgId, ready: false, queryRoot: ["den", "automations", orgId],
    });
    await setFeatures(false);
    await renderOverlay();
    expect(connection.resolveOpenworkConnection).toHaveBeenCalledTimes(1);
    expect(server.createOpenworkServerClient).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8787", token: "test-token", hostToken: "test-host",
    });
    expect(client.getEngineV2PreviewStatus).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
    expect(useEngineMigrationStore.getState().progress).toMatchObject({
      serverManaged: true, switchWhenDone: false, view: "banner",
    });
    expectReadOnlyDiscovery(client);
  });
}

for (const upgrade of [false, true]) {
  test(`web never discovers host status or requests Den with legacy cache=${upgrade}`, async () => {
    const client = engineClient();
    await setFeatures(upgrade);
    await renderOverlay();
    expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
    expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
    expectReadOnlyDiscovery(client);
    expect(document.body.textContent).toBe("");
  });
}

test("discovery can be explicitly disabled on desktop", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await renderOverlay(false);
  expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  expectReadOnlyDiscovery(client);
});

for (const state of ["completed", "error"] satisfies Array<"completed" | "error">) {
  test(`discovery polls pending migration to ${state} without renderer recovery or switching`, async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    const read = spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(pendingStatus);
    await renderOverlay();
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).not.toBeNull();
    read.mockResolvedValue({
      ...pendingStatus,
      enabled: state === "completed", chatRouting: state === "completed",
      engineOrigin: state === "completed" ? "forced" : "manual",
      engineForced: state === "completed", forceUpgradePending: false,
      migration: { state, imported: state === "completed" ? 2 : 1, skipped: 0, total: 2, error: state === "error" ? "Copy failed" : undefined },
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(useEngineMigrationStore.getState().progress).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
    expectReadOnlyDiscovery(client);
  });
}

test("observing host ownership replaces a manual progress dialog without taking over migration", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  useEngineMigrationStore.setState({ progress: {
    client, migration: { state: "running", imported: 1, skipped: 0, total: 2 },
    selected: "v1", view: "dialog", retrying: false, runningTasks: 0, switchWhenDone: true,
  } });
  observeEngineMigration(client, pendingStatus);
  expect(useEngineMigrationStore.getState().progress).toMatchObject({
    serverManaged: true, switchWhenDone: false, view: "banner",
  });
  await renderOverlay(false);
  expect(document.querySelector('[data-testid="engine-migration-banner"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
  expectReadOnlyDiscovery(client);
});

test("fresh forced v2 status refreshes routing once, then polls without duplicate routing events", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue({
    ...status, enabled: true, running: true, chatRouting: true,
    v1HistoryAvailable: false, engineOrigin: "forced", engineForced: true,
  });
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    await setFeatures(false);
    await renderOverlay();
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    expect(client.getEngineV2PreviewStatus).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toBe("");
    expectReadOnlyDiscovery(client);
  } finally {
    window.removeEventListener("openwork-engine-changed", changed);
  }
});

test("pending host routing changes dispatch an event, not a renderer engine switch", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  const read = spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue({
    ...status, forceUpgradePending: true,
  });
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    await renderOverlay();
    expect(changed).not.toHaveBeenCalled();
    read.mockResolvedValue({ ...status, enabled: true, chatRouting: true, engineForced: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expectReadOnlyDiscovery(client);
  } finally {
    window.removeEventListener("openwork-engine-changed", changed);
  }
});

test("a failed discovery read never falls back to renderer migration, policy writes, or consent", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(client, "getEngineV2PreviewStatus").mockRejectedValue(new Error("Host unavailable"));
  await renderOverlay();
  expect(client.getEngineV2PreviewStatus).toHaveBeenCalledTimes(1);
  expectReadOnlyDiscovery(client);
  expect(document.body.textContent).toBe("");
});

test("legacy cache changes neither write host policy nor remove manual upgrade consent", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await setFeatures(false);
  await renderOverlay();
  await act(async () => requestEngineMigration(client, "upgrade"));
  await setFeatures(true);
  await setFeatures(false);
  expect(useEngineMigrationStore.getState().consent).toMatchObject({ client, mode: "upgrade", submitting: false });
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).not.toBeNull();
  expectReadOnlyDiscovery(client);
});

test("force API sends host authentication and parses ownership fields without inferring missing markers", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    ...status, engineOrigin: "manual", engineForced: false, forceUpgradePending: true,
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token", hostToken: "test-host" });
  const result = await client.setEngineV2ForcePolicy({ upgrade: true });
  expect(result.engineOrigin).toBe("manual");
  expect(result.engineForced).toBe(false);
  expect(result.forceUpgradePending).toBe(true);
  const [url, options] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("http://localhost:8787/experimental/engine-v2-preview/force");
  expect(options?.method).toBe("POST");
  expect(new Headers(options?.headers).get("X-OpenWork-Host-Token")).toBe("test-host");
  expect(options?.body).toBe(JSON.stringify({ upgrade: true }));
  fetch.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
  const legacy = await client.getEngineV2PreviewStatus();
  expect(legacy.engineOrigin).toBeUndefined();
  expect(legacy.engineForced).toBeUndefined();
  expect(legacy.forceUpgradePending).toBeUndefined();
});
