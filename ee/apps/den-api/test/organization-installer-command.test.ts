import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { buildOrganizationInstaller, parseOrganizationInstallerConfig } from "../src/utils/organization-installer-command.js"
import { organizationInstallerArtifactNames } from "../src/utils/organization-installer-bundle.js"
import { createStoredZip } from "../src/utils/zip-append.js"

function organizationConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    appName: "Acme Work",
    appVersion: "9.9.9",
    clientName: "Acme Robotics",
    webUrl: "https://work.acme.example",
    apiUrl: "https://api.acme.example",
    requireSignin: true,
    logoUrl: "https://work.acme.example/wordmark.png",
    iconUrl: "https://work.acme.example/icon.png",
    ...overrides,
  }
}

describe("organization installer command", () => {
  test("builds the same deterministic organization bundle from local release artifacts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-enterprise-installer-"))
    try {
      const configPath = path.join(dir, "openwork-installer.json")
      const artifactsDir = path.join(dir, "artifacts")
      const outputDir = path.join(dir, "output")
      mkdirSync(artifactsDir)
      writeFileSync(configPath, `${JSON.stringify(organizationConfig(), null, 2)}\n`)
      const names = organizationInstallerArtifactNames("mac-arm64", "v9.9.9")
      const installerBytes = Buffer.from(createStoredZip([
        { name: "OpenWork Installer.app/Contents/MacOS/openwork-installer", content: Buffer.from("signed-installer") },
      ]))
      const desktopBytes = Buffer.from("signed-desktop")
      writeFileSync(path.join(artifactsDir, names.genericFileName), installerBytes)
      writeFileSync(path.join(artifactsDir, names.desktopFileName), desktopBytes)

      const result = await buildOrganizationInstaller({
        configPath,
        platform: "mac-arm64",
        output: outputDir,
        artifactsDir,
      })

      expect(result.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.checksumPath && existsSync(result.checksumPath)).toBe(true)
      const extracted = path.join(dir, "extracted")
      mkdirSync(extracted)
      const unzip = spawnSync("unzip", ["-q", result.outputPath, "-d", extracted], { encoding: "utf8" })
      expect(unzip.status, unzip.stderr || unzip.stdout).toBe(0)
      expect(readFileSync(path.join(extracted, names.desktopFileName))).toEqual(desktopBytes)
      expect(readFileSync(path.join(extracted, "OpenWork Installer.app/Contents/MacOS/openwork-installer"))).toEqual(Buffer.from("signed-installer"))
      expect(JSON.parse(readFileSync(path.join(extracted, "openwork-installer.json"), "utf8"))).toEqual(organizationConfig())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("dry-run validates local artifacts without writing output", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-enterprise-installer-dry-run-"))
    try {
      const configPath = path.join(dir, "openwork-installer.json")
      const artifactsDir = path.join(dir, "artifacts")
      const outputDir = path.join(dir, "output")
      mkdirSync(artifactsDir)
      writeFileSync(configPath, JSON.stringify(organizationConfig()))
      const names = organizationInstallerArtifactNames("mac-arm64", "v9.9.9")
      writeFileSync(path.join(artifactsDir, names.genericFileName), Buffer.from(createStoredZip([
        { name: "OpenWork Installer.app/binary", content: Buffer.from("signed-installer") },
      ])))
      writeFileSync(path.join(artifactsDir, names.desktopFileName), "signed-desktop")

      const result = await buildOrganizationInstaller({
        configPath,
        platform: "mac-arm64",
        output: outputDir,
        artifactsDir,
        dryRun: true,
      })

      expect(result.bundleSha256).toBeNull()
      expect(result.checksumPath).toBeNull()
      expect(existsSync(result.outputPath)).toBe(false)
      expect(existsSync(outputDir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("packages unchanged Windows installer and desktop bytes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-enterprise-installer-windows-"))
    try {
      const configPath = path.join(dir, "openwork-installer.json")
      const artifactsDir = path.join(dir, "artifacts")
      const outputDir = path.join(dir, "output")
      mkdirSync(artifactsDir)
      writeFileSync(configPath, JSON.stringify(organizationConfig()))
      const names = organizationInstallerArtifactNames("win-x64", "v9.9.9")
      const installerBytes = Buffer.from("signed-generic-windows")
      const desktopBytes = Buffer.from("signed-desktop-windows")
      writeFileSync(path.join(artifactsDir, names.genericFileName), installerBytes)
      writeFileSync(path.join(artifactsDir, names.desktopFileName), desktopBytes)

      const result = await buildOrganizationInstaller({
        configPath,
        platform: "win-x64",
        output: outputDir,
        artifactsDir,
      })
      const extracted = path.join(dir, "extracted")
      mkdirSync(extracted)
      const unzip = spawnSync("unzip", ["-q", result.outputPath, "-d", extracted], { encoding: "utf8" })
      expect(unzip.status, unzip.stderr || unzip.stdout).toBe(0)
      expect(readFileSync(path.join(extracted, "OpenWork Installer.exe"))).toEqual(installerBytes)
      expect(readFileSync(path.join(extracted, names.desktopFileName))).toEqual(desktopBytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("requires HTTPS for production organization configuration", () => {
    expect(() => parseOrganizationInstallerConfig(organizationConfig({ webUrl: "http://work.acme.example" }))).toThrow("must use HTTPS")
    expect(() => parseOrganizationInstallerConfig(organizationConfig({ webUrl: "http://127.0.0.1:3000" }))).not.toThrow()
    expect(() => parseOrganizationInstallerConfig(organizationConfig({ appVersion: "../../private" }))).toThrow("release-safe version")
  })
})
