import { afterEach, describe, expect, test, vi } from "vitest"
import { LICENSE_TRANSITION_MS, LICENSE_VERIFICATION_GRACE_MS, type LicenseEntitlement } from "./license"
import { mapModuleIds, MODULE_IDS, type ModuleId } from "./module-ids"
import { CLOUD_FREE_PLAN_MODULES, MODULE_DEFINITIONS, type ModuleDefinition } from "./modules"
import { evaluateModuleOperation } from "./operations"
import {
  computeTransitionStart,
  isModuleOn,
  isModuleUsable,
  resolveModules,
  type AvailabilityMap,
  type EffectiveModules,
  type LicenseEntitlementInput,
  type ModuleState,
  type ResolverInputs,
} from "./resolver"

const NOW = new Date("2026-10-05T12:00:00.000Z")
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()

const ALL_AVAILABLE: AvailabilityMap = mapModuleIds((): true => true)
const ALL_ENTITLED = mapModuleIds(() => true)

function resolve(overrides: Partial<ResolverInputs> = {}, definitions?: Readonly<Record<ModuleId, ModuleDefinition>>): EffectiveModules {
  return resolveModules({
    deployment: "cloud",
    availability: ALL_AVAILABLE,
    entitlement: { source: "static", modules: ALL_ENTITLED },
    disabled: [],
    now: NOW,
    ...overrides,
  }, definitions)
}

function licenseInput(
  license: Partial<LicenseEntitlement> = {},
  input: Partial<Omit<LicenseEntitlementInput, "source" | "license">> = {},
): LicenseEntitlementInput {
  const kind = license.kind ?? "standard"
  return {
    source: "license",
    license: {
      wireVersion: 2,
      licenseId: "lic_test",
      status: "active",
      kind,
      isTrial: kind === "trial",
      modules: ALL_ENTITLED,
      featureFlags: { beta: true },
      maxUsers: 10,
      expiresAt: null,
      invalidatedAt: null,
      checkedAt: at(-HOUR),
      cacheTtlSeconds: 300,
      ...license,
    },
    lastVerifiedAt: at(-HOUR),
    transitionStartedAt: null,
    credentialRejectedAt: null,
    ...input,
  }
}

const state = (effective: EffectiveModules, id: ModuleId): ModuleState => effective.modules[id]
const OFF = (reason: string, extra: Record<string, string> = {}) => ({ state: "off", reason, ...extra })

afterEach(() => vi.restoreAllMocks())

describe("reason precedence (§6.3 steps 1-8)", () => {
  test("1. not on this deployment, even when entitled and available", () => {
    expect(state(resolve({ deployment: "selfHosted" }), "billing")).toEqual(OFF("not_on_deployment"))
    expect(state(resolve({ deployment: "selfHosted" }), "openworkModels.analytics")).toEqual(OFF("not_on_deployment"))
  })

  test("2. not available: missing key is unknown, otherwise the reason", () => {
    const availability: AvailabilityMap = { ...ALL_AVAILABLE, aiGateway: undefined, workbot: { reason: "workbot_url_missing" } }
    const effective = resolve({ availability, disabled: ["aiGateway"] })
    expect(state(effective, "aiGateway")).toEqual(OFF("not_available", { detail: "unknown" }))
    expect(state(effective, "workbot")).toEqual(OFF("not_available", { detail: "workbot_url_missing" }))
    expect(state(effective, "aiGateway.usageLimits")).toEqual(OFF("requires", { requires: "aiGateway" }))
  })

  test("3. not entitled beats org toggles and dependencies", () => {
    const effective = resolve({
      entitlement: { source: "static", modules: { ...ALL_ENTITLED, aiGateway: false, connect: false, mcpApps: false } },
      disabled: ["aiGateway"],
    })
    expect(state(effective, "aiGateway")).toEqual(OFF("not_entitled"))
    expect(state(effective, "mcpApps")).toEqual(OFF("not_entitled"))
  })

  test("4. license expired beats the org toggle", () => {
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-DAY - 31 * DAY) }), disabled: ["aiGateway"] })
    expect(state(effective, "aiGateway")).toEqual(OFF("license_expired"))
  })

  test("5. disabled by org", () => {
    expect(state(resolve({ disabled: ["aiGateway"] }), "aiGateway")).toEqual(OFF("disabled_by_org"))
  })

  test("6. requires: the first failing parent or hard dependency", () => {
    const effective = resolve({ disabled: ["connect", "marketplace"] })
    expect(state(effective, "mcpApps")).toEqual(OFF("requires", { requires: "connect" }))
    expect(state(effective, "workflows")).toEqual(OFF("requires", { requires: "marketplace" }))
    expect(state(effective, "connect.nativeProviders")).toEqual(OFF("requires", { requires: "connect" }))
    expect(state(effective, "dashboards")).toEqual({ state: "on" })
  })

  test("7. restricted during a license transition", () => {
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-25 * HOUR) }) })
    expect(state(effective, "enterpriseAuth.sso")).toEqual({
      state: "restricted",
      until: at(-HOUR + LICENSE_TRANSITION_MS),
      operations: MODULE_DEFINITIONS["enterpriseAuth.sso"].transitionOperations,
    })
  })

  test("8. on", () => {
    const effective = resolve()
    for (const id of MODULE_IDS) expect([id, state(effective, id)]).toEqual([id, { state: "on" }])
  })
})

