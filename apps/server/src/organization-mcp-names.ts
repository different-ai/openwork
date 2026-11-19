// MCP servers OpenWork registers for the organization: its Cloud connection
// and the connections an administrator exposed (see
// connect-mcp-server-catalog.ts). Members cannot create these names
// (validators.ts). The desktop leaves such a server running only while it is
// the one OpenWork registered, at the same address, as OpenWork's own records
// say (registeredOrganizationMcpServers), so any other server under such a
// name, from a project config or stored earlier, gains nothing; Den applies
// the member's MCP server rules to each organization connection and skill
// behind it.
const ORGANIZATION_MCP_NAMES = new Set(["openwork-cloud"]);
const ORGANIZATION_MCP_PREFIXES = ["openwork-connect-", "openwork-direct-", "openwork-app-host-connect-"];

/** Name → the addresses OpenWork registered under it. */
export type OrganizationMcpServers = Record<string, string[]>;

export function isOrganizationMcpName(name: string): boolean {
  const value = name.toLowerCase();
  return ORGANIZATION_MCP_NAMES.has(value) || ORGANIZATION_MCP_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** A remote MCP server's address; organization servers are always remote. */
export function mcpServerUrl(server: unknown): string | null {
  return typeof server === "object" && server !== null && "url" in server && typeof server.url === "string" ? server.url : null;
}

export function parseOrganizationMcpServers(value: unknown): OrganizationMcpServers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, urls]) => {
    const valid = Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
    return isOrganizationMcpName(name) && valid.length > 0 ? [[name, valid]] : [];
  }));
}
