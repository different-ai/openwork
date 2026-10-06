import { describe, expect, test } from "vitest"
import {
  AUTH_TRANSITION_POLICY,
  LEGACY_V1_AUTH_MODULES,
  LEGACY_V1_CAPABILITY_MODULES,
  LICENSE_CACHE_TTL_SECONDS,
  LICENSE_CHECK_PATH,
  LICENSE_TRANSITION_MS,
  LICENSE_VERIFICATION_GRACE_MS,
  licenseCheckRequestSchema,
  licenseCheckRequestSchemaAny,
  licenseCheckRequestSchemaV1,
  licenseCheckRequestSchemaV2,
  licenseCheckResponseSchema,
  licenseCheckResponseSchemaAny,
  licenseCheckResponseSchemaV1,
  licenseCheckResponseSchemaV2,
  normalizeLicenseCheckResponse,
  projectLicenseResponseToV1,
  upgradeLicenseCheckResponseToV2,
  type LicenseCheckResponseV1,
} from "./license"
import { isModuleId } from "./module-ids"

/** The private license server README examples. */
const v1Active = {
  schemaVersion: 1,
  licenseId: "lic_123",
  status: "active",
  modules: { auth: true },
  featureFlags: { beta: true },
  maxUsers: 25,
  expiresAt: null,
  invalidatedAt: null,
  checkedAt: "2026-09-07T12:00:00.000Z",
  cacheTtlSeconds: 300,
} as const
const v1Expired = { ...v1Active, status: "expired", expiresAt: "2026-09-01T00:00:00.000Z" } as const
const v1Suspended = { ...v1Active, status: "suspended", invalidatedAt: "2026-09-02T00:00:00.000Z" } as const

const v1Request = { schemaVersion: 1, baseUrl: "https://den.example.com", organizationId: "optional-org-id", currentUsers: 5 } as const
const v2Request = { ...v1Request, schemaVersion: 2, instanceId: "den-api-7f9c:1", version: "0.18.3" } as const

const v2Active = {
  schemaVersion: 2,
  licenseId: "lic_123",
  kind: "standard",
  status: "active",
  modules: { "org.auth.sso": true, "org.auth.scim": false, "org.members.teams": true, "future.module": true },
  featureFlags: { beta: true },
  maxUsers: 25,
  expiresAt: null,
  invalidatedAt: null,
  checkedAt: "2026-09-07T12:00:00.000Z",
  cacheTtlSeconds: 300,
} as const

describe("v1 (frozen)", () => {
  test("constants keep their v1 values", () => {
    expect(LICENSE_CHECK_PATH).toBe("/v1/licenses/check")
    expect(LICENSE_CACHE_TTL_SECONDS).toBe(300)
    expect(LICENSE_VERIFICATION_GRACE_MS).toBe(24 * 60 * 60 * 1000)
    expect(LICENSE_TRANSITION_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(AUTH_TRANSITION_POLICY).toEqual({ ssoSignIn: "verified_owner_or_superadmin", scim: "continue", other: "deny" })
    expect(licenseCheckRequestSchemaV1).toBe(licenseCheckRequestSchema)
    expect(licenseCheckResponseSchemaV1).toBe(licenseCheckResponseSchema)
  })

  test("the README examples parse", () => {
    for (const fixture of [v1Active, v1Expired, v1Suspended]) expect(licenseCheckResponseSchema.parse(fixture)).toEqual(fixture)
    expect(licenseCheckRequestSchema.parse(v1Request)).toEqual(v1Request)
  })

  test("requests are strict", () => {
    for (const body of [
      { ...v1Request, schemaVersion: 2 },
      { ...v1Request, currentUsers: -1 },
      { ...v1Request, currentUsers: 1.5 },
      { ...v1Request, baseUrl: "not-url" },
      { ...v1Request, modules: { auth: true } },
    ]) expect(licenseCheckRequestSchema.safeParse(body).success).toBe(false)
  })

  test("responses are strict and keep their invariants", () => {
    expect(licenseCheckResponseSchema.safeParse({ ...v1Active, kind: "standard" }).success).toBe(false)
    expect(licenseCheckResponseSchema.safeParse({ ...v1Active, modules: { auth: true, teams: true } }).success).toBe(false)
    expect(licenseCheckResponseSchema.safeParse({ ...v1Active, status: "trial" }).success).toBe(false)
    expect(licenseCheckResponseSchema.safeParse({ ...v1Active, status: "expired" }).success).toBe(false)
    expect(licenseCheckResponseSchema.safeParse({ ...v1Active, status: "revoked" }).success).toBe(false)
  })
})

describe("v2", () => {
  test("requests need instanceId and version and stay strict", () => {
    expect(licenseCheckRequestSchemaV2.parse(v2Request)).toEqual(v2Request)
    expect(licenseCheckRequestSchemaV2.safeParse({ ...v2Request, instanceId: undefined }).success).toBe(false)
    expect(licenseCheckRequestSchemaV2.safeParse({ ...v2Request, version: "latest" }).success).toBe(false)
    expect(licenseCheckRequestSchemaV2.safeParse({ ...v2Request, instanceId: "has space" }).success).toBe(false)
    expect(licenseCheckRequestSchemaV2.safeParse({ ...v2Request, extra: true }).success).toBe(false)
  })

  test("the request union dispatches on schemaVersion", () => {
    expect(licenseCheckRequestSchemaAny.parse(v1Request).schemaVersion).toBe(1)
    expect(licenseCheckRequestSchemaAny.parse(v2Request).schemaVersion).toBe(2)
    expect(licenseCheckRequestSchemaAny.safeParse({ ...v2Request, schemaVersion: 3 }).success).toBe(false)
  })

  test("responses tolerate unknown module keys and strip unknown fields, including userFlags", () => {
    const parsed = licenseCheckResponseSchemaV2.parse({ ...v2Active, userFlags: { alice: true }, plan: "team" })
    expect(parsed).toEqual(v2Active)
    expect("userFlags" in parsed).toBe(false)
  })

  test("invariants: trials need expiresAt, invalid licenses need invalidatedAt", () => {
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, kind: "trial" }).success).toBe(false)
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, kind: "trial", expiresAt: "2026-09-12T12:00:00.000Z" }).success).toBe(true)
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, status: "suspended" }).success).toBe(false)
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, status: "trial" }).success).toBe(false)
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, kind: undefined }).success).toBe(false)
  })

  test("module and flag keys are validated", () => {
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, modules: { "Bad Key": true } }).success).toBe(false)
    expect(licenseCheckResponseSchemaV2.safeParse({ ...v2Active, featureFlags: { "bad flag!": true } }).success).toBe(false)
  })

  test("the response union accepts both versions", () => {
    expect(licenseCheckResponseSchemaAny.parse(v1Active).schemaVersion).toBe(1)
    expect(licenseCheckResponseSchemaAny.parse(v2Active).schemaVersion).toBe(2)
  })
})

