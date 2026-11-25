import type { McpRegistrationOutcome, McpRegistrationStatus } from "@openwork/types/den/mcp-registration"

export type McpRegistrationFacts = {
  clientMetadataSupported?: boolean | null
  dynamicRegistrationSupported?: boolean | null
}

export function nextMcpRegistrationStatus(
  current: McpRegistrationStatus | null,
  outcome: McpRegistrationOutcome,
  facts: McpRegistrationFacts = {},
): McpRegistrationStatus {
  switch (outcome) {
    case "registered_client_metadata":
      return "client_metadata"
    case "registered_dynamic":
      return "dynamic_open"
    case "refused":
      return "dynamic_refused"
    case "no_registration_method":
      return "requires_client"
    case "no_auth":
      return "no_auth"
    case "unreachable":
      return current ?? "unknown"
    case "metadata_only": {
      if (facts.clientMetadataSupported) return "client_metadata"
      if (facts.dynamicRegistrationSupported) {
        return current === "dynamic_open" || current === "dynamic_refused" ? current : "unknown"
      }
      if (facts.dynamicRegistrationSupported === false && facts.clientMetadataSupported === false) return "requires_client"
      return current ?? "unknown"
    }
  }
}

export function isRegistrationRefusal(diagnostic: { phase?: string | null; code?: string | null; httpStatus?: number | null }): boolean {
  if (diagnostic.phase !== "AUTH_CLIENT_REGISTRATION") return false
  return diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403
    || diagnostic.code === "MCP_HTTP_401" || diagnostic.code === "MCP_HTTP_403"
}

export function normalizeIssuer(issuer: string): string | null {
  try {
    const url = new URL(issuer)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    const path = url.pathname.replace(/\/+$/, "")
    return `${url.origin}${path}`.slice(0, 512)
  } catch {
    return null
  }
}

export function redactEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null
  try {
    const url = new URL(endpoint)
    return `${url.origin}${url.pathname}`.slice(0, 2048)
  } catch {
    return null
  }
}
