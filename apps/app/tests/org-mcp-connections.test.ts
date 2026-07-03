import { describe, expect, test } from "bun:test";

import { resolveOrgMcpConnectionCardState } from "../src/react-app/domains/connections/use-org-mcp-connections";

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
});
