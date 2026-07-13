export type NativeProviderDisconnectableConnection = {
  id: string;
  connectedForMe: boolean;
};

export function isNativeProviderConnectionId(id: string): boolean {
  return id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id);
}
