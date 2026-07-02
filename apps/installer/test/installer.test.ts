import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { desktopBootstrapPath } from "../src/bootstrap-path"
import { resolveInstallerConfig } from "../src/config"
import { writeBootstrapConfig } from "../src/install"
import { releaseAssetFor } from "../src/release-asset"

describe("desktopBootstrapPath", () => {
  test("honors the explicit override", () => {
    expect(desktopBootstrapPath({ OPENWORK_DESKTOP_BOOTSTRAP_PATH: "/tmp/custom.json" }, "darwin")).toBe("/tmp/custom.json")
  })

  test("prefers XDG_CONFIG_HOME on every platform", () => {
    expect(desktopBootstrapPath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "openwork", "desktop-bootstrap.json"))
    expect(desktopBootstrapPath({ XDG_CONFIG_HOME: "/xdg" }, "win32")).toBe(path.join("/xdg", "openwork", "desktop-bootstrap.json"))
  })

  test("uses APPDATA on Windows and ~/.config elsewhere", () => {
    expect(desktopBootstrapPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")).toBe(
      path.join("C:\\Users\\u\\AppData\\Roaming", "openwork", "desktop-bootstrap.json"),
    )
    expect(desktopBootstrapPath({}, "darwin")).toBe(path.join(os.homedir(), ".config", "openwork", "desktop-bootstrap.json"))
  })
})

describe("releaseAssetFor", () => {
  test("resolves per-platform asset names", () => {
    expect(releaseAssetFor("v0.17.7", "darwin", "arm64").fileName).toBe("openwork-mac-arm64-0.17.7.dmg")
    expect(releaseAssetFor("0.17.7", "darwin", "x64").fileName).toBe("openwork-mac-x64-0.17.7.dmg")
    expect(releaseAssetFor("0.17.7", "win32", "x64").fileName).toBe("openwork-win-x64-0.17.7.exe")
    expect(releaseAssetFor("0.17.7", "linux", "x64").fileName).toBe("openwork-linux-x86_64-0.17.7.AppImage")
    expect(releaseAssetFor("0.17.7", "linux", "arm64").fileName).toBe("openwork-linux-arm64-0.17.7.AppImage")
  })

  test("builds the release download URL from the version tag", () => {
    expect(releaseAssetFor("0.17.7", "darwin", "arm64").url).toBe(
      "https://github.com/different-ai/openwork/releases/download/v0.17.7/openwork-mac-arm64-0.17.7.dmg",
    )
  })

  test("rejects unsupported targets", () => {
    expect(() => releaseAssetFor("0.17.7", "win32", "arm64")).toThrow()
    expect(() => releaseAssetFor("", "darwin", "arm64")).toThrow()
  })
})

describe("resolveInstallerConfig", () => {
  test("reads env overrides and normalizes URLs", () => {
    const config = resolveInstallerConfig({
      OPENWORK_INSTALLER_CLIENT_NAME: "Acme Corp",
      OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com/",
      OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
      OPENWORK_INSTALLER_REQUIRE_SIGNIN: "true",
    })
    expect(config).toEqual({
      clientName: "Acme Corp",
      webUrl: "https://openwork.acme.com",
      apiUrl: "https://openwork-api.acme.com",
      logoUrl: null,
      requireSignin: true,
    })
  })

  test("accepts an optional logo URL and rejects non-http logos", () => {
    const config = resolveInstallerConfig({
      OPENWORK_INSTALLER_CLIENT_NAME: "Acme",
      OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com",
      OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
      OPENWORK_INSTALLER_LOGO_URL: "https://acme.com/logo.svg",
    })
    expect(config.logoUrl).toBe("https://acme.com/logo.svg")
    expect(() =>
      resolveInstallerConfig({
        OPENWORK_INSTALLER_CLIENT_NAME: "Acme",
        OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com",
        OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
        OPENWORK_INSTALLER_LOGO_URL: "file:///etc/passwd",
      }),
    ).toThrow()
  })

  test("fails without a configured deployment", () => {
    expect(() => resolveInstallerConfig({})).toThrow()
  })
})

describe("writeBootstrapConfig", () => {
  test("writes the deployment config and preserves existing extra fields", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-test-"))
    const target = path.join(dir, "desktop-bootstrap.json")
    try {
      writeFileSync(target, JSON.stringify({ baseUrl: "https://old.example.com", handoff: { grant: "keep-me" } }))
      const written = writeBootstrapConfig(
        { clientName: "Acme", webUrl: "https://openwork.acme.com", apiUrl: "https://openwork-api.acme.com", requireSignin: true },
        { OPENWORK_DESKTOP_BOOTSTRAP_PATH: target },
      )
      expect(written).toBe(target)
      const parsed = JSON.parse(readFileSync(target, "utf8"))
      expect(parsed.baseUrl).toBe("https://openwork.acme.com")
      expect(parsed.apiBaseUrl).toBe("https://openwork-api.acme.com")
      expect(parsed.requireSignin).toBe(true)
      expect(parsed.handoff).toEqual({ grant: "keep-me" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
