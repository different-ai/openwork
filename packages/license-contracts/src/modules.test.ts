import { describe, expect, test } from "vitest"
import { MODULE_IDS, type ModuleId } from "./module-ids"
import {
  CLOUD_FREE_PLAN_MODULES,
  computeModuleTopoOrder,
  hardDependencyClosure,
  hardEdges,
  MODULE_DEFINITIONS,
  MODULE_TOPO_ORDER,
  moduleAncestors,
  moduleChildren,
  validateLicenseModules,
  type ModuleDefinition,
} from "./modules"

/**
 * dependency-map.md §2 (with D42 / Q-B2: dashboards → mcpApps is soft).
 * Any edge or deployment change must show up as a diff here.
 */
const GRAPH: Record<ModuleId, { parent: ModuleId | null; hard: ModuleId[]; soft: ModuleId[]; cloudOnly?: true }> = {
  connect: { parent: null, hard: [], soft: ["marketplace"] },
  "connect.nativeProviders": { parent: "connect", hard: [], soft: [] },
  marketplace: { parent: null, hard: [], soft: ["connect", "workflows"] },
  "marketplace.githubSync": { parent: "marketplace", hard: [], soft: ["connect"] },
  workflows: { parent: null, hard: ["marketplace"], soft: ["connect", "automations"] },
  mcpApps: { parent: null, hard: ["connect", "marketplace"], soft: ["workflows"] },
  dashboards: { parent: null, hard: [], soft: ["mcpApps", "connect"] },
  automations: { parent: null, hard: [], soft: ["workflows", "openworkWeb", "aiGateway", "openworkModels", "customProviders", "desktopPolicies"] },
  "automations.headless": { parent: "automations", hard: [], soft: [] },
  "automations.remoteSessions": { parent: "automations", hard: [], soft: ["openworkWeb"] },
  openworkWeb: { parent: null, hard: ["connect"], soft: ["aiGateway", "openworkModels", "automations"] },
  workbot: { parent: null, hard: ["connect"], soft: ["automations.headless"] },
  slackAssistant: { parent: null, hard: ["connect"], soft: ["automations.remoteSessions", "openworkWeb"] },
  "slackAssistant.headless": { parent: "slackAssistant", hard: [], soft: [] },
  aiGateway: { parent: null, hard: [], soft: ["auditLogs"] },
  "aiGateway.usageLimits": { parent: "aiGateway", hard: [], soft: ["teams"] },
  openworkModels: { parent: null, hard: ["billing"], soft: ["customProviders"], cloudOnly: true },
  "openworkModels.analytics": { parent: "openworkModels", hard: [], soft: [], cloudOnly: true },
  freeInference: { parent: null, hard: [], soft: ["desktopPolicies"], cloudOnly: true },
  customProviders: { parent: null, hard: [], soft: ["desktopPolicies"] },
  desktopPolicies: { parent: null, hard: [], soft: ["teams"] },
  versionPinning: { parent: null, hard: [], soft: [] },
  branding: { parent: null, hard: [], soft: [] },
  analytics: { parent: null, hard: [], soft: ["workflows"] },
  auditLogs: { parent: null, hard: [], soft: [] },
  "auditLogs.export": { parent: "auditLogs", hard: [], soft: [] },
  teams: { parent: null, hard: [], soft: [] },
  advancedPermissions: { parent: null, hard: [], soft: [] },
  diagnostics: { parent: null, hard: [], soft: [] },
  billing: { parent: null, hard: [], soft: [], cloudOnly: true },
  enterpriseAuth: { parent: null, hard: [], soft: [] },
  "enterpriseAuth.sso": { parent: "enterpriseAuth", hard: [], soft: [] },
  "enterpriseAuth.scim": { parent: "enterpriseAuth", hard: ["enterpriseAuth.sso"], soft: ["teams"] },
  installLinks: { parent: null, hard: [], soft: ["branding", "versionPinning"] },
  webOrigins: { parent: null, hard: [], soft: [] },
}

const definitions: ModuleDefinition[] = MODULE_IDS.map((id) => MODULE_DEFINITIONS[id])

