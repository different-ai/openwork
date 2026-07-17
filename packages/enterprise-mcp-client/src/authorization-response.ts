import { EnterpriseMcpOAuthContractError } from "./errors.js"
import { isAuthorizationServerDiscoveryBound } from "./oauth-discovery-binding.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export type McpAuthorizationResponseMixUpDefense =
  | "response-issuer"
  | "distinct-redirect-uri"
  | "legacy"

export type McpAuthorizationResponseIssuerValidation = {
  defense: McpAuthorizationResponseMixUpDefense
  ignoredResponseIssuer?: string
}

/**
 * Validate the OAuth mix-up defense before a code is sent to a token endpoint
 * or a provider error is acted upon. Shared callbacks require RFC 9207 issuer
 * identification. A caller may instead prove an issuer-specific redirect URI
 * per RFC 9700; only then may an unadvertised provider `iss` be treated as
 * untrusted compatibility data. Exact issuer comparisons are never normalized.
 */
export function validateMcpAuthorizationResponseIssuer(input: {
  expectedIssuer?: string | null
  discoveryState?: unknown
  /** Undefined means the response omitted `iss`; an empty value is present and invalid. */
  responseIssuer?: string
  mixUpDefense?: McpAuthorizationResponseMixUpDefense
}): McpAuthorizationResponseIssuerValidation {
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
  const discoveryIsBound = discoveryIssuer
    ? isAuthorizationServerDiscoveryBound({
        authorizationServerUrl: discoveryIssuer,
        authorizationServerMetadata: metadataIssuer ? { issuer: metadataIssuer } : undefined,
        resourceMetadata: resourceMetadata
          ? {
              resource: optionalString(resourceMetadata.resource),
              authorization_servers: advertisedIssuers,
            }
          : undefined,
      }, expectedIssuer)
    : (metadataIssuer === undefined || metadataIssuer === expectedIssuer)
      && (advertisedIssuers === undefined || advertisedIssuers.includes(expectedIssuer))
  if (!discoveryIsBound) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_ISSUER_MISMATCH",
      "The stored OAuth discovery state no longer matches the issuer bound to this MCP connection.",
    )
  }

  if (input.responseIssuer !== undefined) {
    if (input.responseIssuer !== expectedIssuer) {
      if (
        input.mixUpDefense === "distinct-redirect-uri"
        && authorizationServerMetadata?.authorization_response_iss_parameter_supported !== true
      ) {
        return {
          defense: "distinct-redirect-uri",
          ignoredResponseIssuer: input.responseIssuer,
        }
      }
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_ISSUER_MISMATCH",
        "The OAuth authorization response issuer does not match the issuer selected for this MCP connection.",
      )
    }
    return { defense: input.mixUpDefense ?? "response-issuer" }
  }

  if (authorizationServerMetadata?.authorization_response_iss_parameter_supported === true) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_ISSUER_MISMATCH",
      "The OAuth authorization response omitted the issuer required by the authorization-server metadata.",
    )
  }

  if ((input.mixUpDefense ?? "response-issuer") === "response-issuer") {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_ISSUER_MISMATCH",
      "The shared OAuth callback requires an authorization-response issuer.",
    )
  }

  return { defense: input.mixUpDefense ?? "legacy" }
}
