import { McpConnectionsScreen } from "../../../_components/mcp-connections-screen";

export default async function McpConnectionDetailPage({
  params,
}: {
  params: Promise<{ connectorId: string }>;
}) {
  const { connectorId } = await params;

  return <McpConnectionsScreen view="detail" connectorId={connectorId} />;
}
