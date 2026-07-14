import { describe, expect, test } from "bun:test";
import {
  canDisconnectMyMcpAccount,
  myMcpAccountDisconnectPath,
} from "../app/(den)/dashboard/_components/mcp-connections-data";

describe("Your Connections personal disconnect", () => {
  test("offers the caller-only endpoint for a connected external per-member account", () => {
    const connection = {
      id: "emc_01h2xcejqtf2nbrexx3vqjhp41",
      credentialMode: "per_member" as const,
      connectedForMe: true,
    };
    expect(canDisconnectMyMcpAccount(connection)).toBe(true);
    expect(myMcpAccountDisconnectPath(connection)).toBe(
      "/v1/mcp-connections/emc_01h2xcejqtf2nbrexx3vqjhp41/my-account/disconnect",
    );
  });

  test("preserves native provider disconnects and hides unsafe shared-account actions", () => {
    const native = {
      id: "microsoft-365",
      credentialMode: "per_member" as const,
      connectedForMe: true,
    };
    expect(canDisconnectMyMcpAccount(native)).toBe(true);
    expect(myMcpAccountDisconnectPath(native)).toBe("/v1/oauth-providers/microsoft-365/disconnect");

    const shared = {
      id: "emc_01h2xcejqtf2nbrexx3vqjhp42",
      credentialMode: "shared" as const,
      connectedForMe: true,
    };
    expect(canDisconnectMyMcpAccount(shared)).toBe(false);
    expect(() => myMcpAccountDisconnectPath(shared)).toThrow("Only per-member");
    expect(canDisconnectMyMcpAccount({ ...native, connectedForMe: false })).toBe(false);
  });
})
