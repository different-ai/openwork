import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClient } from "../src/app/lib/opencode";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalConsoleInfo = console.info;
const originalDeployment = process.env.VITE_OPENWORK_DEPLOYMENT;

type RecordedRequest = {
  url: string;
  method: string;
  body: string | null;
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function installWindow(options: { origin: string; gateway?: boolean }) {
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      localStorage,
      location: { origin: options.origin },
      __OPENWORK_GATEWAY__: options.gateway ? { version: 1 } : undefined,
    },
  });
  return localStorage;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input.url;
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return "GET";
}

function getRequestBody(init?: RequestInit): string | null {
  return typeof init?.body === "string" ? init.body : null;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cloudProviderPayload(options: { conflict?: boolean } = {}) {
  return {
    id: "lpr_test",
    source: options.conflict ? "openwork" : "custom",
    providerId: options.conflict ? "openwork" : "openai",
    name: options.conflict ? "OpenWork Models" : "Team OpenAI",
    providerConfig: { env: [options.conflict ? "OPENWORK_API_KEY" : "OPENAI_API_KEY"] },
    hasApiKey: true,
    apiKey: "sk-test",
    models: [
      {
        id: "gpt-test",
        name: "GPT Test",
        config: {},
        createdAt: null,
      },
    ],
    createdAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function installCloudSession(storage: Storage) {
  storage.setItem("openwork.den.baseUrl", "https://den.example");
  storage.setItem("openwork.den.authToken", "den-token");
  storage.setItem("openwork.den.activeOrgId", "org_test");
}

function createProviderAuthTestStore(
  configCapabilities: { read: boolean; write: boolean; providerSync?: boolean } = { read: true, write: true },
) {
  const opencodeClient = createClient("https://engine.example", "/tmp/workspace_test", {
    token: "engine-token",
    mode: "openwork",
  });
  let serverHostToken = "host-token";
  let openworkClient = createOpenworkServerClient({
    baseUrl: "https://server.example",
    token: "server-token",
    hostToken: serverHostToken,
  });
  let workspace: WorkspaceDisplay = {
    id: "workspace_test",
    name: "Test workspace",
    path: "/tmp/workspace_test",
    preset: "default",
    workspaceType: "local",
  };
  let runtimeWorkspaceId = "ws_1";
  let providers: ProviderListItem[] = [];
  let providerDefaults: Record<string, string> = {};
  let providerConnectedIds: string[] = [];
  let disabledProviders: string[] = [];
  let reloadCount = 0;

  const store = createProviderAuthStore({
    client: () => opencodeClient,
    providers: () => providers,
    providerDefaults: () => providerDefaults,
    providerConnectedIds: () => providerConnectedIds,
    disabledProviders: () => disabledProviders,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => "https://engine.example",
    selectedWorkspaceRoot: () => workspace.path,
    runtimeWorkspaceId: () => runtimeWorkspaceId,
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: "connected",
        openworkServerClient: openworkClient,
        openworkServerAuth: { token: "server-token", hostToken: serverHostToken },
        openworkServerCapabilities: {
          config: configCapabilities,
          providerSync: configCapabilities.providerSync,
        },
      }),
    },
    setProviders: (value) => {
      providers = value;
    },
    setProviderDefaults: (value) => {
      providerDefaults = value;
    },
    setProviderConnectedIds: (value) => {
      providerConnectedIds = value;
    },
    setDisabledProviders: (value) => {
      disabledProviders = value;
    },
    markOpencodeConfigReloadRequired: () => {
      reloadCount += 1;
    },
  });

  return {
    store,
    reloadCount: () => reloadCount,
    selectWorkspace: (id: string, path: string) => {
      workspace = { ...workspace, id, path };
      runtimeWorkspaceId = id;
    },
    rotateServerHostToken: (hostToken: string) => {
      serverHostToken = hostToken;
      openworkClient = createOpenworkServerClient({
        baseUrl: "https://server.example",
        token: "server-token",
        hostToken,
      });
    },
  };
}

