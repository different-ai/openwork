import { EXTERNAL_MCP_PRESETS } from "../../../capability-sources/external-mcp-presets.js"

export type GithubPluginMcpImportAuthType = "apikey" | "none" | "oauth"

function normalizedRemoteMcpUrl(value: string) {
  try {
    const url = new URL(value)
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return null
  }
}

export function declaredGithubPluginMcpAuthType(config: Record<string, unknown>): "oauth" | null {
  const oauth = config.oauth
  return oauth !== undefined && oauth !== null && oauth !== false ? "oauth" : null
}

export function resolveGithubPluginMcpImportAuthType(input: {
  declaredAuthType: "oauth" | null
  requestedAuthType: "none" | "oauth"
  url: string
}): GithubPluginMcpImportAuthType {
  const normalizedUrl = normalizedRemoteMcpUrl(input.url)
  const preset = normalizedUrl
    ? EXTERNAL_MCP_PRESETS.find((candidate) => normalizedRemoteMcpUrl(candidate.url) === normalizedUrl)
    : null
  return preset?.authType ?? input.declaredAuthType ?? input.requestedAuthType
}
