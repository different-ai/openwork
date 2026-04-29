import { describe, expect, test } from "bun:test";

import { createConnectionsStore } from "../src/react-app/domains/connections/store";

describe("connections MCP toggle flow", () => {
  test("does not request reload or refetch when the server reports no change", async () => {
    const reloads: unknown[] = [];
    let listCalls = 0;
    let patchCalls = 0;
    const openworkClient = {
      setMcpEnabled: async () => {
        patchCalls += 1;
        return {
          changed: false,
          enabled: true,
          items: [
            {
              name: "stripe",
              config: { type: "remote", url: "https://example.com/mcp", enabled: true },
            },
          ],
        };
      },
      listMcp: async () => {
        listCalls += 1;
        return { items: [] };
      },
    };

    const store = createConnectionsStore({
      client: () => null,
      setClient: () => {},
      projectDir: () => "",
      selectedWorkspaceId: () => "ws_1",
      selectedWorkspaceRoot: () => "/tmp/ws_1",
      workspaceType: () => "remote",
      runtimeWorkspaceId: () => "ws_1",
      developerMode: () => false,
      markReloadRequired: (...args) => {
        reloads.push(args);
      },
      openworkServer: {
        getSnapshot: () => ({
          openworkServerClient: openworkClient,
          openworkServerStatus: "connected",
          openworkServerCapabilities: { mcp: { read: true, write: true } },
        }),
      } as never,
    });

    await store.setMcpEnabled("stripe", true);

    expect(patchCalls).toBe(1);
    expect(listCalls).toBe(0);
    expect(reloads).toHaveLength(0);
    expect(store.getSnapshot().mcpServers).toEqual([
      {
        name: "stripe",
        config: { type: "remote", url: "https://example.com/mcp", enabled: true },
      },
    ]);
  });

  test("ignores a toggle result after switching workspaces", async () => {
    const reloads: unknown[] = [];
    let selectedWorkspaceId = "ws_1";
    let selectedWorkspaceRoot = "/tmp/ws_1";
    let runtimeWorkspaceId = "ws_1";
    let patchCalls = 0;
    let resolvePatch: ((value: {
      changed: boolean;
      enabled: boolean;
      items: Array<{ name: string; config: Record<string, unknown> }>;
    }) => void) | undefined;
    let markPatchStarted: (() => void) | undefined;
    const patchStarted = new Promise<void>((resolve) => {
      markPatchStarted = resolve;
    });
    const patchResult = new Promise<{
      changed: boolean;
      enabled: boolean;
      items: Array<{ name: string; config: Record<string, unknown> }>;
    }>((resolve) => {
      resolvePatch = resolve;
    });
    const openworkClient = {
      setMcpEnabled: async () => {
        patchCalls += 1;
        markPatchStarted?.();
        return patchResult;
      },
      listMcp: async () => ({ items: [] }),
    };

    const store = createConnectionsStore({
      client: () => null,
      setClient: () => {},
      projectDir: () => selectedWorkspaceRoot,
      selectedWorkspaceId: () => selectedWorkspaceId,
      selectedWorkspaceRoot: () => selectedWorkspaceRoot,
      workspaceType: () => "remote",
      runtimeWorkspaceId: () => runtimeWorkspaceId,
      developerMode: () => false,
      markReloadRequired: (...args) => {
        reloads.push(args);
      },
      openworkServer: {
        getSnapshot: () => ({
          openworkServerClient: openworkClient,
          openworkServerStatus: "connected",
          openworkServerCapabilities: { mcp: { read: true, write: true } },
        }),
      } as never,
    });

    const pending = store.setMcpEnabled("stripe", false);
    await patchStarted;

    selectedWorkspaceId = "ws_2";
    selectedWorkspaceRoot = "/tmp/ws_2";
    runtimeWorkspaceId = "ws_2";
    store.syncFromOptions();

    resolvePatch?.({
      changed: true,
      enabled: false,
      items: [
        {
          name: "stripe",
          config: { type: "remote", url: "https://example.com/mcp", enabled: false },
        },
      ],
    });
    await pending;

    expect(patchCalls).toBe(1);
    expect(reloads).toHaveLength(0);
    expect(store.getSnapshot().mcpServers).toEqual([]);
    expect(store.getSnapshot().mcpConnectingName).toBeNull();
  });
});
