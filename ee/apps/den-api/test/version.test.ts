import { expect, test } from "bun:test"
import { PUBLISHED_DESKTOP_VERSIONS } from "../src/generated/desktop-versions.js"
import { denApiAppVersion } from "../src/version.js"

test("latest app version matches the newest published desktop version", () => {
  expect(denApiAppVersion.latestAppVersion).toBe(PUBLISHED_DESKTOP_VERSIONS[0])
})
