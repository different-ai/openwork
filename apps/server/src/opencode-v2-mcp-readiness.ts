export const MCP_READINESS_RPC_ID = "openwork.mcp-readiness";
export type McpPublishedTool = { readonly id: string; readonly options?: { readonly namespace?: string } };

export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_");
export const mcpToolId = (server: string, name: string) => `${mcpNamespace(server)}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export function mcpBindingsReady(current: readonly McpPublishedTool[], server: string, desired: readonly string[], previous: readonly string[]): boolean {
  const published = new Set(current.filter(tool => tool.options?.namespace === mcpNamespace(server)).map(tool => tool.id));
  const wanted = new Set(desired);
  return desired.every(id => published.has(id)) && previous.every(id => wanted.has(id) || !published.has(id));
}
