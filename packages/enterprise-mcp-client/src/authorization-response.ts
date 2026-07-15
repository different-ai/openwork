import { EnterpriseMcpOAuthContractError } from "./errors.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Validate the RFC 9207 issuer on an OAuth authorization response before a
 * code is sent to a token endpoint or a provider error is acted upon.
 * Comparisons are deliberately exact: issuer identifiers must not be URL
 * normalized before comparison.
 */
export function validateMcpAuthorizationResponseIssuer(input: {
  expectedIssuer?: string | null
  discoveryState?: unknown
  /** Undefined means the response omitted `iss`; an empty value is present and invalid. */
  responseIssuer?: string
}): void {
  const discovery = isRecord(input.discoveryState) ? input.discoveryState : undefined
  const authorizationServerMetadata = isRecord(discovery?.authorizationServerMetadata)
    ? discovery.authorizationServerMetadata
    : undefined
  const resourceMetadata = isRecord(discovery?.resourceMetadata)
    ? discovery.resourceMetadata
    : undefined
  const metadataIssuer = optionalString(authorizationServerMetadata?.issuer)
  const discoveryIssuer = optionalString(discovery?.authorizationServerUrl)
  const expectedIssuer = input.expectedIssuer ?? metadataIssuer ?? discoveryIssuer

  if (!expectedIssuer) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_CONFIGURATION_REQUIRED",
      "The OAuth authorization response cannot be validated without a bound authorization-server issuer.",
    )
  }

  const advertisedIssuers = Array.isArray(resourceMetadata?.authorization_servers)
    ? resourceMetadata.authorization_servers.filter((value): value is string => typeof value === "string")
    : undefined
  if (
    (metadataIssuer !== undefined && metadataIssuer !== expectedIssuer)
    || (discoveryIssuer !== undefined && discoveryIssuer !== expectedIssuer)
    || (advertisedIssuers !== undefined && !advertisedIssuers.includes(expectedIssuer))
  ) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_ISSUER_MISMATCH",
      "The stored OAuth discovery state no longer matches the issuer bound to this MCP connection.",
    )
  }

  if (input.responseIssuer !== undefined) {
    if (input.responseIssuer !== expectedIssuer) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_ISSUER_MISMATCH",
        "The OAuth authorization response issuer does not match the issuer selected for this MCP connection.",
      )
    }
    return
  }

  if (authorizationServerMetadata?.authorization_response_iss_parameter_supported === true) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_ISSUER_MISMATCH",
      "The OAuth authorization response omitted the issuer required by the authorization-server metadata.",
    )
  }
}
