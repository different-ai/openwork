import { MODULE_IDS, type ModuleId } from "@openwork/license-contracts/modules"
import { resolveModules } from "@openwork/license-contracts/resolver"
import { describe, expect, test } from "vitest"
import { computeInstanceAvailability } from "./instance/availability"
import type { InstanceConfig } from "./instance/config"
import { legacyResolverInputs, prepareOrg } from "./legacy/adapter"
import { extractLegacyOrgInputs, LEGACY_CAPABILITY_KEYS, LEGACY_PLAN_TIERS, legacyDisabledModules, legacyInputsDigest } from "./legacy/inputs"
import { KNOWN_LEGACY_DIVERGENCES, LEGACY_ENTITLEMENT_RULES, legacyPlanAllows, matchKnownDivergence, type LegacyDivergenceContext } from "./legacy/mapping"
import { parseOrgModulesDocument, readRecord } from "./org-row"
import { testInstanceConfig, testOrganizationModules } from "./testing"

const tri: ReadonlyArray<boolean | undefined> = [true, false, undefined]

describe("extractLegacyOrgInputs", () => {
  test("reads literal booleans only, plan tier, aliases and complimentary access", () => {
    const inputs = extractLegacyOrgInputs({
      plan: { tier: "team" },
      capabilities: { workbot: true, auditLogs: "true", installLinks: false, retired: true },
      connectEnabled: false,
      mcpConnectionsEnabled: 1,
      complimentaryAccess: { openworkWeb: true },
    })
    expect(inputs).toEqual({
      planTier: "team",
      capabilities: {
        installLinks: false,
        mcpConnections: undefined,
        modelsAnalytics: undefined,
        auditLogs: undefined,
        orgManagedDashboards: undefined,
        slackAssistant: undefined,
        slackAssistantHeadless: undefined,
        headlessAutomations: undefined,
        workbot: true,
      },
      aliases: { connectEnabled: false, mcpConnectionsEnabled: undefined },
      complimentaryOpenworkWeb: true,
      connectOn: false,
      installLinksOn: false,
    })
  })

  test("string metadata parses like an object; unreadable metadata is empty", () => {
    const metadata = { plan: { tier: "enterprise" }, capabilities: { slackAssistant: true } }
    expect(extractLegacyOrgInputs(JSON.stringify(metadata))).toEqual(extractLegacyOrgInputs(metadata))
    for (const value of [null, undefined, "", "{broken", "[]", 42, ["capabilities"]]) {
      const inputs = extractLegacyOrgInputs(value)
      expect(inputs.planTier).toBe("free")
      expect(inputs.connectOn && inputs.installLinksOn).toBe(true)
      expect(legacyInputsDigest(inputs)).toBe(legacyInputsDigest(extractLegacyOrgInputs({})))
    }
    expect(extractLegacyOrgInputs({ plan: { tier: "gold" } }).planTier).toBe("free")
  })

  test.each(tri.flatMap((capability) => tri.flatMap((connectEnabled) => tri.map((mcpConnectionsEnabled) => ({ capability, connectEnabled, mcpConnectionsEnabled })))))(
    "connect precedence: capability $capability, connectEnabled $connectEnabled, mcpConnectionsEnabled $mcpConnectionsEnabled (I2)",
    ({ capability, connectEnabled, mcpConnectionsEnabled }) => {
      const inputs = extractLegacyOrgInputs({ capabilities: { mcpConnections: capability }, connectEnabled, mcpConnectionsEnabled })
      const expected = capability !== undefined
        ? capability
        : connectEnabled === true || mcpConnectionsEnabled === true
          ? true
          : !(connectEnabled === false || mcpConnectionsEnabled === false)
      expect(inputs.connectOn).toBe(expected)
      expect(legacyDisabledModules(inputs).includes("connect")).toBe(!expected)
    },
  )

  test("the digest changes with every input that changes a result", () => {
    const base = legacyInputsDigest(extractLegacyOrgInputs({}))
    const variants = [
      { plan: { tier: "team" } },
      { connectEnabled: false },
      { mcpConnectionsEnabled: true },
      { complimentaryAccess: { openworkWeb: true } },
      ...LEGACY_CAPABILITY_KEYS.flatMap((key) => [{ capabilities: { [key]: true } }, { capabilities: { [key]: false } }]),
    ]
    const digests = variants.map((metadata) => legacyInputsDigest(extractLegacyOrgInputs(metadata)))
    expect(new Set([base, ...digests]).size).toBe(variants.length + 1)
  })
})

