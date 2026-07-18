/**
 * [INPUT]: 依赖 Den 公网 API origin 与 External MCP connection 标识
 * [OUTPUT]: 对外提供共享/旧版 callback 和 OAuth client metadata URL
 * [POS]: capability-sources 的 OAuth URL 契约，集中维持注册、回调与部署 origin 一致性
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ExternalMcpOAuthCallbackMode } from "@openwork-ee/den-db/schema"
import { env } from "../env.js"

function configuredPublicApiBaseUrl(): string {
  if (!env.apiPublicUrl) {
    throw new Error("DEN_API_PUBLIC_URL must be configured before external MCP OAuth can start.")
  }
  const url = new URL(env.apiPublicUrl)
  const pathname = url.pathname.replace(/\/+$/, "")
  return `${url.origin}${pathname === "/" ? "" : pathname}`
}

function publicApiUrl(pathname: string): string {
  return `${configuredPublicApiBaseUrl()}${pathname}`
}

export function externalMcpSharedCallbackUrl(): string {
  return publicApiUrl("/v1/mcp-connections/oauth/callback")
}

export function externalMcpLegacyCallbackUrl(connectionId: string): string {
  return publicApiUrl(`/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`)
}

export function externalMcpCallbackUrl(input: {
  connectionId: string
  callbackMode: ExternalMcpOAuthCallbackMode
}): string {
  return input.callbackMode === "shared-v1"
    ? externalMcpSharedCallbackUrl()
    : externalMcpLegacyCallbackUrl(input.connectionId)
}

export function externalMcpClientMetadataUrl(): string {
  return publicApiUrl("/oauth/client-metadata.json")
}
