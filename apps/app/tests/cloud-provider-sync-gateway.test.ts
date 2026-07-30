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

function cloudProviderPayload() {
  return {
    id: "lpr_test",
    source: "custom",
    providerId: "openai",
    name: "Team OpenAI",
    providerConfig: { env: ["OPENAI_API_KEY"] },
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

function createProviderAuthTestStore() {
  const opencodeClient = createClient("https://engine.example", "/tmp/workspace_test", {
    token: "engine-token",
    mode: "openwork",
  });
  const openworkClient = createOpenworkServerClient({
    baseUrl: "https://server.example",
    token: "server-token",
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
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: "connected",
        openworkServerClient: openworkClient,
        openworkServerCapabilities: { config: { read: true, write: true } },
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

function installProviderSyncFetch(requests: RecordedRequest[]) {
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
        return jsonResponse({ llmProviders: [cloudProviderPayload()] });
      }
      if (url.origin === "https://den.example" && url.pathname === "/api/den/v1/llm-providers/lpr_test/connect") {
        return jsonResponse({ llmProvider: cloudProviderPayload() });
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/config" && method === "GET") {
        return jsonResponse({ opencode: {}, openwork: {} });
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/config" && method === "PATCH") {
        return jsonResponse({ updatedAt: 1 });
      }
      if (url.origin === "https://server.example" && url.pathname === "/env") {
        return jsonResponse({ ok: true });
      }
      if (url.origin === "https://server.example" && url.pathname === "/workspace/ws_1/opencode-config") {
        return jsonResponse(null);
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
});
