import type { ExternalMcpPreset, McpRequirementsDiscovery } from "./mcp-connections-data";

export type ConnectorSignInMethod = "sign_in" | "oauth_app" | "api_key" | "none" | "unsupported";

type DiscoveryAuthentication = Pick<McpRequirementsDiscovery, "authentication">;
type PresetAuth = Pick<ExternalMcpPreset, "authType" | "requiresOAuthClient" | "defaultOAuthClientId">;

export function connectorSignInMethod(discovery: DiscoveryAuthentication, preset?: PresetAuth | null): ConnectorSignInMethod {
  if (preset?.authType === "apikey") return "api_key";
  if (preset?.authType === "none") return "none";
  if (preset?.authType === "oauth" && preset.defaultOAuthClientId) return "sign_in";
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

export function oauthRequestFieldsForTarget(
  discovery: DiscoveryAuthentication | null,
  target: { preset?: Pick<ExternalMcpPreset, "defaultOAuthScopes"> | null; requestedScopes?: readonly string[] },
): { authorizationServerIssuer?: string; requestedScopes: string[] } {
  return oauthRequestFields(discovery, target.requestedScopes?.length ? { defaultOAuthScopes: [...target.requestedScopes] } : target.preset);
}

export function oauthClientSecretRequired(discovery: DiscoveryAuthentication | null): boolean {
  const servers = discovery?.authentication.authorizationServers ?? [];
  const advertised = servers.filter((server) => (server.tokenEndpointAuthMethodsSupported?.length ?? 0) > 0);
  if (advertised.length === 0) return false;
  return advertised.every((server) => !(server.tokenEndpointAuthMethodsSupported ?? []).includes("none"));
}

export function oauthRequestFields(
  discovery: DiscoveryAuthentication | null,
  preset?: Pick<ExternalMcpPreset, "defaultOAuthScopes"> | null,
): { authorizationServerIssuer?: string; requestedScopes: string[] } {
  const authentication = discovery?.authentication;
  const servers = authentication?.authorizationServers ?? [];
  const requestedScopes = preset?.defaultOAuthScopes?.length
    ? [...new Set(preset.defaultOAuthScopes)]
    : [...new Set([...(authentication?.requiredScopes ?? []), ...(authentication?.recommendedScopes ?? [])])];
  return {
    ...(servers.length === 1 && servers[0] ? { authorizationServerIssuer: servers[0].issuer } : {}),
    requestedScopes,
  };
}
