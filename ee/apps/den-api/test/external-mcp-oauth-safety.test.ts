import { describe, expect, test } from "bun:test"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  ExternalMcpOAuthProvider,
  assertExternalMcpPkceDiscovery,
  externalMcpClientTokenEndpointAuthMethod,
  externalMcpClientMetadataUrl,
  externalMcpOAuthClientRegistrationProvenance,
  externalMcpOAuthRegistrationPolicy,
  externalMcpPreRegisteredClientExtra,
  restoreExternalMcpClientInformation,
  safeExternalMcpClientInformation,
  shouldRotateExternalMcpOAuthClient,
} from "../src/capability-sources/external-mcp-client.js"
import {
  ExternalMcpOAuthAuthorizationRevokedError,
  isExternalMcpOAuthAuthorizationRevokedError,
  normalizeExternalMcpRequestedOAuthScopes,
} from "../src/capability-sources/external-mcp-connections.js"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"
import { ExternalMcpDiagnosticTracker } from "../src/capability-sources/external-mcp-diagnostics.js"

function oauthDiscoveryState(input: {
  clientIdMetadataDocument?: boolean
  tokenEndpointAuthMethods?: string[]
} = {}): OAuthDiscoveryState {
  return {
    authorizationServerUrl: "https://auth.example.test",
    authorizationServerMetadata: {
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      ...(input.clientIdMetadataDocument === undefined
        ? {}
        : { client_id_metadata_document_supported: input.clientIdMetadataDocument }),
      ...(input.tokenEndpointAuthMethods === undefined
        ? {}
        : { token_endpoint_auth_methods_supported: input.tokenEndpointAuthMethods }),
    },
  }
}

function oauthProvider(): ExternalMcpOAuthProvider {
  const connection = {
    id: "externalMcpConnection_oauth_policy",
    organizationId: "organization_oauth_policy",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: "member_oauth_policy",
    requestedOAuthScopes: null,
  } as ExternalMcpConnectionRow
  return new ExternalMcpOAuthProvider(
    connection,
    "https://api.openwork.example/v1/mcp-connections/externalMcpConnection_oauth_policy/connect/callback",
    "signed-state",
    undefined,
    new ExternalMcpDiagnosticTracker("req_oauth_policy"),
  )
}

