export type McpConnectionsCapabilityState = {
  mcpConnections: boolean;
};

export function shouldShowMcpConnectionsStagingBanner(capabilities: McpConnectionsCapabilityState) {
  return !capabilities.mcpConnections;
}
