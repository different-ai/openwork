import { describe, expect, test } from "bun:test";

import {
  editableMcpIdentityChanged,
  marketplaceIdentityOwnerNames,
  mcpAccessMode,
  normalizeEditableMcpIdentityUrl,
} from "../app/(den)/dashboard/_components/mcp-connection-editing";

describe("MCP connection edit projection", () => {
  test("normalizes host/default-port and trailing slash without erasing path case or query", () => {
    expect(normalizeEditableMcpIdentityUrl("https://MCP.EXAMPLE.com:443/MCP/?tenant=a"))
      .toBe("https://mcp.example.com/MCP?tenant=a");
    expect(normalizeEditableMcpIdentityUrl("https://mcp.example.com/mcp?tenant=a"))
      .not.toBe("https://mcp.example.com/MCP?tenant=a");
  });

  test("warns only for normalized URL, authentication, or account-mode identity changes", () => {
    const current = { url: "https://mcp.example.com/mcp/", authType: "oauth" as const, credentialMode: "shared" as const };

    expect(editableMcpIdentityChanged(current, {
      url: "https://MCP.EXAMPLE.com:443/mcp",
      authType: "oauth",
      credentialMode: "shared",
    })).toBe(false);
    expect(editableMcpIdentityChanged(current, {
      url: "https://mcp.example.com/new-mcp",
      authType: "oauth",
      credentialMode: "shared",
    })).toBe(true);
    expect(editableMcpIdentityChanged(current, {
      url: current.url,
      authType: "apikey",
      credentialMode: "shared",
    })).toBe(true);
    expect(editableMcpIdentityChanged(current, {
      url: current.url,
      authType: "oauth",
      credentialMode: "per_member",
    })).toBe(true);
  });

  test("prefills everyone, teams, or people from direct assignments", () => {
    expect(mcpAccessMode({ orgWide: true, memberIds: [], teamIds: [] })).toBe("everyone");
    expect(mcpAccessMode({ orgWide: false, memberIds: [], teamIds: ["team_1"] })).toBe("teams");
    expect(mcpAccessMode({ orgWide: false, memberIds: ["mem_1"], teamIds: [] })).toBe("people");
  });

  test("explains marketplace ownership using unique server-derived plugin names", () => {
    expect(marketplaceIdentityOwnerNames([
      { pluginId: "plg_support", name: "Support Operations" },
      { pluginId: "plg_support_copy", name: "Support Operations" },
      { pluginId: "plg_triage", name: "Support Triage" },
    ])).toBe("Support Operations, Support Triage");
  });
});
