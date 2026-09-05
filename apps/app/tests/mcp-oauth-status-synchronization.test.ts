import { describe, expect, test } from "bun:test";

import { getMcpIdentityKey } from "../src/app/mcp";
import type { McpServerEntry, McpStatusMap } from "../src/app/types";
import {
  createMcpStatusSynchronizer,
  resolveObservedMcpStatus,
} from "../src/react-app/domains/connections/mcp-status-synchronization";

function server(input?: Partial<McpServerEntry>): McpServerEntry {
  return {
    id: "cloud-mcp",
    name: "cloud-mcp",
    config: { type: "remote", url: "https://cloud.example/mcp", enabled: true },
    ...input,
  };
}

describe("MCP OAuth status synchronization", () => {
  test("resolves canonical and uniquely normalized producer identities", () => {
    const entry = server({ id: "cloud-mcp", name: "Cloud MCP" });

    expect(resolveObservedMcpStatus({ "cloud-mcp": { status: "connected" } }, entry)).toEqual({
      status: "connected",
    });
    expect(resolveObservedMcpStatus({ "CLOUD MCP": { status: "connected" } }, entry)).toEqual({
      status: "connected",
    });
    expect(resolveObservedMcpStatus({
      "cloud mcp": { status: "connected" },
      "cloud_mcp": { status: "failed", error: "foreign collision" },
    }, entry)).toBeUndefined();
  });

  test("uses the configured server identity for display names and preserves underscores", () => {
    expect(getMcpIdentityKey({ name: "Cloud MCP", serverName: "company_cloud" })).toBe("company_cloud");
    expect(getMcpIdentityKey({ name: "Company_Cloud" })).toBe("company_cloud");
  });

  test("keeps verified OAuth success ready through delayed engine status, dialog close, and refresh", () => {
    const sync = createMcpStatusSynchronizer();
    const workspace = "web:workspace-a";
    const entry = server();
    sync.recordAuthenticated(workspace, "cloud-mcp");

    const delayed = sync.project(sync.beginRefresh(workspace), {
      "cloud-mcp": { status: "disconnected" },
    }, [entry]);
    const afterDialogClose = sync.project(sync.beginRefresh(workspace), {}, [entry]);
    const converged = sync.project(sync.beginRefresh(workspace), {
      "Cloud MCP": { status: "connected" },
    }, [entry]);
    const owningRefresh = sync.project(sync.beginRefresh(workspace), {
      "cloud-mcp": { status: "connected" },
    }, [entry]);

    expect(delayed?.[entry.name]).toEqual({ status: "connected" });
    expect(afterDialogClose?.[entry.name]).toEqual({ status: "connected" });
    expect(converged?.[entry.name]).toEqual({ status: "connected" });
    expect(owningRefresh?.[entry.name]).toEqual({ status: "connected" });
    expect(sync.isPending(workspace, entry.name)).toBe(false);
  });

  test("a delayed refresh cannot regress a newer connected response", () => {
    const sync = createMcpStatusSynchronizer();
    const workspace = "web:workspace-a";
    const entry = server();
    const stale = sync.beginRefresh(workspace);
    const latest = sync.beginRefresh(workspace);

    expect(sync.project(latest, { "cloud-mcp": { status: "connected" } }, [entry])).toEqual({
      "cloud-mcp": { status: "connected" },
    });
    expect(sync.project(stale, { "cloud-mcp": { status: "disconnected" } }, [entry])).toBeNull();
  });

  test.each([
    ["failed", { status: "failed", error: "provider rejected the token" }],
    ["needs auth", { status: "needs_auth" }],
    ["reconnect required", { status: "reconnect_required" }],
    ["client registration required", { status: "needs_client_registration", error: "register first" }],
  ] as const)("real %s overrides verified-success grace", (_label, status) => {
    const sync = createMcpStatusSynchronizer();
    const workspace = "web:workspace-a";
    const entry = server();
    sync.recordAuthenticated(workspace, entry.name);

    const projected = sync.project(
      sync.beginRefresh(workspace),
      { [entry.name]: status } as McpStatusMap,
      [entry],
    );

    expect(projected?.[entry.name]).toEqual(status);
    expect(projected?.[entry.name]?.status).not.toBe("connected");
    expect(sync.isPending(workspace, entry.name)).toBe(false);
  });

  test("disabled entries, removal, and foreign workspaces never inherit green", () => {
    const sync = createMcpStatusSynchronizer();
    const workspace = "web:workspace-a";
    const disabled = server({ config: { type: "remote", url: "https://cloud.example/mcp", enabled: false } });
    sync.recordAuthenticated(workspace, disabled.name);

    expect(sync.project(sync.beginRefresh(workspace), {}, [disabled])?.[disabled.name]).toEqual({
      status: "disabled",
    });

    sync.recordAuthenticated(workspace, disabled.name);
    expect(sync.project(sync.beginRefresh(workspace), {}, [])).toEqual({});
    expect(sync.isPending(workspace, disabled.name)).toBe(false);

    sync.recordAuthenticated(workspace, disabled.name);
    const foreign = sync.beginRefresh("web:workspace-b");
    expect(sync.project(foreign, {}, [server()])).toEqual({});
  });

  test("missing or disconnected status loses success grace after a bounded number of refreshes", () => {
    const sync = createMcpStatusSynchronizer({ maxPendingRefreshes: 3 });
    const workspace = "web:workspace-a";
    const entry = server();
    sync.recordAuthenticated(workspace, entry.name);

    const first = sync.project(sync.beginRefresh(workspace), {}, [entry]);
    const second = sync.project(sync.beginRefresh(workspace), {
      [entry.name]: { status: "disconnected" },
    }, [entry]);
    const boundedFinal = sync.project(sync.beginRefresh(workspace), {}, [entry]);

    expect(first?.[entry.name]).toEqual({ status: "connected" });
    expect(second?.[entry.name]).toEqual({ status: "connected" });
    expect(boundedFinal?.[entry.name]).toBeUndefined();
    expect(sync.isPending(workspace, entry.name)).toBe(false);
  });

  test("ordinary disconnected and missing entries never become ready without verified OAuth success", () => {
    const sync = createMcpStatusSynchronizer();
    const workspace = "web:workspace-a";
    const entry = server();

    expect(sync.project(sync.beginRefresh(workspace), {
      [entry.name]: { status: "disconnected" },
    }, [entry])).toEqual({});
    expect(sync.project(sync.beginRefresh(workspace), {}, [entry])).toEqual({});
  });
});