describe("registry shape", () => {
  test("keys equal MODULE_IDS in order and each id matches its key", () => {
    expect(Object.keys(MODULE_DEFINITIONS)).toEqual([...MODULE_IDS])
    for (const id of MODULE_IDS) expect(MODULE_DEFINITIONS[id].id).toBe(id)
  })

  test("matches the dependency-map graph snapshot", () => {
    for (const id of MODULE_IDS) {
      const definition = MODULE_DEFINITIONS[id]
      const expected = GRAPH[id]
      expect({ id, parent: definition.parent, hard: definition.dependsOn, soft: definition.softDependsOn })
        .toEqual({ id, parent: expected.parent, hard: expected.hard, soft: expected.soft })
      expect([id, definition.deployments]).toEqual([id, expected.cloudOnly ? ["cloud"] : ["cloud", "selfHosted"]])
    }
  })

  test("dotted ids have their prefix as parent, one level deep", () => {
    for (const definition of definitions) {
      const parts = definition.id.split(".")
      expect(parts.length).toBeLessThanOrEqual(2)
      if (parts.length === 2) {
        expect(definition.parent).toBe(parts[0])
        expect(MODULE_IDS).toContain(parts[0])
      } else {
        expect(definition.parent).toBeNull()
      }
    }
  })

  test("edges reference known ids without self, duplicates, overlap or parent repeats", () => {
    const known: readonly string[] = MODULE_IDS
    for (const definition of definitions) {
      const edges = [...definition.dependsOn, ...definition.softDependsOn]
      for (const edge of edges) expect(known).toContain(edge)
      expect(edges).not.toContain(definition.id)
      expect(new Set(definition.dependsOn).size).toBe(definition.dependsOn.length)
      expect(new Set(definition.softDependsOn).size).toBe(definition.softDependsOn.length)
      expect(new Set(edges).size).toBe(edges.length)
      if (definition.parent) expect(edges).not.toContain(definition.parent)
    }
  })

  test("is deeply frozen", () => {
    expect(Object.isFrozen(MODULE_DEFINITIONS)).toBe(true)
    for (const definition of definitions) {
      expect(Object.isFrozen(definition)).toBe(true)
      expect(Object.isFrozen(definition.dependsOn)).toBe(true)
      expect(Object.isFrozen(definition.softDependsOn)).toBe(true)
      expect(Object.isFrozen(definition.deployments)).toBe(true)
    }
  })

  test("names and descriptions are present and short", () => {
    for (const definition of definitions) {
      expect(definition.name.length).toBeGreaterThan(0)
      expect(definition.name.length).toBeLessThanOrEqual(40)
      expect(definition.description).toMatch(/^[A-Z].*\.$/)
    }
  })
})

describe("graph", () => {
  test("topological order lists every id once, after its hard dependencies", () => {
    expect([...MODULE_TOPO_ORDER].sort()).toEqual([...MODULE_IDS].sort())
    const position = new Map(MODULE_TOPO_ORDER.map((id, index) => [id, index]))
    for (const definition of definitions) {
      for (const dependency of hardEdges(definition)) {
        expect(position.get(dependency)).toBeLessThan(position.get(definition.id) ?? -1)
      }
    }
  })

  test("soft cycles (connect ↔ marketplace) don't affect the order", () => {
    expect(MODULE_DEFINITIONS.connect.softDependsOn).toContain("marketplace")
    expect(MODULE_DEFINITIONS.marketplace.softDependsOn).toContain("connect")
    expect(MODULE_TOPO_ORDER.slice(0, 3)).toEqual(["connect", "connect.nativeProviders", "marketplace"])
  })

  test("a hard cycle throws", () => {
    const cyclic = {
      ...MODULE_DEFINITIONS,
      connect: { ...MODULE_DEFINITIONS.connect, dependsOn: ["mcpApps"] },
    } satisfies Record<ModuleId, ModuleDefinition>
    expect(() => computeModuleTopoOrder(cyclic)).toThrow(/cycle/)
  })

  test("deployments are reachable through parent and hard dependencies", () => {
    for (const definition of definitions) {
      for (const dependency of hardEdges(definition)) {
        for (const deployment of definition.deployments) {
          expect([definition.id, MODULE_DEFINITIONS[dependency].deployments.includes(deployment)]).toEqual([definition.id, true])
        }
      }
    }
  })

  test("ancestors, children and closure", () => {
    expect(moduleAncestors("enterpriseAuth.scim")).toEqual(["enterpriseAuth"])
    expect(moduleAncestors("connect")).toEqual([])
    expect(moduleChildren("automations")).toEqual(["automations.headless", "automations.remoteSessions"])
    expect(moduleChildren("teams")).toEqual([])
    expect(hardDependencyClosure("enterpriseAuth.scim")).toEqual(["enterpriseAuth", "enterpriseAuth.sso"])
    expect(hardDependencyClosure("openworkModels.analytics")).toEqual(["billing", "openworkModels"])
    expect(hardDependencyClosure("mcpApps")).toEqual(["connect", "marketplace"])
    expect(hardDependencyClosure("dashboards")).toEqual([])
  })
})

