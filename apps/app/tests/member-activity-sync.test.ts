import { describe, expect, test } from "bun:test";
import type { StateStorage } from "zustand/middleware";
import type { DenExternalMcpConnection, DenOrgGatewayProvider } from "../src/app/lib/den";
import { createActivityStore, selectActivityContext } from "../src/react-app/kernel/activity-store";
import { refreshMemberActivity, type MemberActivityClient } from "../src/react-app/domains/cloud/member-activity-sync";

const scope = { baseUrl: "https://activity.example", organizationId: "org-278", memberId: "member-278" };

function feedStore() {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const store = createActivityStore(storage);
  store.getState().setScope(scope);
  return store;
}

function source() {
  const state: {
    providers: DenOrgGatewayProvider[];
    connections: DenExternalMcpConnection[];
    plugin: boolean;
    version: string;
    bound: boolean;
    fail: boolean;
  } = { providers: [], connections: [], plugin: false, version: "version-1", bound: false, fail: false };
  const client: MemberActivityClient = {
    listOrgLlmProviders: async () => [],
    listOrgGatewayProviders: async () => state.providers,
    listMcpConnections: async (_org, requestedScope) => {
      expect(requestedScope).toBe("usable");
      return state.connections;
    },
    listAssignedMarketplaceCapabilities: async () => state.plugin ? [
      { marketplaceId: "market-278", pluginId: "plugin-278", configObjectId: "skill-278", objectType: "skill" },
      { marketplaceId: "market-278", pluginId: "plugin-278", configObjectId: "mcp-278", objectType: "mcp" },
    ] : [],
    listMeLibraryPlugins: async () => {
      if (state.fail) throw new Error("Library refresh failed");
      return [];
    },
    listOrgMarketplaces: async () => { throw new Error("Must not use the paginated admin-visible catalog"); },
    getOrgMarketplaceResolved: async () => ({
      marketplace: { id: "market-278", name: "Team", description: null, status: "active", pluginCount: 1, updatedAt: null },
      plugins: [{ id: "plugin-278", name: "Team toolkit", description: null, status: "active", memberCount: 1, updatedAt: null, componentCounts: {} }],
    }),
    getOrgPluginResolved: async (_org, plugin) => ({
      plugin: {
        ...plugin,
        cloudReadiness: {
          state: "ready", hasInstructional: true,
          connections: state.bound ? [{ id: "connection-278", name: "Team calendar", url: "https://calendar.example/mcp", configObjectId: "mcp-278", serverName: "calendar" }] : [],
        },
      },
      memberships: [
        {
          id: "membership-skill", pluginId: plugin.id, configObjectId: "skill-278",
          configObject: {
            id: "skill-278", objectType: "skill", title: "Team briefing", description: null,
            status: "active", updatedAt: null, currentFileName: null, currentFileExtension: null, currentRelativePath: null,
            latestVersion: { id: state.version, rawSourceText: null, normalizedPayloadJson: null, sourceRevisionRef: null, createdAt: null },
          },
        },
        {
          id: "membership-mcp", pluginId: plugin.id, configObjectId: "mcp-278",
          configObject: {
            id: "mcp-278", objectType: "mcp", title: "Team calendar", description: null,
            status: "active", updatedAt: null, currentFileName: null, currentFileExtension: null, currentRelativePath: null,
            latestVersion: { id: "mcp-version-1", rawSourceText: null, normalizedPayloadJson: { mcpServers: { calendar: { url: "https://calendar.example/mcp" } } }, sourceRevisionRef: null, createdAt: null },
          },
        },
      ],
    }),
  };
  return { state, client };
}

function connection(): DenExternalMcpConnection {
  return {
    id: "connection-278", name: "Team calendar", url: "https://calendar.example/mcp",
    authType: "oauth", credentialMode: "per_member", exposeDirectly: false,
    connected: false, connectedForMe: false, connectedAt: null,
  };
}

