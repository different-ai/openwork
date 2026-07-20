type McpBrowserHandoffEvent = {
  type: "mcp.browser.open.failed";
  properties: {
    mcpName: string;
    url: string;
  };
};

export function mcpBrowserOpenFailedUrl(payload: unknown, expectedMcpName: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Partial<McpBrowserHandoffEvent>;
  const properties = event.properties;
  if (
    event.type !== "mcp.browser.open.failed"
    || properties?.mcpName !== expectedMcpName
    || typeof properties.url !== "string"
    || !properties.url.trim()
  ) return null;
  return properties.url;
}
