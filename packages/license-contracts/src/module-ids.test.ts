import { describe, expect, test } from "vitest"
import {
  isModuleGroupId,
  isModuleId,
  mapModuleIds,
  MODULE_GROUPS,
  MODULE_ID_MAX_SEGMENTS,
  MODULE_IDS,
  moduleIdPrefixes,
  moduleIdSchema,
  nearestModuleAncestor,
  parseModuleIdList,
} from "./module-ids"
import snapshot from "./module-ids.snapshot.json"

const SEGMENT = /^[a-z][A-Za-z0-9]*$/

describe("MODULE_IDS and MODULE_GROUPS (D44)", () => {
  test("34 unique modules and 7 unique groups", () => {
    expect(MODULE_IDS).toHaveLength(34)
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length)
    expect([...MODULE_GROUPS]).toEqual(["org", "org.members", "org.auth", "org.observability", "ai", "library", "library.connectors.native"])
  })

  test("ids are camelCase location paths of at most 4 segments", () => {
    expect(MODULE_ID_MAX_SEGMENTS).toBe(4)
    for (const id of [...MODULE_IDS, ...MODULE_GROUPS]) {
      const segments = id.split(".")
      expect([id, segments.length <= MODULE_ID_MAX_SEGMENTS]).toEqual([id, true])
      for (const segment of segments) expect([id, segment]).toEqual([id, expect.stringMatching(SEGMENT)])
    }
  })

  test("no id is both a module and a group", () => {
    const modules: readonly string[] = MODULE_IDS
    for (const group of MODULE_GROUPS) expect(modules).not.toContain(group)
  })

  test("every prefix of a module or group is a module or a group", () => {
    for (const id of [...MODULE_IDS, ...MODULE_GROUPS]) {
      for (const prefix of moduleIdPrefixes(id)) {
        expect([id, prefix, isModuleId(prefix) || isModuleGroupId(prefix)]).toEqual([id, prefix, true])
      }
    }
  })

  test("every group has at least one module under it", () => {
    for (const group of MODULE_GROUPS) {
      expect([group, MODULE_IDS.some((id) => id.startsWith(`${group}.`))]).toEqual([group, true])
    }
  })

  test("is append-only: the committed snapshot is a prefix", () => {
    expect(snapshot.length).toBeLessThanOrEqual(MODULE_IDS.length)
    expect(MODULE_IDS.slice(0, snapshot.length)).toEqual(snapshot)
  })

  test("retired and pre-D44 ids are gone", () => {
    const ids: readonly string[] = MODULE_IDS
    for (const retired of [
      "customRoles",
      "workflows.generatedViews",
      "enterpriseAuth",
      "enterpriseAuth.sso",
      "enterpriseAuth.requireSso",
      "remoteSessions",
      "auth",
      "userFlags",
      "analytics",
      "connect",
      "connect.nativeProviders",
      "marketplace",
      "mcpApps",
      "aiGateway",
      "teams",
      "advancedPermissions",
    ]) {
      expect(ids).not.toContain(retired)
    }
    expect(ids).toContain("org.members.roles")
    expect(ids).toContain("automations.remoteSessions")
  })
})

describe("nearestModuleAncestor", () => {
  test("skips groups and stops at the nearest module", () => {
    expect(moduleIdPrefixes("library.connectors.native.googleWorkspace")).toEqual(["library.connectors.native", "library.connectors", "library"])
    expect(nearestModuleAncestor("library.connectors.native.googleWorkspace")).toBe("library.connectors")
    expect(nearestModuleAncestor("ai.gateway.openworkModels.analytics")).toBe("ai.gateway.openworkModels")
    expect(nearestModuleAncestor("org.observability.auditLogs.export")).toBe("org.observability.auditLogs")
    expect(nearestModuleAncestor("org.auth.scim")).toBeNull()
    expect(nearestModuleAncestor("org.desktopPolicies")).toBeNull()
    expect(nearestModuleAncestor("dashboards")).toBeNull()
  })
})

describe("isModuleId, isModuleGroupId and parseModuleIdList", () => {
  test("recognizes only registered ids", () => {
    expect(isModuleId("ai.gateway.usageLimits")).toBe(true)
    expect(isModuleId("org.auth")).toBe(false)
    expect(isModuleId("customRoles")).toBe(false)
    expect(isModuleId(42)).toBe(false)
    expect(isModuleId("toString")).toBe(false)
    expect(isModuleGroupId("org.auth")).toBe(true)
    expect(isModuleGroupId("org.auth.sso")).toBe(false)
  })

  test("drops unknown ids and groups, dedupes and keeps registry order", () => {
    expect(parseModuleIdList(["org.webOrigins", "foo.bar", "library.connectors", 7, null, "org.webOrigins", "org", "ai.gateway"]))
      .toEqual(["org.webOrigins", "ai.gateway", "library.connectors"])
  })

  test("the strict schema refuses unknown ids and groups", () => {
    expect(moduleIdSchema.safeParse("org.members.teams").success).toBe(true)
    expect(moduleIdSchema.safeParse("org.members").success).toBe(false)
    expect(moduleIdSchema.safeParse("teams").success).toBe(false)
  })

  test("mapModuleIds builds a complete record in registry order", () => {
    const record = mapModuleIds((id) => id.length)
    expect(Object.keys(record)).toEqual([...MODULE_IDS])
  })
})
