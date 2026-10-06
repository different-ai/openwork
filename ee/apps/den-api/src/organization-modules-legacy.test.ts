import { emptyOrganizationModules } from "@openwork-ee/den-db/organization-modules"
import { describe, expect, test } from "vitest"
import { memberFacingMcpConnectionsEnabled } from "./capability-sources/external-mcp-rollout.js"
import { organizationInstallLinksEnabled } from "./capability-sources/install-links-rollout.js"
import { planOrganizationModulesBackfill } from "./organization-modules-backfill.js"
import { applyLegacyKillSwitchChanges, legacyDisabledModules, legacyKillSwitchChanges } from "./organization-modules-legacy.js"

const now = new Date("2026-10-05T12:00:00.000Z")

describe("legacyDisabledModules (00-legacy-mapping §G.1)", () => {
  const values = [true, false, undefined, "false", 0]
  const matrix = values.flatMap((installLinks) => values.flatMap((mcpConnections) => values.flatMap((connectEnabled) => values.map((mcpConnectionsEnabled) => {
    const metadata: Record<string, unknown> = { capabilities: { installLinks, mcpConnections, auditLogs: true, workflows: false } }
    if (connectEnabled !== undefined) metadata.connectEnabled = connectEnabled
    if (mcpConnectionsEnabled !== undefined) metadata.mcpConnectionsEnabled = mcpConnectionsEnabled
    return { installLinks, mcpConnections, connectEnabled, mcpConnectionsEnabled, metadata }
  }))))

  test("covers every true/false/absent/non-boolean combination", () => {
    expect(matrix).toHaveLength(625)
  })

  test.each(matrix)("installLinks=$installLinks mcpConnections=$mcpConnections connectEnabled=$connectEnabled mcpConnectionsEnabled=$mcpConnectionsEnabled", ({ installLinks, mcpConnections, connectEnabled, mcpConnectionsEnabled, metadata }) => {
    const expected = [
      ...(memberFacingMcpConnectionsEnabled(metadata) ? [] : ["connect"]),
      ...(organizationInstallLinksEnabled(metadata) ? [] : ["installLinks"]),
    ]
    // Only a literal false disables; the capability outranks the flat aliases (I1, I2).
    const connectOff = mcpConnections === false
      || (mcpConnections !== true && connectEnabled !== true && mcpConnectionsEnabled !== true && (connectEnabled === false || mcpConnectionsEnabled === false))
    expect(expected.includes("connect")).toBe(connectOff)
    expect(expected.includes("installLinks")).toBe(installLinks === false)
    expect(legacyDisabledModules(metadata)).toEqual(expected)
    expect(legacyDisabledModules(JSON.stringify(metadata))).toEqual(expected)
  })

  test.each([null, undefined, "", "{broken", "[]", "42", { capabilities: "nope" }, { capabilities: [false] }])("unreadable metadata %j disables nothing", (metadata) => {
    expect(legacyDisabledModules(metadata)).toEqual([])
  })

  test("grant capabilities are never copied", () => {
    expect(legacyDisabledModules({ capabilities: { auditLogs: false, workbot: false, slackAssistant: false, appMcpServers: false } })).toEqual([])
  })
})

describe("legacy kill-switch dual-write (§G.3)", () => {
  test("reports only the switches a write flipped", () => {
    expect(legacyKillSwitchChanges({}, { capabilities: { mcpConnections: false } })).toEqual({ disable: ["connect"], enable: [] })
    expect(legacyKillSwitchChanges({ capabilities: { installLinks: false } }, { capabilities: {} })).toEqual({ disable: [], enable: ["installLinks"] })
    expect(legacyKillSwitchChanges({ connectEnabled: false }, { connectEnabled: false, capabilities: { mcpConnections: true } })).toEqual({ disable: [], enable: ["connect"] })
    expect(legacyKillSwitchChanges({ capabilities: { auditLogs: false } }, { capabilities: { auditLogs: true } })).toEqual({ disable: [], enable: [] })
  })

  test("applies changes without touching other opt-outs", () => {
    const doc = { ...emptyOrganizationModules(now), revision: 4, disabled: ["installLinks", "teams"] }
    expect(applyLegacyKillSwitchChanges(doc, { disable: ["connect"], enable: ["installLinks"] }).disabled).toEqual(["teams", "connect"])
    expect(applyLegacyKillSwitchChanges(doc, { disable: [], enable: [] })).toEqual(doc)
  })
})

test("planOrganizationModulesBackfill writes only explicit kill switches into a NULL column", () => {
  const stored = { ...emptyOrganizationModules(now), revision: 2 }
  expect(planOrganizationModulesBackfill({ id: "org_a", metadata: { capabilities: { installLinks: false, workbot: true } }, modules: null }))
    .toEqual({ action: "write", disabled: ["installLinks"] })
  expect(planOrganizationModulesBackfill({ id: "org_a", metadata: JSON.stringify({ mcpConnectionsEnabled: false }), modules: null }))
    .toEqual({ action: "write", disabled: ["connect"] })
  expect(planOrganizationModulesBackfill({ id: "org_a", metadata: { capabilities: { auditLogs: true } }, modules: null })).toEqual({ action: "nothing_to_copy" })
  expect(planOrganizationModulesBackfill({ id: "org_a", metadata: { capabilities: { installLinks: false } }, modules: stored }).action).toBe("already_present")
  expect(planOrganizationModulesBackfill({ id: "org_a", metadata: null, modules: { revision: "x" } }).action).toBe("invalid_document")
})
