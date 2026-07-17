export type NativeProviderDisconnectableConnection = {
  id: string;
  connectedForMe: boolean;
};

export type ReconnectableConnection = {
  needsReconnect?: boolean;
  missingFeatures?: readonly string[];
};

export function connectionNeedsReconnect(connection: ReconnectableConnection): boolean {
  return connection.needsReconnect === true || (connection.missingFeatures?.length ?? 0) > 0;
}

export function isNativeProviderConnectionId(id: string): boolean {
  return id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id);
}
