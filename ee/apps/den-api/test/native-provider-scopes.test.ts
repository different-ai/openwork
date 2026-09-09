import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"

import type { OrgOAuthClientRow } from "../src/capability-sources/oauth-credentials.js"

const GOOGLE_WORKSPACE_IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]

const GOOGLE_WORKSPACE_LEGACY_BASE_SCOPES = [
  ...GOOGLE_WORKSPACE_IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let registry: typeof import("../src/capability-sources/provider-registry.js")
let oauth: typeof import("../src/capability-sources/generic-oauth.js")

beforeAll(async () => {
  seedRequiredEnv()
  registry = await import("../src/capability-sources/provider-registry.js")
  oauth = await import("../src/capability-sources/generic-oauth.js")
})

function googleWorkspaceProvider() {
  const provider = registry.getNativeOAuthProvider("google-workspace")
  if (!provider) {
    throw new Error("google-workspace provider is missing")
  }
  return provider
}

describe("google-workspace native provider scopes", () => {
  test("defaultScopes is only the identity trio", () => {
    expect(googleWorkspaceProvider().defaultScopes).toEqual(GOOGLE_WORKSPACE_IDENTITY_SCOPES)
  })

  test("missing features keeps legacy rows on the old desktop base behavior", () => {
    const provider = googleWorkspaceProvider()
    const features = registry.clientSelectedFeatures(provider, {})
    const scopes = registry.resolveProviderScopes(provider, features)

    // Legacy rows without a features key preserve the old base-6 scope behavior.
    expect(registry.clientSelectedFeatures(provider, null)).toEqual(["calendarRead", "gmailDraft", "driveFile"])
    expect(features).toEqual(["calendarRead", "gmailDraft", "driveFile"])
    expect(scopes).toEqual(GOOGLE_WORKSPACE_LEGACY_BASE_SCOPES)
  })

  test("features empty array means identity-only", () => {
    const provider = googleWorkspaceProvider()
    const features = registry.clientSelectedFeatures(provider, { features: [] })
    const scopes = registry.resolveProviderScopes(provider, features)

    expect(features).toEqual([])
    expect(scopes).toEqual(GOOGLE_WORKSPACE_IDENTITY_SCOPES)
  })

  test("selected features are the complete capability set", () => {
    const provider = googleWorkspaceProvider()
    const features = registry.clientSelectedFeatures(provider, {
      features: ["calendarRead", "calendarWrite", "gmailDraft", "gmailRead"],
    })
    const scopes = registry.resolveProviderScopes(provider, features)

    expect(scopes).toEqual([
      ...GOOGLE_WORKSPACE_IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
    ])
  })

  test.each([
    ["gmailManage", "gmail.modify"],
    ["gmailLabels", "gmail.labels"],
    ["sheetsRead", "spreadsheets.readonly"],
    ["sheetsWrite", "spreadsheets"],
  ])("%s requests only its selected scope beyond identity", (feature, scope) => {
    const provider = googleWorkspaceProvider()
    const features = registry.clientSelectedFeatures(provider, { features: [feature, feature] })
    expect(features).toEqual([feature])
    expect(registry.resolveProviderScopes(provider, features)).toEqual([
      ...GOOGLE_WORKSPACE_IDENTITY_SCOPES,
      `https://www.googleapis.com/auth/${scope}`,
    ])
  })

  test("Google scope implications accept broader grants without escalating narrower ones", () => {
    const provider = googleWorkspaceProvider()
    const scope = (name: string) => `https://www.googleapis.com/auth/${name}`
    for (const required of ["gmail.readonly", "gmail.compose", "gmail.labels"]) {
      expect(registry.providerScopesSatisfy(provider, [scope("gmail.modify")], scope(required))).toBe(true)
      expect(registry.providerScopesSatisfy(provider, [scope(required)], scope("gmail.modify"))).toBe(false)
    }
    expect(registry.providerScopesSatisfy(provider, [scope("spreadsheets")], scope("spreadsheets.readonly"))).toBe(true)
    expect(registry.providerScopesSatisfy(provider, [scope("spreadsheets.readonly")], scope("spreadsheets"))).toBe(false)
    for (const required of ["drive.readonly", "drive.file", "spreadsheets", "spreadsheets.readonly"]) {
      expect(registry.providerScopesSatisfy(provider, [scope("drive")], scope(required))).toBe(true)
    }
    expect(registry.providerScopesSatisfy(provider, [scope("gmail.modify.lookalike")], scope("gmail.readonly"))).toBe(false)
    expect(registry.providerScopesSatisfy(provider, [scope("spreadsheets.lookalike")], scope("spreadsheets.readonly"))).toBe(false)
  })

  test("unknown grants do not satisfy the new feature scopes", () => {
    const provider = googleWorkspaceProvider()
    const grants: (string[] | null)[] = [null, [], GOOGLE_WORKSPACE_IDENTITY_SCOPES]
    for (const granted of grants) {
      for (const scope of ["gmail.modify", "gmail.labels", "spreadsheets.readonly", "spreadsheets"]) {
        expect(registry.providerScopesSatisfy(provider, granted, `https://www.googleapis.com/auth/${scope}`)).toBe(false)
      }
    }
  })

  test("clientSelectedFeatures ignores unknown keys and non-strings", () => {
    const provider = googleWorkspaceProvider()

    expect(registry.clientSelectedFeatures(provider, {
      features: ["calendarRead", "unknown", 42, "gmailRead", null],
    })).toEqual(["calendarRead", "gmailRead"])
  })

  test("buildAuthorizeUrl includes identity plus the complete selected feature scopes", () => {
    const client: OrgOAuthClientRow = {
      id: createDenTypeId("orgOAuthClient"),
      organizationId: createDenTypeId("organization"),
      providerId: "google-workspace",
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      extra: { features: ["calendarRead", "gmailDraft", "driveFile", "gmailRead", "calendarWrite"] },
      createdByOrgMembershipId: createDenTypeId("member"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }

    const authorizeUrl = oauth.buildAuthorizeUrl({
      provider: googleWorkspaceProvider(),
      client,
      state: "state-token",
      redirectUri: "http://127.0.0.1:8790/v1/oauth-providers/google-workspace/connect/callback",
      codeChallenge: "pkce-challenge",
    })
    const authorizeParams = new URL(authorizeUrl).searchParams
    const scopes = authorizeParams.get("scope")?.split(" ") ?? []

    expect(scopes).toEqual([
      ...GOOGLE_WORKSPACE_IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ])
    expect(scopes).toHaveLength(8)
    expect(authorizeParams.get("prompt")).toBe("consent select_account")
  })
})
