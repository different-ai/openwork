import { expect, test } from "bun:test";

import type { Client, ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

function providerItem(input: {
  id: string;
  name: string;
  source: ProviderListItem["source"];
  env?: string[];
}): ProviderListItem {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    env: input.env ?? [],
    options: {},
    models: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHarness() {
  const engine = {
    authRemoved: [] as string[],
    configUpdates: [] as Array<Record<string, unknown>>,
    engineConfig: {} as Record<string, unknown>,
    all: [
      providerItem({ id: "litellm", name: "LiteLLM", source: "config" }),
      providerItem({ id: "anthropic", name: "Anthropic", source: "env", env: ["ANTHROPIC_API_KEY"] }),
    ],
    connected: ["litellm", "anthropic"],
  };

  const client = {
    auth: {
      remove: async (input: { providerID: string }) => {
        engine.authRemoved.push(input.providerID);
        return { data: true };
      },
    },
    global: { health: async () => ({ data: { healthy: true } }) },
    instance: { dispose: async () => ({ data: true }) },
    config: {
      get: async () => ({ data: { ...engine.engineConfig } }),
      update: async (input: { config: Record<string, unknown> }) => {
        engine.configUpdates.push(input.config);
        engine.engineConfig = input.config;
        return { data: input.config };
      },
    },
    provider: {
      list: async () => ({
        data: { all: engine.all, connected: engine.connected, default: {} },
      }),
    },
  } as unknown as Client;

  const ui = {
    providers: [] as ProviderListItem[],
    connected: [] as string[],
    disabled: [] as string[],
    defaults: {} as Record<string, string>,
    reloadRequired: 0,
  };

  const workspace: WorkspaceDisplay = {
    id: "ws_config_provider",
    name: "Config Provider Workspace",
    path: "/tmp/ws-config-provider",
    preset: "default",
    workspaceType: "local",
  };

  const store = createProviderAuthStore({
    client: () => client,
    providers: () => ui.providers,
    providerDefaults: () => ui.defaults,
    providerConnectedIds: () => ui.connected,
    disabledProviders: () => ui.disabled,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => `http://127.0.0.1:1/${workspace.id}`,
    selectedWorkspaceRoot: () => workspace.path,
    runtimeWorkspaceId: () => null,
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: "disconnected",
        openworkServerClient: null,
        openworkServerCapabilities: null,
      }),
    },
    setProviders: (value) => {
      ui.providers = value;
    },
    setProviderDefaults: (value) => {
      ui.defaults = value;
    },
    setProviderConnectedIds: (value) => {
      ui.connected = value;
    },
    setDisabledProviders: (value) => {
      ui.disabled = value;
    },
    markOpencodeConfigReloadRequired: () => {
      ui.reloadRequired += 1;
    },
  });

  return { engine, ui, store };
}

test("disconnecting a config-file provider disables it without changing env-backed providers", async () => {
  const { engine, ui, store } = createHarness();

  const message = await store.disconnectProvider("litellm");

  expect(engine.authRemoved).toContain("litellm");
  expect(message).toBe("Disconnected litellm");
  expect(ui.disabled).toContain("litellm");
  expect(ui.connected).not.toContain("litellm");
  expect(ui.providers.some((provider) => provider.id === "litellm")).toBe(false);
  expect(store.getSnapshot().providerAuthError).toBeNull();

  expect(engine.configUpdates.length).toBeGreaterThan(0);
  for (const update of engine.configUpdates) {
    expect(Object.keys(update)).toEqual(["disabled_providers"]);
    expect(isRecord(update.provider)).toBe(false);
  }
  expect(engine.configUpdates.at(-1)?.disabled_providers).toEqual(["litellm"]);

  const envMessage = await store.disconnectProvider("anthropic");
  expect(engine.authRemoved).toContain("anthropic");
  expect(envMessage).toContain("Removed stored credentials for anthropic");
  expect(envMessage).toContain("still reports it as connected");
  expect(ui.disabled).not.toContain("anthropic");
  expect(ui.connected).toContain("anthropic");
  expect(ui.providers.some((provider) => provider.id === "anthropic")).toBe(true);
  expect(engine.configUpdates.at(-1)?.disabled_providers).toEqual(["litellm"]);
});