describe("member sync to Activity", () => {
  test("sharing a plugin cannot remove its already usable backing connection", async () => {
    const store = feedStore();
    const { state, client } = source();
    state.connections = [connection()];
    const refresh = () => refreshMemberActivity({ scope, client, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    state.plugin = true;
    state.bound = true;
    expect(await refresh()).toBe("updated");
    expect(selectActivityContext(store.getState()).entries.some((entry) => entry.change === "unavailable")).toBe(false);
  });

  test("shared skills and plugins carry the marketplace, skill count and the exact capability used by Try it", async () => {
    const store = feedStore();
    const { state, client } = source();
    const refresh = () => refreshMemberActivity({ scope, client, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    expect(selectActivityContext(store.getState()).baseline?.labels).toEqual([]);
    state.plugin = true;
    expect(await refresh()).toBe("updated");
    const resources = Object.fromEntries(selectActivityContext(store.getState()).entries.map((entry) => [entry.resource.kind, entry.resource]));
    expect(resources.plugin).toMatchObject({ label: "Team toolkit", marketplaceName: "Team", skillCount: 1 });
    expect(resources.skill).toMatchObject({
      label: "Team briefing", pluginName: "Team toolkit", marketplaceName: "Team",
      skillSlug: "team-briefing", capability: "plugin:plugin-278:skill-278",
    });
  });

  test("a newly shared plugin appears even when it contains only a Workflow", async () => {
    const store = feedStore();
    const { state, client } = source();
    const workflowClient: MemberActivityClient = {
      ...client,
      listAssignedMarketplaceCapabilities: async () => state.plugin ? [{
        marketplaceId: "market-278", pluginId: "plugin-278", configObjectId: "workflow-278", objectType: "workflow",
      }] : [],
      getOrgPluginResolved: async (org, plugin) => {
        const resolved = await client.getOrgPluginResolved(org, plugin);
        return {
          ...resolved,
          memberships: resolved.memberships.slice(0, 1).map((membership) => ({
            ...membership,
            configObjectId: "workflow-278",
            configObject: membership.configObject ? {
              ...membership.configObject, id: "workflow-278", objectType: "workflow",
            } : null,
          })),
        };
      },
    };
    const refresh = () => refreshMemberActivity({ scope, client: workflowClient, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    state.plugin = true;
    expect(await refresh()).toBe("updated");
    expect(selectActivityContext(store.getState()).entries.map((entry) => [entry.resource.kind, entry.change])).toEqual([
      ["plugin", "available"],
    ]);
  });

  test("a plugin's usable backing connection appears once when it becomes available", async () => {
    const store = feedStore();
    const { state, client } = source();
    state.plugin = true;
    const refresh = () => refreshMemberActivity({ scope, client, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    state.bound = true;
    state.connections = [connection()];
    expect(await refresh()).toBe("updated");
    const entries = selectActivityContext(store.getState()).entries;
    expect(entries.some((entry) => entry.change === "unavailable")).toBe(false);
    expect(entries.filter((entry) => entry.change === "available")).toHaveLength(1);
    expect(entries[0]?.resource.id).toBe("connection-278");
    expect(selectActivityContext(store.getState()).snapshots.connections).toHaveLength(1);
  });

  test("a partial refresh preserves every successful baseline and the last known feed", async () => {
    const store = feedStore();
    const { state, client } = source();
    const refresh = () => refreshMemberActivity({ scope, client, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    state.plugin = true;
    state.providers = [{ id: "provider-278", providerId: "anthropic", name: "Team models", source: "openwork_gateway" }];
    state.connections = [connection()];
    expect(await refresh()).toBe("updated");
    const before = selectActivityContext(store.getState());
    expect(before.entries.map((entry) => entry.resource.label).sort()).toEqual([
      "Team briefing", "Team calendar", "Team models", "Team toolkit",
    ]);
    state.providers = [];
    state.fail = true;
    expect(await refresh()).toBe("failed");
    expect(store.getState().refreshState).toBe("error");
    expect(selectActivityContext(store.getState())).toEqual(before);
    state.fail = false;
    expect(await refresh()).toBe("updated");
    const latest = selectActivityContext(store.getState()).entries[0];
    expect(latest?.change).toBe("unavailable");
    expect(latest?.resource.label).toBe("Team models");
    expect(await refresh()).toBe("updated");
    expect(selectActivityContext(store.getState()).entries).toHaveLength(5);
  });

  test("credential health does not masquerade as a connection update; configuration changes do", async () => {
    const store = feedStore();
    const { state, client } = source();
    state.connections = [connection()];
    const refresh = () => refreshMemberActivity({ scope, client, feed: store.getState(), isCurrent: () => true });
    expect(await refresh()).toBe("updated");
    state.connections = [{ ...connection(), connected: true, connectedForMe: true, connectedAt: "2026-09-28T11:00:00Z" }];
    expect(await refresh()).toBe("updated");
    expect(selectActivityContext(store.getState()).entries).toEqual([]);
    state.connections = [{ ...connection(), url: "https://calendar.example/updated?token=private-fixture-value" }];
    expect(await refresh()).toBe("updated");
    const context = selectActivityContext(store.getState());
    expect(context.entries).toHaveLength(1);
    expect(context.entries[0]?.change).toBe("updated");
    expect(JSON.stringify(context)).not.toContain("private-fixture-value");
    expect(JSON.stringify(context)).not.toContain("https://calendar.example");
  });

  test("an in-flight response cannot enter a different member's feed", async () => {
    const store = feedStore();
    const { state, client } = source();
    state.plugin = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let current = true;
    const pending = refreshMemberActivity({
      scope,
      feed: store.getState(),
      isCurrent: () => current,
      client: { ...client, listOrgLlmProviders: async () => { await gate; return []; } },
    });
    current = false;
    store.getState().setScope({ ...scope, memberId: "other-member" });
    release?.();
    expect(await pending).toBe("stale");
    expect(selectActivityContext(store.getState()).entries).toEqual([]);
    expect(selectActivityContext(store.getState()).snapshots).toEqual({});
  });
});
