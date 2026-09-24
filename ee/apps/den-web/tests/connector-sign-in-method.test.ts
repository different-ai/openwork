import { describe, expect, test } from "bun:test";
import {
  connectorSignInMethod,
  oauthClientSecretRequired,
  oauthRequestFields,
} from "../app/(den)/dashboard/_components/connector-sign-in-method";
import type { McpRequirementsDiscovery } from "../app/(den)/dashboard/_components/mcp-connections-data";

type Authentication = McpRequirementsDiscovery["authentication"];

function discovery(overrides: Partial<Authentication>): Pick<McpRequirementsDiscovery, "authentication"> {
  return {
    authentication: {
      kind: "oauth",
      authorizationServers: [],
      requiredScopes: [],
      recommendedScopes: [],
      refreshSupport: "unknown",
      availableRegistrationMethods: [],
      recommendedRegistrationMethod: "dynamic",
      ...overrides,
    },
  };
}

const server = (issuer: string, tokenEndpointAuthMethodsSupported?: string[]) => ({
  issuer,
  clientIdMetadataDocumentSupported: false,
  ...(tokenEndpointAuthMethodsSupported ? { tokenEndpointAuthMethodsSupported } : {}),
});

describe("step two: how people sign in", () => {
  test("OAuth that registers itself signs people in", () => {
    expect(connectorSignInMethod(discovery({ availableRegistrationMethods: ["dynamic"] }))).toBe("sign_in");
    expect(connectorSignInMethod(discovery({ availableRegistrationMethods: ["client_metadata", "pre_registered"] }))).toBe("sign_in");
  });

  test("OAuth that only takes a pre-registered app asks for its client ID first", () => {
    expect(connectorSignInMethod(discovery({ availableRegistrationMethods: ["pre_registered"], recommendedRegistrationMethod: "pre_registered" }))).toBe("oauth_app");
    expect(connectorSignInMethod(discovery({ availableRegistrationMethods: [] }))).toBe("oauth_app");
  });

  test("a preset with OpenWork's public OAuth app goes straight to sign-in", () => {
    expect(connectorSignInMethod(discovery({ availableRegistrationMethods: ["pre_registered"] }), { authType: "oauth", defaultOAuthClientId: "openwork" })).toBe("sign_in");
    expect(connectorSignInMethod(discovery({ kind: "manual_bearer" }), { authType: "apikey", defaultOAuthClientId: "openwork" })).toBe("api_key");
  });

  test("a preset that requires an OAuth app asks for it even when the server registers clients itself", () => {
    expect(connectorSignInMethod(discovery({ availableRegistrationMethods: ["dynamic"] }), { authType: "oauth", requiresOAuthClient: true })).toBe("oauth_app");
  });

  test("a server that takes a bearer token, or an API-key preset, asks for a key", () => {
    expect(connectorSignInMethod(discovery({ kind: "manual_bearer" }))).toBe("api_key");
    expect(connectorSignInMethod(discovery({ kind: "oauth", availableRegistrationMethods: ["dynamic"] }), { authType: "apikey" })).toBe("api_key");
  });

  test("no sign-in, and unknown servers", () => {
    expect(connectorSignInMethod(discovery({ kind: "none" }))).toBe("none");
    expect(connectorSignInMethod(discovery({ kind: "unknown" }))).toBe("unsupported");
    expect(connectorSignInMethod(discovery({ kind: "unknown" }), { authType: "oauth" })).toBe("sign_in");
    expect(connectorSignInMethod(discovery({ kind: "oauth", availableRegistrationMethods: ["dynamic"] }), { authType: "none" })).toBe("none");
  });

  test("tolerates a discovery answer without registration methods", () => {
    // Den can answer with only the fields it knows; parse one like the browser does.
    const partial: Pick<McpRequirementsDiscovery, "authentication"> = JSON.parse('{"authentication":{"kind":"oauth"}}');
    expect(connectorSignInMethod(partial)).toBe("oauth_app");
    expect(oauthRequestFields(partial)).toEqual({ requestedScopes: [] });
    expect(oauthClientSecretRequired(partial)).toBe(false);
  });
});

describe("OAuth app fields", () => {
  test("the client secret is optional unless every token endpoint refuses public clients", () => {
    expect(oauthClientSecretRequired(null)).toBe(false);
    expect(oauthClientSecretRequired(discovery({ authorizationServers: [server("https://a.test")] }))).toBe(false);
    expect(oauthClientSecretRequired(discovery({ authorizationServers: [server("https://a.test", ["none", "client_secret_post"])] }))).toBe(false);
    expect(oauthClientSecretRequired(discovery({ authorizationServers: [server("https://a.test", ["client_secret_basic"])] }))).toBe(true);
  });

  test("saves the single issuer and required plus recommended scopes, as the full editor did", () => {
    expect(oauthRequestFields(discovery({
      authorizationServers: [server("https://auth.example.test")],
      requiredScopes: ["read"],
      recommendedScopes: ["read", "write"],
    }))).toEqual({ authorizationServerIssuer: "https://auth.example.test", requestedScopes: ["read", "write"] });
    expect(oauthRequestFields(discovery({ authorizationServers: [server("https://a.test"), server("https://b.test")] })))
      .toEqual({ requestedScopes: [] });
  });
});
