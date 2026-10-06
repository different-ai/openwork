import { describe, expect, test } from "vitest"
import { isModuleGroupId, MODULE_GROUPS, MODULE_IDS, nearestModuleAncestor, type ModuleId } from "./module-ids"
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
 * dependency-map.md §2a (D44 tree) with the §2 edges carried over
 * (D42 / Q-B2: dashboards → library.apps is soft).
 * Any edge or deployment change must show up as a diff here.
 */
const GRAPH: Record<ModuleId, { parent: ModuleId | null; hard: ModuleId[]; soft: ModuleId[]; cloudOnly?: true }> = {
  "org.members.teams": { parent: null, hard: [], soft: [] },
  "org.members.roles": { parent: null, hard: [], soft: [] },
  "org.auth.sso": { parent: null, hard: [], soft: [] },
  "org.auth.scim": { parent: null, hard: ["org.auth.sso"], soft: ["org.members.teams"] },
  "org.observability.auditLogs": { parent: null, hard: [], soft: [] },
  "org.observability.auditLogs.export": { parent: "org.observability.auditLogs", hard: [], soft: [] },
  "org.desktopPolicies": { parent: null, hard: [], soft: ["org.members.teams"] },
  "org.desktopPolicies.versionPinning": { parent: "org.desktopPolicies", hard: [], soft: [] },
  "org.installLinks": { parent: null, hard: [], soft: ["org.branding", "org.desktopPolicies.versionPinning"] },
  "org.branding": { parent: null, hard: [], soft: [] },
  "org.webOrigins": { parent: null, hard: [], soft: [] },
  "org.diagnostics": { parent: null, hard: [], soft: [] },
  "org.billing": { parent: null, hard: [], soft: [], cloudOnly: true },
  "ai.gateway": { parent: null, hard: [], soft: ["org.observability.auditLogs"] },
  "ai.gateway.usageLimits": { parent: "ai.gateway", hard: [], soft: ["org.members.teams"] },
  "ai.gateway.openworkModels": { parent: "ai.gateway", hard: ["org.billing"], soft: ["ai.customProviders"], cloudOnly: true },
  "ai.gateway.openworkModels.analytics": { parent: "ai.gateway.openworkModels", hard: [], soft: [], cloudOnly: true },
  "ai.gateway.freeInference": { parent: "ai.gateway", hard: [], soft: ["org.desktopPolicies"], cloudOnly: true },
  "ai.customProviders": { parent: null, hard: [], soft: ["org.desktopPolicies"] },
  "library.plugins": { parent: null, hard: [], soft: ["library.connectors", "library.workflows"] },
  "library.plugins.githubSync": { parent: "library.plugins", hard: [], soft: ["library.connectors"] },
  "library.workflows": { parent: null, hard: ["library.plugins"], soft: ["library.connectors", "automations"] },
  "library.apps": { parent: null, hard: ["library.plugins", "library.connectors"], soft: ["library.workflows"] },
  "library.connectors": { parent: null, hard: [], soft: ["library.plugins"] },
  "library.connectors.native.googleWorkspace": { parent: "library.connectors", hard: [], soft: [] },
  "library.connectors.native.microsoft365": { parent: "library.connectors", hard: [], soft: [] },
  "library.connectors.slackAssistant": { parent: "library.connectors", hard: [], soft: ["automations.remoteSessions", "openworkWeb"] },
  "library.connectors.slackAssistant.headless": { parent: "library.connectors.slackAssistant", hard: [], soft: [] },
  dashboards: { parent: null, hard: [], soft: ["library.apps", "library.connectors"] },
  automations: {
    parent: null,
    hard: [],
    soft: ["library.workflows", "openworkWeb", "ai.gateway", "ai.gateway.openworkModels", "ai.customProviders", "org.desktopPolicies"],
  },
  "automations.headless": { parent: "automations", hard: [], soft: [] },
  "automations.remoteSessions": { parent: "automations", hard: [], soft: ["openworkWeb"] },
  openworkWeb: { parent: null, hard: ["library.connectors"], soft: ["ai.gateway", "ai.gateway.openworkModels", "automations"] },
  workbot: { parent: null, hard: ["library.connectors"], soft: ["automations.headless"] },
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
      expect([id, definition.deployments]).toEqual([id, expected.cloudOnly ? ["cloud"] : ["cloud", "self_hosted"]])
    }
  })

  test("parent is the nearest module ancestor; groups are never parents (D44)", () => {
    for (const definition of definitions) {
      expect([definition.id, definition.parent]).toEqual([definition.id, nearestModuleAncestor(definition.id)])
      if (definition.parent) expect(definition.id.startsWith(`${definition.parent}.`)).toBe(true)
    }
  })

  test("group ids never appear as a parent or a dependency", () => {
    for (const definition of definitions) {
      for (const edge of [definition.parent, ...definition.dependsOn, ...definition.softDependsOn]) {
        expect([definition.id, edge !== null && isModuleGroupId(edge)]).toEqual([definition.id, false])
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

  test("soft cycles (library.connectors ↔ library.plugins) don't affect the order", () => {
    expect(MODULE_DEFINITIONS["library.connectors"].softDependsOn).toContain("library.plugins")
    expect(MODULE_DEFINITIONS["library.plugins"].softDependsOn).toContain("library.connectors")
    const position = new Map(MODULE_TOPO_ORDER.map((id, index) => [id, index]))
    expect(position.get("library.connectors")).toBeLessThan(position.get("library.apps") ?? -1)
  })

  test("a hard cycle throws", () => {
    const cyclic = {
      ...MODULE_DEFINITIONS,
      "library.connectors": { ...MODULE_DEFINITIONS["library.connectors"], dependsOn: ["library.apps"] },
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
    expect(moduleAncestors("ai.gateway.openworkModels.analytics")).toEqual(["ai.gateway.openworkModels", "ai.gateway"])
    expect(moduleAncestors("org.auth.scim")).toEqual([])
    expect(moduleAncestors("library.connectors.native.microsoft365")).toEqual(["library.connectors"])
    expect(moduleChildren("automations")).toEqual(["automations.headless", "automations.remoteSessions"])
    expect(moduleChildren("library.connectors")).toEqual([
      "library.connectors.native.googleWorkspace",
      "library.connectors.native.microsoft365",
      "library.connectors.slackAssistant",
    ])
    expect(moduleChildren("ai.gateway")).toEqual(["ai.gateway.usageLimits", "ai.gateway.openworkModels", "ai.gateway.freeInference"])
    expect(moduleChildren("org.members.teams")).toEqual([])
    expect(hardDependencyClosure("org.auth.scim")).toEqual(["org.auth.sso"])
    expect(hardDependencyClosure("ai.gateway.openworkModels.analytics")).toEqual(["org.billing", "ai.gateway", "ai.gateway.openworkModels"])
    expect(hardDependencyClosure("library.apps")).toEqual(["library.plugins", "library.connectors"])
    expect(hardDependencyClosure("library.connectors.slackAssistant.headless")).toEqual(["library.connectors", "library.connectors.slackAssistant"])
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
    expect(where((definition) => !definition.deployments.includes("self_hosted")))
      .toEqual(["org.billing", "ai.gateway.openworkModels", "ai.gateway.openworkModels.analytics", "ai.gateway.freeInference"])
    expect(where((definition) => definition.entitlement === "free")).toEqual(["org.installLinks", "org.billing"])
    expect(where((definition) => definition.orgToggle === "none")).toEqual(["org.auth.sso", "org.auth.scim", "org.billing"])
    expect(where((definition) => definition.expiryPolicy === "restricted")).toEqual(["org.auth.sso"])
  })

  test("SSO transition: members keep signing in, new SSO users are blocked (Q-B5)", () => {
    expect(MODULE_DEFINITIONS["org.auth.sso"].transitionOperations).toMatchObject({
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
  test("reports unknown keys (including groups), D6, deployment and hard-dependency issues", () => {
    expect(validateLicenseModules({ "foo.bar": true, auth: true, "org.auth": true }, { scope: "external_den" }).map((issue) => issue.code))
      .toEqual(["unknown_module", "unknown_module", "unknown_module"])
    expect(validateLicenseModules({ "ai.gateway.usageLimits": true }, { scope: "external_den" }))
      .toEqual([{ code: "submodule_without_parent", module: "ai.gateway.usageLimits", detail: "ai.gateway" }])
    expect(validateLicenseModules({ "ai.gateway": true, "ai.gateway.freeInference": true }, { scope: "external_den" }))
      .toEqual([{ code: "not_on_deployment", module: "ai.gateway.freeInference", detail: "self_hosted" }])
    expect(validateLicenseModules({ "library.apps": true, "library.connectors": true }, { scope: "external_den" }))
      .toEqual([{ code: "missing_hard_dependency", module: "library.apps", detail: "library.plugins" }])
  })

  test("free modules satisfy dependencies unless explicitly denied", () => {
    expect(validateLicenseModules({ "ai.gateway": true, "ai.gateway.openworkModels": true }, { scope: "hosted_cloud_org" })).toEqual([])
    expect(validateLicenseModules({ "ai.gateway": true, "ai.gateway.openworkModels": true, "org.billing": false }, { scope: "hosted_cloud_org" }))
      .toEqual([{ code: "missing_hard_dependency", module: "ai.gateway.openworkModels", detail: "org.billing" }])
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

  test("groups are never module definitions", () => {
    const keys: readonly string[] = Object.keys(MODULE_DEFINITIONS)
    for (const group of MODULE_GROUPS) expect(keys).not.toContain(group)
  })
})