describe("entitlement sources", () => {
  test("none: every module is not entitled, including free ones (D14)", () => {
    const effective = resolve({ deployment: "selfHosted", entitlement: { source: "none" } })
    expect(state(effective, "installLinks")).toEqual(OFF("not_entitled"))
    expect(state(effective, "billing")).toEqual(OFF("not_on_deployment"))
    for (const id of MODULE_IDS) expect(isModuleUsable(effective, id)).toBe(false)
    expect(state(resolve({ entitlement: { source: "none" } }), "billing")).toEqual(OFF("not_entitled"))
  })

  test("cloudFreeFallback: the Cloud free plan", () => {
    const effective = resolve({ entitlement: { source: "cloudFreeFallback" } })
    for (const id of MODULE_IDS) {
      expect([id, isModuleOn(effective, id)]).toEqual([id, CLOUD_FREE_PLAN_MODULES[id]])
    }
    expect(state(effective, "auditLogs.export")).toEqual(OFF("not_entitled"))
  })

  test("static: missing keys fall back to free, explicit false wins", () => {
    const missing = resolve({ entitlement: { source: "static", modules: {} } })
    expect(state(missing, "installLinks")).toEqual({ state: "on" })
    expect(state(missing, "billing")).toEqual({ state: "on" })
    expect(state(missing, "teams")).toEqual(OFF("not_entitled"))
    const denied = resolve({ entitlement: { source: "static", modules: { installLinks: false } } })
    expect(state(denied, "installLinks")).toEqual(OFF("not_entitled"))
  })

  test("static feature flags pass through; flags never grant modules", () => {
    const effective = resolve({ entitlement: { source: "static", modules: {}, featureFlags: { teams: true } } })
    expect(effective.featureFlags).toEqual({ teams: true })
    expect(state(effective, "teams")).toEqual(OFF("not_entitled"))
  })

  test("license: missing keys are not entitled, free modules always are", () => {
    const effective = resolve({ entitlement: licenseInput({ modules: { teams: true, installLinks: false } }) })
    expect(state(effective, "teams")).toEqual({ state: "on" })
    expect(state(effective, "auditLogs")).toEqual(OFF("not_entitled"))
    expect(state(effective, "installLinks")).toEqual({ state: "on" })
    expect(effective.featureFlags).toEqual({ beta: true })
    expect(effective.entitlementSource).toBe("license")
  })
})

describe("sub-modules and dependencies (D6)", () => {
  test("a sub-module without its parent resolves to requires", () => {
    const effective = resolve({ entitlement: licenseInput({ modules: { "aiGateway.usageLimits": true } }) })
    expect(state(effective, "aiGateway")).toEqual(OFF("not_entitled"))
    expect(state(effective, "aiGateway.usageLimits")).toEqual(OFF("requires", { requires: "aiGateway" }))
  })

  test("a parent works without its sub-modules", () => {
    const effective = resolve({ entitlement: licenseInput({ modules: { aiGateway: true } }) })
    expect(state(effective, "aiGateway")).toEqual({ state: "on" })
    expect(state(effective, "aiGateway.usageLimits")).toEqual(OFF("not_entitled"))
  })

  test("requires names the first failing dependency, not the root cause", () => {
    const effective = resolve({ entitlement: { source: "static", modules: { ...ALL_ENTITLED, billing: false } } })
    expect(state(effective, "openworkModels")).toEqual(OFF("requires", { requires: "billing" }))
    expect(state(effective, "openworkModels.analytics")).toEqual(OFF("requires", { requires: "openworkModels" }))
    const scim = resolve({ entitlement: { source: "static", modules: { ...ALL_ENTITLED, "enterpriseAuth.sso": false } } })
    expect(state(scim, "enterpriseAuth.scim")).toEqual(OFF("requires", { requires: "enterpriseAuth.sso" }))
  })

  test("a disabled parent makes the child require it", () => {
    expect(state(resolve({ disabled: ["aiGateway"] }), "aiGateway.usageLimits")).toEqual(OFF("requires", { requires: "aiGateway" }))
  })

  test("soft dependencies never affect state", () => {
    const effective = resolve({ disabled: ["mcpApps", "workflows", "auditLogs", "teams"] })
    expect(state(effective, "dashboards")).toEqual({ state: "on" })
    expect(state(effective, "aiGateway")).toEqual({ state: "on" })
    expect(state(effective, "automations")).toEqual({ state: "on" })
  })
})

