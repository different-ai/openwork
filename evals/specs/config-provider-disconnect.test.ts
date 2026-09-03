import { expect } from "vitest";
import { briefTest, claim, testBrief } from "@openwork/testkit";

import type { Client, ProviderListItem, WorkspaceDisplay } from "../../apps/app/src/app/types";
import { createProviderAuthStore } from "../../apps/app/src/react-app/domains/connections/provider-auth/store";

// Field report (Desktop 0.18.41/0.18.42): a custom OpenAI-compatible provider
// defined in the user-level ~/.config/opencode/opencode.json cannot be
// disconnected from Settings > AI Providers — clicking Disconnect removes no
// state (auth removal is a no-op because the definition lives in a config
// file the app never edits), the provider stays connected, and under a
// managed-models-only desktop policy it cannot be used either.

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
  // Engine double: `litellm` is declared in the user-level opencode.json
  // (source "config"), `anthropic` comes from ANTHROPIC_API_KEY (source
  // "env"). Both stay connected after /auth removal, exactly like the real
  // engine, because neither connection is backed by auth.json credentials.
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

  // Only the endpoints the disconnect flow touches are exercised; a full SDK
  // client cannot be constructed in a unit spec (see renderer-bounded-caches).
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

briefTest(testBrief({
  behavior:
    "Disconnecting a provider defined in a user-level opencode config file actually disables it, while env-backed providers keep their credentials-only contract.",
  claims: {
    configProviderDisabled: claim(
      "disconnecting a config-file provider disables it and removes it from the connected state",
      { never: "leave the click a silent no-op that keeps the provider connected and unchanged" },
    ),
    definitionPreserved: claim(
      "the disable path only writes disabled_providers",
      { never: "delete or rewrite the user's provider definition block" },
    ),
    envProviderUntouched: claim(
      "an env-backed provider only loses stored credentials and reports it stayed connected",
      { never: "silently add the env provider to disabled_providers or drop it from state" },
    ),
  },
}), async ({ prove }) => {
  const { engine, ui, store } = createHarness();

  // --- Config-file provider (the reported case) ---
  const message = await store.disconnectProvider("litellm");

  // Auth removal was attempted for exactly this provider (it is a no-op on
  // the engine because the definition lives in opencode.json).
  expect(engine.authRemoved).toContain("litellm");

  // The user sees a truthful outcome and a real state change: the provider
  // is disabled and no longer listed as connected.
  expect(message).toBe("Disconnected litellm");
  expect(ui.disabled).toContain("litellm");
  expect(ui.connected).not.toContain("litellm");
  expect(ui.providers.some((provider) => provider.id === "litellm")).toBe(false);
  expect(store.getSnapshot().providerAuthError).toBeNull();
  prove.configProviderDisabled(
    ui.disabled.includes("litellm") && !ui.connected.includes("litellm"),
    "disconnectProvider('litellm') returned 'Disconnected litellm', wrote litellm into disabled_providers, and removed it from the connected provider state instead of returning the still-connected no-op message.",
  );

  // The engine config writes only manage disabled_providers; the litellm
  // provider definition itself is never edited or deleted by the app.
  expect(engine.configUpdates.length).toBeGreaterThan(0);
  for (const update of engine.configUpdates) {
    expect(Object.keys(update)).toEqual(["disabled_providers"]);
    expect(isRecord(update.provider)).toBe(false);
  }
  const disabledWrite = engine.configUpdates.at(-1);
  expect(disabledWrite?.disabled_providers).toEqual(["litellm"]);
  prove.definitionPreserved(
    engine.configUpdates.every((update) => Object.keys(update).join(",") === "disabled_providers"),
    "Every engine config write contained only the disabled_providers key; the litellm provider block in the user's opencode.json was never rewritten or deleted.",
  );

  // --- Negative half: env-backed provider keeps the credentials-only path ---
  const envMessage = await store.disconnectProvider("anthropic");
  expect(engine.authRemoved).toContain("anthropic");
  expect(envMessage).toContain("Removed stored credentials for anthropic");
  expect(envMessage).toContain("still reports it as connected");
  // Its environment stays operator-owned: never disabled, never dropped.
  expect(ui.disabled).not.toContain("anthropic");
  expect(ui.connected).toContain("anthropic");
  expect(ui.providers.some((provider) => provider.id === "anthropic")).toBe(true);
  const lastWrite = engine.configUpdates.at(-1);
  expect(lastWrite?.disabled_providers).toEqual(["litellm"]);
  prove.envProviderUntouched(
    !ui.disabled.includes("anthropic") && ui.connected.includes("anthropic"),
    "disconnectProvider('anthropic') removed stored credentials only, reported the provider as still connected, and never added anthropic to disabled_providers or removed it from state.",
  );
});
