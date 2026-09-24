import type { ExternalMcpPreset, McpRequirementsDiscovery } from "./mcp-connections-data";

/**
 * What the second setup check asks for:
 * - `sign_in`: OpenWork registers itself (dynamic or client metadata), people sign in.
 * - `oauth_app`: the server only accepts a pre-registered OAuth app; an admin pastes its client ID first.
 * - `api_key`: the server takes a key; an admin pastes it and everyone shares it.
 * - `none`: nothing to sign in to.
 * - `unsupported`: OpenWork could not tell.
 */
export type ConnectorSignInMethod = "sign_in" | "oauth_app" | "api_key" | "none" | "unsupported";

type DiscoveryAuthentication = Pick<McpRequirementsDiscovery, "authentication">;
type PresetAuth = Pick<ExternalMcpPreset, "authType" | "requiresOAuthClient">;

/** A curated preset's auth type stays authoritative over the live probe, as it did in the full editor. */
export function connectorSignInMethod(discovery: DiscoveryAuthentication, preset?: PresetAuth | null): ConnectorSignInMethod {
  if (preset?.authType === "apikey") return "api_key";
  if (preset?.authType === "none") return "none";
  if (preset?.authType === "oauth" && preset.requiresOAuthClient === true) return "oauth_app";
  const authentication = discovery.authentication;
  if (preset?.authType === "oauth") return authentication.kind === "oauth" ? oauthMethod(authentication) : "sign_in";
  switch (authentication.kind) {
    case "none":
      return "none";
    case "oauth":
      return oauthMethod(authentication);
    case "manual_bearer":
      return "api_key";
    default:
      return "unsupported";
  }
}

function oauthMethod(authentication: McpRequirementsDiscovery["authentication"]): ConnectorSignInMethod {
  const methods = authentication.availableRegistrationMethods ?? [];
  return methods.includes("dynamic") || methods.includes("client_metadata") ? "sign_in" : "oauth_app";
}

/** A client secret is optional unless every advertised token endpoint rejects public clients. */
export function oauthClientSecretRequired(discovery: DiscoveryAuthentication | null): boolean {
  const servers = discovery?.authentication.authorizationServers ?? [];
  const advertised = servers.filter((server) => (server.tokenEndpointAuthMethodsSupported?.length ?? 0) > 0);
  if (advertised.length === 0) return false;
  return advertised.every((server) => !(server.tokenEndpointAuthMethodsSupported ?? []).includes("none"));
}

/** Issuer and scopes to save with an OAuth connection, matching the full editor's defaults. */
export function oauthRequestFields(discovery: DiscoveryAuthentication | null): { authorizationServerIssuer?: string; requestedScopes: string[] } {
  const authentication = discovery?.authentication;
  const servers = authentication?.authorizationServers ?? [];
  const requestedScopes = [...new Set([...(authentication?.requiredScopes ?? []), ...(authentication?.recommendedScopes ?? [])])];
  return {
    ...(servers.length === 1 && servers[0] ? { authorizationServerIssuer: servers[0].issuer } : {}),
    requestedScopes,
  };
}
