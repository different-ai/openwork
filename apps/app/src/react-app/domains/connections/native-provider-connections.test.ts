declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => { toBe: (expected: unknown) => void; toEqual: (expected: unknown) => void };

import {
  canDisconnectMemberConnection,
  canDisconnectNativeProviderAccount,
  canMemberAuthorizeConnection,
  connectionNeedsAdminRepair,
  isNativeProviderConnectionId,
  type MemberLifecycleConnection,
} from "./native-provider-connections";
import { resolveOrgMcpConnectionCardState } from "./use-org-mcp-connections";
import { resolveConnectionRowGroup } from "../settings/connect-cloud-readiness";

describe("native provider connections", () => {
  const lifecycleConnection = (
    id: string,
    authType: MemberLifecycleConnection["authType"],
    credentialMode: MemberLifecycleConnection["credentialMode"],
    connectedForMe: boolean,
    reconnectActionOwner?: MemberLifecycleConnection["reconnectActionOwner"],
    needsReconnect?: boolean,
  ): MemberLifecycleConnection => {
    const connection: MemberLifecycleConnection = {
      id,
      authType,
      credentialMode,
      connectedForMe,
    };
    if (reconnectActionOwner !== undefined) connection.reconnectActionOwner = reconnectActionOwner;
    if (needsReconnect !== undefined) connection.needsReconnect = needsReconnect;
    return connection;
  };

  test("recognizes native provider ids", () => {
    expect(isNativeProviderConnectionId("google-workspace")).toBe(true);
    expect(isNativeProviderConnectionId("microsoft-365")).toBe(true);
    expect(isNativeProviderConnectionId("emc_google_workspace")).toBe(false);
    expect(isNativeProviderConnectionId("emc_google_workspace", "google-workspace")).toBe(true);
  });

  test("shows disconnect only for the connected calling member", () => {
    expect(canDisconnectNativeProviderAccount({ id: "google-workspace", connectedForMe: true })).toBe(true);
    expect(canDisconnectNativeProviderAccount({ id: "microsoft-365", connectedForMe: true })).toBe(true);
    expect(canDisconnectNativeProviderAccount({ id: "google-workspace", connectedForMe: false })).toBe(false);
    expect(canDisconnectNativeProviderAccount({ id: "emc_google_workspace", nativeProviderKey: "google-workspace", connectedForMe: true })).toBe(true);
    expect(canDisconnectNativeProviderAccount({ id: "emc_external", nativeProviderKey: null, connectedForMe: true })).toBe(false);
  });

  test("allows members to disconnect their own per-member account", () => {
    const googleWorkspace = lifecycleConnection("google-workspace", "oauth", "per_member", true);
    const externalMcp = lifecycleConnection("emc_google_workspace", "oauth", "per_member", true);
    expect(canDisconnectMemberConnection(googleWorkspace)).toBe(true);
    expect(canDisconnectMemberConnection(externalMcp)).toBe(true);
    expect(canDisconnectMemberConnection(lifecycleConnection("shared", "oauth", "shared", true))).toBe(false);
    expect(canDisconnectMemberConnection(lifecycleConnection("not-connected", "oauth", "per_member", false))).toBe(false);
  });

  test("allows members to authorize per-member OAuth connections unless admin repair owns it", () => {
    expect(canMemberAuthorizeConnection(lifecycleConnection("not-connected", "oauth", "per_member", false))).toBe(true);
    expect(canMemberAuthorizeConnection(lifecycleConnection("connected", "oauth", "per_member", true))).toBe(true);
    expect(canMemberAuthorizeConnection(lifecycleConnection("shared", "oauth", "shared", false))).toBe(false);
    expect(canMemberAuthorizeConnection(lifecycleConnection("apikey", "apikey", "per_member", false))).toBe(false);
    expect(canMemberAuthorizeConnection(lifecycleConnection("admin-repair", "oauth", "per_member", true, "organization_admin", true))).toBe(false);
    expect(canMemberAuthorizeConnection(lifecycleConnection("member-repair", "oauth", "per_member", true, "member", true))).toBe(true);
    expect(canMemberAuthorizeConnection(lifecycleConnection("unset-repair", "oauth", "per_member", true, undefined, true))).toBe(true);
  });

  test("detects administrator-owned repair", () => {
    expect(connectionNeedsAdminRepair({ needsReconnect: true, reconnectActionOwner: "organization_admin" })).toBe(true);
    expect(connectionNeedsAdminRepair({ needsReconnect: true, reconnectActionOwner: "member" })).toBe(false);
    expect(connectionNeedsAdminRepair({ needsReconnect: true, reconnectActionOwner: null })).toBe(false);
    expect(connectionNeedsAdminRepair({ needsReconnect: true })).toBe(false);
    expect(connectionNeedsAdminRepair({ needsReconnect: false, reconnectActionOwner: "organization_admin" })).toBe(false);
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

  test("routes administrator-owned OAuth recovery away from member sign-in", () => {
    expect(resolveConnectionRowGroup({
      credentialMode: "per_member",
      connectedForMe: true,
      needsReconnect: true,
      reconnectActionOwner: "organization_admin",
    })).toBe("needs_admin_setup");
  });
});