/** Hand-written from 00-legacy-mapping §E.4 (column E), as the reference for the data table. */
function expectedEntitled(id: ModuleId, metadata: Record<string, unknown>, config: InstanceConfig): boolean {
  const capabilities = readRecord(metadata.capabilities)
  const plan = readRecord(metadata.plan)
  const tier = typeof plan.tier === "string" ? plan.tier : "free"
  const gating = config.deprecatedFlags.planGatingEnabled
  switch (id) {
    case "dashboards": return capabilities.orgManagedDashboards === true
    case "automations.headless": return capabilities.headlessAutomations === true && (!gating || tier === "team" || tier === "enterprise")
    case "openworkWeb": return config.deprecatedFlags.openworkWebEnabled || readRecord(metadata.complimentaryAccess).openworkWeb === true
    case "workbot": return capabilities.workbot === true
    case "slackAssistant": return capabilities.slackAssistant === true
    case "slackAssistant.headless": return capabilities.slackAssistantHeadless === true
    case "openworkModels.analytics": return capabilities.modelsAnalytics === true
    case "auditLogs": return capabilities.auditLogs === true
    default: return true
  }
}

describe("LEGACY_ENTITLEMENT_RULES truth table", () => {
  const metadataMatrix = LEGACY_PLAN_TIERS.flatMap((tier) => [true, false, undefined].flatMap((value) => [false, true].map((complimentary) => ({
    plan: { tier },
    capabilities: Object.fromEntries(LEGACY_CAPABILITY_KEYS.map((key) => [key, value])),
    ...(complimentary ? { complimentaryAccess: { openworkWeb: true } } : {}),
  }))))
  const configs = [false, true].flatMap((planGatingEnabled) => [false, true].map((openworkWebEnabled) => testInstanceConfig({ deprecatedFlags: { planGatingEnabled, openworkWebEnabled } })))

  test.each(MODULE_IDS.map((id) => [id]))("%s", (id) => {
    for (const metadata of metadataMatrix) {
      for (const config of configs) {
        expect(LEGACY_ENTITLEMENT_RULES[id].entitled(extractLegacyOrgInputs(metadata), config), JSON.stringify({ metadata, flags: config.deprecatedFlags })).toBe(expectedEntitled(id, metadata, config))
      }
    }
  })
})

describe("legacyPlanAllows (00-legacy-mapping §C)", () => {
  test.each(LEGACY_PLAN_TIERS.flatMap((tier) => [false, true].flatMap((gating) => [false, true].flatMap((selfHosted) => [false, true].flatMap((capture) => [false, true].map((visibility) => ({ tier, gating, selfHosted, capture, visibility })))))))(
    "tier $tier gating $gating selfHosted $selfHosted capture $capture visibility $visibility",
    ({ tier, gating, selfHosted, capture, visibility }) => {
      const config = testInstanceConfig({ deprecatedFlags: { planGatingEnabled: gating, auditSelfHostedEnabled: selfHosted, auditCaptureEnabled: capture, auditVisibilityEnabled: visibility } })
      const inputs = extractLegacyOrgInputs({ plan: { tier } })
      const enterprise = tier === "enterprise"
      expect(legacyPlanAllows("sso.configure", inputs, config)).toBe(!gating || tier !== "free")
      expect(legacyPlanAllows("versionPinning.write", inputs, config)).toBe(!gating || enterprise)
      expect(legacyPlanAllows("desktopPolicies.write", inputs, config)).toBe(!gating || enterprise)
      expect(legacyPlanAllows("branding.write", inputs, config)).toBe(!gating || enterprise)
      expect(legacyPlanAllows("audit.entitlement", inputs, config)).toBe(selfHosted || enterprise)
      expect(legacyPlanAllows("audit.capture", inputs, config)).toBe(capture && (selfHosted || enterprise))
      expect(legacyPlanAllows("audit.read", inputs, config)).toBe(visibility)
    },
  )
})

