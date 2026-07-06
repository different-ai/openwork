import { McpConnectionsCapabilityGuard } from "../../_components/mcp-connections-capability-guard";
import { McpConnectionsScreen } from "../../_components/mcp-connections-screen";

export default function McpConnectionsPage() {
  return (
    <McpConnectionsCapabilityGuard>
      <McpConnectionsScreen />
    </McpConnectionsCapabilityGuard>
  );
}
