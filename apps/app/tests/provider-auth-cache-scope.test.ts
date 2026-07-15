import { beforeEach, describe, expect, test } from "bun:test";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { ensureProviderListQuery } from "../src/react-app/infra/provider-list-query";

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
    const client = {
      config: {
        get: async () => ({ data: { disabled_providers: [] } }),
      },
      provider: {
        list: async () => {
          providerListCalls += 1;
          return { data: providerList };
        },
      },
    } as unknown as Client;

    await ensureProviderListQuery(getReactQueryClient(), {
      client,
      baseUrl,
      directory,
    });

    let providers: ProviderListItem[] = [];
    let providerDefaults: Record<string, string> = {};
    let connectedProviderIds: string[] = [];
    let disabledProviderIds: string[] = [];
    const store = createProviderAuthStore({
      client: () => client,
      opencodeBaseUrl: () => baseUrl,
      providers: () => providers,
      providerDefaults: () => providerDefaults,
      providerConnectedIds: () => connectedProviderIds,
      disabledProviders: () => disabledProviderIds,
      checkDesktopAppRestriction: () => false,
      selectedWorkspaceDisplay: () => ({
        id: "workspace-test",
        name: "Workspace Test",
        path: directory,
        preset: "default",
        workspaceType: "local",
      }) as WorkspaceDisplay,
      selectedWorkspaceRoot: () => directory,
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

    await store.refreshProviders();

    expect(providerListCalls).toBe(1);
    expect(connectedProviderIds).toEqual(["anthropic"]);
  });
});
