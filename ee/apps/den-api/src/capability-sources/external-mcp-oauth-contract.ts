import type { ExternalMcpOAuthCallbackMode } from "@openwork-ee/den-db/schema"
import { env } from "../env.js"

export const HOSTED_MCP_CALLBACK_MIGRATION_CUTOFF = new Date("2026-08-24T00:01:00.000Z")

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

function hostedWebProxyUrl(pathname: string): string {
  const url = new URL(`/api/den${pathname}`, env.betterAuthUrl)
  return url.toString()
}

function usesHostedDirectApiMigration(): boolean {
  if (!env.apiPublicUrl) return false
  const web = new URL(env.betterAuthUrl)
  const api = new URL(env.apiPublicUrl)
  return web.protocol === "https:"
    && api.protocol === "https:"
    && web.hostname === "app.openworklabs.com"
    && (api.hostname === "api.app.openworklabs.com" || api.hostname === "api.openworklabs.com")
}

export function externalMcpHostedWebProxyCallbackUrl(input: {
  connectionId: string
  callbackMode: ExternalMcpOAuthCallbackMode
}): string {
  return input.callbackMode === "shared-v1"
    ? hostedWebProxyUrl("/v1/mcp-connections/oauth/callback")
    : hostedWebProxyUrl(`/v1/mcp-connections/${encodeURIComponent(input.connectionId)}/connect/callback`)
}

function validAbsoluteUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

export function externalMcpCompatibleCallbackUrl(input: {
  connectionId: string
  callbackMode: ExternalMcpOAuthCallbackMode
  createdAt: Date
  registeredRedirectUri?: string | null
}): string {
  // The provider's OAuth app registration is authoritative for reconnects: if
  // Den recorded the redirect URI used when the client was registered, keep
  // sending that exact URI through authorize and token exchange.
  const registered = validAbsoluteUrl(input.registeredRedirectUri)
  if (registered) return registered
  // Rows created before the hosted Den API split may not have a recorded client
  // redirect. Keep those on the old app/proxy callback so existing provider
  // allowlists continue to work, while new rows use the direct API callback.
  if (input.createdAt.getTime() < HOSTED_MCP_CALLBACK_MIGRATION_CUTOFF.getTime() && usesHostedDirectApiMigration()) {
    return externalMcpHostedWebProxyCallbackUrl(input)
  }
  return externalMcpCallbackUrl(input)
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
