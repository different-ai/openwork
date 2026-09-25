import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { createDenClient } from "../src/app/lib/den";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { gatewayUsageQueryPrefix } from "../src/react-app/domains/cloud/gateway-usage-state";
import { usageStatus } from "./gateway-usage-fixture";

import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClient } from "../src/app/lib/opencode";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { readGatewayUsageScope } from "../src/app/lib/gateway-usage-scope";
import { resolveGatewayProviderIds } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

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

function observeOwnUsage() {
  const scope = readGatewayUsageScope();
  const client = createDenClient({ baseUrl: scope.baseUrl, apiBaseUrl: scope.apiBaseUrl, token: scope.token });
  const observer = new QueryObserver(getReactQueryClient(), {
    queryKey: [...gatewayUsageQueryPrefix, scope.generation, scope.organizationId, "user_test"],
    queryFn: () => client.getGatewayUsageStatus(scope.organizationId ?? ""),
    initialData: usageStatus({ organizationId: scope.organizationId ?? "", state: "within_limit", buckets: [] }),
    staleTime: Infinity,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

function createProviderAuthTestStore(
  configCapabilities: { read: boolean; write: boolean; providerSync?: boolean } = { read: true, write: true },
  readiness: { client?: boolean; server?: boolean; workspace?: boolean } = {},
) {
  const opencodeClient = createClient("https://engine.example", "/tmp/workspace_test", {
    token: "engine-token",
    mode: "openwork",
  });
  const openworkClient = createOpenworkServerClient({
    baseUrl: "https://server.example",
    token: "server-token",
    hostToken: "host-token",
  });
  const workspace = {
    id: "workspace_test",
    name: "Test workspace",
    path: "/tmp/workspace_test",
    preset: "default",
    workspaceType: "local",
  } satisfies WorkspaceDisplay;
  let providers: ProviderListItem[] = [];
  let providerDefaults: Record<string, string> = {};
  let providerConnectedIds: string[] = [];
  let disabledProviders: string[] = [];
  let reloadCount = 0;

  const store = createProviderAuthStore({
    client: () => readiness.client === false ? null : opencodeClient,
    providers: () => providers,
    providerDefaults: () => providerDefaults,
    providerConnectedIds: () => providerConnectedIds,
    disabledProviders: () => disabledProviders,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => "https://engine.example",
    selectedWorkspaceRoot: () => readiness.workspace === false ? "" : "/tmp/workspace_test",
    runtimeWorkspaceId: () => readiness.workspace === false ? null : "ws_1",
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: readiness.server === false ? "disconnected" : "connected",
        openworkServerClient: openworkClient,
        openworkServerAuth: { token: "server-token", hostToken: "host-token" },
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
  };
}

function installProviderSyncFetch(
  requests: RecordedRequest[],
  options: {
    conflict?: boolean;
    cloudProviders?: Array<ReturnType<typeof cloudProviderPayload>>;
    onUsage?: () => Response | Promise<Response>;
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

      if (["https://den.example", "https://self-hosted.example"].includes(url.origin) && url.pathname === "/api/den/v1/gateway/usage-limits/me") {
        return options.onUsage?.() ?? jsonResponse(usageStatus());
      }
      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers") {
        return jsonResponse({ llmProviders: options.cloudProviders ?? [cloudProviderPayload(options)] });
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

describe("cloud provider sync usage refresh", () => {
  beforeEach(() => {
    process.env.VITE_OPENWORK_DEPLOYMENT = "web";
    console.info = () => undefined;
  });

  afterEach(() => {
    getReactQueryClient().clear();
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    console.info = originalConsoleInfo;
    if (originalDeployment === undefined) delete process.env.VITE_OPENWORK_DEPLOYMENT;
    else process.env.VITE_OPENWORK_DEPLOYMENT = originalDeployment;
  });

  test.each([false, true])("refreshes fresh healthy own usage without config changes (server sync: %s)", async (providerSync) => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests, { cloudProviders: [] });
    const { store, reloadCount } = createProviderAuthTestStore({ read: true, write: true, providerSync });
    const { observer, unsubscribe } = observeOwnUsage();
    const inactiveKey = [...gatewayUsageQueryPrefix, readGatewayUsageScope().generation, "org_test", "inactive"];
    getReactQueryClient().setQueryData(inactiveKey, usageStatus());
    try {
      expect(observer.getCurrentResult().data?.state).toBe("within_limit");
      expect(requests).toHaveLength(0);
      await store.runCloudProviderSync("app_resume");
      await observer.getCurrentQuery().promise;
      expect(requests.filter((request) => request.url.endsWith("/gateway/usage-limits/me"))).toHaveLength(1);
      expect(observer.getCurrentResult().data?.state).toBe("blocked");
      expect(getReactQueryClient().getQueryState(inactiveKey)?.isInvalidated).toBe(false);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(reloadCount()).toBe(0);
    } finally { unsubscribe(); store.dispose(); }
  });

  test.each(["gateway", "readonly", "client-not-ready", "server-not-ready", "workspace-not-ready"])("normal sync refreshes active usage without provider requests when %s", async (mode) => {
    const storage = installWindow({ origin: "https://self-hosted.example", gateway: mode === "gateway" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const capabilities = { read: true, write: mode !== "readonly" };
    const readiness = { client: mode !== "client-not-ready", server: mode !== "server-not-ready", workspace: mode !== "workspace-not-ready" };
    const { store } = createProviderAuthTestStore(capabilities, readiness);
    const { store: remount } = createProviderAuthTestStore(capabilities, readiness);
    const { observer, unsubscribe } = observeOwnUsage();
    try {
      expect(observer.getCurrentResult().data?.state).toBe("within_limit");
      await Promise.all([store.runCloudProviderSync("app_resume"), remount.runCloudProviderSync("sign_in")]);
      await observer.getCurrentQuery().promise;
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "GET", url: `${mode === "gateway" ? "https://self-hosted.example" : "https://den.example"}/api/den/v1/gateway/usage-limits/me` });
      expect(observer.getCurrentResult().data?.state).toBe("blocked");
      await store.runCloudProviderSync("app_resume");
      await observer.getCurrentQuery().promise;
      expect(requests).toHaveLength(2);
      expect(requests[1]?.url).toBe(requests[0]?.url);
      expect(store.getSnapshot().providerAuthError).toBeNull();
    } finally { unsubscribe(); store.dispose(); remount.dispose(); }
  });

  test.each(["gateway", "readonly"])("queued %s refresh rejects changed identity and disposed stores", async (mode) => {
    for (const change of ["signout", "organization", "account", "dispose"]) {
      const storage = installWindow({ origin: "https://self-hosted.example" });
      installCloudSession(storage);
      const requests: RecordedRequest[] = [];
      let release = () => {};
      let reached = () => {};
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { reached = resolve; });
      installProviderSyncFetch(requests, { onRun: () => { reached(); return pending; } });
      const { store: blocker } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
      const blocking = blocker.runCloudProviderSync("app_resume");
      await started;
      if (mode === "gateway") Object.defineProperty(window, "__OPENWORK_GATEWAY__", { configurable: true, value: { version: 1 } });
      const { store } = createProviderAuthTestStore({ read: true, write: false });
      const { observer, unsubscribe } = observeOwnUsage();
      let nextUsage: ReturnType<typeof observeOwnUsage> | undefined;
      try {
        const queued = store.runCloudProviderSync("app_resume");
        blocker.dispose();
        if (change === "signout") storage.clear();
        else if (change === "organization") storage.setItem("openwork.den.activeOrgId", "org_next");
        else if (change === "account") storage.setItem("openwork.den.authToken", "next-token");
        else store.dispose();
        nextUsage = observeOwnUsage();
        release();
        await Promise.all([blocking, queued]);
        if (change === "dispose" || change === "signout") await store.runCloudProviderSync("app_resume");
        expect(requests.filter((request) => request.url.endsWith("/gateway/usage-limits/me"))).toHaveLength(0);
        expect(observer.getCurrentQuery().state.isInvalidated).toBe(false);
        expect(nextUsage.observer.getCurrentQuery().state.isInvalidated).toBe(false);
      } finally {
        release();
        await blocking;
        unsubscribe(); nextUsage?.unsubscribe(); store.dispose(); blocker.dispose();
        getReactQueryClient().clear();
      }
    }
  });

  test.each(["organization", "dispose"])("read-only target resolution rejects an in-flight %s change", async (change) => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store } = createProviderAuthTestStore({ read: true, write: false });
    const { observer, unsubscribe } = observeOwnUsage();
    try {
      const running = store.runCloudProviderSync("app_resume");
      if (change === "organization") storage.setItem("openwork.den.activeOrgId", "org_next");
      else store.dispose();
      await running;
      expect(requests).toHaveLength(0);
      expect(observer.getCurrentQuery().state.isInvalidated).toBe(false);
    } finally { unsubscribe(); store.dispose(); }
  });

  test("coalesced callers and remounted stores invalidate usage only once", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    installProviderSyncFetch(requests, { onRun: () => pending });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    const { store: remount } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    const { observer, unsubscribe } = observeOwnUsage();
    try {
      const runs = [store.runCloudProviderSync("app_resume"), store.runCloudProviderSync("sign_in"), remount.runCloudProviderSync("app_resume")];
      release();
      await Promise.all(runs);
      await observer.getCurrentQuery().promise;
      expect(requests.filter((request) => request.url.endsWith("/cloud-provider-sync/run"))).toHaveLength(1);
      expect(requests.filter((request) => request.url.endsWith("/gateway/usage-limits/me"))).toHaveLength(1);
    } finally { release(); unsubscribe(); store.dispose(); remount.dispose(); }
  });

  test.each(["signout", "organization", "account", "baseUrl"])("an in-flight sync cannot invalidate usage after %s changes", async (change) => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    let nextUsage: ReturnType<typeof observeOwnUsage> | undefined;
    installProviderSyncFetch(requests, { onRun: () => {
      if (change === "signout") storage.clear();
      else if (change === "organization") storage.setItem("openwork.den.activeOrgId", "org_next");
      else if (change === "account") storage.setItem("openwork.den.authToken", "next-token");
      else storage.setItem("openwork.den.baseUrl", "https://den-next.example");
      nextUsage = observeOwnUsage();
    } });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    const { observer, unsubscribe } = observeOwnUsage();
    try {
      await store.runCloudProviderSync("app_resume");
      expect(requests.filter((request) => request.url.endsWith("/gateway/usage-limits/me"))).toHaveLength(0);
      expect(observer.getCurrentQuery().state.isInvalidated).toBe(false);
      expect(nextUsage?.observer.getCurrentQuery().state.isInvalidated).toBe(false);
    } finally { unsubscribe(); nextUsage?.unsubscribe(); store.dispose(); }
  });

  test.each([false, true])("usage failure neither delays nor fails provider sync/reload (server sync: %s)", async (providerSync) => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    let resolveUsage: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { resolveUsage = resolve; });
    installProviderSyncFetch(requests, { onUsage: () => pending, runStatuses: [{ status: "applied" }] });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync });
    const { observer, unsubscribe } = observeOwnUsage();
    try {
      const outcome = await store.runCloudProviderSync("settings_cloud_opened");
      expect(outcome).toEqual(providerSync ? { outcome: "handled_server_side" } : undefined);
      expect(observer.getCurrentResult().isFetching).toBe(true);
      expect(requests.some((request) => new URL(request.url).pathname === "/provider")).toBe(true);
      expect(store.getSnapshot().providerLoadState.status).toBe("ready");
      if (!providerSync) expect(requests.some((request) => request.url.endsWith("/engine/reload"))).toBe(true);
      await store.runCloudProviderSync("app_resume");
      expect(requests.filter((request) => request.url.endsWith("/gateway/usage-limits/me"))).toHaveLength(1);
      resolveUsage(jsonResponse({ error: "Usage unavailable" }, 503));
      await observer.getCurrentQuery().promise?.catch(() => {});
      expect(observer.getCurrentQuery().state.status).toBe("error");
      expect(store.getSnapshot().providerAuthError).toBeNull();
      expect(store.getSnapshot().lastSyncError).toEqual({});
    } finally { resolveUsage(jsonResponse({})); unsubscribe(); store.dispose(); }
  });
});

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

  test.each(["settings_cloud_opened", "manual"] as const)("rereads hosted runtime providers without client-side materialization on %s", async (reason) => {
    const storage = installWindow({ origin: "https://web.openworklabs.com", gateway: true });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const { store } = createProviderAuthTestStore();

    const outcome = await store.runCloudProviderSync(reason);

    expect(outcome).toEqual({ outcome: "handled_server_side" });
    expect(requests.some((request) => new URL(request.url).pathname === "/provider")).toBe(true);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.some((request) => request.url.includes("/cloud-provider-sync/run"))).toBe(false);
    expect(store.getSnapshot().providerAuthError).toBeNull();
  });

  test.each(["session delivery", "OAuth response"])("does not use an OAuth result after an organization switch during %s", async (phase) => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installProviderSyncFetch(requests);
    const fixtureFetch = globalThis.fetch;
    const starts: string[] = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = getRequestUrl(input);
      if (url.endsWith("/den-session") && phase === "session delivery") {
        storage.setItem("openwork.den.activeOrgId", "org_other");
      }
      if (url.endsWith("/oauth/start")) {
        starts.push(url);
        if (phase === "OAuth response") storage.setItem("openwork.den.activeOrgId", "org_other");
        return jsonResponse({ authorizationUrl: "https://den.example/gateway/connect?attempt=fixture" });
      }
      return fixtureFetch(input, init);
    } });
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    await expect(store.startGatewayProviderOAuth("ipr_fixture", "gcs_fixture", new AbortController().signal)).rejects.toThrow("changed");
    expect(starts).toHaveLength(phase === "session delivery" ? 0 : 1);
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

  test("quota notice provenance stays with org A through delayed/failed B sync and changes only on verified B success", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    const provider = (id: string) => ({ cloudProviderId: id, providerId: id, sourceProviderId: "openai", source: "openwork_gateway", name: "Assigned", modelIds: ["model"] });
    const options: NonNullable<Parameters<typeof installProviderSyncFetch>[1]> = {
      statusProviders: [provider("ipr_org_a")], runStatuses: [{ status: "applied" }],
    };
    installProviderSyncFetch(requests, options);
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    const eligible = (id: string) => store.getSnapshot().gatewayUsageProviderScope === readGatewayUsageScope().generation
      && resolveGatewayProviderIds(store.getSnapshot().importedCloudProviders).has(id);
    try {
      await store.refreshImportedCloudProviders();
      expect(eligible("ipr_org_a")).toBe(false);
      const readOnlyOptions = { strict: false, verifiedScope: readGatewayUsageScope().generation };
      await store.refreshImportedCloudProviders(readOnlyOptions);
      expect(eligible("ipr_org_a")).toBe(false);
      await store.runCloudProviderSync("manual");
      expect(eligible("ipr_org_a")).toBe(true);
      const scopeA = store.getSnapshot().gatewayUsageProviderScope;
      storage.setItem("openwork.den.activeOrgId", "org_b");
      storage.setItem("openwork.den.authToken", "token_b");
      let release: (() => void) | undefined;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      options.onRun = async () => { await delayed; throw new Error("Sync unavailable"); };
      const syncB = store.runCloudProviderSync("manual");
      await Promise.resolve();
      expect(store.getSnapshot().importedCloudProviders.ipr_org_a).toBeDefined();
      expect(eligible("ipr_org_a")).toBe(false);
      expect(scopeA).not.toBe(readGatewayUsageScope().generation);
      release?.();
      await syncB;
      expect(store.getSnapshot().importedCloudProviders.ipr_org_a).toBeDefined();
      expect(eligible("ipr_org_a")).toBe(false);
      options.onRun = undefined;
      options.statusProviders = [provider("ipr_org_b")];
      await store.runCloudProviderSync("manual");
      expect(eligible("ipr_org_b")).toBe(true);
      expect(eligible("ipr_org_a")).toBe(false);
    } finally { store.dispose(); }
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
    // The old organization's callers are cancelled rather than publishing
    // the replacement organization's result into their stale context.
    expect(outcomes).toEqual([undefined, undefined, undefined, { outcome: "handled_server_side" }, { outcome: "handled_server_side" }]);
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
    expect(sessionRequests).toHaveLength(2);
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

  test("keeps pending assigned aliases in status only and removes them on an authoritative context refresh", async () => {
    const storage = installWindow({ origin: "https://self-hosted.example" });
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    const credentialSetId = "gcs_00000000000000000000000002";
    const id = "gwm_00000000000000000000000001_00000000000000000000000002_00000000000000000000000003";
    const model = { id, name: "Assigned model", config: { id }, upstreamModelId: "upstream",
      modelGroupId: "gmg_00000000000000000000000001", modelGroupName: "Assigned group",
      credentialSetId, credentialSetName: "Personal" };
    let release: () => void = () => undefined;
    let hold = Promise.resolve();
    const options = { onRun: async () => { await hold; }, statusSkipped: [{ cloudProviderId: "ipr_pending", providerId: "ipr_pending", credentialSetId,
      name: "Member provider", reason: "member_auth_required", models: [model, { ...model, credentialSetId: "gcs_wrong" }] }] };
    installProviderSyncFetch(requests, options);
    const { store } = createProviderAuthTestStore({ read: true, write: true, providerSync: true });
    try {
      await store.runCloudProviderSync("manual");
      expect(store.getSnapshot().cloudProviderServerSync?.skippedProviders[`ipr_pending:${credentialSetId}`]?.models).toEqual([model]);
      expect(store.getSnapshot().importedCloudProviders).toEqual({});
      expect(store.isGatewayModelAvailable({ cloudProviderId: "ipr_pending", providerId: "ipr_pending", credentialSetId, name: "Member", authUrl: null }, { providerID: "ipr_pending", modelID: id })).toBe(false);
      expect(requests.filter((request) => request.method !== "GET").every((request) => ["/den-session", "/cloud-provider-sync/run"].includes(new URL(request.url).pathname))).toBe(true);
      storage.setItem("openwork.den.activeOrgId", "org_replacement");
      options.statusSkipped = [];
      hold = new Promise<void>((resolve) => { release = resolve; });
      const refresh = store.runCloudProviderSync("manual");
      expect(store.getSnapshot().cloudProviderServerSync).toBeNull();
      release();
      await refresh;
      expect(store.getSnapshot().cloudProviderServerSync?.skippedProviders).toEqual({});
    } finally { store.dispose(); }
  });

  test("maps imported provider status and ordered authorized pins by cloud provider id", async () => {
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
        modelIds: ["gpt-test", "gpt-second"],
        pinnedModelIds: ["gpt-second", "not-granted", "gpt-test", "gpt-second"],
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
      modelIds: ["gpt-test", "gpt-second"],
      pinnedModelIds: ["gpt-second", "gpt-test"],
      importedAt: 123,
    });
  });
});
