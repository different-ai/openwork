import { describe, expect, test } from "bun:test"
import {
  allPublishedDesktopVersionsAllowed,
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

    expect(allPublishedDesktopVersionsAllowed({
      draftVersions: ["0.17.21", "0.17.22", "0.17.23", "0.17.24"],
      publishedVersions: ["0.17.22", "0.17.23", "0.17.24"],
    })).toBe(false)
  })

  test("represents an unrestricted policy by selecting the full inventory", () => {
    const publishedVersions = ["0.17.22", "0.17.23", "0.17.24"]
    const draftVersions = initialAllowedDesktopVersions(null, publishedVersions)
    expect(allPublishedDesktopVersionsAllowed({ draftVersions, publishedVersions })).toBe(true)
  })
})
