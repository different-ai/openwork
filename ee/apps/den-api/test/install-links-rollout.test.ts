import { describe, expect, test } from "bun:test"
import { organizationInstallLinksEnabled } from "../src/capability-sources/install-links-rollout.js"

describe("organizationInstallLinksEnabled", () => {
  test("is active by default when deployment gating is off", () => {
    expect(organizationInstallLinksEnabled(null, { gatingEnabled: false })).toBe(true)
    expect(organizationInstallLinksEnabled({ capabilities: { installLinks: false } }, { gatingEnabled: false })).toBe(true)
  })

  test("requires explicit organization opt-in when hosted gating is on", () => {
    expect(organizationInstallLinksEnabled(null, { gatingEnabled: true })).toBe(false)
    expect(organizationInstallLinksEnabled({ capabilities: { installLinks: false } }, { gatingEnabled: true })).toBe(false)
    expect(organizationInstallLinksEnabled({ capabilities: { installLinks: true } }, { gatingEnabled: true })).toBe(true)
  })
})
