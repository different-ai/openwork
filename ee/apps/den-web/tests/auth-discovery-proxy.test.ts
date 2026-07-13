import { describe, expect, test } from "bun:test";
import { AUTH_DISCOVERY_PROXY_OPTIONS } from "../app/.well-known/_lib/auth-discovery-proxy-options";
import * as oauthAuthorizationServerRoute from "../app/.well-known/oauth-authorization-server/api/auth/route";
import * as openidConfigurationRoute from "../app/.well-known/openid-configuration/api/auth/route";

describe("authorization-server discovery aliases", () => {
  test("proxy the MCP priority URLs to Den API without rewriting metadata", () => {
    expect(AUTH_DISCOVERY_PROXY_OPTIONS.oauthAuthorizationServer).toEqual({
      routePrefix: "/.well-known/oauth-authorization-server/api/auth",
      upstreamPathPrefix: ".well-known/oauth-authorization-server/api/auth",
    });
    expect(AUTH_DISCOVERY_PROXY_OPTIONS.openidConfiguration).toEqual({
      routePrefix: "/.well-known/openid-configuration/api/auth",
      upstreamPathPrefix: ".well-known/openid-configuration/api/auth",
    });
  });

  test("route aliases expose GET only", () => {
    expect(typeof oauthAuthorizationServerRoute.GET).toBe("function");
    expect("HEAD" in oauthAuthorizationServerRoute).toBe(false);
    expect("POST" in oauthAuthorizationServerRoute).toBe(false);
    expect("PUT" in oauthAuthorizationServerRoute).toBe(false);
    expect("PATCH" in oauthAuthorizationServerRoute).toBe(false);
    expect("DELETE" in oauthAuthorizationServerRoute).toBe(false);
    expect("OPTIONS" in oauthAuthorizationServerRoute).toBe(false);

    expect(typeof openidConfigurationRoute.GET).toBe("function");
    expect("HEAD" in openidConfigurationRoute).toBe(false);
    expect("POST" in openidConfigurationRoute).toBe(false);
    expect("PUT" in openidConfigurationRoute).toBe(false);
    expect("PATCH" in openidConfigurationRoute).toBe(false);
    expect("DELETE" in openidConfigurationRoute).toBe(false);
    expect("OPTIONS" in openidConfigurationRoute).toBe(false);
  });
});
