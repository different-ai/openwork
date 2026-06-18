export function getMcpClientCompatibilityScopeUpdate(input: {
  storedScopes: readonly string[]
  requestedScopes: readonly string[]
}) {
  const requestedScopes = new Set(input.requestedScopes)
  if (!requestedScopes.has("mcp:read") && !requestedScopes.has("mcp:write")) {
    return null
  }

  const storedScopes = new Set(input.storedScopes)
  if (!storedScopes.has("mcp:write") || storedScopes.has("mcp:read")) {
    return null
  }

  storedScopes.add("mcp:read")
  return Array.from(storedScopes)
}
