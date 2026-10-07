// MCP servers OpenWork itself manages: the organization's Cloud connection,
// connections an administrator exposed (see connect-mcp-server-catalog.ts)
// and the hidden UI bridge. Users cannot create these names
// (validators.ts), and team rules for local MCP servers never apply to them.
const ORGANIZATION_MCP_NAMES = new Set(["openwork-cloud", "openwork-ui"]);
const ORGANIZATION_MCP_PREFIXES = ["openwork-connect-", "openwork-direct-", "openwork-app-host-connect-"];

export function isOrganizationMcpName(name: string): boolean {
  return ORGANIZATION_MCP_NAMES.has(name) || ORGANIZATION_MCP_PREFIXES.some((prefix) => name.startsWith(prefix));
}
