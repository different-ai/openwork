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
});
