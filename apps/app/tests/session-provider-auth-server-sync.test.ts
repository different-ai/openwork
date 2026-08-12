import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClient } from "../src/app/lib/opencode";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createSessionOpenworkServer } from "../src/react-app/domains/connections/provider-auth/session-openwork-server";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

/**
 * Regression tests for #3671 (org-published LLM providers never reach
 * signed-in desktops): the session route — the app's default surface — used to
 * feed the provider-auth store a fabricated openwork-server snapshot without
 * the `providerSync` capability or host-token auth, so
 * `serverHandlesProviderSync()` was permanently false there. After sign-in
 * the store therefore never PUT the Den session to the local server
 * (server-side sync never started) and instead ran the legacy renderer-side
 * import loop against Den.
 *
 * These tests drive the real store through the real session-route snapshot
 * builder (`createSessionOpenworkServer`) and assert the store takes the
 * server-side path for local endpoints: PUT /den-session with the host token,
 * POST /cloud-provider-sync/run, and zero renderer-side Den provider fetches.
 */

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalConsoleInfo = console.info;
const originalDeployment = process.env.VITE_OPENWORK_DEPLOYMENT;

const LOCAL_SERVER_ORIGIN = "http://127.0.0.1:7899";
const REMOTE_SERVER_ORIGIN = "https://worker.example";

type RecordedRequest = {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
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

function installWindow(): Storage {
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      localStorage,
      location: { origin: "https://self-hosted.example" },
      __OPENWORK_GATEWAY__: undefined,
    },
  });
  return localStorage;
}

function installCloudSession(storage: Storage) {
  storage.setItem("openwork.den.baseUrl", "https://den.example");
  storage.setItem("openwork.den.authToken", "den-token");
  storage.setItem("openwork.den.activeOrgId", "org_test");
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

function normalizeHeaders(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) {
    const entries: Record<string, string> = {};
    raw.forEach((value, key) => {
      entries[key.toLowerCase()] = value;
    });
    return entries;
  }
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cloudProviderPayload() {
  return {
    id: "lpr_test",
    source: "custom",
    providerId: "openai",
    name: "Team OpenAI",
    providerConfig: { env: ["OPENAI_API_KEY"] },
    hasApiKey: true,
    apiKey: "sk-test",
    models: [{ id: "gpt-test", name: "GPT Test", config: {}, createdAt: null }],
    createdAt: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function installFetchMock(
  requests: RecordedRequest[],
  options: { runStatuses?: Array<{ status: "applied" | "noop" | "failed" | "no_session"; message?: string }> } = {},
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
        body: typeof init?.body === "string" ? init.body : null,
        headers: normalizeHeaders(init),
      });

      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers") {
        return jsonResponse({ llmProviders: [cloudProviderPayload()] });
      }
      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers/lpr_test/connect") {
        return jsonResponse({ llmProvider: cloudProviderPayload() });
      }
      if (url.pathname === "/den-session" && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/cloud-provider-sync/run" && method === "POST") {
        const statuses = options.runStatuses ?? [{ status: "noop" }];
        const result = statuses[Math.min(runIndex, statuses.length - 1)];
        runIndex += 1;
        return jsonResponse(result);
      }
      if (url.pathname === "/cloud-provider-sync/status" && method === "GET") {
        return jsonResponse({ hasSession: true, lastRun: null, providers: [] });
      }
      if (url.pathname === "/workspace/ws_1/config" && method === "GET") {
        return jsonResponse({ opencode: {}, openwork: {} });
      }
      if (url.pathname === "/workspace/ws_1/config" && method === "PATCH") {
        return jsonResponse({ updatedAt: 1 });
      }
      if (url.pathname === "/workspace/ws_1/opencode-config") {
        return jsonResponse(null);
      }
      if (url.pathname === "/env") {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/workspace/ws_1/engine/reload") {
        return jsonResponse({ ok: true, reloadedAt: 1 });
      }
      if (url.pathname === "/global/health") {
        return jsonResponse({ healthy: true, version: "1.17.11" });
      }
      if (url.pathname === "/provider") {
        return jsonResponse({ all: [], connected: [], default: {} });
      }
      if (url.pathname === "/config") {
        return jsonResponse({ disabled_providers: [] });
      }
      return jsonResponse({});
    },
  });
}

function makeEndpoint(options: { origin: string; isRemote: boolean }): ResolvedWorkspaceEndpoint {
  const client = createOpenworkServerClient({ baseUrl: options.origin, token: "client-token" });
  const mountedBaseUrl = `${options.origin}/workspace/ws_1`;
  return {
    baseUrl: options.origin,
    token: "client-token",
    workspaceId: "ws_1",
    isRemote: options.isRemote,
    client,
    mountedBaseUrl,
    opencodeBaseUrl: `${mountedBaseUrl}/opencode`,
  };
}

