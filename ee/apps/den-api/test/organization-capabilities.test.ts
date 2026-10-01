import { describe, expect, test } from "bun:test"
import {
  normalizeOrganizationCapabilities,
  ORGANIZATION_CAPABILITY_KEYS,
  organizationCapabilityKeySchema,
  organizationHasCapability,
  organizationAppMcpServersEnabled,
  organizationManagedDashboardsEnabled,
  readOrganizationCapabilityOverrides,
} from "../src/organization-capabilities.js"

const defaultCapabilities = { installLinks: false, mcpConnections: false, modelsAnalytics: false, auditLogs: false, orgManagedDashboards: false, appMcpServers: false, slackAssistant: false, slackAssistantHeadless: false, headlessAutomations: false, cloudBrowser: false, workbot: false }

test("auditLogs accepts only canonical literal booleans and defaults off even for Enterprise", () => {
  expect(organizationCapabilityKeySchema.parse("auditLogs")).toBe("auditLogs")
  for (const auditLogs of [undefined, null, true, false, "true", "false", 1, {}, []]) {
    const metadata = { plan: { tier: "enterprise" }, auditLogs: true, capabilities: { auditLogs } }
    for (const input of [metadata, JSON.stringify(metadata)]) {
      expect(organizationHasCapability(input, "auditLogs")).toBe(auditLogs === true)
      expect(readOrganizationCapabilityOverrides(input)).toEqual(typeof auditLogs === "boolean" ? { auditLogs } : {})
    }
  }
})

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
  test("retired gateway rollout metadata never becomes an active capability or override", () => {
    expect(ORGANIZATION_CAPABILITY_KEYS).not.toContain("gatewayDashboard")
    expect(organizationCapabilityKeySchema.safeParse("gatewayDashboard").success).toBe(false)
    for (const gatewayDashboard of [undefined, null, true, false, "true", "false", 1, 0, {}, []]) {
      const metadata = { capabilities: { gatewayDashboard, installLinks: true, mcpConnections: false } }
      for (const input of [metadata, JSON.stringify(metadata)]) {
        expect(normalizeOrganizationCapabilities(input)).toEqual({ ...defaultCapabilities, installLinks: true })
        expect(readOrganizationCapabilityOverrides(input)).toEqual({ installLinks: true, mcpConnections: false })
      }
    }

    for (const metadata of [null, undefined, "not json", "null", "[]", {}, { capabilities: null }, { capabilities: "true" }, { capabilities: [] }]) {
      expect(normalizeOrganizationCapabilities(metadata)).toEqual(defaultCapabilities)
      expect(readOrganizationCapabilityOverrides(metadata)).toEqual({})
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

test("Slack Assistant is an explicit platform capability in object and JSON metadata", () => {
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    for (const input of [{ capabilities: { slackAssistant: value } }, JSON.stringify({ capabilities: { slackAssistant: value } })]) {
      expect(organizationHasCapability(input, "slackAssistant")).toBe(false)
      expect(readOrganizationCapabilityOverrides(input)).toEqual(value === false ? { slackAssistant: false } : {})
    }
  }
  for (const input of [{ capabilities: { slackAssistant: true } }, '{"capabilities":{"slackAssistant":true}}']) {
    expect(normalizeOrganizationCapabilities(input)).toEqual({ ...defaultCapabilities, slackAssistant: true })
    expect(readOrganizationCapabilityOverrides(input)).toEqual({ slackAssistant: true })
  }
  expect(organizationHasCapability({ complimentaryAccess: { openworkWeb: true } }, "slackAssistant")).toBe(false)
})

test("orgManagedDashboards is default-off and enabled only by a literal true", () => {
  for (const orgManagedDashboards of [undefined, null, false, "true", 1, {}, []]) {
    const metadata = { capabilities: { orgManagedDashboards } }
    expect(organizationManagedDashboardsEnabled(metadata)).toBe(false)
    expect(organizationManagedDashboardsEnabled(JSON.stringify(metadata))).toBe(false)
  }
  for (const metadata of [null, undefined, "", "not json", {}, { capabilities: null }]) {
    expect(organizationManagedDashboardsEnabled(metadata)).toBe(false)
  }
  const enabled = { plan: { tier: "team" }, capabilities: { installLinks: false, orgManagedDashboards: true } }
  expect(organizationManagedDashboardsEnabled(enabled)).toBe(true)
  expect(organizationManagedDashboardsEnabled(JSON.stringify(enabled))).toBe(true)
  expect(organizationCapabilityKeySchema.parse("orgManagedDashboards")).toBe("orgManagedDashboards")
  expect(normalizeOrganizationCapabilities(enabled)).toEqual({ ...defaultCapabilities, orgManagedDashboards: true })
  expect(readOrganizationCapabilityOverrides(enabled)).toEqual({ installLinks: false, orgManagedDashboards: true })
})

test("appMcpServers is default-off and enabled only by a literal true", () => {
  for (const appMcpServers of [undefined, null, false, "true", 1, {}, []]) {
    const metadata = { capabilities: { appMcpServers } }
    expect(organizationAppMcpServersEnabled(metadata)).toBe(false)
    expect(organizationAppMcpServersEnabled(JSON.stringify(metadata))).toBe(false)
  }
  for (const metadata of [null, undefined, "", "not json", {}, { capabilities: null }]) {
    expect(organizationAppMcpServersEnabled(metadata)).toBe(false)
  }
  const enabled = { plan: { tier: "team" }, capabilities: { installLinks: false, appMcpServers: true } }
  expect(organizationAppMcpServersEnabled(enabled)).toBe(true)
  expect(organizationAppMcpServersEnabled(JSON.stringify(enabled))).toBe(true)
  expect(organizationCapabilityKeySchema.parse("appMcpServers")).toBe("appMcpServers")
  expect(normalizeOrganizationCapabilities(enabled)).toEqual({ ...defaultCapabilities, appMcpServers: true })
  expect(readOrganizationCapabilityOverrides(enabled)).toEqual({ installLinks: false, appMcpServers: true })
})

test("the Slack headless runtime is its own default-off platform capability", () => {
  expect(organizationCapabilityKeySchema.parse("slackAssistantHeadless")).toBe("slackAssistantHeadless")
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    expect(organizationHasCapability({ capabilities: { slackAssistant: true, slackAssistantHeadless: value } }, "slackAssistantHeadless")).toBe(false)
  }
  const enabled = { capabilities: { slackAssistant: true, slackAssistantHeadless: true } }
  expect(normalizeOrganizationCapabilities(enabled)).toEqual({ ...defaultCapabilities, slackAssistant: true, slackAssistantHeadless: true })
  expect(readOrganizationCapabilityOverrides(JSON.stringify(enabled))).toEqual({ slackAssistant: true, slackAssistantHeadless: true })
})

test("headless Automations are their own default-off platform capability", () => {
  expect(organizationCapabilityKeySchema.parse("headlessAutomations")).toBe("headlessAutomations")
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    expect(organizationHasCapability({ capabilities: { headlessAutomations: value } }, "headlessAutomations")).toBe(false)
  }
  const enabled = { capabilities: { headlessAutomations: true } }
  expect(normalizeOrganizationCapabilities(enabled)).toEqual({ ...defaultCapabilities, headlessAutomations: true })
  expect(readOrganizationCapabilityOverrides(JSON.stringify(enabled))).toEqual({ headlessAutomations: true })
})

test("the cloud browser is its own default-off platform capability", () => {
  expect(organizationCapabilityKeySchema.parse("cloudBrowser")).toBe("cloudBrowser")
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    expect(organizationHasCapability({ capabilities: { cloudBrowser: value } }, "cloudBrowser")).toBe(false)
  }
  const enabled = { capabilities: { cloudBrowser: true } }
  expect(normalizeOrganizationCapabilities(enabled)).toEqual({ ...defaultCapabilities, cloudBrowser: true })
  expect(readOrganizationCapabilityOverrides(JSON.stringify(enabled))).toEqual({ cloudBrowser: true })
})

test("Workbot is its own default-off platform capability", () => {
  expect(organizationCapabilityKeySchema.parse("workbot")).toBe("workbot")
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    expect(organizationHasCapability({ capabilities: { workbot: value } }, "workbot")).toBe(false)
  }
  expect(normalizeOrganizationCapabilities({ capabilities: { workbot: true } })).toEqual({ ...defaultCapabilities, workbot: true })
})
