import { emptyOrganizationModules } from "@openwork-ee/den-db/organization-modules"
import { resolveFeatures, type FeatureOverrides, type FeatureRollouts } from "@openwork/features"
import { describe, expect, test } from "vitest"
import { planOrganizationModulesBackfill } from "./organization-modules-backfill.js"
import { legacyDisabledModules } from "./organization-modules-legacy.js"

const now = new Date("2026-10-05T12:00:00.000Z")

describe("legacyDisabledModules (00-legacy-mapping §G.1)", () => {
  const overrideValues = [undefined, true, false] as const
  const rolloutValues: ReadonlyArray<{ name: string; rollouts: FeatureRollouts }> = [
    { name: "on", rollouts: { installLinks: { enabled: true, killed: false }, mcpConnections: { enabled: true, killed: false } } },
    { name: "off", rollouts: { installLinks: { enabled: false, killed: false }, mcpConnections: { enabled: false, killed: false } } },
    { name: "killed", rollouts: { installLinks: { enabled: true, killed: true }, mcpConnections: { enabled: true, killed: true } } },
  ]
  const matrix = overrideValues.flatMap((installLinks) => overrideValues.flatMap((mcpConnections) => rolloutValues.map(({ name, rollouts }) => {
    const overrides: FeatureOverrides = { auditLogs: true, workbot: false }
    if (installLinks !== undefined) overrides.installLinks = installLinks
    if (mcpConnections !== undefined) overrides.mcpConnections = mcpConnections
    return { installLinks, mcpConnections, rollout: name, rollouts, overrides }
  })))

  test("covers every absent/true/false override crossed with rollout on/off/killed", () => {
    expect(matrix).toHaveLength(27)
  })

  test.each(matrix)("installLinks=$installLinks mcpConnections=$mcpConnections rollout=$rollout", ({ installLinks, mcpConnections, rollouts, overrides }) => {
    const expected = [...(mcpConnections === false ? ["library.connectors"] : []), ...(installLinks === false ? ["org.installLinks"] : [])]
    expect(legacyDisabledModules(overrides)).toEqual(expected)
    // Rollout state changes the effective feature but never the org opt-out (D43: effective = module AND flag).
    const features = resolveFeatures({ deployment: "cloud", locks: {}, rollouts, overrides })
    if (mcpConnections === false) expect(features.mcpConnections).toBe(false)
    expect(planOrganizationModulesBackfill({ id: "org_a", modules: null, overrides }))
      .toEqual(expected.length ? { action: "write", disabled: expected } : { action: "nothing_to_copy" })
  })

  test("grant features are never copied", () => {
    expect(legacyDisabledModules({ auditLogs: false, workbot: false, slackAssistant: false, orgManagedDashboards: false, modelsAnalytics: false })).toEqual([])
  })
})

test("planOrganizationModulesBackfill never overwrites a stored document", () => {
  const stored = { ...emptyOrganizationModules(now), revision: 2 }
  expect(planOrganizationModulesBackfill({ id: "org_a", modules: stored, overrides: { installLinks: false } }).action).toBe("already_present")
  expect(planOrganizationModulesBackfill({ id: "org_a", modules: JSON.stringify(stored), overrides: { mcpConnections: false } }).action).toBe("already_present")
  expect(planOrganizationModulesBackfill({ id: "org_a", modules: { revision: "x" }, overrides: {} }).action).toBe("invalid_document")
})