describe("legacyResolverInputs", () => {
  test("a valid document is authoritative for disabled; NULL or invalid derives the kill switches from metadata", () => {
    const metadata = { capabilities: { installLinks: false }, connectEnabled: false }
    const absent = prepareOrg(metadata, parseOrgModulesDocument({ id: "org", metadata, modules: null }))
    expect(absent).toMatchObject({ disabled: ["connect", "installLinks"], disabledSource: "metadata" })
    const invalid = prepareOrg(metadata, parseOrgModulesDocument({ id: "org", metadata, modules: { revision: "x" } }))
    expect(invalid).toMatchObject({ disabled: ["connect", "installLinks"], disabledSource: "metadata" })
    const column = prepareOrg(metadata, parseOrgModulesDocument({ id: "org", metadata, modules: testOrganizationModules({ disabled: ["teams"] }) }))
    expect(column).toMatchObject({ disabled: ["teams"], disabledSource: "column" })
  })

  test("an empty org on a fully configured Cloud resolves like today: everything on except per-org grants", () => {
    const config = testInstanceConfig()
    const prepared = prepareOrg({}, { status: "absent", doc: null })
    const availability = computeInstanceAvailability({ config, deployment: "cloud" })
    const effective = resolveModules(legacyResolverInputs(prepared, { deployment: "cloud", availability: availability.map, config, now: new Date() }))
    const off = MODULE_IDS.filter((id) => effective.modules[id].state === "off")
    expect(off).toEqual([
      "dashboards",
      "automations.headless",
      "openworkWeb",
      "workbot",
      "slackAssistant",
      "slackAssistant.headless",
      "openworkModels.analytics",
      "auditLogs",
      "auditLogs.export",
    ])
    expect(effective.entitlementSource).toBe("static")
  })
})

describe("KNOWN_LEGACY_DIVERGENCES", () => {
  const base: LegacyDivergenceContext = { inputs: extractLegacyOrgInputs({}), config: testInstanceConfig(), deployment: "cloud", disabled: [] }

  test("nothing applies to a default org on a default Cloud", () => {
    for (const id of MODULE_IDS) expect(matchKnownDivergence(id, base)).toBeNull()
  })

  test("each code applies only to its combination", () => {
    const web = { ...base, inputs: extractLegacyOrgInputs({ complimentaryAccess: { openworkWeb: true } }), disabled: ["connect"] }
    expect(matchKnownDivergence("openworkWeb", web)?.code).toBe("G2")
    expect(matchKnownDivergence("openworkWeb", { ...web, disabled: [] })).toBeNull()
    const workbot = { ...base, inputs: extractLegacyOrgInputs({ capabilities: { workbot: true } }), disabled: ["connect"] }
    expect(matchKnownDivergence("workbot", workbot)?.code).toBe("G3")
    expect(matchKnownDivergence("workbot", { ...workbot, config: testInstanceConfig({ infra: { workbotConfigured: false } }) })).toBeNull()
    const runtimeOff = { ...base, config: testInstanceConfig({ deprecatedFlags: { automationsRuntimeEnabled: false } }) }
    expect(matchKnownDivergence("automations.remoteSessions", runtimeOff)?.code).toBe("G4")
    expect(matchKnownDivergence("automations.remoteSessions", { ...runtimeOff, config: testInstanceConfig({ orgMode: "single_org", deprecatedFlags: { automationsRuntimeEnabled: false } }) })).toBeNull()
    const headless = { ...runtimeOff, inputs: extractLegacyOrgInputs({ capabilities: { headlessAutomations: true } }) }
    expect(matchKnownDivergence("automations.headless", headless)?.code).toBe("G11")
    expect(matchKnownDivergence("automations.headless", { ...headless, config: testInstanceConfig() })).toBeNull()
    const selfHosted: LegacyDivergenceContext = { ...base, deployment: "selfHosted", inputs: extractLegacyOrgInputs({ capabilities: { modelsAnalytics: true } }) }
    expect(matchKnownDivergence("openworkModels.analytics", selfHosted)?.code).toBe("G5")
    expect(matchKnownDivergence("freeInference", selfHosted)?.code).toBe("G5")
    expect(matchKnownDivergence("openworkModels.analytics", { ...selfHosted, deployment: "cloud" })).toBeNull()
  })

  test("codes are documented with a module and summary", () => {
    for (const divergence of KNOWN_LEGACY_DIVERGENCES) {
      expect(MODULE_IDS).toContain(divergence.moduleId)
      expect(divergence.summary.length).toBeGreaterThan(10)
    }
  })
})
