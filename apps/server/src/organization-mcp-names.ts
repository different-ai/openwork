const ORGANIZATION_MCP_NAMES = new Set(["openwork-cloud"]);
const ORGANIZATION_MCP_PREFIXES = ["openwork-connect-", "openwork-direct-", "openwork-app-host-connect-"];

export type OrganizationMcpServers = Record<string, string[]>;

export function isOrganizationMcpName(name: string): boolean {
  const value = name.toLowerCase();
  return ORGANIZATION_MCP_NAMES.has(value) || ORGANIZATION_MCP_PREFIXES.some((prefix) => value.startsWith(prefix));
}

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
