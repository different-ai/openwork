import { describe, expect, test } from "vitest"
import { entitlementInvalidationHintSchema, licenseCheckBatchRequestSchema, licenseCheckBatchResponseSchema } from "./hints"
import { mapModuleIds } from "./module-ids"
import { entitlementInputFromSnapshot, entitlementSnapshotSchema, organizationModulesSchema } from "./org-modules"
import { moduleDisabledErrorClientSchema } from "./errors"
import { moduleStateSchema, orgModulesPayloadSchema, toOrgModulesPayload } from "./payload"
import { resolveModules } from "./resolver"

const v2Payload = {
  schemaVersion: 2,
  licenseId: "lic_1",
  kind: "standard",
  status: "active",
  modules: { "org.members.teams": true, "future.module": true },
  featureFlags: {},
  maxUsers: 5,
  expiresAt: null,
  invalidatedAt: null,
  checkedAt: "2026-10-05T11:00:00.000Z",
  cacheTtlSeconds: 300,
} as const

const snapshot = {
  schemaVersion: 1,
  payload: v2Payload,
  lastVerifiedAt: "2026-10-05T11:00:00.000Z",
  nextRefreshAt: "2026-10-05T11:05:00.000Z",
  transitionStartedAt: null,
} as const

describe("entitlementSnapshotSchema", () => {
  test("round-trips through JSON and defaults credentialRejectedAt", () => {
    const parsed = entitlementSnapshotSchema.parse(snapshot)
    expect(parsed.credentialRejectedAt).toBeNull()
    expect(entitlementSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  test("accepts a v1 payload", () => {
    const v1 = { schemaVersion: 1, licenseId: "lic_1", status: "active", modules: { auth: true }, featureFlags: {}, maxUsers: 5, expiresAt: null, invalidatedAt: null, checkedAt: "2026-10-05T11:00:00.000Z", cacheTtlSeconds: 300 }
    expect(entitlementSnapshotSchema.safeParse({ ...snapshot, payload: v1 }).success).toBe(true)
  })

  test("becomes a license resolver input", () => {
    const input = entitlementInputFromSnapshot(entitlementSnapshotSchema.parse(snapshot))
    expect(input).toMatchObject({ source: "license", lastVerifiedAt: snapshot.lastVerifiedAt, transitionStartedAt: null, credentialRejectedAt: null })
    expect(input.license.modules).toEqual({ "org.members.teams": true })
  })
})

describe("organizationModulesSchema", () => {
  const document = {
    schemaVersion: 1,
    revision: 3,
    disabled: ["org.members.teams", "customRoles", "someFutureModule"],
    updatedAt: "2026-10-05T10:00:00.000Z",
    updatedBy: "member_1",
  }

  test("keeps unknown ids in disabled so they survive a downgrade", () => {
    expect(organizationModulesSchema.parse(document).disabled).toEqual(["org.members.teams", "customRoles", "someFutureModule"])
  })

  test("accepts the optional entitlement snapshot and reconcile marker", () => {
    const parsed = organizationModulesSchema.parse({ ...document, entitlement: snapshot, reconciled: ["ai.gateway"] })
    expect(parsed.entitlement?.payload.licenseId).toBe("lic_1")
    expect(parsed.reconciled).toEqual(["ai.gateway"])
  })

  test("rejects bad documents", () => {
    expect(organizationModulesSchema.safeParse({ ...document, revision: -1 }).success).toBe(false)
    expect(organizationModulesSchema.safeParse({ ...document, schemaVersion: 2 }).success).toBe(false)
    expect(organizationModulesSchema.safeParse({ ...document, disabled: Array.from({ length: 129 }, (_, index) => `m${index}`) }).success).toBe(false)
  })
})

describe("client payload", () => {
  test("toOrgModulesPayload passes the wire schema", () => {
    const effective = resolveModules({
      deployment: "self_hosted",
      availability: { ...mapModuleIds((): true => true), workbot: { reason: "workbot_url_missing" } },
      entitlement: { source: "static", modules: mapModuleIds(() => true), featureFlags: { beta: true } },
      disabled: ["library.connectors"],
      now: new Date("2026-10-05T12:00:00.000Z"),
    })
    const payload = toOrgModulesPayload(effective)
    expect(orgModulesPayloadSchema.parse(payload)).toEqual(payload)
    expect(payload.modules["org.billing"]).toEqual({ state: "off", reason: "not_on_deployment" })
    expect(payload.modules.workbot).toEqual({ state: "off", reason: "not_available", detail: "workbot_url_missing" })
    expect(payload.modules["library.apps"]).toEqual({ state: "off", reason: "requires", requires: "library.connectors" })
    expect(payload.featureFlags).toEqual({ beta: true })
  })

  test("older clients tolerate new ids, reasons and policies", () => {
    expect(moduleStateSchema.safeParse({ state: "off", reason: "quota_exceeded" }).success).toBe(true)
    expect(moduleStateSchema.safeParse({ state: "restricted", until: "2026-11-01T00:00:00.000Z", operations: { x: "audit_only" } }).success).toBe(true)
    expect(orgModulesPayloadSchema.safeParse({ modules: { futureModule: { state: "on" } }, featureFlags: {} }).success).toBe(true)
    expect(moduleDisabledErrorClientSchema.safeParse({ error: "module_disabled", module: "x", reason: "new", message: "m", action: "new" }).success).toBe(true)
  })
})

describe("hints and batch", () => {
  test("hint schema", () => {
    const hint = { schemaVersion: 1, hintId: "3f1d8a64-5d0e-4c43-9a55-1b2a9a8f0c11", organizationIds: ["org_1"], issuedAt: "2026-10-05T12:00:00.000Z" }
    expect(entitlementInvalidationHintSchema.parse(hint)).toEqual(hint)
    expect(entitlementInvalidationHintSchema.safeParse({ ...hint, organizationIds: [] }).success).toBe(false)
    expect(entitlementInvalidationHintSchema.safeParse({ ...hint, modules: {} }).success).toBe(false)
  })

  test("batch schemas", () => {
    const request = {
      schemaVersion: 2,
      baseUrl: "https://den.example.com",
      instanceId: "pod-1",
      version: "0.18.3",
      organizations: [{ organizationId: "org_1", currentUsers: 3 }],
    }
    expect(licenseCheckBatchRequestSchema.safeParse(request).success).toBe(true)
    const response = {
      schemaVersion: 2,
      checkedAt: "2026-10-05T12:00:00.000Z",
      results: [
        { ok: true, organizationId: "org_1", response: v2Payload },
        { ok: false, organizationId: "org_2", error: "organization_scope_denied" },
      ],
    }
    expect(licenseCheckBatchResponseSchema.safeParse(response).success).toBe(true)
  })
})