function installProviderSyncFetch(
  requests: RecordedRequest[],
  options: {
    conflict?: boolean;
    runStatuses?: Array<{ status: "applied" | "noop" | "failed" | "no_session"; message?: string }>;
    statusProviders?: Array<Record<string, unknown>>;
    statusReloadPending?: boolean;
    statusSkipped?: Array<Record<string, unknown>>;
    onRun?: (runIndex: number) => void | Promise<void>;
  } = {},
) {
  let runIndex = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(getRequestUrl(input));
      const method = getRequestMethod(input, init);
      requests.push({
        url: url.toString(),
        method,
        body: getRequestBody(init),
      });

      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers") {
        return jsonResponse({ llmProviders: [cloudProviderPayload(options)] });
      }
      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers/lpr_test/connect") {
        return jsonResponse({ llmProvider: cloudProviderPayload(options) });
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/config" && method === "GET") {
        return jsonResponse({ opencode: {}, openwork: {} });
      }
      if (url.origin === "https://server.example" && url.pathname === "/den-session" && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.origin === "https://server.example" && url.pathname === "/cloud-provider-sync/run" && method === "POST") {
        await options.onRun?.(runIndex);
        const statuses = options.runStatuses ?? [{ status: "noop" }];
        const result = statuses[Math.min(runIndex, statuses.length - 1)];
        runIndex += 1;
        return jsonResponse(result);
      }
      if (url.origin === "https://server.example" && url.pathname === "/cloud-provider-sync/status" && method === "GET") {
        return jsonResponse({
          hasSession: true,
          lastRun: null,
          providers: options.statusProviders ?? [],
          reloadPending: options.statusReloadPending ?? false,
          skippedProviders: options.statusSkipped ?? [],
        });
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/config" && method === "PATCH") {
        return jsonResponse({ updatedAt: 1 });
      }
      if (url.origin === "https://server.example" && url.pathname === "/env") {
        return jsonResponse({ ok: true });
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/opencode-config") {
        return jsonResponse(options.conflict
          ? { content: '{"provider":{"openwork":{"name":"Local OpenWork"}}}' }
          : null);
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/engine/reload") {
        return jsonResponse({ ok: true, reloadedAt: 1 });
      }
      if (url.origin === "https://engine.example" && url.pathname === "/global/health") {
        return jsonResponse({ healthy: true, version: "1.17.11" });
      }
      if (url.origin === "https://engine.example" && url.pathname === "/provider") {
        return jsonResponse({
          all: [
            {
              id: "lpr_test",
              name: "Team OpenAI",
              source: "custom",
              env: ["OPENAI_API_KEY"],
              models: { "gpt-test": { id: "gpt-test", name: "GPT Test" } },
            },
          ],
          connected: ["lpr_test"],
          default: {},
        });
      }
      if (url.origin === "https://engine.example" && url.pathname === "/config") {
        return jsonResponse({ disabled_providers: [] });
      }

      return jsonResponse({});
    },
  });
}

async function waitForRequestCount(
  requests: RecordedRequest[],
  pathname: string,
  expected: number,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (requests.filter((request) => new URL(request.url).pathname === pathname).length >= expected) {
      return;
    }
    await Bun.sleep(1);
  }
}

describe("cloud provider sync in gateway mode", () => {
  beforeEach(() => {
    process.env.VITE_OPENWORK_DEPLOYMENT = "web";
    console.info = () => undefined;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    console.info = originalConsoleInfo;
    if (originalDeployment === undefined) {
      delete process.env.VITE_OPENWORK_DEPLOYMENT;
    } else {
      process.env.VITE_OPENWORK_DEPLOYMENT = originalDeployment;
    }
  });

  test("returns a server-handled outcome without network calls or error state behind the gateway", async () => {
    const storage = installWindow({ origin: "https://web.openworklabs.com", gateway: true });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store } = createProviderAuthTestStore();

    const outcome = await store.runCloudProviderSync("settings_cloud_opened");

    expect(outcome).toEqual({ outcome: "handled_server_side" });
    expect(requests).toEqual([]);
    expect(store.getSnapshot().providerAuthError).toBeNull();
  });

  test("keeps the client materialization path active outside gateway mode", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store, reloadCount } = createProviderAuthTestStore();

    await store.runCloudProviderSync("settings_cloud_opened");

    const patchRequests = requests.filter(
      (request) => request.method === "PATCH" && request.url === "https://server.example/workspace/ws_1/config",
    );
    expect(requests.some((request) => request.url === "https://den.example/api/den/v1/llm-providers")).toBe(true);
    expect(requests.some((request) => request.url === "https://den.example/api/den/v1/llm-providers/lpr_test/connect")).toBe(true);
    expect(patchRequests).toHaveLength(1);
    expect(patchRequests[0]?.body).toContain("\"opencode\"");
    expect(store.getSnapshot().importedCloudProviders.lpr_test?.providerId).toBe("lpr_test");
    expect(store.getSnapshot().providerAuthError).toBeNull();
    expect(reloadCount()).toBe(0);
  });

  test("keeps automatic client sync scoped to the selected workspace", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store, selectWorkspace } = createProviderAuthTestStore();

    store.syncFromOptions();
    await waitForRequestCount(requests, "/api/den/v1/llm-providers", 1);
    selectWorkspace("ws_2", "/tmp/workspace_2");
    store.syncFromOptions();
    await waitForRequestCount(requests, "/api/den/v1/llm-providers", 2);

    expect(
      requests.filter((request) => new URL(request.url).pathname === "/api/den/v1/llm-providers"),
    ).toHaveLength(2);
  });

  test("does not spin imports when workspace config is read-only", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store } = createProviderAuthTestStore({ read: true, write: false });

    await store.runCloudProviderSync("settings_cloud_opened");

    expect(requests).toEqual([]);
    expect(store.getSnapshot().lastSyncError).toEqual({});
  });

  test("records a hand-authored OpenWork collision once and skips later automatic retries", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { conflict: true });
    const { store } = createProviderAuthTestStore();

    await store.runCloudProviderSync("settings_cloud_opened");

    expect(store.getSnapshot().lastSyncError.lpr_test).toMatchObject({
      kind: "conflict",
      message: expect.stringContaining("openwork already has a provider block"),
    });
    expect(store.getSnapshot().importedCloudProviders.lpr_test).toBeUndefined();
    const firstConnectCount = requests.filter(
      (request) => request.url === "https://den.example/api/den/v1/llm-providers/lpr_test/connect",
    ).length;
    expect(firstConnectCount).toBe(1);

    await store.runCloudProviderSync("app_resume");

    const secondConnectCount = requests.filter(
      (request) => request.url === "https://den.example/api/den/v1/llm-providers/lpr_test/connect",
    ).length;
    expect(secondConnectCount).toBe(firstConnectCount);
  });
});

