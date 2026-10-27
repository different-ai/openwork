"use client";

import { getAddConnectorRoute, getMcpConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AdminConnectorPageScreen } from "./admin-connector-page-screen";
import { ItemHeader, ItemPage } from "./item-header";
import { LinkButton } from "./item-list";
import { useMcpConnections } from "./mcp-connections-data";

/** A configured connector's Manage page, Google Workspace and Microsoft 365 included. */
export function AdminConnectorRoute({ connectorId, confirmRemove = false }: { connectorId: string; confirmRemove?: boolean }) {
  const { orgSlug } = useOrgDashboard();
  // Always re-read on open: whether Remove is allowed comes with the connection.
  const connections = useMcpConnections("manageable", { refetchOnMount: "always" });
  const usable = useMcpConnections("usable", { refetchOnMount: "always" });
  const connection = connections.data?.find((entry) => entry.id === connectorId)
    ?? usable.data?.find((entry) => entry.id === connectorId);
  if (connection) return <AdminConnectorPageScreen connection={connection} confirmRemove={confirmRemove} />;
  const back = { href: getMcpConnectionsRoute(orgSlug), label: "Connectors" };
  if (connections.isLoading || usable.isLoading) return <ItemPage><ItemHeader back={back} title="Loading..." /></ItemPage>;
  return (
    <ItemPage testId="connector-not-found">
      <ItemHeader
        back={back}
        title="Connector not found"
        description="It may have been removed."
        actions={<LinkButton variant="primary" href={getAddConnectorRoute(orgSlug)}>Add a connector</LinkButton>}
      />
    </ItemPage>
  );
}
