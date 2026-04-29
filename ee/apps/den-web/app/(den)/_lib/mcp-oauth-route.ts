export function getMcpOAuthSelectOrganizationRoute(search: string) {
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  if (!normalizedSearch) return null;

  const params = new URLSearchParams(normalizedSearch);
  const scopes = new Set((params.get("scope") ?? "").split(/\s+/).filter(Boolean));
  if (params.get("response_type") !== "code" || !params.get("client_id") || (!scopes.has("mcp:read") && !scopes.has("mcp:write"))) {
    return null;
  }

  return `/mcp/select-organization?${normalizedSearch}`;
}
