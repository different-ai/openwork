declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => { toBe: (expected: unknown) => void; toEqual: (expected: unknown) => void };

import {
  canDisconnectNativeProviderAccount,
  isNativeProviderConnectionId,
} from "./native-provider-connections";
import { resolveOrgMcpConnectionCardState } from "./use-org-mcp-connections";
import { resolveConnectionRowGroup } from "../settings/connect-cloud-readiness";

describe("native provider connections", () => {
  test("recognizes the Google Workspace native provider id", () => {
    expect(isNativeProviderConnectionId("google-workspace")).toBe(true);
    expect(isNativeProviderConnectionId("emc_google_workspace")).toBe(false);
  });

  test("shows disconnect only for the connected calling member", () => {
    expect(canDisconnectNativeProviderAccount({ id: "google-workspace", connectedForMe: true })).toBe(true);
    expect(canDisconnectNativeProviderAccount({ id: "google-workspace", connectedForMe: false })).toBe(false);
    expect(canDisconnectNativeProviderAccount({ id: "emc_google_workspace", connectedForMe: true })).toBe(false);
  });

  test("projects connected native providers with missing scopes as reconnectable", () => {
    expect(resolveOrgMcpConnectionCardState({
      credentialMode: "per_member",
      connected: true,
      connectedForMe: true,
      needsReconnect: true,
    })).toEqual({
      connected: false,
      descriptionKey: "mcp.org_connection_desc_per_member_reconnect",
      actionLabelKey: "mcp.org_connection_reconnect_action",
    });
  });

  test("routes reconnect-needed rows into the sign-in group", () => {
    expect(resolveConnectionRowGroup({ credentialMode: "per_member", connectedForMe: true, needsReconnect: true })).toBe("needs_signin");
  });
});
