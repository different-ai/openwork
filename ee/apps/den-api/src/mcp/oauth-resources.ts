import * as crypto from "node:crypto"
import { env } from "../env.js"
import { deriveDenMcpAgentResource, deriveDenMcpResource, mcpEndpointResource } from "./resource.js"

// Den's MCP OAuth resources, claims and token prefixes. Shared by auth.ts
// (re-exported for existing importers) and the OAuth provider contributor
// (core/hooks/legacy/agent-mcp.ts), so neither imports the other.

function localMcpResourceAliases(resource: string) {
  if (!env.devMode) {
    return []
  }

  try {
    const url = new URL(resource)
    if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost"
      return [url.toString().replace(/\/+$/, "")]
    }
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1"
      return [url.toString().replace(/\/+$/, "")]
    }
  } catch {}

  return []
}

function apiPublicMcpResource(apiPublicUrl: string | undefined) {
  if (!apiPublicUrl) return []

  try {
    const url = new URL(apiPublicUrl)
    const pathname = url.pathname.replace(/\/+$/, "")
    return [`${url.origin}${pathname === "/" ? "" : pathname}/mcp`]
  } catch {
    return []
  }
}

function mcpEndpointResourceAliases(resource: string) {
  return [mcpEndpointResource(resource, "agent"), mcpEndpointResource(resource, "admin")]
}

export const DEN_MCP_RESOURCE = env.mcpResourceUrl ?? deriveDenMcpResource(env.betterAuthUrl, env.webAppHosts)
export const DEN_MCP_OAUTH_RESOURCE = deriveDenMcpAgentResource({
  apiPublicUrl: env.apiPublicUrl,
  mcpResource: DEN_MCP_RESOURCE,
})
export const DEN_MCP_FIRST_PARTY_CLIENT_ID = "openwork-desktop"
const DEN_API_PUBLIC_MCP_RESOURCES = apiPublicMcpResource(env.apiPublicUrl)
const DEN_MCP_BASE_RESOURCES = [
  DEN_MCP_RESOURCE,
  // Audience compatibility: tokens issued before the proxied default carry
  // the bare-origin resource (`<betterAuthUrl>/mcp`); keep accepting them.
  `${env.betterAuthUrl}/mcp`,
  // Auto-trust the public API origin so multi-origin clients work without extra config.
  ...DEN_API_PUBLIC_MCP_RESOURCES,
  ...env.mcpAdditionalResources,
  ...localMcpResourceAliases(DEN_MCP_RESOURCE),
  ...DEN_API_PUBLIC_MCP_RESOURCES.flatMap((resource) => localMcpResourceAliases(resource)),
  ...env.mcpAdditionalResources.flatMap((resource) => localMcpResourceAliases(resource)),
]
export const DEN_MCP_LEGACY_PARENT_RESOURCES = Array.from(new Set(DEN_MCP_BASE_RESOURCES))
export const DEN_MCP_FIRST_PARTY_RESOURCES = Array.from(new Set([
  ...DEN_MCP_BASE_RESOURCES,
  // rmcp uses the configured concrete endpoint as the OAuth resource during
  // token exchange. Accept the two registered child endpoints as aliases of
  // their canonical parent resource.
  ...DEN_MCP_BASE_RESOURCES.flatMap((resource) => mcpEndpointResourceAliases(resource)),
]))
export const DEN_MCP_RESOURCES = Array.from(new Set([
  DEN_MCP_OAUTH_RESOURCE,
  ...DEN_MCP_FIRST_PARTY_RESOURCES,
]))
export const DEN_MCP_OAUTH_VALID_AUDIENCES = [DEN_MCP_OAUTH_RESOURCE]
export const DEN_MCP_TOKEN_USE_CLAIM = `${env.mcpClaimNamespace}/token_use`
export const DEN_MCP_ORG_ID_CLAIM = `${env.mcpClaimNamespace}/org_id`
export const DEN_MCP_RESOURCE_CLAIM = `${env.mcpClaimNamespace}/resource`
export const DEN_MCP_GRANT_ID_CLAIM = `${env.mcpClaimNamespace}/grant_id`
export const DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX = "ow_mcp_at_"
export const DEN_MCP_REFRESH_TOKEN_PREFIX = "ow_mcp_rt_"
export const INVALID_MCP_SESSION_GRANT_DESCRIPTION = "The authorization backing this grant has been revoked. Re-authorize the connection."

export function normalizeMcpOAuthResource(resource: string): string | null {
  const normalized = resource.replace(/\/+$/, "")
  if (normalized === DEN_MCP_OAUTH_RESOURCE) {
    return DEN_MCP_OAUTH_RESOURCE
  }
  return DEN_MCP_FIRST_PARTY_RESOURCES.includes(normalized) ? DEN_MCP_OAUTH_RESOURCE : null
}

export function hashOAuthProviderToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url")
}