describe("cloud provider sync in server-capability mode", () => {
  beforeEach(() => {
    process.env.VITE_OPENWORK_DEPLOYMENT = "web";
    console.info = () => undefined;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    console.info = originalConsoleInfo;
    if (originalDeployment === undefined) delete process.env.VITE_OPENWORK_DEPLOYMENT;
    else process.env.VITE_OPENWORK_DEPLOYMENT = originalDeployment;
  });

  test("posts run-now without fetching Den providers in the renderer", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { runStatuses: [{ status: "applied" }] });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(await store.runCloudProviderSync("settings_cloud_opened")).toEqual({ outcome: "handled_server_side" });
    expect(requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes("/v1/llm-providers"))).toHaveLength(0);
  });

  test("keeps automatic server sync stable across workspace switches and invalidates account or server changes", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store, selectWorkspace, rotateServerHostToken } = createProviderAuthTestStore({
      read: true,
      write: true,
      providerSync: true,
    });

    store.syncFromOptions();
    await waitForRequestCount(requests, "/cloud-provider-sync/run", 1);
    expect(await store.runCloudProviderSync("app_launch")).toEqual({ outcome: "handled_server_side" });

    selectWorkspace("ws_2", "/tmp/workspace_2");
    store.syncFromOptions();
    expect(await store.runCloudProviderSync("app_launch")).toEqual({ outcome: "handled_server_side" });
    expect(
      requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run"),
    ).toHaveLength(1);

    storage.setItem("openwork.den.activeOrgId", "org_changed");
    store.syncFromOptions();
    expect(await store.runCloudProviderSync("app_launch")).toEqual({ outcome: "handled_server_side" });

    rotateServerHostToken("host-token-rotated");
    store.syncFromOptions();
    expect(await store.runCloudProviderSync("app_launch")).toEqual({ outcome: "handled_server_side" });
    expect(
      requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run"),
    ).toHaveLength(3);
  });

  test("shares same-context runs and coalesces a changed context into one trailing request", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    let markFirstRunReached: () => void = () => undefined;
    const firstRunReached = new Promise<void>((resolve) => {
      markFirstRunReached = resolve;
    });
    let releaseFirstRun: () => void = () => undefined;
    const firstRunReleased = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    installProviderSyncFetch(requests, {
      onRun: async (runIndex) => {
        if (runIndex !== 0) return;
        markFirstRunReached();
        await firstRunReleased;
      },
    });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    const { store: strictModeRemountStore } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    const first = store.runCloudProviderSync("app_launch");
    await firstRunReached;
    const sameContext = [
      store.runCloudProviderSync("sign_in"),
      strictModeRemountStore.runCloudProviderSync("app_resume"),
    ];
    await Bun.sleep(10);
    expect(requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(1);

    storage.setItem("openwork.den.activeOrgId", "org_changed");
    const changedContext = [
      store.runCloudProviderSync("sign_in"),
      strictModeRemountStore.runCloudProviderSync("app_resume"),
    ];
    await Bun.sleep(10);
    expect(requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(1);

    releaseFirstRun();
    const outcomes = await Promise.all([first, ...sameContext, ...changedContext]);
    expect(outcomes).toEqual(Array.from({ length: 5 }, () => ({ outcome: "handled_server_side" })));
    expect(requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(2);
  });

  test("resolves noop as handled server-side", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { runStatuses: [{ status: "noop" }] });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(await store.runCloudProviderSync("settings_cloud_opened")).toEqual({ outcome: "handled_server_side" });
  });

  test("exposes server failure in settings", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { runStatuses: [{ status: "failed", message: "Provider import failed" }] });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(await store.runCloudProviderSync("settings_cloud_opened")).toBeUndefined();
    expect(store.getSnapshot().providerAuthError).toContain("Provider import failed");
  });

  test("does not show a sync failure when logout removes the session in flight", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, {
      runStatuses: [{ status: "failed", message: "Cloud provider sync failed." }],
      onRun: () => storage.clear(),
    });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(await store.runCloudProviderSync("settings_cloud_opened")).toBeUndefined();
    expect(store.getSnapshot().providerAuthError).toBeNull();
  });

  test("does not start settings sync while signed out", async () => {
    installWindow({ origin: "https://self-hosted.example" });
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { runStatuses: [{ status: "no_session" }] });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(await store.runCloudProviderSync("settings_cloud_opened")).toBeUndefined();
    expect(requests).toEqual([]);
    expect(store.getSnapshot().providerAuthError).toBeNull();
  });

  test("pushes the resolved Den API session and retries once when missing", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { runStatuses: [{ status: "no_session" }, { status: "noop" }] });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(await store.runCloudProviderSync("settings_cloud_opened")).toEqual({ outcome: "handled_server_side" });
    const sessionRequests = requests.filter((request) => request.method === "PUT" && new URL(request.url).pathname === "/den-session");
    expect(sessionRequests).toHaveLength(1);
    expect(sessionRequests[0]?.body).toBe(JSON.stringify({
      baseUrl: "https://den.example/api/den",
      token: "den-token",
      orgId: "org_test",
    }));
    expect(requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(2);
  });

  test("re-derives imported rows and server sync facts after a server-handled sync", async () => {
    // #3671, UI layer: the server applied the sync, but the store only read
    // /cloud-provider-sync/status once at start() (usually before a session
    // existed), so importedCloudProviders stayed empty and the Cloud
    // Providers rows sat on "Syncing" forever. Every server-handled pass must
    // re-derive the records and the reloadPending/skip facts.
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, {
      runStatuses: [{ status: "applied" }],
      statusProviders: [{
        cloudProviderId: "lpr_test",
        providerId: "lpr_test",
        sourceProviderId: "openai",
        name: "Team OpenAI",
        source: "custom",
        updatedAt: "2026-08-10T00:00:00.000Z",
        modelIds: ["gpt-test"],
        importedAt: 123,
      }],
      statusReloadPending: false,
      statusSkipped: [{
        cloudProviderId: "lpr_nocred",
        providerId: "lpr_nocred",
        name: "No Credential Provider",
        reason: "missing_credentials",
      }],
    });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    expect(store.getSnapshot().importedCloudProviders).toEqual({});
    expect(await store.runCloudProviderSync("sign_in")).toEqual({ outcome: "handled_server_side" });

    expect(store.getSnapshot().importedCloudProviders.lpr_test?.providerId).toBe("lpr_test");
    expect(store.getSnapshot().cloudProviderServerSync).toEqual({
      reloadPending: false,
      skippedProviders: {
        lpr_nocred: {
          cloudProviderId: "lpr_nocred",
          providerId: "lpr_nocred",
          name: "No Credential Provider",
          reason: "missing_credentials",
        },
      },
    });
  });

  test("maps imported provider status by cloud provider id", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, {
      statusProviders: [{
        cloudProviderId: "cloud_1",
        providerId: "lpr_cloud_1",
        sourceProviderId: "openai",
        name: "Team OpenAI",
        source: "custom",
        updatedAt: "2026-08-04T00:00:00.000Z",
        modelIds: ["gpt-test"],
        importedAt: 123,
      }],
    });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });

    await store.refreshImportedCloudProviders();

    expect(store.getSnapshot().importedCloudProviders.cloud_1).toEqual({
      cloudProviderId: "cloud_1",
      providerId: "lpr_cloud_1",
      sourceProviderId: "openai",
      name: "Team OpenAI",
      source: "custom",
      updatedAt: "2026-08-04T00:00:00.000Z",
      modelIds: ["gpt-test"],
      importedAt: 123,
    });
  });
});
