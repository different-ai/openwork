export type NativeProviderDisconnectableConnection = {
  id: string;
  nativeProviderKey?: string | null;
  connectedForMe: boolean;
};

export type ReconnectableConnection = {
  nativeProviderKey?: string | null;
  needsReconnect?: boolean;
  policyBlocked?: boolean;
  missingFeatures?: readonly string[];
};

export type MemberLifecycleConnection = {
  id: string;
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  connectedForMe: boolean;
  needsReconnect?: boolean;
  policyBlocked?: boolean;
  missingFeatures?: readonly string[];
  reconnectActionOwner?: "member" | "organization_admin" | null;
};

const SLACK_OPTIONAL_ACCESS: Record<string, string> = {
  privateChannels: "private channels",
  directMessages: "direct messages",
  groupMessages: "group direct messages",
};

export function slackMissingAccess(connection: ReconnectableConnection): string[] {
  if (connection.nativeProviderKey !== "slack") return [];
  return (connection.missingFeatures ?? []).flatMap((feature) => {
    const label = SLACK_OPTIONAL_ACCESS[feature];
    return label ? [label] : [];
  });
}

export function connectionNeedsReconnect(connection: ReconnectableConnection): boolean {
  if (connection.policyBlocked) return false;
  if (connection.needsReconnect === true) return true;
  // Optional Slack consent leaves public-channel access usable. Other providers
  // keep their existing missing-feature recovery behavior.
  return (connection.missingFeatures ?? []).some((feature) =>
    connection.nativeProviderKey !== "slack" || !SLACK_OPTIONAL_ACCESS[feature]);
}

export function isNativeProviderConnectionId(id: string, nativeProviderKey?: string | null): boolean {
  return nativeProviderKey != null || id === "google-workspace" || id === "microsoft-365" || id === "slack";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id, connection.nativeProviderKey);
}

/** Reconnect/repair is owned by an org admin, not the member. */
export function connectionNeedsAdminRepair(connection: Pick<MemberLifecycleConnection, "needsReconnect" | "reconnectActionOwner">): boolean {
  return connection.needsReconnect === true && connection.reconnectActionOwner === "organization_admin";
}

/** The member may authorize their own OAuth account or personal API key. */
export function canMemberAuthorizeConnection(connection: MemberLifecycleConnection): boolean {
  return !connection.policyBlocked && connection.credentialMode === "per_member" && connection.authType !== "none" && !connectionNeedsAdminRepair(connection);
}

/** The member may remove their own stored account. */
export function canDisconnectMemberConnection(connection: Pick<MemberLifecycleConnection, "credentialMode" | "connectedForMe">): boolean {
  return connection.credentialMode === "per_member" && connection.connectedForMe;
}
