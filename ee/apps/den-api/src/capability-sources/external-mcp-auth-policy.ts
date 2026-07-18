/**
 * [INPUT]: 依赖 External MCP 预设认证元数据与插件 MCP 声明
 * [OUTPUT]: 对外提供认证类型、预注册 OAuth 要求与 GitHub 插件导入认证解析
 * [POS]: capability-sources 的认证策略层，保证已知服务的安全要求覆盖模糊导入参数
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { EXTERNAL_MCP_PRESETS } from "./external-mcp-presets.js"

export type PluginMcpAuthType = "apikey" | "none" | "oauth"

function normalizedRemoteMcpUrl(value: string) {
  try {
    const url = new URL(value)
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return null
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
  const normalizedUrl = normalizedRemoteMcpUrl(input.url)
  const preset = normalizedUrl
    ? EXTERNAL_MCP_PRESETS.find((candidate) => normalizedRemoteMcpUrl(candidate.url) === normalizedUrl)
    : null
  return preset?.authType ?? input.declaredAuthType
}

export function pluginMcpRequiresPreRegisteredOAuthClient(url: string): boolean {
  const normalizedUrl = normalizedRemoteMcpUrl(url)
  return normalizedUrl !== null && EXTERNAL_MCP_PRESETS.some((candidate) =>
    normalizedRemoteMcpUrl(candidate.url) === normalizedUrl && candidate.requiresOAuthClient === true
  )
}

export function resolveGithubPluginMcpImportAuthType(input: {
  declaredAuthType: "oauth" | null
  requestedAuthType: "none" | "oauth"
  url: string
}): PluginMcpAuthType {
  return requiredPluginMcpAuthType(input) ?? input.requestedAuthType
}
