import { describe, expect, test } from "bun:test"
import {
  normalizeOrganizationCapabilities,
  organizationHasCapability,
} from "../src/organization-capabilities.js"

describe("normalizeOrganizationCapabilities", () => {
  test("defaults every capability to false when metadata is empty", () => {
    expect(normalizeOrganizationCapabilities(null)).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities(undefined)).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities({})).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities("")).toEqual({ installLinks: false })
  })

  test("reads an explicit opt-in from record metadata", () => {
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: true } })).toEqual({ installLinks: true })
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: false } })).toEqual({ installLinks: false })
  })

  test("reads an explicit opt-in from JSON string metadata", () => {
    expect(normalizeOrganizationCapabilities(JSON.stringify({ capabilities: { installLinks: true } }))).toEqual({ installLinks: true })
  })

  test("treats anything but literal true as off", () => {
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: "true" } })).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: 1 } })).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities({ capabilities: null })).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities({ capabilities: [] })).toEqual({ installLinks: false })
    expect(normalizeOrganizationCapabilities("not json")).toEqual({ installLinks: false })
  })

  test("ignores unrelated metadata keys", () => {
    const metadata = {
      limits: { members: 5, workers: 1 },
      plan: { tier: "enterprise", source: "manual" },
      capabilities: { installLinks: true },
    }
    expect(normalizeOrganizationCapabilities(metadata)).toEqual({ installLinks: true })
  })
})

describe("organizationHasCapability", () => {
  test("is false by default and true only with an explicit opt-in", () => {
    expect(organizationHasCapability(null, "installLinks")).toBe(false)
    expect(organizationHasCapability({ capabilities: {} }, "installLinks")).toBe(false)
    expect(organizationHasCapability({ capabilities: { installLinks: true } }, "installLinks")).toBe(true)
    expect(organizationHasCapability(JSON.stringify({ capabilities: { installLinks: true } }), "installLinks")).toBe(true)
  })
})
