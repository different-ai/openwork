export type NativeProviderDisconnectableConnection = {
  id: string;
  nativeProviderKey?: string | null;
  connectedForMe: boolean;
};

export type ReconnectableConnection = {
  needsReconnect?: boolean;
  missingFeatures?: readonly string[];
};

export type MemberLifecycleConnection = {
  id: string;
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  connectedForMe: boolean;
  needsReconnect?: boolean;
  missingFeatures?: readonly string[];
  reconnectActionOwner?: "member" | "organization_admin" | null;
};

export function connectionNeedsReconnect(connection: ReconnectableConnection): boolean {
  return connection.needsReconnect === true || (connection.missingFeatures?.length ?? 0) > 0;
}

export function isNativeProviderConnectionId(id: string, nativeProviderKey?: string | null): boolean {
  return nativeProviderKey != null || id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id, connection.nativeProviderKey);
}

/** Reconnect/repair is owned by an org admin, not the member. */
export function connectionNeedsAdminRepair(connection: Pick<MemberLifecycleConnection, "needsReconnect" | "reconnectActionOwner">): boolean {
  return connection.needsReconnect === true && connection.reconnectActionOwner === "organization_admin";
}

/** The member may run the OAuth flow themselves (connect or reconnect). */
export function canMemberAuthorizeConnection(connection: MemberLifecycleConnection): boolean {
  return connection.credentialMode === "per_member" && connection.authType === "oauth" && !connectionNeedsAdminRepair(connection);
}

/** The member may remove their own stored account. */
export function canDisconnectMemberConnection(connection: Pick<MemberLifecycleConnection, "credentialMode" | "connectedForMe">): boolean {
  return connection.credentialMode === "per_member" && connection.connectedForMe;
}
