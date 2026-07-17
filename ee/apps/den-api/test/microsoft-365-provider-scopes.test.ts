import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { OrgOAuthClientRow } from "../src/capability-sources/oauth-credentials.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let registry: typeof import("../src/capability-sources/provider-registry.js")
let oauth: typeof import("../src/capability-sources/generic-oauth.js")
const originalFetch = globalThis.fetch
let nativeConnections: typeof import("../src/capability-sources/native-provider-connections.js")

beforeAll(async () => {
  seedRequiredEnv()
  registry = await import("../src/capability-sources/provider-registry.js")
  oauth = await import("../src/capability-sources/generic-oauth.js")
  nativeConnections = await import("../src/capability-sources/native-provider-connections.js")
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function microsoft365Provider() {
  const provider = registry.getNativeOAuthProvider("microsoft-365")
  if (!provider) throw new Error("microsoft-365 provider is missing")
  return provider
}

describe("Microsoft 365 native provider", () => {
  test("defaults to delegated, organizational, read-only scopes", () => {
    const provider = microsoft365Provider()
    const features = registry.clientSelectedFeatures(provider, null)
    expect(features).toEqual(["mailRead", "calendarRead", "filesRead"])
    expect(registry.resolveProviderScopes(provider, features)).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.Read",
      "Calendars.Read",
      "Files.Read",
    ])
    expect(provider.authorizeUrl).toContain("/{tenantId}/oauth2/v2.0/authorize")
    expect(provider.tokenUrl).toContain("/{tenantId}/oauth2/v2.0/token")
  })

  test("supports identity-only and individually selected read features", () => {
    const provider = microsoft365Provider()
    expect(registry.resolveProviderScopes(provider, registry.clientSelectedFeatures(provider, { features: [] }))).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
    ])
    expect(registry.resolveProviderScopes(provider, registry.clientSelectedFeatures(provider, { features: ["filesRead"] }))).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Files.Read",
    ])
  })

  test("maps every permission-parity feature to its delegated Graph scopes", () => {
    const provider = microsoft365Provider()
    const features = [
      "calendarRead",
      "calendarWrite",
      "mailDraft",
      "mailRead",
      "filesRead",
      "filesWrite",
      "filesReadAll",
      "filesFull",
      "teamsChatRead",
      "teamsChatSend",
    ]
    expect(registry.clientSelectedFeatures(provider, { features })).toEqual(features)
    expect(registry.resolveProviderScopes(provider, features)).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Calendars.Read",
      "Calendars.ReadWrite",
      "Mail.ReadWrite",
      "Mail.Read",
      "Files.Read",
      "Files.ReadWrite",
      "Files.Read.All",
      "Files.ReadWrite.All",
      "Chat.Read",
      "ChatMessage.Send",
    ])
  })

  test("recognizes stronger Microsoft scopes and avoids false reconnect warnings", () => {
    const provider = microsoft365Provider()
    expect(registry.providerScopesSatisfy(provider, ["mail.readwrite"], "Mail.Read")).toBe(true)
    expect(registry.providerScopesSatisfy(provider, ["Calendars.ReadWrite"], "Calendars.Read")).toBe(true)
    expect(registry.providerScopesSatisfy(provider, ["Files.ReadWrite.All"], "Files.Read.All")).toBe(true)
    expect(registry.providerScopesSatisfy(provider, ["Chat.ReadWrite"], "ChatMessage.Send")).toBe(true)
    expect(registry.providerScopesSatisfy(provider, ["Mail.Read"], "Mail.ReadWrite")).toBe(false)

    expect(nativeConnections.resolveNativeProviderReconnectState(
      provider,
      { features: ["mailRead", "calendarRead", "filesReadAll"] },
      [...provider.defaultScopes, "Mail.ReadWrite", "Calendars.ReadWrite", "Files.ReadWrite.All"],
    )).toEqual({ needsReconnect: false, missingFeatures: [] })
    expect(nativeConnections.resolveNativeProviderReconnectState(
      provider,
      { features: ["mailDraft", "teamsChatSend"] },
      [...provider.defaultScopes, "Mail.Read", "Chat.Read"],
    )).toEqual({ needsReconnect: true, missingFeatures: ["mailDraft", "teamsChatSend"] })
  })

  test("buildAuthorizeUrl requests PKCE and the configured feature scopes", () => {
    const client: OrgOAuthClientRow = {
      id: createDenTypeId("orgOAuthClient"),
      organizationId: createDenTypeId("organization"),
      providerId: "microsoft-365",
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      extra: {
        features: ["mailRead", "calendarRead"],
        tenantId: "12345678-1234-1234-1234-123456789abc",
      },
      createdByOrgMembershipId: createDenTypeId("member"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }
    const authorizeUrl = new URL(oauth.buildAuthorizeUrl({
      provider: microsoft365Provider(),
      client,
      state: "state-token",
      redirectUri: "https://cloud.openwork.so/v1/oauth-providers/microsoft-365/connect/callback",
      codeChallenge: "pkce-challenge",
    }))

    expect(authorizeUrl.searchParams.get("code_challenge")).toBe("pkce-challenge")
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizeUrl.pathname).toBe("/12345678-1234-1234-1234-123456789abc/oauth2/v2.0/authorize")
    expect(authorizeUrl.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.Read",
      "Calendars.Read",
    ])
  })

  test("refuses to build an unscoped Microsoft authority", () => {
    const client: OrgOAuthClientRow = {
      id: createDenTypeId("orgOAuthClient"),
      organizationId: createDenTypeId("organization"),
      providerId: "microsoft-365",
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      extra: { features: ["mailRead"] },
      createdByOrgMembershipId: createDenTypeId("member"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }

    expect(() => oauth.buildAuthorizeUrl({
      provider: microsoft365Provider(),
      client,
      state: "state-token",
      redirectUri: "https://cloud.openwork.so/v1/oauth-providers/microsoft-365/connect/callback",
      codeChallenge: "pkce-challenge",
    })).toThrow("requires a valid tenant ID")
  })

  test("preserves Microsoft's safe invalid-secret evidence through the real token request", async () => {
    const client: OrgOAuthClientRow = {
      id: createDenTypeId("orgOAuthClient"),
      organizationId: createDenTypeId("organization"),
      providerId: "microsoft-365",
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret-value",
      extra: { tenantId: "12345678-1234-1234-1234-123456789abc" },
      createdByOrgMembershipId: createDenTypeId("member"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }
    let postedBody = ""
    globalThis.fetch = async (_request, init) => {
      if (init?.body instanceof URLSearchParams) postedBody = init.body.toString()
      return new Response(JSON.stringify({
        error: "invalid_client",
        error_description: "AADSTS7000215: client_secret=microsoft-client-secret-value",
        error_codes: [7_000_215],
        trace_id: "00000000-0000-4000-8000-000000000001",
        correlation_id: "00000000-0000-4000-8000-000000000002",
        timestamp: "2030-01-02 03:04:05Z",
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }

    try {
      await oauth.exchangeCodeForTokens({
        provider: microsoft365Provider(),
        client,
        code: "authorization-code",
        redirectUri: "http://localhost:31585/v1/oauth-providers/microsoft-365/connect/callback",
        codeVerifier: "pkce-verifier",
      })
      throw new Error("Expected token exchange to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(oauth.OAuthTokenExchangeError)
      if (!(error instanceof oauth.OAuthTokenExchangeError)) throw error
      expect(error.code).toBe("oauth_invalid_client_secret")
      expect(error.details.providerTraceId).toBe("00000000-0000-4000-8000-000000000001")
      expect(error.message).toContain("AADSTS7000215")
      expect(error.message).not.toContain("microsoft-client-secret-value")
    }

    const posted = new URLSearchParams(postedBody)
    expect(posted.get("client_secret")).toBe("microsoft-client-secret-value")
    expect(posted.get("code_verifier")).toBe("pkce-verifier")
    expect(posted.get("redirect_uri")).toBe("http://localhost:31585/v1/oauth-providers/microsoft-365/connect/callback")
  })
})
