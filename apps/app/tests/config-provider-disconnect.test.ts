import { afterEach, expect, test } from "bun:test";

import type { Client, ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore, type ProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { clearProviderListQueries } from "../src/react-app/infra/provider-list-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const stores: ProviderAuthStore[] = [];
const unverifiedMessage = "Disconnection could not be verified";

afterEach(() => {
  for (const store of stores) store.dispose();
  stores.length = 0;
  clearProviderListQueries(getReactQueryClient());
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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

function createHarness(hooks: {
  beforeAuthRemove?: () => Promise<void>;
  beforeHealth?: () => Promise<void>;
  beforeConfigRead?: () => void;
} = {}) {
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
        await hooks.beforeAuthRemove?.();
        return { data: true };
      },
    },
    global: {
      health: async () => {
        await hooks.beforeHealth?.();
        return { data: { healthy: true } };
      },
    },
    instance: { dispose: async () => ({ data: true }) },
    config: {
      get: async () => {
        hooks.beforeConfigRead?.();
        return { data: { ...engine.engineConfig } };
      },
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

  stores.push(store);
  return { engine, ui, store, workspace };
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

test.each([
  { providerId: "litellm", verification: 1, disabled: false },
  { providerId: "anthropic", verification: 1, disabled: false },
  { providerId: "litellm", verification: 2, disabled: true },
  { providerId: "opencode", verification: 1, disabled: true },
])("Disconnect of $providerId is unverified when a background refresh supersedes verification $verification (disabled: $disabled)", async ({ providerId, verification, disabled }) => {
  const paused = deferred();
  const resume = deferred();
  let healthReads = 0;
  const { engine, ui, store } = createHarness({
    beforeHealth: async () => {
      if (++healthReads === verification) {
        paused.resolve();
        await resume.promise;
      }
    },
  });
  if (providerId === "opencode") {
    engine.all.push(providerItem({ id: providerId, name: "OpenCode Zen", source: "env" }));
    engine.connected.push(providerId);
  }
  await store.refreshProviders({ force: true });
  const result = store.disconnectProvider(providerId).then(
    (message) => ({ message, error: null }),
    (error: unknown) => ({ message: null, error }),
  );
  try {
    await paused.promise;
    const background = await store.refreshProviders({ force: true });
    expect(background?.connected.includes(providerId)).toBe(!disabled);
  } finally {
    resume.resolve();
  }
  const outcome = await result;
  expect(outcome.message).toBeNull();
  expect(outcome.error).toBeInstanceOf(Error);
  expect(engine.authRemoved).toContain(providerId);
  expect(ui.connected.includes(providerId)).toBe(!disabled);
  expect(ui.disabled.includes(providerId)).toBe(disabled);
  expect(engine.configUpdates).toHaveLength(disabled ? 1 : 0);
  expect(store.getSnapshot().providerAuthError).toContain(unverifiedMessage);
  expect(store.getSnapshot().providerLoadState.status).toBe("ready");
});

test("Disconnect reports failed discovery without erasing retained rows or echoing backend details", async () => {
  let fail = false;
  const secret = "fixture-private-disconnect-details";
  const { engine, ui, store } = createHarness({
    beforeConfigRead: () => {
      if (fail) throw new Error(`/fixture/${secret}/opencode.json: ${secret}`);
    },
  });
  engine.engineConfig = { permission: { bash: "ask" } };
  await store.refreshProviders({ force: true });
  const before = { ...ui };
  fail = true;
  await expect(store.disconnectProvider("litellm")).rejects.toThrow(unverifiedMessage);
  expect(ui).toEqual(before);
  expect(engine.authRemoved).toContain("litellm");
  expect(engine.configUpdates).toHaveLength(0);
  expect(engine.engineConfig).toEqual({ permission: { bash: "ask" } });
  const snapshot = store.getSnapshot();
  expect(snapshot.providerAuthError).toContain(unverifiedMessage);
  expect(snapshot.providerAuthError).not.toContain(secret);
  expect(snapshot.providerLoadState.status).toBe("error");
  expect(snapshot.providerLoadState.error).toContain("Could not load the provider list");
  expect(snapshot.providerLoadState.error).not.toContain(secret);
});

test("Disconnect cannot use another workspace's empty discovery after credential removal", async () => {
  const paused = deferred();
  const resume = deferred();
  const { engine, ui, store, workspace } = createHarness({
    beforeAuthRemove: async () => {
      paused.resolve();
      await resume.promise;
    },
  });
  await store.refreshProviders({ force: true });
  const result = store.disconnectProvider("litellm").then(
    (message) => ({ message, error: null }),
    (error: unknown) => ({ message: null, error }),
  );
  try {
    await paused.promise;
    workspace.id = "ws_other_provider";
    workspace.path = "/tmp/ws-other-provider";
    engine.all = [];
    engine.connected = [];
    await store.refreshProviders({ force: true });
  } finally {
    resume.resolve();
  }
  const outcome = await result;
  expect(outcome.message).toBeNull();
  expect(outcome.error).toBeInstanceOf(Error);
  expect(ui.connected).toEqual([]);
  expect(engine.configUpdates).toHaveLength(0);
  expect(store.getSnapshot().providerAuthError).toContain(unverifiedMessage);
});

test("Disconnect does not claim success when post-disable discovery still reports the provider connected", async () => {
  let beforeConfigRead = () => {};
  const { engine, ui, store } = createHarness({ beforeConfigRead: () => beforeConfigRead() });
  beforeConfigRead = () => {
    if (engine.configUpdates.length > 0) engine.engineConfig = {};
  };
  await store.refreshProviders({ force: true });
  await expect(store.disconnectProvider("litellm")).rejects.toThrow(unverifiedMessage);
  expect(engine.configUpdates.at(-1)?.disabled_providers).toEqual(["litellm"]);
  expect(ui.connected).toContain("litellm");
  expect(ui.providers.some((provider) => provider.id === "litellm")).toBe(true);
  expect(store.getSnapshot().providerAuthError).toContain(unverifiedMessage);
});
