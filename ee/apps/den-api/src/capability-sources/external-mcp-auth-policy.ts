import { EXTERNAL_MCP_PRESETS, type ExternalMcpPreset } from "./external-mcp-presets.js"

export type PluginMcpAuthType = "apikey" | "none" | "oauth"

function normalizedRemoteMcpUrl(value: string) {
  try {
    const url = new URL(value)
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

export function matchExternalMcpPresetForUrl(
  url: string,
  presets: readonly ExternalMcpPreset[] = EXTERNAL_MCP_PRESETS,
): ExternalMcpPreset | null {
  const normalizedUrl = normalizedRemoteMcpUrl(url)
  if (normalizedUrl === null) return null
  return presets.find((candidate) => normalizedRemoteMcpUrl(candidate.url) === normalizedUrl) ?? null
}

export function externalMcpOAuthConfigurationDefaults(input: {
  url: string
  authorizationServerIssuer?: string | null
  requestedScopes?: readonly string[]
}): { authorizationServerIssuer: string | null; requestedScopes: string[] } {
  const preset = matchExternalMcpPresetForUrl(input.url)
  return {
    authorizationServerIssuer: input.authorizationServerIssuer !== undefined
      ? input.authorizationServerIssuer
      : preset?.authorizationServerIssuer ?? null,
    requestedScopes: [...new Set(input.requestedScopes ?? preset?.defaultOAuthScopes ?? [])],
  }
}

export function declaredPluginMcpAuthType(config: Record<string, unknown>): "oauth" | null {
  const oauth = config.oauth
  return oauth !== undefined && oauth !== null && oauth !== false ? "oauth" : null
}

export function requiredPluginMcpAuthType(input: {
  declaredAuthType: "oauth" | null
  url: string
}): PluginMcpAuthType | null {
  const preset = matchExternalMcpPresetForUrl(input.url)
  return preset?.authType ?? input.declaredAuthType
}

export function pluginMcpRequiresPreRegisteredOAuthClient(url: string): boolean {
  return matchExternalMcpPresetForUrl(url)?.requiresOAuthClient === true
}

export function resolveGithubPluginMcpImportAuthType(input: {
  declaredAuthType: "oauth" | null
  requestedAuthType: "none" | "oauth"
  url: string
}): PluginMcpAuthType {
  return requiredPluginMcpAuthType(input) ?? input.requestedAuthType
}
