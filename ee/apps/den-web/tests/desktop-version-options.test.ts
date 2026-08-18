import { describe, expect, test } from "bun:test"
import {
  allowedDesktopVersionsForPolicy,
  desktopVersionPolicyMode,
  getDesktopVersionMetadata,
  initialAllowedDesktopVersions,
} from "../app/(den)/dashboard/_components/desktop-version-options"

describe("desktop version options", () => {
  test("uses the explicit published inventory without synthesizing intermediate versions", () => {
    expect(getDesktopVersionMetadata({
      minAppVersion: "0.11.207",
      latestAppVersion: "0.17.24",
      publishedDesktopVersions: ["0.17.24", "0.17.22", "0.17.23"],
    })?.publishedDesktopVersions).toEqual(["0.17.24", "0.17.23", "0.17.22"])
  })

  test("falls back to the latest version from older Den APIs", () => {
    expect(getDesktopVersionMetadata({
      minAppVersion: "0.11.207",
      latestAppVersion: "0.17.24",
    })?.publishedDesktopVersions).toEqual(["0.17.24"])
  })

  test("preserves stored versions that are absent from the current inventory", () => {
    expect(initialAllowedDesktopVersions(
      ["0.17.21", "0.17.23"],
      ["0.17.22", "0.17.23", "0.17.24"],
    )).toEqual(["0.17.21", "0.17.23"])
  })

  test("represents unrestricted and pinned policies explicitly", () => {
    expect(desktopVersionPolicyMode(null)).toBe("latest")
    expect(desktopVersionPolicyMode(undefined)).toBe("latest")
    expect(desktopVersionPolicyMode(["0.18.28"])).toBe("pinned")

    expect(allowedDesktopVersionsForPolicy("latest", ["0.18.28"]))
      .toBeNull()
    expect(allowedDesktopVersionsForPolicy("pinned", ["0.18.28", "0.18.28"]))
      .toEqual(["0.18.28"])
  })
})
