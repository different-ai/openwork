import { AdminConnectorsScreen } from "../../_components/admin-connectors-screen";
import { McpConnectionsScreen } from "../../_components/mcp-connections-screen";

export default async function McpConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { quickAdd } = await searchParams;
  return quickAdd ? <McpConnectionsScreen /> : <AdminConnectorsScreen />;
}
