import type { ConnectionRepairFacts, MemberConnectionAuthorization } from "@openwork/types/den/connection-state";
export {
  connectionNeedsReconnect,
  connectionNeedsAdminRepair,
  canMemberAuthorizeConnection,
  canDisconnectMemberConnection,
} from "@openwork/types/den/connection-state";

export type NativeProviderDisconnectableConnection = {
  id: string;
  nativeProviderKey?: string | null;
  connectedForMe: boolean;
};

export type ReconnectableConnection = Pick<ConnectionRepairFacts, "needsReconnect" | "missingFeatures">;
export type MemberLifecycleConnection = { id: string } & MemberConnectionAuthorization;

export function isNativeProviderConnectionId(id: string, nativeProviderKey?: string | null): boolean {
  return nativeProviderKey != null || id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: NativeProviderDisconnectableConnection): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id, connection.nativeProviderKey);
}
