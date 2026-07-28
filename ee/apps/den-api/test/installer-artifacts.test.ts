import { beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let installerReleaseAssetUrl: typeof import("../src/utils/installer-artifacts.js")["installerReleaseAssetUrl"]
let desktopReleaseAssetName: typeof import("../src/utils/installer-artifacts.js")["desktopReleaseAssetName"]
let cloudDesktopReleaseAssetName: typeof import("../src/utils/installer-artifacts.js")["cloudDesktopReleaseAssetName"]
let enterpriseDesktopReleaseAssetName: typeof import("../src/utils/installer-artifacts.js")["enterpriseDesktopReleaseAssetName"]
let resolveConfiguredInstallerArtifact: typeof import("../src/utils/installer-artifacts.js")["resolveConfiguredInstallerArtifact"]
let envModule: typeof import("../src/env.js")

beforeAll(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  ;({
    desktopReleaseAssetName,
    cloudDesktopReleaseAssetName,
    enterpriseDesktopReleaseAssetName,
    installerReleaseAssetUrl,
    resolveConfiguredInstallerArtifact,
  } = await import("../src/utils/installer-artifacts.js"))
})

test("builds the installer asset URL for the configured release", () => {
  expect(installerReleaseAssetUrl("openwork-enterprise-mac-arm64-9.9.9.dmg", {
    releaseTag: "v9.9.9+build 2",
    releaseRepo: "different-ai/openwork",
  })).toBe("https://github.com/different-ai/openwork/releases/download/v9.9.9%2Bbuild%202/openwork-enterprise-mac-arm64-9.9.9.dmg")
})

test.each([
  ["mac-arm64", "v9.9.9", "openwork-mac-arm64-9.9.9.dmg"],
  ["mac-x64", "9.9.9", "openwork-mac-x64-9.9.9.dmg"],
  ["win-x64", "v9.9.9", "openwork-win-x64-9.9.9.exe"],
  ["linux-x64", "v9.9.9", "openwork-linux-x86_64-9.9.9.AppImage"],
  ["linux-arm64", "v9.9.9", "openwork-linux-arm64-9.9.9.AppImage"],
])("maps %s to the standard release artifact", (platform, releaseTag, expected) => {
  expect(desktopReleaseAssetName(platform, releaseTag)).toBe(expected)
})

test.each([
  ["mac-arm64", "v9.9.9", "openwork-enterprise-mac-arm64-9.9.9.dmg"],
  ["win-x64", "v9.9.9", "openwork-enterprise-win-x64-9.9.9.exe"],
  ["linux-x64", "v9.9.9", "openwork-enterprise-linux-x86_64-9.9.9.AppImage"],
])("maps %s to the enterprise release artifact", (platform, releaseTag, expected) => {
  expect(enterpriseDesktopReleaseAssetName(platform, releaseTag)).toBe(expected)
})

test.each([
  ["mac-arm64", "v9.9.9", "openwork-cloud-mac-arm64-9.9.9.dmg"],
  ["win-x64", "v9.9.9", "openwork-cloud-win-x64-9.9.9.exe"],
  ["linux-x64", "v9.9.9", "openwork-cloud-linux-x86_64-9.9.9.AppImage"],
])("maps %s to the Cloud release artifact", (platform, releaseTag, expected) => {
  expect(cloudDesktopReleaseAssetName(platform, releaseTag)).toBe(expected)
})

test("resolves only a mounted installer asset and reports its size", async () => {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), "ow-installer-artifacts-"))
  const fileName = "openwork-enterprise-win-x64-9.9.9.exe"
  writeFileSync(path.join(artifactsDir, fileName), "installer-asset")
  envModule.env.installerArtifactsDir = artifactsDir

  await expect(resolveConfiguredInstallerArtifact(fileName)).resolves.toEqual({
    filePath: path.join(artifactsDir, fileName),
    fileName,
    size: 15,
  })
  await expect(resolveConfiguredInstallerArtifact("missing.exe")).resolves.toBeNull()
  await expect(resolveConfiguredInstallerArtifact("openwork-cloud-win-x64-9.9.9.exe")).resolves.toBeNull()

  envModule.env.installerArtifactsDir = undefined
})

test("ignores a directory with the expected filename", async () => {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), "ow-installer-artifacts-"))
  const fileName = "openwork-cloud-win-x64-9.9.9.exe"
  mkdirSync(path.join(artifactsDir, fileName))
  envModule.env.installerArtifactsDir = artifactsDir

  await expect(resolveConfiguredInstallerArtifact(fileName)).resolves.toBeNull()

  envModule.env.installerArtifactsDir = undefined
})