describe("org toggles", () => {
  test("only optOut modules can be switched off; unknown ids are ignored", () => {
    const effective = resolve({ disabled: ["billing", "enterpriseAuth.sso", "customRoles", "foo"] })
    expect(state(effective, "billing")).toEqual({ state: "on" })
    expect(state(effective, "enterpriseAuth.sso")).toEqual({ state: "on" })
  })

  test("toggles survive and restore", () => {
    const entitledOff = resolve({ entitlement: { source: "static", modules: { ...ALL_ENTITLED, teams: false } }, disabled: ["teams"] })
    expect(state(entitledOff, "teams")).toEqual(OFF("not_entitled"))
    expect(state(resolve({ disabled: ["teams"] }), "teams")).toEqual(OFF("disabled_by_org"))
    expect(state(resolve({ disabled: [] }), "teams")).toEqual({ state: "on" })
  })
})

describe("license transitions", () => {
  test("verified 23h ago: all on, valid until the verification grace ends", () => {
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-23 * HOUR) }) })
    expect(isModuleOn(effective, "enterpriseAuth.sso")).toBe(true)
    expect(effective.validUntil).toBe(at(-23 * HOUR + LICENSE_VERIFICATION_GRACE_MS))
    expect(effective.license).toEqual({ status: "active", kind: "standard", isTrial: false, expiresAt: null, transition: null })
  })

  test("verified 25h ago: grace ended 1h ago, the 30-day transition runs", () => {
    const t0 = -HOUR
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-25 * HOUR) }) })
    expect(state(effective, "aiGateway")).toEqual({ state: "on" })
    expect(state(effective, "enterpriseAuth")).toEqual({ state: "on" })
    expect(state(effective, "enterpriseAuth.sso")).toMatchObject({ state: "restricted", until: at(t0 + LICENSE_TRANSITION_MS) })
    expect(state(effective, "enterpriseAuth.scim")).toEqual({ state: "on" })
    expect(effective.validUntil).toBe(at(t0 + LICENSE_TRANSITION_MS))
    expect(effective.license?.transition).toEqual({ startedAt: at(t0), endsAt: at(t0 + LICENSE_TRANSITION_MS) })
  })

  test("31 days after the start: licensed modules expire, free modules stay", () => {
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-DAY - 31 * DAY) }) })
    for (const id of MODULE_IDS) {
      const expected = MODULE_DEFINITIONS[id].entitlement === "free" ? { state: "on" } : OFF("license_expired")
      expect([id, state(effective, id)]).toEqual([id, expected])
    }
    expect(effective.validUntil).toBeNull()
  })

  test("expired: the transition starts at expiresAt", () => {
    const entitlement = licenseInput({ status: "expired", expiresAt: at(-2 * DAY) })
    expect(computeTransitionStart(entitlement, NOW)).toBe(at(-2 * DAY))
    expect(state(resolve({ entitlement }), "enterpriseAuth.sso")).toMatchObject({ until: at(-2 * DAY + LICENSE_TRANSITION_MS) })
  })

  test("an active license past expiresAt starts the transition; a future expiry caps validUntil", () => {
    expect(computeTransitionStart(licenseInput({ expiresAt: at(-HOUR / 2) }), NOW)).toBe(at(-HOUR / 2))
    const future = resolve({ entitlement: licenseInput({ expiresAt: at(2 * HOUR) }) })
    expect(future.validUntil).toBe(at(2 * HOUR))
  })

  test("suspended and revoked: the transition starts at invalidatedAt", () => {
    for (const status of ["suspended", "revoked"] as const) {
      expect(computeTransitionStart(licenseInput({ status, invalidatedAt: at(-3 * DAY) }), NOW)).toBe(at(-3 * DAY))
    }
  })

  test("a rejected credential starts the transition", () => {
    expect(computeTransitionStart(licenseInput({}, { credentialRejectedAt: at(-5 * HOUR) }), NOW)).toBe(at(-5 * HOUR))
  })

  test("a persisted earlier start wins, so restarts can't extend grace", () => {
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-25 * HOUR), transitionStartedAt: at(-31 * DAY) }) })
    expect(state(effective, "aiGateway")).toEqual(OFF("license_expired"))
  })

  test("trial expiry is immediate: no grace, no restricted state (D22)", () => {
    const effective = resolve({ entitlement: licenseInput({ kind: "trial", expiresAt: at(-60_000) }) })
    for (const id of MODULE_IDS) {
      const expected = MODULE_DEFINITIONS[id].entitlement === "free" ? { state: "on" } : OFF("license_expired")
      expect([id, state(effective, id)]).toEqual([id, expected])
    }
    expect(effective.license).toMatchObject({ isTrial: true, transition: { startedAt: at(-60_000), endsAt: at(-60_000) } })
  })

  test("an expired trial is still a trial", () => {
    const effective = resolve({ entitlement: licenseInput({ kind: "trial", status: "expired", expiresAt: at(-HOUR) }) })
    expect(state(effective, "enterpriseAuth.sso")).toEqual(OFF("license_expired"))
  })

  test("a healthy trial is on until it expires", () => {
    const effective = resolve({ entitlement: licenseInput({ kind: "trial", expiresAt: at(3 * HOUR) }) })
    expect(isModuleOn(effective, "teams")).toBe(true)
    expect(effective.validUntil).toBe(at(3 * HOUR))
  })

  test("a module that isn't entitled stays not_entitled during a transition", () => {
    const effective = resolve({ entitlement: licenseInput({ modules: { teams: true } }, { lastVerifiedAt: at(-DAY - 31 * DAY) }) })
    expect(state(effective, "teams")).toEqual(OFF("license_expired"))
    expect(state(effective, "auditLogs")).toEqual(OFF("not_entitled"))
  })

  test("custom definitions apply their own expiry policy", () => {
    const definitions = {
      ...MODULE_DEFINITIONS,
      aiGateway: { ...MODULE_DEFINITIONS.aiGateway, expiryPolicy: "immediate" },
    } satisfies Record<ModuleId, ModuleDefinition>
    const effective = resolve({ entitlement: licenseInput({}, { lastVerifiedAt: at(-25 * HOUR) }) }, definitions)
    expect(state(effective, "aiGateway")).toEqual(OFF("license_expired"))
    expect(state(effective, "aiGateway.usageLimits")).toEqual(OFF("requires", { requires: "aiGateway" }))
    expect(state(effective, "teams")).toEqual({ state: "on" })
  })

  test("a healthy license has no transition start", () => {
    expect(computeTransitionStart(licenseInput(), NOW)).toBeNull()
  })
})