function createSessionRouteStore(options: {
  endpoint: ResolvedWorkspaceEndpoint | null;
  hostToken: string;
}) {
  const opencodeClient = createClient("https://engine.example", "/tmp/workspace_test", {
    token: "engine-token",
    mode: "openwork",
  });
  const workspace = {
    id: "workspace_test",
    name: "Test workspace",
    path: "/tmp/workspace_test",
    preset: "default",
    workspaceType: options.endpoint?.isRemote ? "remote" : "local",
  } satisfies WorkspaceDisplay;
  let providers: ProviderListItem[] = [];
  let providerDefaults: Record<string, string> = {};
  let providerConnectedIds: string[] = [];
  let disabledProviders: string[] = [];

  return createProviderAuthStore({
    client: () => opencodeClient,
    providers: () => providers,
    providerDefaults: () => providerDefaults,
    providerConnectedIds: () => providerConnectedIds,
    disabledProviders: () => disabledProviders,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => "https://engine.example",
    selectedWorkspaceRoot: () => "/tmp/workspace_test",
    runtimeWorkspaceId: () => "ws_1",
    // The exact snapshot builder the session route mounts.
    openworkServer: createSessionOpenworkServer({
      endpoint: () => options.endpoint,
      hostToken: () => options.hostToken,
    }),
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
    markOpencodeConfigReloadRequired: () => undefined,
  });
}

describe("session-route cloud provider sync wiring", () => {
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

  test("startup hydrates assigned organization models without a workspace endpoint", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installFetchMock(requests);
    const store = createSessionRouteStore({
      endpoint: null,
      hostToken: "",
    });
    const assignedModelsLoaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("assigned models did not load")), 1_000);
      const unsubscribe = store.subscribe(() => {
        if (store.getSnapshot().cloudOrgProviders.length === 0) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });

    store.start();
    await assignedModelsLoaded;

    expect(store.getSnapshot().cloudOrgProviders).toMatchObject([
      {
        id: "lpr_test",
        models: [{ id: "gpt-test", name: "GPT Test" }],
      },
    ]);
    expect(
      requests.filter((request) => request.url === "https://den.example/api/den/v1/llm-providers"),
    ).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(0);
    store.dispose();
  });

  test("a local endpoint with a host token pushes the Den session and syncs server-side after sign-in", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installFetchMock(requests, { runStatuses: [{ status: "no_session" }, { status: "applied" }] });
    const store = createSessionRouteStore({
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "host-token-live",
    });

    expect(await store.runCloudProviderSync("sign_in")).toEqual({ outcome: "handled_server_side" });

    const sessionPuts = requests.filter(
      (request) => request.method === "PUT" && new URL(request.url).pathname === "/den-session",
    );
    expect(sessionPuts).toHaveLength(1);
    expect(new URL(sessionPuts[0]?.url ?? "").origin).toBe(LOCAL_SERVER_ORIGIN);
    expect(sessionPuts[0]?.headers["x-openwork-host-token"]).toBe("host-token-live");
    expect(sessionPuts[0]?.body).toBe(JSON.stringify({
      baseUrl: "https://den.example/api/den",
      token: "den-token",
      orgId: "org_test",
    }));

    const runPosts = requests.filter(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/cloud-provider-sync/run",
    );
    expect(runPosts).toHaveLength(2);
    expect(runPosts.every((request) => request.headers["x-openwork-host-token"] === "host-token-live")).toBe(true);

    // Server-side sync means the renderer never fetches Den providers itself.
    expect(requests.filter((request) => request.url.includes("/v1/llm-providers"))).toHaveLength(0);
  });

  test("falls back to the persisted host token for loopback servers when live host info is absent", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    storage.setItem("openwork.server.hostToken", "host-token-stored");
    const requests: RecordedRequest[] = [];
    installFetchMock(requests, { runStatuses: [{ status: "no_session" }, { status: "noop" }] });
    const store = createSessionRouteStore({
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "",
    });

    expect(await store.runCloudProviderSync("sign_in")).toEqual({ outcome: "handled_server_side" });

    const sessionPuts = requests.filter(
      (request) => request.method === "PUT" && new URL(request.url).pathname === "/den-session",
    );
    expect(sessionPuts).toHaveLength(1);
    expect(sessionPuts[0]?.headers["x-openwork-host-token"]).toBe("host-token-stored");
  });

  test("remote workspaces never receive the desktop's Den session and keep the legacy client path", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    // Even a (stale) persisted local host token must not leak to a remote worker.
    storage.setItem("openwork.server.hostToken", "host-token-stored");
    const requests: RecordedRequest[] = [];
    installFetchMock(requests);
    const store = createSessionRouteStore({
      endpoint: makeEndpoint({ origin: REMOTE_SERVER_ORIGIN, isRemote: true }),
      hostToken: "",
    });

    await store.runCloudProviderSync("sign_in");

    expect(requests.filter((request) => new URL(request.url).pathname === "/den-session")).toHaveLength(0);
    expect(requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run")).toHaveLength(0);
    // The legacy renderer-side reconciliation still runs for remote workspaces.
    expect(requests.some((request) => request.url === "https://den.example/api/den/v1/llm-providers")).toBe(true);
  });
});
