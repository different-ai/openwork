export const DEN_MCP_READ_SCOPE = "mcp:read"
export const DEN_MCP_WRITE_SCOPE = "mcp:write"
export const DEN_MCP_OFFLINE_SCOPE = "offline_access"

export type DenMcpTokenScope = typeof DEN_MCP_READ_SCOPE | typeof DEN_MCP_WRITE_SCOPE

export const DEN_MCP_SCOPES = [
  "openid",
  "profile",
  "email",
  DEN_MCP_OFFLINE_SCOPE,
  DEN_MCP_READ_SCOPE,
  DEN_MCP_WRITE_SCOPE,
]

export const DEN_MCP_REQUESTED_SCOPES = [
  DEN_MCP_READ_SCOPE,
  DEN_MCP_WRITE_SCOPE,
  DEN_MCP_OFFLINE_SCOPE,
]
export const DEN_MCP_REQUESTED_SCOPE = DEN_MCP_REQUESTED_SCOPES.join(" ")

export const DEN_MCP_DEFAULT_CLIENT_SCOPES = [...DEN_MCP_REQUESTED_SCOPES]

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

export function addRequestedMcpClientScopes(clientScopes: readonly string[], requestedScopes: readonly string[]) {
  if (!clientScopes.some((scope) => scope === DEN_MCP_READ_SCOPE || scope === DEN_MCP_WRITE_SCOPE)) {
    return [...clientScopes]
  }

  const nextScopes = [...clientScopes]
  for (const scope of [DEN_MCP_WRITE_SCOPE, DEN_MCP_OFFLINE_SCOPE]) {
    if (requestedScopes.includes(scope) && !nextScopes.includes(scope)) {
      nextScopes.push(scope)
    }
  }
  return nextScopes
}
