import { AdminConnectorRoute } from "../../../_components/admin-connector-route";

export default async function McpConnectionDetailPage({ params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params;
  return <AdminConnectorRoute connectorId={connectorId} />;
}
