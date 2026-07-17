import { beforeEach, describe, expect, test } from "bun:test";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { ensureProviderListQuery } from "../src/react-app/infra/provider-list-query";

function createProviderClient(providerList: ProviderListResponse, onList: () => void): Client {
  return {
    config: {
      get: async () => ({ data: { disabled_providers: [] } }),
    },
    provider: {
      list: async () => {
        onList();
        return { data: providerList };
      },
    },
  } as unknown as Client;
}

function createTestProviderStore(input: {
  client: Client;
  baseUrl: string;
  directory: string;
}) {
  let providers: ProviderListItem[] = [];
  let providerDefaults: Record<string, string> = {};
  let connectedProviderIds: string[] = [];
  let disabledProviderIds: string[] = [];
  const store = createProviderAuthStore({
    client: () => input.client,
    opencodeBaseUrl: () => input.baseUrl,
    providers: () => providers,
    providerDefaults: () => providerDefaults,
    providerConnectedIds: () => connectedProviderIds,
    disabledProviders: () => disabledProviderIds,
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => ({
      id: "workspace-test",
      name: "Workspace Test",
      path: input.directory,
      preset: "default",
      workspaceType: "local",
    }) as WorkspaceDisplay,
    selectedWorkspaceRoot: () => input.directory,
    runtimeWorkspaceId: () => "workspace-test",
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
      disabledProviderIds = value;
    },
    markOpencodeConfigReloadRequired: () => {},
  });

  return {
    store,
    connectedProviderIds: () => connectedProviderIds,
  };
}

describe("provider auth catalog cache scope", () => {
  beforeEach(() => {
    getReactQueryClient().clear();
  });

  test("shares the model picker cache entry for the same OpenCode endpoint and workspace", async () => {
    const baseUrl = "http://127.0.0.1:4096";
    const directory = "/tmp/openwork-provider-cache-test";
    const providerList = {
      all: [],
      connected: ["anthropic"],
      default: {},
    } satisfies ProviderListResponse;
    let providerListCalls = 0;
    const client = createProviderClient(providerList, () => {
      providerListCalls += 1;
    });

    await ensureProviderListQuery(getReactQueryClient(), {
      client,
      baseUrl,
      directory,
    });

    const testStore = createTestProviderStore({
      client,
      baseUrl,
      directory,
    });

    await testStore.store.refreshProviders();

    expect(providerListCalls).toBe(1);
    expect(testStore.connectedProviderIds()).toEqual(["anthropic"]);
  });

  test("does not reuse a catalog from another OpenCode endpoint with the same workspace path", async () => {
    const directory = "/tmp/openwork-provider-cache-test";
    const staleBaseUrl = "http://127.0.0.1:4096";
    const activeBaseUrl = "http://127.0.0.1:5096";
    const staleClient = createProviderClient({
      all: [],
      connected: ["anthropic"],
      default: {},
    }, () => {});
    let activeProviderListCalls = 0;
    const activeClient = createProviderClient({
      all: [],
      connected: ["openai"],
      default: {},
    }, () => {
      activeProviderListCalls += 1;
    });

    await ensureProviderListQuery(getReactQueryClient(), {
      client: staleClient,
      baseUrl: staleBaseUrl,
      directory,
    });

    const testStore = createTestProviderStore({
      client: activeClient,
      baseUrl: activeBaseUrl,
      directory,
    });

    await testStore.store.refreshProviders();

    expect(activeProviderListCalls).toBe(1);
    expect(testStore.connectedProviderIds()).toEqual(["openai"]);
  });
});
