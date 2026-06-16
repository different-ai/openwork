export const DEN_MCP_READ_SCOPE = "mcp:read"
export const DEN_MCP_WRITE_SCOPE = "mcp:write"

export type DenMcpTokenScope = typeof DEN_MCP_READ_SCOPE | typeof DEN_MCP_WRITE_SCOPE

export const DEN_MCP_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  DEN_MCP_READ_SCOPE,
  DEN_MCP_WRITE_SCOPE,
]

export const DEN_MCP_DEFAULT_CLIENT_SCOPES = [
  "openid",
  "profile",
  "email",
  DEN_MCP_READ_SCOPE,
]

export const DEN_MCP_DEFAULT_TOKEN_SCOPES: readonly DenMcpTokenScope[] = [DEN_MCP_READ_SCOPE]

export function resolveMcpTokenScopes(scopes: readonly DenMcpTokenScope[] | undefined) {
  return [...(scopes ?? DEN_MCP_DEFAULT_TOKEN_SCOPES)]
}

export function normalizeMcpOAuthClientScope(scope: unknown) {
  if (typeof scope !== "string") {
    return null
  }

  const normalized = scope.split(/\s+/).filter(Boolean).join(" ")
  return normalized || null
}
