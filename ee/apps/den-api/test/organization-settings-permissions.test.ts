import { describe, expect, test } from "bun:test"
import { isDesktopVersionOnlyOrganizationUpdate } from "../src/organization-settings-permissions.js"

describe("organization settings permissions", () => {
  test("recognizes the desktop-version-only update allowed for admins", () => {
    expect(isDesktopVersionOnlyOrganizationUpdate({
      allowedDesktopVersions: ["0.17.32"],
    })).toBe(true)
    expect(isDesktopVersionOnlyOrganizationUpdate({
      allowedDesktopVersions: null,
    })).toBe(true)
  })

  test("keeps all other organization fields owner-only", () => {
    expect(isDesktopVersionOnlyOrganizationUpdate({
      allowedDesktopVersions: ["0.17.32"],
      name: "Renamed workspace",
    })).toBe(false)
    expect(isDesktopVersionOnlyOrganizationUpdate({
      requireSso: true,
    })).toBe(false)
  })
})
