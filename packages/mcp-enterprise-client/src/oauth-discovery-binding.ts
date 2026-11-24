import type { OAuthDiscoveryState } from "@modelcontextprotocol/client"
import { isEquivalentOAuthDiscoveryAlias } from "./oauth-resource-alias.js"

type OAuthDiscoveryBindingState = Pick<OAuthDiscoveryState, "authorizationServerUrl"> & {
  authorizationServerMetadata?: { issuer?: string }
  resourceMetadata?: { resource?: string; authorization_servers?: string[] }
}

function isResourceScopedDiscoveryAlias(state: OAuthDiscoveryBindingState, expectedIssuer: string): boolean {
  const advertisedIssuers = state.resourceMetadata?.authorization_servers
  return state.authorizationServerUrl !== expectedIssuer
    && isEquivalentOAuthDiscoveryAlias(state.authorizationServerMetadata?.issuer, expectedIssuer)
    && isEquivalentOAuthDiscoveryAlias(state.resourceMetadata?.resource, state.authorizationServerUrl)
    && advertisedIssuers?.some((issuer) => isEquivalentOAuthDiscoveryAlias(issuer, state.authorizationServerUrl)) === true
}

function advertisesExpectedIssuerOrResourceAlias(
  state: OAuthDiscoveryBindingState,
  expectedIssuer: string,
): boolean {
  const advertisedIssuers = state.resourceMetadata?.authorization_servers
  if (advertisedIssuers === undefined) return true
  return advertisedIssuers.some((issuer) => isEquivalentOAuthDiscoveryAlias(issuer, expectedIssuer))
    || advertisedIssuers.some((issuer) => isEquivalentOAuthDiscoveryAlias(issuer, state.resourceMetadata?.resource))
}

/**
 * Bind OAuth metadata to either its advertised issuer or the constrained
 * resource-scoped discovery alias advertised by the protected resource.
 * The canonical metadata issuer remains the issuer used for callbacks.
 */
export function isAuthorizationServerDiscoveryBound(
  state: OAuthDiscoveryBindingState,
  expectedIssuer: string,
): boolean {
  const directBinding = isEquivalentOAuthDiscoveryAlias(state.authorizationServerUrl, expectedIssuer)
    && advertisesExpectedIssuerOrResourceAlias(state, expectedIssuer)
  const discoveryBinding = directBinding || isResourceScopedDiscoveryAlias(state, expectedIssuer)
  return discoveryBinding
    && (state.authorizationServerMetadata?.issuer === undefined
      || isEquivalentOAuthDiscoveryAlias(state.authorizationServerMetadata.issuer, expectedIssuer))
}
