import { describe, expect, test } from "vitest"
import { isModuleId, mapModuleIds, MODULE_IDS, moduleIdSchema, parseModuleIdList } from "./module-ids"
import snapshot from "./module-ids.snapshot.json"

describe("MODULE_IDS", () => {
  test("has 35 unique, well-formed ids", () => {
    expect(MODULE_IDS).toHaveLength(35)
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length)
    for (const id of MODULE_IDS) expect(id).toMatch(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)?$/)
  })

  test("is append-only: the committed snapshot is a prefix", () => {
    expect(snapshot.length).toBeLessThanOrEqual(MODULE_IDS.length)
    expect(MODULE_IDS.slice(0, snapshot.length)).toEqual(snapshot)
  })

  test("follows the decisions on retired and renamed ids", () => {
    const ids: readonly string[] = MODULE_IDS
    for (const retired of ["customRoles", "workflows.generatedViews", "enterpriseAuth.requireSso", "remoteSessions", "auth", "userFlags"]) {
      expect(ids).not.toContain(retired)
    }
    expect(ids).toContain("advancedPermissions")
    expect(ids).toContain("automations.remoteSessions")
  })
})

describe("isModuleId and parseModuleIdList", () => {
  test("recognizes only registered ids", () => {
    expect(isModuleId("aiGateway.usageLimits")).toBe(true)
    expect(isModuleId("customRoles")).toBe(false)
    expect(isModuleId(42)).toBe(false)
    expect(isModuleId("toString")).toBe(false)
  })

  test("drops unknown ids, dedupes and keeps registry order", () => {
    expect(parseModuleIdList(["webOrigins", "foo.bar", "connect", 7, null, "webOrigins", "workflows.generatedViews", "aiGateway"]))
      .toEqual(["connect", "aiGateway", "webOrigins"])
  })

  test("the strict schema refuses unknown ids", () => {
    expect(moduleIdSchema.safeParse("teams").success).toBe(true)
    expect(moduleIdSchema.safeParse("customRoles").success).toBe(false)
  })

  test("mapModuleIds builds a complete record in registry order", () => {
    const record = mapModuleIds((id) => id.length)
    expect(Object.keys(record)).toEqual([...MODULE_IDS])
  })
})