describe("purity", () => {
  test("same inputs give the same output without reading the clock", () => {
    const spy = vi.spyOn(Date, "now")
    const inputs: ResolverInputs = {
      deployment: "cloud",
      availability: ALL_AVAILABLE,
      entitlement: licenseInput({}, { lastVerifiedAt: at(-25 * HOUR) }),
      disabled: ["teams"],
      now: NOW,
    }
    expect(resolveModules(inputs)).toEqual(resolveModules(inputs))
    expect(spy).not.toHaveBeenCalled()
    expect(resolveModules(inputs).computedAt).toBe(NOW.toISOString())
  })

  test("10k resolutions stay fast (catches quadratic work)", () => {
    const inputs: ResolverInputs = {
      deployment: "cloud",
      availability: ALL_AVAILABLE,
      entitlement: licenseInput({}, { lastVerifiedAt: at(-25 * HOUR) }),
      disabled: ["teams", "aiGateway"],
      now: NOW,
    }
    const started = performance.now()
    for (let index = 0; index < 10_000; index += 1) resolveModules(inputs)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("evaluateModuleOperation", () => {
  const restricted: ModuleState = {
    state: "restricted",
    until: at(DAY),
    operations: { open: "allow", owners: "owner_only", closed: "deny", other: "owner_only" },
  }
  const owner = { ownerOrSuperAdmin: true }
  const member = { ownerOrSuperAdmin: false }

  test("on allows and off denies", () => {
    expect(evaluateModuleOperation({ state: "on" }, "anything", member)).toBe("allow")
    expect(evaluateModuleOperation({ state: "off", reason: "not_entitled" }, undefined, owner)).toBe("deny")
  })

  test.each([
    ["open", owner, "allow"],
    ["open", member, "allow"],
    ["owners", owner, "allow"],
    ["owners", member, "deny"],
    ["closed", owner, "deny"],
    ["closed", member, "deny"],
    [undefined, owner, "allow"],
    [undefined, member, "deny"],
    ["unlisted", member, "deny"],
    ["unlisted", owner, "allow"],
  ] as const)("restricted %s for %o → %s", (operation, actor, expected) => {
    expect(evaluateModuleOperation(restricted, operation, actor)).toBe(expected)
  })

  test("restricted without other denies unlisted operations", () => {
    const state: ModuleState = { state: "restricted", until: at(DAY), operations: { open: "allow" } }
    expect(evaluateModuleOperation(state, "unlisted", owner)).toBe("deny")
    expect(evaluateModuleOperation(state, "toString", owner)).toBe("deny")
  })
})
