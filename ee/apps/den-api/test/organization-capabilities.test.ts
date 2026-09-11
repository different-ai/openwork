import { describe, expect, test } from "bun:test"
import {
  normalizeOrganizationCapabilities,
  organizationHasCapability,
  readOrganizationCapabilityOverrides,
} from "../src/organization-capabilities.js"

const defaultCapabilities = { installLinks: false, mcpConnections: false, modelsAnalytics: false, gatewayDashboard: false }

describe("normalizeOrganizationCapabilities", () => {
  test("defaults every capability to false when metadata is empty", () => {
    expect(normalizeOrganizationCapabilities(null)).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities(undefined)).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities({})).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities("")).toEqual(defaultCapabilities)
  })

  test("reads an explicit opt-in from record metadata", () => {
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: true } })).toEqual({ ...defaultCapabilities, installLinks: true })
    expect(normalizeOrganizationCapabilities({ capabilities: { mcpConnections: true } })).toEqual({ ...defaultCapabilities, mcpConnections: true })
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: false, mcpConnections: false } })).toEqual(defaultCapabilities)
  })

  test("reads an explicit opt-in from JSON string metadata", () => {
    expect(normalizeOrganizationCapabilities(JSON.stringify({ capabilities: { installLinks: true, mcpConnections: true } }))).toEqual({ ...defaultCapabilities, installLinks: true, mcpConnections: true })
  })

  test("ignores retired rollout keys for features that are now always on", () => {
    expect(normalizeOrganizationCapabilities({ capabilities: { workflows: true, codemodeScripts: true, remoteMcpApps: true, cloud: true } })).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities({ capabilities: { workflows: false, remoteMcpApps: false } })).toEqual(defaultCapabilities)
  })

  test("treats anything but literal true as off", () => {
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: "true", mcpConnections: "true" } })).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities({ capabilities: { installLinks: 1, mcpConnections: 1 } })).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities({ capabilities: null })).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities({ capabilities: [] })).toEqual(defaultCapabilities)
    expect(normalizeOrganizationCapabilities("not json")).toEqual(defaultCapabilities)
  })

  test("ignores unrelated metadata keys", () => {
    const metadata = {
      limits: { members: 5, workers: 1 },
      plan: { tier: "enterprise", source: "manual" },
      capabilities: { installLinks: true, mcpConnections: true },
    }
    expect(normalizeOrganizationCapabilities(metadata)).toEqual({ ...defaultCapabilities, installLinks: true, mcpConnections: true })
  })
})

describe("readOrganizationCapabilityOverrides", () => {
  test("leaves absent capability keys absent", () => {
    expect(readOrganizationCapabilityOverrides(null)).toEqual({})
    expect(readOrganizationCapabilityOverrides({})).toEqual({})
    expect(readOrganizationCapabilityOverrides({ capabilities: {} })).toEqual({})
  })

  test("preserves explicit boolean false overrides", () => {
    expect(readOrganizationCapabilityOverrides({ capabilities: { installLinks: false, mcpConnections: false } })).toEqual({ installLinks: false, mcpConnections: false })
  })

  test("drops retired rollout overrides", () => {
    expect(readOrganizationCapabilityOverrides({ capabilities: { workflows: false, codemodeScripts: true, remoteMcpApps: true } })).toEqual({})
    expect(readOrganizationCapabilityOverrides(JSON.stringify({ capabilities: { workflows: true, remoteMcpApps: false } }))).toEqual({})
  })

  test("ignores unrelated and non-boolean metadata", () => {
    expect(readOrganizationCapabilityOverrides({
      limits: { members: 10 },
      plan: { tier: "enterprise" },
      capabilities: { installLinks: "true", mcpConnections: 1, cloud: "true", otherCapability: true },
    })).toEqual({})
  })

  test("reads explicit overrides from JSON metadata", () => {
    expect(readOrganizationCapabilityOverrides(JSON.stringify({ capabilities: { installLinks: true, mcpConnections: false, cloud: true } }))).toEqual({ installLinks: true, mcpConnections: false })
  })
})

describe("organizationHasCapability", () => {
  test("gateway dashboard requires a literal true in object or JSON metadata", () => {
    for (const gatewayDashboard of [undefined, null, false, "true", "false", 1, 0, {}, []]) {
      const metadata = { capabilities: { gatewayDashboard } }
      expect(organizationHasCapability(metadata, "gatewayDashboard")).toBe(false)
      expect(organizationHasCapability(JSON.stringify(metadata), "gatewayDashboard")).toBe(false)
      expect(readOrganizationCapabilityOverrides(metadata)).toEqual(gatewayDashboard === false ? { gatewayDashboard: false } : {})
    }

    for (const metadata of [null, undefined, "not json", "null", "[]", {}, { capabilities: null }, { capabilities: "true" }, { capabilities: [] }]) {
      expect(organizationHasCapability(metadata, "gatewayDashboard")).toBe(false)
      expect(readOrganizationCapabilityOverrides(metadata)).toEqual({})
    }

    const metadata = { capabilities: { gatewayDashboard: true } }
    for (const input of [metadata, JSON.stringify(metadata)]) {
      expect(normalizeOrganizationCapabilities(input)).toEqual({ ...defaultCapabilities, gatewayDashboard: true })
      expect(organizationHasCapability(input, "gatewayDashboard")).toBe(true)
      expect(readOrganizationCapabilityOverrides(input)).toEqual({ gatewayDashboard: true })
    }
  })

  test("is false by default and true only with an explicit opt-in", () => {
    expect(organizationHasCapability(null, "installLinks")).toBe(false)
    expect(organizationHasCapability(null, "mcpConnections")).toBe(false)
    expect(organizationHasCapability({ capabilities: {} }, "installLinks")).toBe(false)
    expect(organizationHasCapability({ capabilities: {} }, "mcpConnections")).toBe(false)
    expect(organizationHasCapability({ capabilities: { installLinks: true } }, "installLinks")).toBe(true)
    expect(organizationHasCapability({ capabilities: { mcpConnections: true } }, "mcpConnections")).toBe(true)
    expect(organizationHasCapability(JSON.stringify({ capabilities: { installLinks: true } }), "installLinks")).toBe(true)
    expect(organizationHasCapability(JSON.stringify({ capabilities: { mcpConnections: true } }), "mcpConnections")).toBe(true)
  })
})
