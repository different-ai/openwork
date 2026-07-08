export type NativeProviderDisconnectableConnection = {
  id: string;
  connectedForMe: boolean;
};

export function isNativeProviderConnectionId(id: string): boolean {
  // Today google-workspace is the only native provider connection id; a follow-up generalizes this for external per-member connections.
  return id === "google-workspace";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id);
}
