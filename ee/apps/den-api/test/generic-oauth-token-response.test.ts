import { beforeAll, describe, expect, test } from "bun:test"

let oauth: typeof import("../src/capability-sources/generic-oauth.js")

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  oauth = await import("../src/capability-sources/generic-oauth.js")
})

describe("OAuth token response validation", () => {
  test("accepts the standard authorization and refresh response fields", () => {
    expect(oauth.parseOAuthTokenResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3_600,
      token_type: "Bearer",
      scope: "openid Mail.Read",
      ignored_provider_extension: true,
    })).toEqual({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3_600,
      token_type: "Bearer",
      scope: "openid Mail.Read",
    })
  })

  test("rejects missing, blank, or incorrectly typed access tokens", () => {
    for (const response of [{}, { access_token: "" }, { access_token: 123 }]) {
      expect(() => oauth.parseOAuthTokenResponse(response)).toThrow(oauth.OAuthTokenExchangeError)
    }
  })

  test("classifies Microsoft's invalid secret response without exposing the provider body", () => {
    const error = oauth.oauthTokenExchangeErrorFromResponse({
      provider: {
        providerId: "microsoft-365",
        displayName: "Microsoft 365",
        authorizeUrl: "https://login.microsoftonline.test/authorize",
        tokenUrl: "https://login.microsoftonline.test/token",
        websiteUrl: "https://microsoft.test",
        defaultScopes: ["openid"],
        usesPkce: true,
      },
      status: 401,
      body: {
        error: "invalid_client",
        error_description: "AADSTS7000215: invalid client secret value client_secret=must-not-escape",
        error_codes: [7_000_215],
        trace_id: "00000000-0000-4000-8000-000000000001",
        correlation_id: "00000000-0000-4000-8000-000000000002",
        timestamp: "2030-01-02 03:04:05Z",
      },
    })

    expect(error.code).toBe("oauth_invalid_client_secret")
    expect(error.phase).toBe("AUTH_TOKEN_ACQUISITION")
    expect(error.details).toEqual({
      httpStatus: 401,
      providerOAuthError: "invalid_client",
      providerErrorCode: 7_000_215,
      providerTraceId: "00000000-0000-4000-8000-000000000001",
      providerCorrelationId: "00000000-0000-4000-8000-000000000002",
      providerTimestamp: "2030-01-02 03:04:05Z",
    })
    expect(error.message).toContain("AADSTS7000215")
    expect(error.message).toContain("replace the client secret value")
    expect(error.message).not.toContain("must-not-escape")
    expect(JSON.stringify(error.details)).not.toContain("must-not-escape")
  })

  test("classifies a ServiceNow-style invalid client without claiming unverified provider wording", () => {
    const error = oauth.oauthTokenExchangeErrorFromResponse({
      provider: {
        providerId: "servicenow-development",
        displayName: "ServiceNow",
        authorizeUrl: "https://servicenow.test/oauth_auth.do",
        tokenUrl: "https://servicenow.test/oauth_token.do",
        websiteUrl: "https://servicenow.test",
        defaultScopes: ["mcp_server"],
        usesPkce: true,
      },
      status: 401,
      body: {
        error: "invalid_client",
        error_description: "client_secret=must-not-escape",
      },
    })

    expect(error.code).toBe("oauth_invalid_client")
    expect(error.details).toEqual({
      httpStatus: 401,
      providerOAuthError: "invalid_client",
    })
    expect(error.message).toContain("ServiceNow rejected the OAuth client credentials")
    expect(error.message).toContain("verify the client ID and client secret value")
    expect(error.message).not.toContain("must-not-escape")
  })

  test("redacts unknown and malformed provider errors", () => {
    const provider = {
      providerId: "unknown-provider",
      displayName: "Unknown Provider",
      authorizeUrl: "https://provider.test/authorize",
      tokenUrl: "https://provider.test/token",
      websiteUrl: "https://provider.test",
      defaultScopes: ["openid"],
      usesPkce: true,
    }

    for (const body of [
      { error: "custom_secret_failure", error_description: "access_token=must-not-escape" },
      "client_secret=must-not-escape",
    ]) {
      const error = oauth.oauthTokenExchangeErrorFromResponse({ provider, status: 400, body })
      expect(error.code).toBe("oauth_token_exchange_failed")
      expect(error.message).not.toContain("must-not-escape")
      expect(JSON.stringify(error.details)).not.toContain("must-not-escape")
    }
  })
})
