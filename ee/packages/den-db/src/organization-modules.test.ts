import { describe, expect, test } from "vitest"
import {
  affectedRows,
  emptyOrganizationModules,
  normalizeDisabledModules,
  organizationColumnsWithoutModules,
  parseOrganizationModulesColumn,
  readOrganizationModulesRevision,
  type OrganizationModules,
} from "./organization-modules"

const now = new Date("2026-10-05T12:00:00.000Z")
const stored: OrganizationModules = { ...emptyOrganizationModules(now), revision: 3, disabled: ["installLinks", "retiredModule"] }

describe("parseOrganizationModulesColumn", () => {
  const fixtures: Array<[string, unknown, "absent" | "valid" | "invalid", number | null]> = [
    ["null", null, "absent", 0],
    ["undefined", undefined, "absent", 0],
    ["JSON null text", "null", "absent", 0],
    ["object (mysql2)", stored, "valid", 3],
    ["JSON text (PlanetScale)", JSON.stringify(stored), "valid", 3],
    ["broken JSON text", "{not json", "invalid", null],
    ["wrong schemaVersion", { ...stored, schemaVersion: 2 }, "invalid", 3],
    ["negative revision", { ...stored, revision: -1 }, "invalid", null],
    ["fractional revision", { ...stored, revision: 1.5 }, "invalid", null],
    ["bad timestamp", { ...stored, updatedAt: "yesterday" }, "invalid", 3],
    ["array", [], "invalid", null],
    ["too many opt-outs", { ...stored, disabled: Array.from({ length: 129 }, (_, index) => `m${index}`) }, "invalid", 3],
  ]

  test.each(fixtures)("%s", (_name, value, status, revision) => {
    const parsed = parseOrganizationModulesColumn(value)
    expect(parsed.status).toBe(status)
    expect(parsed.revision).toBe(revision)
    expect(readOrganizationModulesRevision(value)).toBe(revision)
    if (parsed.status === "invalid") expect(parsed.issues.length).toBeGreaterThan(0)
  })

  test("keeps unknown module ids so a downgrade never loses an opt-out", () => {
    const parsed = parseOrganizationModulesColumn(stored)
    expect(parsed.status === "valid" && parsed.doc.disabled).toEqual(["installLinks", "retiredModule"])
  })
})

test("normalizeDisabledModules dedupes, sorts and keeps unknown ids", () => {
  expect(normalizeDisabledModules(["installLinks", "connect", "installLinks", "zUnknown"])).toEqual(["connect", "installLinks", "zUnknown"])
})

test("emptyOrganizationModules is the NULL-equivalent document", () => {
  expect(emptyOrganizationModules(now)).toEqual({ schemaVersion: 1, revision: 0, disabled: [], updatedAt: now.toISOString(), updatedBy: null })
})

test("affectedRows reads both mysql2 and PlanetScale results", () => {
  expect(affectedRows([{ affectedRows: 1 }, undefined])).toBe(1)
  expect(affectedRows({ rowsAffected: 0 })).toBe(0)
  expect(affectedRows(null)).toBe(0)
})

test("client-facing org selects exclude the stored document", () => {
  expect(Object.keys(organizationColumnsWithoutModules)).not.toContain("modules")
  expect(Object.keys(organizationColumnsWithoutModules)).toContain("metadata")
})