describe("normalize, upgrade and project", () => {
  test("v1 auth grants org.auth.sso and org.auth.scim (org.auth is a group)", () => {
    expect([...LEGACY_V1_AUTH_MODULES]).toEqual(["org.auth.sso", "org.auth.scim"])
    const entitlement = normalizeLicenseCheckResponse(licenseCheckResponseSchemaV1.parse(v1Active))
    expect(entitlement.modules).toEqual({ "org.auth.sso": true, "org.auth.scim": true })
    expect(entitlement).toMatchObject({ wireVersion: 1, kind: "standard", isTrial: false, status: "active", featureFlags: { beta: true } })
  })

  test("v1 legacy capability flags move into modules; remoteMcpApps is dropped", () => {
    const upgraded = upgradeLicenseCheckResponseToV2({
      ...v1Active,
      modules: { auth: false },
      featureFlags: { beta: true, installLinks: false, mcpConnections: true, workflows: true, cloud: false, remoteMcpApps: true },
    })
    expect(upgraded.modules).toEqual({
      "org.auth.sso": false,
      "org.auth.scim": false,
      "org.installLinks": false,
      "library.connectors": true,
      "library.workflows": true,
      openworkWeb: false,
    })
    expect(upgraded.featureFlags).toEqual({ beta: true })
    expect(licenseCheckResponseSchemaV2.safeParse(upgraded).success).toBe(true)
  })

  test("project(upgrade(v1)) round-trips with legacy flags present", () => {
    for (const auth of [true, false]) {
      const v1: LicenseCheckResponseV1 = {
        ...v1Expired,
        modules: { auth },
        featureFlags: { beta: false, installLinks: true, mcpConnections: false, workflows: true, cloud: true, remoteMcpApps: false },
      }
      const projected = projectLicenseResponseToV1(upgradeLicenseCheckResponseToV2(v1))
      expect(projected).toEqual(v1)
      expect(licenseCheckResponseSchemaV1.safeParse(projected).success).toBe(true)
    }
  })

  test("projection is least privilege for auth and drops kind", () => {
    const projected = projectLicenseResponseToV1(licenseCheckResponseSchemaV2.parse(v2Active))
    expect(projected.modules).toEqual({ auth: false })
    expect(projected.featureFlags).toEqual({ beta: true, installLinks: true, mcpConnections: false, workflows: false, cloud: false, remoteMcpApps: false })
    expect(licenseCheckResponseSchemaV1.safeParse(projected).success).toBe(true)
  })

  test("v2 keeps known ids only and reads the trial kind", () => {
    const entitlement = normalizeLicenseCheckResponse(licenseCheckResponseSchemaV2.parse({ ...v2Active, kind: "trial", expiresAt: "2026-09-12T12:00:00.000Z" }))
    expect(entitlement.modules).toEqual({ "org.auth.sso": true, "org.auth.scim": false, "org.members.teams": true })
    expect(entitlement).toMatchObject({ wireVersion: 2, kind: "trial", isTrial: true })
  })

  test("a v2 answer still carrying v1 auth fills unset org.auth modules", () => {
    const entitlement = normalizeLicenseCheckResponse(licenseCheckResponseSchemaV2.parse({ ...v2Active, modules: { auth: true, "org.auth.scim": false } }))
    expect(entitlement.modules).toEqual({ "org.auth.sso": true, "org.auth.scim": false })
  })

  test("projection grants v1 auth only when both org.auth modules are granted", () => {
    const both = licenseCheckResponseSchemaV2.parse({ ...v2Active, modules: { "org.auth.sso": true, "org.auth.scim": true } })
    expect(projectLicenseResponseToV1(both).modules).toEqual({ auth: true })
    const groupOnly = licenseCheckResponseSchemaV2.parse({ ...v2Active, modules: { "org.auth": true } })
    expect(projectLicenseResponseToV1(groupOnly).modules).toEqual({ auth: false })
    expect(normalizeLicenseCheckResponse(groupOnly).modules).toEqual({})
  })

  test("legacy capability targets are module ids", () => {
    for (const target of Object.values(LEGACY_V1_CAPABILITY_MODULES)) {
      if (target !== null) expect(isModuleId(target)).toBe(true)
    }
    expect(Object.keys(LEGACY_V1_CAPABILITY_MODULES).sort()).toEqual(["cloud", "installLinks", "mcpConnections", "remoteMcpApps", "workflows"])
  })
})
