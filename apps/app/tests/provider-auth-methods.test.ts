import { afterEach, describe, expect, test } from "bun:test";

import { createClient } from "../src/app/lib/opencode";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const opencodeClient = createClient("https://engine.example", "/tmp/workspace_test");

function installWindow(options: {
  origin: string;
  electronInfo?: {
    baseUrl: string;
    ownerToken: string;
  };
}) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      location: { origin: options.origin },
      __OPENWORK_ELECTRON__: options.electronInfo
        ? {
            invokeDesktop: async () => ({
              running: true,
              baseUrl: options.electronInfo?.baseUrl,
              ownerToken: options.electronInfo?.ownerToken,
            }),
          }
        : undefined,
    },
  });
}

function installProviderAuthFetch() {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          openai: [
            { type: "oauth", label: "Sign in with ChatGPT" },
            { type: "oauth", label: "Headless device flow" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
}

function createTestStore(workerType: "local" | "remote") {
  const providers: ProviderListItem[] = [
    {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      source: "env",
      models: {},
    },
  ];
  const workspace = {
    id: "workspace_test",
    name: "Test workspace",
    path: "/tmp/workspace_test",
    preset: "default",
    workspaceType: workerType,
  } satisfies WorkspaceDisplay;

  return createProviderAuthStore({
    client: () => opencodeClient,
    providers: () => providers,
    providerDefaults: () => ({}),
    providerConnectedIds: () => [],
    disabledProviders: () => [],
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
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined,
    markOpencodeConfigReloadRequired: () => undefined,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("OpenAI provider auth methods", () => {
  test("desktop local workers offer non-headless OAuth", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    expect(store.getSnapshot().providerAuthMethods.openai).toEqual([
      { type: "oauth", label: "Sign in with ChatGPT", methodIndex: 0 },
      { type: "api", label: "API key" },
    ]);
  });

  test("desktop remote workers offer only headless OAuth", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("remote");

    await store.openProviderAuthModal();

    expect(store.getSnapshot().providerAuthMethods.openai).toEqual([
      { type: "oauth", label: "Headless device flow", methodIndex: 1 },
      { type: "api", label: "API key" },
    ]);
  });

  test("browser workers offer API keys without OAuth", async () => {
    installWindow({ origin: "https://self-hosted.example" });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    expect(store.getSnapshot().providerAuthMethods.openai).toEqual([
      { type: "api", label: "API key" },
    ]);
  });
});
