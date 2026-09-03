import { afterEach, describe, expect, test } from "bun:test";

import { createClient } from "../src/app/lib/opencode";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

const originalFetch = globalThis.fetch;
const providerId = "litellm";

type RecordedRequest = {
  method: string;
  path: string;
  body: string | null;
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function provider(source: ProviderListItem["source"]): ProviderListItem {
  return {
    id: providerId,
    name: "LiteLLM",
    env: [],
    source,
    models: {},
  };
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  return input instanceof Request ? input.method : "GET";
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return await input.clone().text();
  return null;
}

function disabledProvidersFromBody(body: BodyInit | null | undefined): string[] {
  if (typeof body !== "string") return [];
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || !("disabled_providers" in value)) return [];
  const disabled = value.disabled_providers;
  return Array.isArray(disabled)
    ? disabled.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function createDisconnectStore(options: {
  connectedAfterCredentialRemoval: boolean;
  source?: ProviderListItem["source"];
}) {
  const requests: RecordedRequest[] = [];
  const item = provider(options.source ?? "config");
  let providers = [item];
  let connectedProviderIds = [providerId];
  let providerDefaults: Record<string, string> = { [providerId]: "test-model" };
  let disabledProviders: string[] = [];
  let credentialsRemoved = false;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      const body = await requestBody(input, init);
      requests.push({ method, path: url.pathname, body });

      if (method === "DELETE" && url.pathname === `/auth/${providerId}`) {
        credentialsRemoved = true;
        return jsonResponse(true);
      }
      if (method === "PATCH" && url.pathname === "/config") {
        disabledProviders = disabledProvidersFromBody(body);
        return jsonResponse({ disabled_providers: disabledProviders });
      }
      if (method === "GET" && url.pathname === "/config") {
        return jsonResponse({ disabled_providers: disabledProviders });
      }
      if (method === "GET" && url.pathname === "/provider") {
        const connected = credentialsRemoved && !options.connectedAfterCredentialRemoval
          ? []
          : [providerId];
        return jsonResponse({ all: [item], connected, default: providerDefaults });
      }
      if (url.pathname === "/global/health") {
        return jsonResponse({ healthy: true, version: "test" });
      }
      return jsonResponse(true);
    },
  });

  const client = createClient("https://engine.example", "/tmp/provider-auth-disconnect");
  const workspace = {
    id: "workspace_test",
    name: "Test workspace",
    path: "/tmp/provider-auth-disconnect",
    preset: "default",
    workspaceType: "local",
  } satisfies WorkspaceDisplay;
  const store = createProviderAuthStore({
    client: () => client,
    providers: () => providers,
    providerDefaults: () => providerDefaults,
    providerConnectedIds: () => connectedProviderIds,
    disabledProviders: () => disabledProviders,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => "https://engine.example",
    selectedWorkspaceRoot: () => workspace.path,
    runtimeWorkspaceId: () => workspace.id,
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: "disconnected",
        openworkServerClient: null,
        openworkServerCapabilities: null,
      }),
    },
    setProviders: (value) => {
      providers = value;
    },
    setProviderDefaults: (value) => {
      providerDefaults = value;
    },
    setProviderConnectedIds: (value) => {
      connectedProviderIds = value;
    },
    setDisabledProviders: (value) => {
      disabledProviders = value;
    },
    markOpencodeConfigReloadRequired: () => undefined,
  });

  return {
    store,
    requests,
    connectedProviderIds: () => connectedProviderIds,
    disabledProviders: () => disabledProviders,
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("provider disconnect", () => {
  test("disables a config-defined provider that remains connected after credential removal", async () => {
    const harness = createDisconnectStore({ connectedAfterCredentialRemoval: true });

    const message = await harness.store.disconnectProvider(providerId);

    expect(message).toBe("Disconnected litellm");
    expect(harness.disabledProviders()).toEqual([providerId]);
    expect(harness.connectedProviderIds()).toEqual([]);
    expect(harness.store.getSnapshot().providerAuthProviders).toEqual([]);
    const configWrites = harness.requests.filter(
      (request) => request.method === "PATCH" && request.path === "/config",
    );
    expect(configWrites).toHaveLength(1);
    expect(configWrites[0]?.body).toContain(providerId);
  });

  test("does not disable a provider when credential removal disconnects it", async () => {
    const harness = createDisconnectStore({ connectedAfterCredentialRemoval: false });

    const message = await harness.store.disconnectProvider(providerId);

    expect(message).toBe("Disconnected litellm");
    expect(harness.disabledProviders()).toEqual([]);
    expect(harness.connectedProviderIds()).toEqual([]);
    expect(harness.requests.some(
      (request) => request.method === "PATCH" && request.path === "/config",
    )).toBe(false);
  });

  test("leaves an environment-backed provider enabled when it remains connected", async () => {
    const harness = createDisconnectStore({
      connectedAfterCredentialRemoval: true,
      source: "env",
    });

    const message = await harness.store.disconnectProvider(providerId);

    expect(message).toContain("still reports it as connected");
    expect(harness.disabledProviders()).toEqual([]);
    expect(harness.connectedProviderIds()).toEqual([providerId]);
    expect(harness.requests.some(
      (request) => request.method === "PATCH" && request.path === "/config",
    )).toBe(false);
  });
});
