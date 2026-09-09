import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearDenSession } from "../src/app/lib/den";
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
  signal?: AbortSignal | null;
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
  const listeners = new Map<string, Set<EventListener>>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (type: string, listener: EventListener) => {
        const registered = listeners.get(type) ?? new Set<EventListener>();
        registered.add(listener);
        listeners.set(type, registered);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
        return true;
      },
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

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected request did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionPuts(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === "PUT" && new URL(request.url).pathname === "/den-session");
}

function syncRuns(requests: RecordedRequest[]) {
  return requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/run");
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
  options: {
    runStatuses?: Array<{ status: "applied" | "noop" | "failed" | "no_session"; message?: string }>;
    providerResponse?: Promise<Response>;
    sessionResponse?: (attempt: number) => Response | Promise<Response>;
    runResponse?: Promise<Response> | ((attempt: number) => Response | Promise<Response>);
    statusResponse?: Promise<Response>;
  } = {},
) {
  let runIndex = 0;
  let sessionIndex = 0;
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
        signal: init?.signal,
      });

      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers") {
        return options.providerResponse ?? jsonResponse({ llmProviders: [cloudProviderPayload()] });
      }
      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers/lpr_test/connect") {
        return jsonResponse({ llmProvider: cloudProviderPayload() });
      }
      if (url.pathname === "/den-session" && method === "PUT") {
        return options.sessionResponse?.(sessionIndex++) ?? new Response(null, { status: 204 });
      }
      if (url.pathname === "/cloud-provider-sync/run" && method === "POST") {
        if (typeof options.runResponse === "function") return options.runResponse(runIndex++);
        if (options.runResponse) return options.runResponse;
        const statuses = options.runStatuses ?? [{ status: "noop" }];
        const result = statuses[Math.min(runIndex, statuses.length - 1)];
        runIndex += 1;
        return jsonResponse(result);
      }
      if (url.pathname === "/cloud-provider-sync/status" && method === "GET") {
        return options.statusResponse ?? jsonResponse({ hasSession: true, lastRun: null, providers: [] });
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
  generation?: number;
  connectedProviderIds?: string[];
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
  let providerConnectedIds: string[] = options.connectedProviderIds ?? [];
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
      generation: () => options.generation ?? null,
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

  test("clearing the Den session clears assigned organization models", async () => {
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
    clearDenSession();

    expect(store.getSnapshot().cloudOrgProviders).toEqual([]);
    expect(store.getSnapshot().importedCloudProviders).toEqual({});
    store.dispose();
  });

  test("logout removes connected provider credentials and resets their saved default", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    storage.setItem("openwork.defaultModel", "anthropic/claude-fable-5");
    const requests: RecordedRequest[] = [];
    installFetchMock(requests);
    const store = createSessionRouteStore({
      endpoint: null,
      hostToken: "",
      connectedProviderIds: ["opencode", "anthropic"],
    });

    store.start();
    clearDenSession();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (requests.some((request) =>
        request.method === "DELETE" && new URL(request.url).pathname === "/auth/anthropic"
      )) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(
      requests.filter((request) =>
        request.method === "DELETE" && new URL(request.url).pathname === "/auth/anthropic"
      ),
    ).toHaveLength(1);
    expect(storage.getItem("openwork.defaultModel")).not.toBe("anthropic/claude-fable-5");
    store.dispose();
  });

  test("an organization provider request started before logout cannot restore stale models", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    let resolveProviderResponse: (response: Response) => void = () => undefined;
    const providerResponse = new Promise<Response>((resolve) => {
      resolveProviderResponse = resolve;
    });
    installFetchMock(requests, { providerResponse });
    const store = createSessionRouteStore({
      endpoint: null,
      hostToken: "",
    });

    store.start();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (requests.some((request) => request.url === "https://den.example/api/den/v1/llm-providers")) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      requests.filter((request) => request.url === "https://den.example/api/den/v1/llm-providers"),
    ).toHaveLength(1);
    clearDenSession();
    resolveProviderResponse(jsonResponse({ llmProviders: [cloudProviderPayload()] }));
    await providerResponse;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getSnapshot().cloudOrgProviders).toEqual([]);
    expect(store.getSnapshot().importedCloudProviders).toEqual({});
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
    expect(sessionPuts).toHaveLength(2);
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
    expect(sessionPuts).toHaveLength(2);
    expect(sessionPuts[0]?.headers["x-openwork-host-token"]).toBe("host-token-stored");
  });

  test("the same store redelivers once when only the local runtime generation changes", async () => {
    installCloudSession(installWindow());
    const requests: RecordedRequest[] = [];
    installFetchMock(requests);
    const options = {
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "host-token-live",
      generation: 1,
    };
    const store = createSessionRouteStore(options);
    try {
      store.syncFromOptions();
      await store.runCloudProviderSync("manual");
      expect(sessionPuts(requests)).toHaveLength(1);
      options.generation = 2;
      store.syncFromOptions();
      store.syncFromOptions();
      await store.runCloudProviderSync("manual");
      expect(sessionPuts(requests)).toHaveLength(2);
      expect(syncRuns(requests)).toHaveLength(2);
      await store.runCloudProviderSync("manual");
      expect(sessionPuts(requests)).toHaveLength(2);
      const operations = requests.filter((request) =>
        ["/den-session", "/cloud-provider-sync/run"].includes(new URL(request.url).pathname),
      );
      expect(operations.map((request) => request.method)).toEqual(["PUT", "POST", "PUT", "POST", "POST"]);
    } finally {
      store.dispose();
    }
  });

  for (const failure of ["network", "policy_unavailable", "server_unavailable"]) {
    test(`retries transient ${failure} delivery and coalesces concurrent sync requests`, async () => {
      installCloudSession(installWindow());
      const requests: RecordedRequest[] = [];
      installFetchMock(requests, {
        sessionResponse: (attempt) => {
          if (attempt > 0) return new Response(null, { status: 204 });
          if (failure === "network") throw new TypeError("Failed to fetch");
          return jsonResponse({ code: failure }, failure === "policy_unavailable" ? 403 : 503);
        },
      });
      const store = createSessionRouteStore({
        endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
        hostToken: "host-token-live",
      });
      try {
        store.syncFromOptions();
        const results = await Promise.all([
          store.runCloudProviderSync("manual"),
          store.runCloudProviderSync("app_resume"),
        ]);
        expect(results).toEqual([{ outcome: "handled_server_side" }, { outcome: "handled_server_side" }]);
        expect(sessionPuts(requests)).toHaveLength(2);
        expect(syncRuns(requests)).toHaveLength(1);
        expect(requests.indexOf(syncRuns(requests)[0]!)).toBeGreaterThan(requests.indexOf(sessionPuts(requests)[1]!));
      } finally {
        store.dispose();
      }
    });
  }

  test("bounds failed refresh retries and redelivers on the next sync even when the server still has an old session", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    installFetchMock(requests, {
      // Initial delivery succeeds. The next three PUTs fail without clearing
      // the old server session; its run endpoint would still return noop.
      sessionResponse: (attempt) => attempt > 0 && attempt < 4
        ? jsonResponse({ code: "policy_unavailable" }, 403)
        : new Response(null, { status: 204 }),
    });
    const store = createSessionRouteStore({
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "host-token-live",
    });
    try {
      await store.runCloudProviderSync("manual");
      storage.setItem("openwork.den.authToken", "refreshed-den-token");
      store.syncFromOptions();
      expect(await store.runCloudProviderSync("settings_cloud_opened")).toBeUndefined();
      expect(sessionPuts(requests)).toHaveLength(4);
      expect(syncRuns(requests)).toHaveLength(1);
      expect(await store.runCloudProviderSync("manual")).toEqual({ outcome: "handled_server_side" });
      expect(sessionPuts(requests)).toHaveLength(5);
      expect(syncRuns(requests)).toHaveLength(2);
      expect(JSON.parse(sessionPuts(requests)[4]!.body!).token).toBe("refreshed-den-token");
    } finally {
      store.dispose();
    }
  });

  for (const { status, code } of [
    { status: 401, code: "unauthorized" },
    { status: 403, code: "organization_denied" },
    { status: 409, code: "policy_identity_changed" },
    { status: 429, code: "rate_limited" },
  ]) {
    test(`does not retry explicit ${code} delivery failure`, async () => {
      installCloudSession(installWindow());
      const requests: RecordedRequest[] = [];
      installFetchMock(requests, { sessionResponse: () => jsonResponse({ code }, status) });
      const store = createSessionRouteStore({
        endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
        hostToken: "host-token-live",
      });
      try {
        expect(await store.runCloudProviderSync("manual")).toBeUndefined();
        expect(sessionPuts(requests)).toHaveLength(1);
        expect(syncRuns(requests)).toHaveLength(0);
      } finally {
        store.dispose();
      }
    });
  }

  for (const cancel of ["signout", "dispose", "remote"]) {
    test(`${cancel} cancels pending delivery retries without forwarding desktop credentials`, async () => {
      installCloudSession(installWindow());
      const requests: RecordedRequest[] = [];
      installFetchMock(requests, { sessionResponse: () => jsonResponse({ code: "policy_unavailable" }, 403) });
      const options = {
        endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
        hostToken: "host-token-live",
        generation: 1,
      };
      const store = createSessionRouteStore(options);
      store.start();
      try {
        const pending = store.runCloudProviderSync("manual");
        await waitFor(() => sessionPuts(requests).length === 1);
        if (cancel === "signout") clearDenSession();
        else if (cancel === "dispose") store.dispose();
        else {
          options.endpoint = makeEndpoint({ origin: REMOTE_SERVER_ORIGIN, isRemote: true });
          options.generation = 2;
          store.syncFromOptions();
        }
        await pending;
        expect(sessionPuts(requests)).toHaveLength(1);
        expect(sessionPuts(requests)[0]!.signal?.aborted).toBe(true);
        expect(syncRuns(requests)).toHaveLength(0);
        if (cancel === "remote") await store.runCloudProviderSync("manual");
        expect(requests.filter((request) => new URL(request.url).origin === REMOTE_SERVER_ORIGIN).every((request) =>
          !request.headers["x-openwork-host-token"] && !request.body?.includes("den-token"),
        )).toBe(true);
      } finally {
        store.dispose();
      }
    });
  }

  test("an obsolete runtime PUT cannot satisfy delivery to the replacement runtime", async () => {
    installCloudSession(installWindow());
    const requests: RecordedRequest[] = [];
    const old = deferredResponse();
    installFetchMock(requests, { sessionResponse: (attempt) => attempt === 0 ? old.promise : new Response(null, { status: 204 }) });
    const options = {
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "host-token-live",
      generation: 1,
    };
    const store = createSessionRouteStore(options);
    try {
      const pending = store.runCloudProviderSync("manual");
      await waitFor(() => sessionPuts(requests).length === 1);
      options.generation = 2;
      store.syncFromOptions();
      old.resolve(new Response(null, { status: 204 }));
      await pending;
      await store.runCloudProviderSync("manual");
      expect(sessionPuts(requests)).toHaveLength(2);
      expect(syncRuns(requests)).toHaveLength(1);
      expect(sessionPuts(requests)[0]!.signal?.aborted).toBe(true);
    } finally {
      old.resolve(new Response(null, { status: 204 }));
      store.dispose();
    }
  });

  test("a late successful PUT after signout cannot restore or memoize the old session", async () => {
    const storage = installWindow();
    installCloudSession(storage);
    const requests: RecordedRequest[] = [];
    const old = deferredResponse();
    installFetchMock(requests, { sessionResponse: (attempt) => attempt === 0 ? old.promise : new Response(null, { status: 204 }) });
    const store = createSessionRouteStore({
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "host-token-live",
    });
    store.start();
    try {
      const pending = store.runCloudProviderSync("manual");
      await waitFor(() => sessionPuts(requests).length === 1);
      clearDenSession();
      expect(syncRuns(requests)).toHaveLength(0);
      expect(store.getSnapshot().cloudProviderServerSync).toBeNull();
      // Reusing the same credentials must not revive the old request's lease.
      installCloudSession(storage);
      const current = store.runCloudProviderSync("manual");
      old.resolve(new Response(null, { status: 204 }));
      await Promise.all([pending, current]);
      expect(sessionPuts(requests)).toHaveLength(2);
      expect(syncRuns(requests)).toHaveLength(1);
    } finally {
      old.resolve(new Response(null, { status: 204 }));
      store.dispose();
    }
  });

  test("a surviving store takes over a coalesced delivery when its owning store is disposed", async () => {
    installCloudSession(installWindow());
    const requests: RecordedRequest[] = [];
    const old = deferredResponse();
    installFetchMock(requests, { sessionResponse: (attempt) => attempt === 0 ? old.promise : new Response(null, { status: 204 }) });
    const options = {
      endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
      hostToken: "host-token-live",
    };
    const owner = createSessionRouteStore(options);
    const survivor = createSessionRouteStore(options);
    try {
      const first = owner.runCloudProviderSync("manual");
      await waitFor(() => sessionPuts(requests).length === 1);
      const second = survivor.runCloudProviderSync("manual");
      expect(sessionPuts(requests)).toHaveLength(1);
      owner.dispose();
      old.resolve(new Response(null, { status: 204 }));
      expect(await first).toBeUndefined();
      expect(await second).toEqual({ outcome: "handled_server_side" });
      expect(sessionPuts(requests)).toHaveLength(2);
      expect(syncRuns(requests)).toHaveLength(1);
    } finally {
      old.resolve(new Response(null, { status: 204 }));
      owner.dispose();
      survivor.dispose();
    }
  });

  for (const action of ["dropped", "replaced"]) {
    test(`a ${action} trailing batch cannot satisfy another store's runtime generation`, async () => {
      installCloudSession(installWindow());
      const requests: RecordedRequest[] = [];
      const runs = [deferredResponse(), deferredResponse(), deferredResponse()];
      installFetchMock(requests, {
        runResponse: (attempt) => runs[attempt]?.promise ?? jsonResponse({ status: "noop" }),
      });
      const optionsA = {
        endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
        hostToken: "host-token-live",
        generation: 1,
      };
      const storeA = createSessionRouteStore(optionsA);
      const storeB = createSessionRouteStore({ ...optionsA, generation: 2 });
      const pending: Array<Promise<unknown>> = [];
      try {
        pending.push(storeA.runCloudProviderSync("manual"));
        await waitFor(() => syncRuns(requests).length === 1);
        let bSettled = false;
        pending.push(storeB.runCloudProviderSync("manual").then((result) => {
          bSettled = true;
          return result;
        }));
        // A stale gen1 trigger drops B's gen2 batch; a gen3 trigger replaces
        // it. Neither executed context may be accepted as B's own sync.
        if (action === "replaced") optionsA.generation = 3;
        pending.push(storeA.runCloudProviderSync("app_resume"));
        expect(syncRuns(requests)).toHaveLength(1);
        runs[0]!.resolve(jsonResponse({ status: "noop" }));
        await waitFor(() => syncRuns(requests).length === 2);
        expect(bSettled).toBe(false);
        runs[1]!.resolve(jsonResponse({ status: "noop" }));
        if (action === "replaced") {
          await waitFor(() => syncRuns(requests).length === 3);
          expect(bSettled).toBe(false);
          runs[2]!.resolve(jsonResponse({ status: "noop" }));
        }
        const results = await Promise.all(pending);
        expect(results[1]).toEqual({ outcome: "handled_server_side" });
        expect(sessionPuts(requests)).toHaveLength(action === "replaced" ? 3 : 2);
        expect(syncRuns(requests)).toHaveLength(action === "replaced" ? 3 : 2);
      } finally {
        storeA.dispose();
        storeB.dispose();
        for (const run of runs) run.resolve(jsonResponse({ status: "noop" }));
        await Promise.allSettled(pending);
      }
    });
  }

  for (const delayed of ["run", "status"]) {
    test(`discards a late server ${delayed} response after signout`, async () => {
      installCloudSession(installWindow());
      const requests: RecordedRequest[] = [];
      const old = deferredResponse();
      installFetchMock(requests, delayed === "run" ? { runResponse: old.promise } : { statusResponse: old.promise });
      const store = createSessionRouteStore({
        endpoint: makeEndpoint({ origin: LOCAL_SERVER_ORIGIN, isRemote: false }),
        hostToken: "host-token-live",
      });
      store.start();
      try {
        const pending = store.runCloudProviderSync("manual");
        await waitFor(() => delayed === "run"
          ? syncRuns(requests).length === 1
          : syncRuns(requests).length === 1 && requests.filter((request) => new URL(request.url).pathname === "/cloud-provider-sync/status").length >= 2);
        clearDenSession();
        old.resolve(jsonResponse(delayed === "run"
          ? { status: "applied" }
          : { hasSession: true, lastRun: null, providers: [], reloadPending: true }));
        await pending;
        expect(store.getSnapshot().cloudProviderServerSync).toBeNull();
        expect(store.getSnapshot().importedCloudProviders).toEqual({});
      } finally {
        old.resolve(jsonResponse({}));
        store.dispose();
      }
    });
  }

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