describe("policy fields", () => {
  test("free ⇔ expiryPolicy n/a; restricted ⇔ transitionOperations with other", () => {
    for (const definition of definitions) {
      expect([definition.id, definition.entitlement === "free"]).toEqual([definition.id, definition.expiryPolicy === "n/a"])
      const restricted = definition.expiryPolicy === "restricted"
      expect([definition.id, definition.transitionOperations !== undefined]).toEqual([definition.id, restricted])
      if (definition.transitionOperations) expect(definition.transitionOperations.other).toBeDefined()
    }
  })

  test("cloud-only, free and no-toggle sets", () => {
    const where = (predicate: (definition: ModuleDefinition) => boolean) => definitions.filter(predicate).map((definition) => definition.id)
    expect(where((definition) => !definition.deployments.includes("selfHosted")))
      .toEqual(["openworkModels", "openworkModels.analytics", "freeInference", "billing"])
    expect(where((definition) => definition.entitlement === "free")).toEqual(["billing", "installLinks"])
    expect(where((definition) => definition.orgToggle === "none"))
      .toEqual(["billing", "enterpriseAuth", "enterpriseAuth.sso", "enterpriseAuth.scim"])
    expect(where((definition) => definition.expiryPolicy === "restricted")).toEqual(["enterpriseAuth.sso"])
  })

  test("SSO transition: members keep signing in, new SSO users are blocked (Q-B5)", () => {
    expect(MODULE_DEFINITIONS["enterpriseAuth.sso"].transitionOperations).toMatchObject({
      ssoSignIn: "allow",
      ssoJitProvision: "deny",
      other: "deny",
    })
  })
})

describe("CLOUD_FREE_PLAN_MODULES", () => {
  test("covers every id, grants free modules and passes license validation", () => {
    expect(Object.keys(CLOUD_FREE_PLAN_MODULES)).toEqual([...MODULE_IDS])
    for (const definition of definitions) {
      if (definition.entitlement === "free") expect(CLOUD_FREE_PLAN_MODULES[definition.id]).toBe(true)
    }
    expect(validateLicenseModules(CLOUD_FREE_PLAN_MODULES, { scope: "hosted_cloud_org" })).toEqual([])
  })
})

describe("validateLicenseModules", () => {
  test("reports unknown keys, D6, deployment and hard-dependency issues", () => {
    expect(validateLicenseModules({ "foo.bar": true, auth: true }, { scope: "external_den" }).map((issue) => issue.code))
      .toEqual(["unknown_module", "unknown_module"])
    expect(validateLicenseModules({ "aiGateway.usageLimits": true }, { scope: "external_den" }))
      .toEqual([{ code: "submodule_without_parent", module: "aiGateway.usageLimits", detail: "aiGateway" }])
    expect(validateLicenseModules({ freeInference: true }, { scope: "external_den" }))
      .toEqual([{ code: "not_on_deployment", module: "freeInference", detail: "selfHosted" }])
    expect(validateLicenseModules({ mcpApps: true, connect: true }, { scope: "external_den" }))
      .toEqual([{ code: "missing_hard_dependency", module: "mcpApps", detail: "marketplace" }])
  })

  test("free modules satisfy dependencies unless explicitly denied", () => {
    expect(validateLicenseModules({ openworkModels: true }, { scope: "hosted_cloud_org" })).toEqual([])
    expect(validateLicenseModules({ openworkModels: true, billing: false }, { scope: "hosted_cloud_org" }))
      .toEqual([{ code: "missing_hard_dependency", module: "openworkModels", detail: "billing" }])
  })

  test("every licensed module granted with its closure is valid on its deployments", () => {
    for (const definition of definitions) {
      for (const deployment of definition.deployments) {
        const modules = Object.fromEntries([definition.id, ...hardDependencyClosure(definition.id)].map((id) => [id, true]))
        const scope = deployment === "cloud" ? "hosted_cloud_org" : "external_den"
        expect([definition.id, validateLicenseModules(modules, { scope })]).toEqual([definition.id, []])
      }
    }
  })
})
