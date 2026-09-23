"use client";

import { AdminConnectorPageScreen } from "./admin-connector-page-screen";
import { ItemHeader, ItemPage } from "./item-header";
import { McpConnectionsScreen } from "./mcp-connections-screen";
import { isNativeProviderConnectionId, useMcpConnections } from "./mcp-connections-data";

/** A configured connector gets its Manage page; a catalog id or a Google or Microsoft suite keeps the full editor. */
export function AdminConnectorRoute({ connectorId }: { connectorId: string }) {
  const connections = useMcpConnections("manageable");
  const connection = connections.data?.find((entry) => entry.id === connectorId);
  if (connection && !isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)) {
    return <AdminConnectorPageScreen connection={connection} />;
  }
  if (connections.isLoading) return <ItemPage><ItemHeader title="Loading..." /></ItemPage>;
  return <McpConnectionsScreen view="detail" connectorId={connectorId} />;
}
