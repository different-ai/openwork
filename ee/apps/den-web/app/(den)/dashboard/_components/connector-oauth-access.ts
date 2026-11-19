/** Discovery advertisements are not grants. In particular, /readonly only describes a tool endpoint. */
type ScopeDiscovery = {
  authentication: {
    requiredScopes: readonly string[];
    recommendedScopes: readonly string[];
    resourceScopesSupported?: readonly string[];
    authorizationServers: readonly { scopesSupported?: readonly string[] }[];
  };
};

type ScopePreset = { defaultOAuthScopes?: readonly string[] };

export type ConnectorOAuthAccess = {
  requiredScopes: string[];
  optionalScopes: string[];
  selectedDefault: string[];
  conflictingScopes: string[];
  requiresScopeChoice: boolean;
  warnings: string[];
};

function unique(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}

/** Only for newly reviewed setup. Never apply this to saved connections or infer scopes from tool hints. */
export function connectorOAuthAccess(discovery: ScopeDiscovery | null, preset?: ScopePreset | null): ConnectorOAuthAccess {
  const authentication = discovery?.authentication;
  const requiredScopes = unique(authentication?.requiredScopes ?? []);
  const advertised = unique([
    ...(authentication?.resourceScopesSupported ?? []),
    ...(authentication?.recommendedScopes ?? []),
    ...(authentication?.authorizationServers.flatMap((server) => server.scopesSupported ?? []) ?? []),
    ...(preset?.defaultOAuthScopes ?? []),
  ]);
  const optionalScopes = advertised.filter((scope) => !requiredScopes.includes(scope));
  // Keep provider-required challenge scopes; do not automatically select every advertised capability.
  const selectedDefault = unique([...requiredScopes, ...(preset?.defaultOAuthScopes ?? [])]);
  const conflictingScopes = authentication?.resourceScopesSupported === undefined ? []
    : requiredScopes.filter((scope) => !authentication.resourceScopesSupported?.includes(scope));
  const requiresScopeChoice = selectedDefault.length === 0 && optionalScopes.length > 0;
  const warnings = [
    "A read-only tool endpoint does not mean a read-only OAuth grant. Review the provider's consent screen before approving access.",
    "The provider can require additional scopes and refresh access. These are requested permissions, not a guarantee of the final grant.",
  ];
  if (conflictingScopes.length) warnings.push("The sign-in challenge requests permissions not listed in the resource metadata. Required permissions have not been removed; check with the server owner before continuing.");
  if (!selectedDefault.length) warnings.push("Without an explicit scope selection, the provider may request all advertised permissions or use its own defaults.");
  return { requiredScopes, optionalScopes, selectedDefault, conflictingScopes, requiresScopeChoice, warnings };
}

/** An explicit admin selection replaces recommendations, but never silently removes challenge requirements. */
export function requestedScopeSelection(discovery: ScopeDiscovery | null, selected: readonly string[]): string[] {
  return unique([...(discovery?.authentication.requiredScopes ?? []), ...selected]);
}
