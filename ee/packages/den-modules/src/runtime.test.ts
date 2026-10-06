import type { ModuleId } from "@openwork/license-contracts/modules"
import { describe, expect, test } from "vitest"
import { createDisabledLicenseClient } from "./entitlement/license-client"
import { parseInstanceConfig, resolveDeployment } from "./instance/config"
import { createModuleRuntime, type ModuleRuntimeOptions } from "./runtime"
import {
  createFakeClock,
  createMemoryLogger,
  createMemoryOrgRowLoader,
  testInstanceConfig,
  testLicenseResponse,
  testOrganizationModules,
  testOrgRow,
} from "./testing"

const throwingRows = {
  async load(): Promise<never> {
    throw new Error("the request path must not read the database")
  },
}

function runtime(overrides: Partial<ModuleRuntimeOptions> = {}) {
  const clock = createFakeClock()
  const logger = createMemoryLogger()
  const value = createModuleRuntime({
    deployment: "cloud",
    instance: testInstanceConfig(),
    orgRows: throwingRows,
    clock: clock.now,
    logger,
    isProduction: true,
    ...overrides,
  })
  return { runtime: value, clock, logger }
}

describe("createModuleRuntime (legacy mode)", () => {
  test("getEffectiveModules is sync, memoized and does no I/O", () => {
    const { runtime: modules } = runtime()
    const row = testOrgRow({ metadata: { capabilities: { workbot: true } } })
    const first = modules.getEffectiveModules(row)
    expect(first).not.toBeInstanceOf(Promise)
    expect(first.modules.workbot).toEqual({ state: "on" })
    expect(modules.getEffectiveModules({ ...row })).toBe(first)
    expect(modules.isOn(row, "workbot")).toBe(true)
    expect(modules.stateOf(row, "dashboards")).toEqual({ state: "off", reason: "not_entitled" })
    expect(modules.entitlementMode).toBe("legacy")
  })

  test("a metadata change or a new revision recomputes", () => {
    const { runtime: modules } = runtime()
    const first = modules.getEffectiveModules(testOrgRow())
    const granted = modules.getEffectiveModules(testOrgRow({ metadata: { capabilities: { auditLogs: true } } }))
    expect(granted).not.toBe(first)
    expect(granted.modules.auditLogs.state).toBe("on")
    const toggled = modules.getEffectiveModules(testOrgRow({ metadata: { capabilities: { auditLogs: true } }, modules: testOrganizationModules({ disabled: ["installLinks"] }) }))
    expect(toggled.modules.installLinks).toEqual({ state: "off", reason: "disabled_by_org" })
  })

  test("NULL column derives kill switches from metadata; a document is authoritative", () => {
    const { runtime: modules } = runtime()
    const metadata = { capabilities: { mcpConnections: false } }
    expect(modules.stateOf(testOrgRow({ id: "a", metadata }), "connect")).toEqual({ state: "off", reason: "disabled_by_org" })
    expect(modules.stateOf(testOrgRow({ id: "a", metadata }), "mcpApps")).toEqual({ state: "off", reason: "requires", requires: "connect" })
    expect(modules.isOn(testOrgRow({ id: "b", metadata, modules: testOrganizationModules() }), "connect")).toBe(true)
  })

  test("a corrupt document resolves as absent and logs once", () => {
    const { runtime: modules, logger } = runtime()
    const row = testOrgRow({ metadata: { capabilities: { installLinks: false } }, modules: "{broken" })
    expect(modules.stateOf(row, "installLinks")).toEqual({ state: "off", reason: "disabled_by_org" })
    modules.resolveForRow(row)
    modules.resolveForRow(row)
    expect(logger.named("den_modules_document_invalid")).toHaveLength(1)
  })

  test("resolveForRow bypasses the memo and emits nothing", async () => {
    const { runtime: modules } = runtime()
    const events: unknown[] = []
    modules.onModuleTransition((transition) => {
      events.push(transition)
    })
    const row = testOrgRow()
    const memoized = modules.getEffectiveModules(row)
    expect(modules.resolveForRow(row)).not.toBe(memoized)
    modules.resolveForRow(testOrgRow({ metadata: { capabilities: { workbot: true } } }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual([])
  })

  test("getEffectiveModulesForOrgId selects once and returns null for an unknown org", async () => {
    const rows = createMemoryOrgRowLoader([testOrgRow({ id: "org_known", metadata: { capabilities: { slackAssistant: true } } })])
    const { runtime: modules } = runtime({ orgRows: rows })
    expect((await modules.getEffectiveModulesForOrgId("org_known"))?.modules.slackAssistant.state).toBe("on")
    expect(await modules.getEffectiveModulesForOrgId("org_unknown")).toBeNull()
    expect(rows.loads).toEqual(["org_known", "org_unknown"])
  })

  test("instanceState reflects deployment and availability", () => {
    const { runtime: modules } = runtime({ deployment: "selfHosted", instance: testInstanceConfig({ infra: { gatewayEnabled: false } }) })
    expect(modules.instanceState("billing")).toEqual({ state: "off", reason: "not_on_deployment" })
    expect(modules.instanceState("aiGateway")).toEqual({ state: "off", reason: "not_available", detail: "gateway_disabled" })
    expect(modules.instanceState("teams")).toEqual({ state: "on" })
  })

  test("planAllows and toggleWired", () => {
    const { runtime: modules } = runtime({ instance: testInstanceConfig({ deprecatedFlags: { planGatingEnabled: true } }), toggleWiredModules: ["teams"] })
    expect(modules.planAllows(testOrgRow({ metadata: { plan: { tier: "team" } } }), "sso.configure")).toBe(true)
    expect(modules.planAllows(testOrgRow({ metadata: { plan: { tier: "team" } } }), "desktopPolicies.write")).toBe(false)
    expect(modules.toggleWired("teams")).toBe(true)
    expect(modules.toggleWired("connect")).toBe(false)
  })

  test("refreshEntitlementNow is a no-op outside license mode", async () => {
    const { runtime: modules } = runtime()
    await modules.start()
    expect(await modules.refreshEntitlementNow({ instance: true })).toEqual({ kind: "skipped", why: "disabled" })
    await modules.close()
  })
})

describe("entitlement modes and guards", () => {
  const override = JSON.stringify(testLicenseResponse({ modules: { connect: true, marketplace: true, mcpApps: true } }))

  test("devOverride resolves from the license response and is refused in production", () => {
    expect(() => runtime({ entitlementMode: "devOverride", devOverride: override })).toThrow("production")
    const { runtime: modules } = runtime({ entitlementMode: "devOverride", devOverride: override, isProduction: false })
    const row = testOrgRow({ metadata: { capabilities: { workbot: true } } })
    expect(modules.isOn(row, "mcpApps")).toBe(true)
    expect(modules.stateOf(row, "workbot")).toEqual({ state: "off", reason: "not_entitled" })
    expect(modules.isOn(row, "installLinks")).toBe(true)
    expect(() => runtime({ entitlementMode: "devOverride", devOverride: "{}", isProduction: false })).toThrow("DEN_LICENSE_DEV_OVERRIDE")
  })

  test("license mode with the stub client is refused in production", () => {
    const license = { client: createDisabledLicenseClient(), request: { baseUrl: "https://den.example.com", instanceId: "i", version: "1.0.0", currentUsers: async () => 0 } }
    expect(() => runtime({ entitlementMode: "license", license })).toThrow("Phase 5")
    expect(() => runtime({ entitlementMode: "license" })).toThrow("license options")
  })
})

describe("gateway and den-api agree on the gateway-observable modules", () => {
  const observable: readonly ModuleId[] = ["aiGateway", "aiGateway.usageLimits", "openworkModels", "openworkModels.analytics", "freeInference", "billing"]
  const envs = [undefined, "true", "false"].flatMap((gateway) => [undefined, "1", "false"].flatMap((free) => [undefined, "multi_org"].flatMap((orgMode) => [undefined, "cloud", "self_hosted"].map((deployment) => ({
    GATEWAY_ENABLED: gateway,
    INFERENCE_FREE_ENABLED: free,
    DEN_ORG_MODE: orgMode,
    DEN_DEPLOYMENT: deployment,
  })))))
  const rows = [testOrgRow(), testOrgRow({ metadata: { capabilities: { modelsAnalytics: true }, plan: { tier: "enterprise" } } }), testOrgRow({ metadata: { capabilities: { mcpConnections: false } } })]

  test.each(envs)("%j", (env) => {
    const shared = parseInstanceConfig(env)
    const deployment = resolveDeployment(env, shared.orgMode)
    const denApi = createModuleRuntime({ deployment, instance: { ...shared, infra: { ...shared.infra, headlessRunnerConfigured: true, cloudRuntimeAvailable: false } }, isProduction: true, logger: createMemoryLogger() })
    const gateway = createModuleRuntime({ deployment, instance: shared, availabilityObservable: observable, isProduction: true, logger: createMemoryLogger(), shadow: { enabled: false } })
    for (const row of rows) {
      for (const id of observable) expect(gateway.stateOf(row, id), id).toEqual(denApi.stateOf(row, id))
    }
  })
})
