import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
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
let nativeConnections: typeof import("../src/capability-sources/native-provider-connections.js")

beforeAll(async () => {
  seedRequiredEnv()
  registry = await import("../src/capability-sources/provider-registry.js")
  oauth = await import("../src/capability-sources/generic-oauth.js")
  nativeConnections = await import("../src/capability-sources/native-provider-connections.js")
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
})