describe("external MCP OAuth persistence safety", () => {
  test("recognizes revoked authority through diagnostic error wrappers for safe 403 mapping", () => {
    const revoked = new ExternalMcpOAuthAuthorizationRevokedError()
    expect(isExternalMcpOAuthAuthorizationRevokedError(revoked)).toBe(true)
    expect(isExternalMcpOAuthAuthorizationRevokedError(
      new Error("safe outer message", { cause: new Error("middle", { cause: revoked }) }),
    )).toBe(true)
    expect(isExternalMcpOAuthAuthorizationRevokedError(new Error("unrelated"))).toBe(false)
  })

  test("keeps registration metadata but never duplicates credentials in JSON", () => {
    const registered = {
      client_id: "registered-client",
      client_secret: "encrypted-column-only",
      registration_access_token: "never-persist-this",
      redirect_uris: ["https://den.example.test/callback"],
      token_endpoint_auth_method: "client_secret_basic",
      client_id_issued_at: 1_700_000_000,
    } as OAuthClientInformationMixed & { registration_access_token: string }

    const safe = safeExternalMcpClientInformation(registered)

    expect(safe.client_id).toBe("registered-client")
    expect(safe.redirect_uris).toEqual(["https://den.example.test/callback"])
    expect(safe.client_secret).toBeUndefined()
    expect(safe.registration_access_token).toBeUndefined()
  })

  test("restores a full SDK client using only the encrypted secret column", () => {
    const restored = restoreExternalMcpClientInformation({
      clientId: "registered-client",
      clientSecret: "decrypted-at-read-time",
      extra: {
        clientInformation: {
          client_id: "stale-client-id",
          client_secret: "stale-plaintext-secret",
          redirect_uris: ["https://den.example.test/callback"],
          token_endpoint_auth_method: "client_secret_basic",
        },
      },
    })

    expect(restored.client_id).toBe("registered-client")
    expect(restored.client_secret).toBe("decrypted-at-read-time")
    expect("redirect_uris" in restored ? restored.redirect_uris : undefined).toEqual([
      "https://den.example.test/callback",
    ])

    const minimal = restoreExternalMcpClientInformation({
      clientId: "pre-registered-client",
      clientSecret: "encrypted-secret",
      extra: {
        clientInformation: { token_endpoint_auth_method: "client_secret_post" },
      },
    })
    expect("token_endpoint_auth_method" in minimal ? minimal.token_endpoint_auth_method : undefined).toBe("client_secret_post")
  })

  test("refuses OAuth discovery before registration unless S256 PKCE is advertised", () => {
    const base = {
      authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"],
      },
    } satisfies OAuthDiscoveryState

    expect(() => assertExternalMcpPkceDiscovery(base)).toThrow("S256")
    expect(() => assertExternalMcpPkceDiscovery({
      ...base,
      authorizationServerMetadata: {
        ...base.authorizationServerMetadata,
        code_challenge_methods_supported: ["S256"],
      },
    })).not.toThrow()
  })

  test("uses a connection-scoped HTTPS Client ID Metadata Document", () => {
    expect(externalMcpClientMetadataUrl({
      connectionId: "externalMcpConnection_123",
      redirectUri: "https://api.openwork.example/v1/mcp-connections/externalMcpConnection_123/connect/callback",
    })).toBe("https://api.openwork.example/v1/mcp-connections/externalMcpConnection_123/oauth-client-metadata")
    expect(externalMcpClientMetadataUrl({
      connectionId: "externalMcpConnection_123",
      redirectUri: "https://api.openwork.example/api/den/v1/mcp-connections/externalMcpConnection_123/connect/callback",
    })).toBe("https://api.openwork.example/api/den/v1/mcp-connections/externalMcpConnection_123/oauth-client-metadata")
    expect(externalMcpClientMetadataUrl({
      connectionId: "externalMcpConnection_123",
      redirectUri: "http://127.0.0.1:8787/v1/mcp-connections/externalMcpConnection_123/connect/callback",
    })).toBeUndefined()
    expect(externalMcpClientMetadataUrl({
      connectionId: "externalMcpConnection_123",
      redirectUri: "https://api.openwork.example/api/den/unrelated/callback",
    })).toBeUndefined()
  })

  test("keeps requested OAuth fallback scopes bounded and separate from granted scopes", () => {
    expect(normalizeExternalMcpRequestedOAuthScopes([
      "read:jira-work offline_access",
      "read:jira-work",
      " ",
    ])).toEqual(["read:jira-work", "offline_access"])
    expect(normalizeExternalMcpRequestedOAuthScopes(null)).toBeNull()
    expect(() => normalizeExternalMcpRequestedOAuthScopes(["x".repeat(513)])).toThrow("at most 512")
    expect(() => normalizeExternalMcpRequestedOAuthScopes(
      Array.from({ length: 101 }, (_, index) => `scope:${index}`),
    )).toThrow("At most 100")
  })

  test("selects only token endpoint authentication methods OpenWork can actually execute", () => {
    expect(externalMcpOAuthRegistrationPolicy(oauthDiscoveryState())).toEqual({
      provenance: "dcr",
      tokenEndpointAuthMethod: "client_secret_basic",
    })
    expect(externalMcpOAuthRegistrationPolicy(oauthDiscoveryState({
      tokenEndpointAuthMethods: ["client_secret_post"],
    }))).toEqual({
      provenance: "dcr",
      tokenEndpointAuthMethod: "client_secret_post",
    })
    expect(externalMcpOAuthRegistrationPolicy(oauthDiscoveryState({
      tokenEndpointAuthMethods: ["none"],
    }))).toEqual({
      provenance: "dcr",
      tokenEndpointAuthMethod: "none",
    })
    expect(externalMcpOAuthRegistrationPolicy(oauthDiscoveryState({
      clientIdMetadataDocument: true,
      tokenEndpointAuthMethods: ["none", "client_secret_basic"],
    }))).toEqual({
      provenance: "cimd",
      tokenEndpointAuthMethod: "none",
    })
    expect(() => externalMcpOAuthRegistrationPolicy(oauthDiscoveryState({
      clientIdMetadataDocument: true,
      tokenEndpointAuthMethods: ["private_key_jwt"],
    }))).toThrow("does not advertise a supported")
  })

  test("uses confidential DCR metadata and exposes CIMD only for a public client", async () => {
    const confidential = oauthProvider()
    await confidential.saveDiscoveryState(oauthDiscoveryState({
      clientIdMetadataDocument: true,
      tokenEndpointAuthMethods: ["client_secret_post"],
    }))
    expect(confidential.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
    expect(confidential.clientMetadataUrl).toBeUndefined()

    const publicClient = oauthProvider()
    await publicClient.saveDiscoveryState(oauthDiscoveryState({
      clientIdMetadataDocument: true,
      tokenEndpointAuthMethods: ["none"],
    }))
    expect(publicClient.clientMetadata.token_endpoint_auth_method).toBe("none")
    expect(publicClient.clientMetadataUrl).toBe(
      "https://api.openwork.example/v1/mcp-connections/externalMcpConnection_oauth_policy/oauth-client-metadata",
    )

    const unsupported = oauthProvider()
    await expect(unsupported.saveDiscoveryState(oauthDiscoveryState({
      tokenEndpointAuthMethods: ["private_key_jwt"],
    }))).rejects.toThrow("does not advertise a supported")
  })

  test("validates persisted clients against discovered token authentication semantics", () => {
    expect(externalMcpClientTokenEndpointAuthMethod({
      clientInformation: { client_id: "confidential", client_secret: "secret" },
      discoveryState: oauthDiscoveryState(),
    })).toBe("client_secret_basic")
    expect(externalMcpClientTokenEndpointAuthMethod({
      clientInformation: { client_id: "confidential", client_secret: "secret" },
      discoveryState: oauthDiscoveryState({ tokenEndpointAuthMethods: ["client_secret_post"] }),
    })).toBe("client_secret_post")
    expect(externalMcpClientTokenEndpointAuthMethod({
      clientInformation: { client_id: "public" },
      discoveryState: oauthDiscoveryState({ tokenEndpointAuthMethods: ["none"] }),
    })).toBe("none")
    expect(() => externalMcpClientTokenEndpointAuthMethod({
      clientInformation: { client_id: "missing-secret" },
      discoveryState: oauthDiscoveryState(),
    })).toThrow("no client secret")
    expect(() => externalMcpClientTokenEndpointAuthMethod({
      clientInformation: {
        client_id: "unsupported",
        client_secret: "secret",
        redirect_uris: ["https://api.openwork.example/callback"],
        token_endpoint_auth_method: "private_key_jwt",
      },
      discoveryState: oauthDiscoveryState({ tokenEndpointAuthMethods: ["private_key_jwt"] }),
    })).toThrow("does not support")
  })

  test("rotates only auto-managed DCR clients after invalid_client", () => {
    const preRegistered = externalMcpOAuthClientRegistrationProvenance({
      clientId: "admin-managed",
      clientSecret: "secret",
      extra: externalMcpPreRegisteredClientExtra(),
    })
    const dcr = externalMcpOAuthClientRegistrationProvenance({
      clientId: "dynamically-registered",
      clientSecret: "secret",
      extra: { registrationProvenance: "dcr", clientInformation: { client_id: "dynamically-registered" } },
    })
    const cimd = externalMcpOAuthClientRegistrationProvenance({
      clientId: "https://api.openwork.example/client.json",
      clientSecret: null,
      extra: { registrationProvenance: "cimd", clientInformation: { client_id: "https://api.openwork.example/client.json" } },
    })

    expect(preRegistered).toBe("pre_registered")
    expect(dcr).toBe("dcr")
    expect(cimd).toBe("cimd")
    expect(shouldRotateExternalMcpOAuthClient(preRegistered)).toBe(false)
    expect(shouldRotateExternalMcpOAuthClient(dcr)).toBe(true)
    expect(shouldRotateExternalMcpOAuthClient(cimd)).toBe(false)
  })
})
