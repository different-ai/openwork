import { describe, expect, test } from "vitest"
import { readRecord, parseOrgMetadata, type OrgModuleRow } from "./org-row"
import { createModuleRuntime, type ModuleRuntimeOptions } from "./runtime"
import { granted, type LegacyOracle } from "./shadow"
import { createFakeClock, createMemoryLogger, testInstanceConfig, testOrganizationModules, testOrgRow } from "./testing"

const flush = () => new Promise((resolve) => setImmediate(resolve))

function capabilities(row: OrgModuleRow): Record<string, unknown> {
  return readRecord(parseOrgMetadata(row.metadata).capabilities)
}

const workbotOracle: LegacyOracle = {
  id: "org.capabilities.workbot",
  moduleId: "workbot",
  legacy: (row) => capabilities(row).workbot === true,
}

function setup(shadow: ModuleRuntimeOptions["shadow"] = {}, random?: () => number) {
  const clock = createFakeClock()
  const logger = createMemoryLogger()
  const modules = createModuleRuntime({ deployment: "cloud", instance: testInstanceConfig(), clock: clock.now, logger, isProduction: true, shadow, random })
  return { modules, clock, logger }
}

describe("shadow compare", () => {
  test("matching oracles log nothing; compare is deferred and never throws", async () => {
    const { modules, logger } = setup()
    modules.registerLegacyOracles([workbotOracle])
    modules.shadowCompare(testOrgRow({ metadata: { capabilities: { workbot: true } } }))
    expect(logger.events).toEqual([])
    await flush()
    expect(logger.events).toEqual([])
  })

  test("an untagged mismatch logs a warning with ids and booleans only", async () => {
    const { modules, logger } = setup()
    modules.registerLegacyOracles([{ ...workbotOracle, legacy: () => true }])
    modules.shadowCompare(testOrgRow({ id: "org_a", metadata: { capabilities: { workbot: false }, name: "Secret Corp" } }))
    await flush()
    const [event] = logger.named("den_modules_shadow_mismatch")
    expect(event).toMatchObject({
      level: "warn",
      fields: { organizationId: "org_a", oracle: "org.capabilities.workbot", moduleId: "workbot", legacy: true, resolved: false, reason: "not_entitled", knownDivergence: null, disabledSource: "metadata" },
    })
    expect(JSON.stringify(event)).not.toContain("Secret Corp")
  })

  test("known divergences are tagged and logged at info", () => {
    const { modules, logger } = setup()
    modules.registerLegacyOracles([{ id: "org.capabilities.workbot.origin", moduleId: "workbot", legacy: (row) => capabilities(row).workbot === true }])
    const mismatches = modules.shadowCompareNow(testOrgRow({ metadata: { capabilities: { workbot: true, mcpConnections: false } } }))
    expect(mismatches).toEqual(["org.capabilities.workbot.origin"])
    expect(logger.named("den_modules_shadow_mismatch")[0]).toMatchObject({ level: "info", fields: { knownDivergence: "G3", reason: "requires", requires: "connect" } })
  })

  test("custom resolved functions see states and plan gates", () => {
    const { modules } = setup()
    modules.registerLegacyOracles([
      { id: "entitled.slack", moduleId: "slackAssistant", legacy: (row) => capabilities(row).slackAssistant === true, resolved: (view) => granted(view.state("slackAssistant")) },
      { id: "plan.sso", moduleId: "enterpriseAuth.sso", legacy: () => true, resolved: (view) => view.planAllows("sso.configure") },
    ])
    expect(modules.shadowCompareNow(testOrgRow({ metadata: { capabilities: { slackAssistant: true, mcpConnections: false } } }))).toEqual([])
  })

  test("sampling skips work", async () => {
    const { modules, logger } = setup({ sampleRate: 0.5 }, () => 0.9)
    modules.registerLegacyOracles([{ ...workbotOracle, legacy: () => true }])
    modules.shadowCompare(testOrgRow())
    await flush()
    expect(logger.events).toEqual([])
  })

  test("per-key and global rate limits, with a dropped count", () => {
    const { modules, logger, clock } = setup({ maxLogsPerMinute: 2, perKeyIntervalMs: 3_600_000 })
    modules.registerLegacyOracles([{ ...workbotOracle, legacy: () => true }])
    modules.shadowCompareNow(testOrgRow({ id: "org_a" }))
    modules.shadowCompareNow(testOrgRow({ id: "org_a" }))
    expect(logger.named("den_modules_shadow_mismatch")).toHaveLength(1)
    modules.shadowCompareNow(testOrgRow({ id: "org_b" }))
    modules.shadowCompareNow(testOrgRow({ id: "org_c" }))
    modules.shadowCompareNow(testOrgRow({ id: "org_d" }))
    expect(logger.named("den_modules_shadow_mismatch")).toHaveLength(2)
    clock.advance(60_000)
    modules.shadowCompareNow(testOrgRow({ id: "org_e" }))
    expect(logger.named("den_modules_shadow_dropped")[0]?.fields).toMatchObject({ dropped: 2 })
    expect(logger.named("den_modules_shadow_mismatch")).toHaveLength(3)
  })

  test("a throwing oracle is reported once and the others still run", () => {
    const { modules, logger } = setup()
    modules.registerLegacyOracles([
      { id: "broken", moduleId: "teams", legacy: () => { throw new Error("boom") } },
      { ...workbotOracle, legacy: () => true },
    ])
    expect(() => modules.shadowCompareNow(testOrgRow())).not.toThrow()
    expect(modules.shadowCompareNow(testOrgRow())).toEqual(["org.capabilities.workbot"])
    expect(logger.named("den_modules_shadow_failed")).toHaveLength(1)
  })

  test("duplicate oracle ids are refused", () => {
    const { modules } = setup()
    modules.registerLegacyOracles([workbotOracle])
    expect(() => modules.registerLegacyOracles([workbotOracle])).toThrow("twice")
  })

  test("disabled shadow does nothing", async () => {
    const { modules, logger } = setup({ enabled: false })
    modules.registerLegacyOracles([{ ...workbotOracle, legacy: () => true }])
    modules.shadowCompare(testOrgRow())
    await flush()
    expect(logger.events).toEqual([])
  })

  test("the column's kill switches must match metadata while only system writes touched it", () => {
    const { modules, logger } = setup()
    const metadata = { capabilities: { installLinks: false } }
    modules.shadowCompareNow(testOrgRow({ id: "org_ok", metadata, modules: testOrganizationModules({ disabled: ["installLinks"] }) }))
    modules.shadowCompareNow(testOrgRow({ id: "org_owner", metadata, modules: testOrganizationModules({ disabled: [], updatedBy: "om_owner" }) }))
    expect(logger.named("den_modules_legacy_mirror_mismatch")).toEqual([])
    modules.shadowCompareNow(testOrgRow({ id: "org_missed", metadata, modules: testOrganizationModules({ disabled: ["connect"] }) }))
    expect(logger.named("den_modules_legacy_mirror_mismatch").map((event) => event.fields)).toEqual([
      { organizationId: "org_missed", moduleId: "connect", columnDisabled: true, metadataDisabled: false, modulesRevision: 1 },
      { organizationId: "org_missed", moduleId: "installLinks", columnDisabled: false, metadataDisabled: true, modulesRevision: 1 },
    ])
  })
})
