import { McpConnectionsCapabilityGuard } from "../_components/mcp-connections-capability-guard";
import { YourConnectionsScreen } from "../_components/your-connections-screen";

export default function YourConnectionsPage() {
  return (
    <McpConnectionsCapabilityGuard>
      <YourConnectionsScreen />
    </McpConnectionsCapabilityGuard>
  );
}
