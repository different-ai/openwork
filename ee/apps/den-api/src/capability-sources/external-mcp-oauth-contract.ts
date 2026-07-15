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
