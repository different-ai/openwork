export type AuthDiscoveryAlias = "oauthAuthorizationServer" | "openidConfiguration";

export type AuthDiscoveryProxyOptions = {
  routePrefix: string;
  upstreamPathPrefix: string;
};

export const AUTH_DISCOVERY_PROXY_OPTIONS: Record<AuthDiscoveryAlias, AuthDiscoveryProxyOptions> = {
  oauthAuthorizationServer: {
    routePrefix: "/.well-known/oauth-authorization-server/api/auth",
    upstreamPathPrefix: ".well-known/oauth-authorization-server/api/auth",
  },
  openidConfiguration: {
    routePrefix: "/.well-known/openid-configuration/api/auth",
    upstreamPathPrefix: ".well-known/openid-configuration/api/auth",
  },
};
