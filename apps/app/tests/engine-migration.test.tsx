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
const { EngineMigrationOverlay, resetEngineMigrationForTest, useEngineMigrationStore } = await import("../src/react-app/shell/engine-migration");
const { useOpencodeEngineControls } = await import("../src/react-app/shell/opencode-engine-controls");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let queryClient: QueryClient;
let previousBridge: unknown;

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
  queryClient.setQueryData(["den", "org-features", orgId], { engineV2Upgrade: true });
  spyOn(automations, "useAutomationsDenContext").mockReturnValue({
    client: createDenClient({ baseUrl: "https://den.example.test", token: "test-token" }),
    organizationId: orgId, ready: true, queryRoot: ["den", "automations", orgId],
  });
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
  spyOn(client, "migrateOpencodeHistory").mockResolvedValue(status);
  spyOn(client, "getEngineActivity").mockResolvedValue({
    v1: { verdict: "idle", busySessions: 0, waitingRequests: 0 }, v2: null,
  });
  spyOn(client, "switchOpencodeEngine").mockResolvedValue({ ...status, enabled: true, chatRouting: true });
  spyOn(server, "createOpenworkServerClient").mockReturnValue(client);
  return client;
}

async function renderOverlay() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}><EngineMigrationOverlay discoverRunningMigration={false} /></QueryClientProvider>);
  });
}

test("web never offers an engine upgrade from another consumer's enabled feature cache", async () => {
  const client = engineClient();
  expect(isDesktopRuntime()).toBe(false);
  await renderOverlay();
  expect(queryClient.getQueryData(["den", "org-features", orgId])).toEqual({ engineV2Upgrade: true });
  expect(document.querySelector('[data-testid="engine-upgrade-notice"]') === null).toBe(true);
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  // A render-only guard is insufficient: the feature hook must not start engine reads on web either.
  expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
});

test("desktop still offers the cached upgrade and opens its consent", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  engineClient();
  await renderOverlay();
  const notice = document.querySelector('[data-testid="engine-upgrade-notice"]');
  expect(notice).not.toBeNull();
  const upgrade = notice?.querySelectorAll("button")[1];
  if (!(upgrade instanceof HTMLButtonElement)) throw new Error("Missing upgrade action");
  await act(async () => upgrade.click());
  expect(document.querySelector('[data-testid="engine-migration-consent"]')?.getAttribute("data-mode")).toBe("upgrade");
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
