import { describe, expect, test } from "bun:test";

import {
  isOrgMcpPollScopeCurrent,
  resolveOrgMcpConnectionCardState,
} from "../src/react-app/domains/connections/use-org-mcp-connections";

describe("resolveOrgMcpConnectionCardState", () => {
  test("a shared connection is shown as managed by the org, never actionable by a member", () => {
    const state = resolveOrgMcpConnectionCardState({
      credentialMode: "shared",
      connected: true,
      connectedForMe: false,
    });

    expect(state.connected).toBe(true);
    expect(state.actionLabelKey).toBe("mcp.org_connection_managed_label");
    expect(state.descriptionKey).toBe("mcp.org_connection_desc_shared");
  });

  test("an unconnected shared connection still isn't actionable — admin manages it, not the member", () => {
    const state = resolveOrgMcpConnectionCardState({
      credentialMode: "shared",
      connected: false,
      connectedForMe: false,
    });

    expect(state.connected).toBe(false);
    expect(state.actionLabelKey).toBe("mcp.org_connection_managed_label");
  });

  test("a per_member connection the caller has NOT connected yet is actionable", () => {
    const state = resolveOrgMcpConnectionCardState({
      credentialMode: "per_member",
      connected: true, // published/usable at the org level
      connectedForMe: false, // but this member hasn't signed in
    });

    expect(state.connected).toBe(false);
    expect(state.actionLabelKey).toBe("mcp.org_connection_connect_action");
    expect(state.descriptionKey).toBe("mcp.org_connection_desc_per_member");
  });

  test("a per_member connection the caller HAS connected shows connected, not managed", () => {
    const state = resolveOrgMcpConnectionCardState({
      credentialMode: "per_member",
      connected: true,
      connectedForMe: true,
    });

    expect(state.connected).toBe(true);
    expect(state.actionLabelKey).toBe("mcp.org_connection_connected_label");
    expect(state.descriptionKey).toBe("mcp.org_connection_desc_per_member_connected");
  });

  test("missing features keep a connected per-member account in reconnect state", () => {
    const state = resolveOrgMcpConnectionCardState({
      credentialMode: "per_member",
      connected: true,
      connectedForMe: true,
      needsReconnect: false,
      missingFeatures: ["driveFile"],
    });

    expect(state.connected).toBe(false);
    expect(state.actionLabelKey).toBe("mcp.org_connection_reconnect_action");
  });
});

describe("organization MCP OAuth polling", () => {
  test("an in-flight response cannot apply org A rows after switching to org B", async () => {
    let releaseResponse = () => {};
    const responsePending = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const pollScope = { generation: 4, organizationId: "org_a" };
    let currentGeneration = 4;
    let activeOrganizationId = "org_a";
    let appliedRows: string[] = [];

    const response = (async () => {
      await responsePending;
      if (isOrgMcpPollScopeCurrent(pollScope, currentGeneration, activeOrganizationId)) {
        appliedRows = ["org-a-row"];
      }
    })();

    currentGeneration += 1;
    activeOrganizationId = "org_b";
    releaseResponse();
    await response;

    expect(appliedRows).toEqual([]);
  });

  test("requires both the captured generation and organization id", () => {
    const scope = { generation: 2, organizationId: "org_a" };
    expect(isOrgMcpPollScopeCurrent(scope, 2, "org_a")).toBe(true);
    expect(isOrgMcpPollScopeCurrent(scope, 3, "org_a")).toBe(false);
    expect(isOrgMcpPollScopeCurrent(scope, 2, "org_b")).toBe(false);
  });

  test("the already-connected fast path cannot clear a newer org action after its refresh awaits", async () => {
    let releaseRefresh = () => {};
    let markRefreshStarted = () => {};
    const refreshPending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const scope = { generation: 7, organizationId: "org_a" };
    let currentGeneration = 7;
    let activeOrganizationId = "org_a";
    let connectingId: string | null = "org-a-connection";

    const connectedFastPath = (async () => {
      await Promise.resolve();
      if (!isOrgMcpPollScopeCurrent(scope, currentGeneration, activeOrganizationId)) return;
      markRefreshStarted();
      await refreshPending;
      if (!isOrgMcpPollScopeCurrent(scope, currentGeneration, activeOrganizationId)) return;
      connectingId = null;
    })();

    await refreshStarted;
    currentGeneration += 1;
    activeOrganizationId = "org_b";
    connectingId = "org-b-connection";
    releaseRefresh();
    await connectedFastPath;

    expect(connectingId).toBe("org-b-connection");
  });

  test("disconnect completion and cleanup cannot mutate a newer org after either await", async () => {
    let releaseRefresh = () => {};
    let markRefreshStarted = () => {};
    const refreshPending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const scope = { generation: 11, organizationId: "org_a" };
    let currentGeneration = 11;
    let activeOrganizationId = "org_a";
    let disconnectingId: string | null = "org-a-provider";
    let appliedRows: string[] = [];

    const disconnect = (async () => {
      try {
        await Promise.resolve();
        if (!isOrgMcpPollScopeCurrent(scope, currentGeneration, activeOrganizationId)) return;
        markRefreshStarted();
        await refreshPending;
        if (!isOrgMcpPollScopeCurrent(scope, currentGeneration, activeOrganizationId)) return;
        appliedRows = ["org-a-row"];
      } finally {
        if (isOrgMcpPollScopeCurrent(scope, currentGeneration, activeOrganizationId)) {
          disconnectingId = null;
        }
      }
    })();

    await refreshStarted;
    currentGeneration += 1;
    activeOrganizationId = "org_b";
    disconnectingId = "org-b-provider";
    releaseRefresh();
    await disconnect;

    expect(appliedRows).toEqual([]);
    expect(disconnectingId).toBe("org-b-provider");
  });
});
