import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { installConfigUrlFor, parseInstallerFilenameTag } from "@openwork/install-config"

import { desktopBootstrapPath } from "../src/bootstrap-path"
import { parseInstallLinkInput, resolveInstallerConfig } from "../src/config"
import { isTranslocatedPath, parseMountTableLine, readSidecarConfig, resolveTranslocatedOriginalPath } from "../src/config-sources"
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
  test("reads env overrides and normalizes URLs", async () => {
    const { config, source } = await resolveInstallerConfig({ env: {
      OPENWORK_INSTALLER_CLIENT_NAME: "Acme Corp",
      OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com/",
      OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
      OPENWORK_INSTALLER_REQUIRE_SIGNIN: "true",
    } })
    expect(source).toBe("env")
    expect(config).toEqual({
      clientName: "Acme Corp",
      webUrl: "https://openwork.acme.com",
      apiUrl: "https://openwork-api.acme.com",
      logoUrl: null,
      requireSignin: true,
    })
  })

  test("accepts an optional logo URL and rejects non-http logos", async () => {
    const { config } = await resolveInstallerConfig({ env: {
      OPENWORK_INSTALLER_CLIENT_NAME: "Acme",
      OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com",
      OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
      OPENWORK_INSTALLER_LOGO_URL: "https://acme.com/logo.svg",
    } })
    expect(config.logoUrl).toBe("https://acme.com/logo.svg")
    await expect(
      resolveInstallerConfig({
        env: {
        OPENWORK_INSTALLER_CLIENT_NAME: "Acme",
        OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com",
        OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
        OPENWORK_INSTALLER_LOGO_URL: "file:///etc/passwd",
        },
      }),
    ).rejects.toThrow()
  })

  test("fails without a configured deployment", async () => {
    await expect(resolveInstallerConfig({ env: {}, execPath: path.join(os.tmpdir(), "openwork-installer") })).rejects.toThrow()
  })

  test("prefers env overrides over sidecar config", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-precedence-"))
    try {
      const execPath = path.join(dir, "openwork-installer")
      writeFileSync(execPath, "")
      writeFileSync(path.join(dir, "openwork-installer.json"), JSON.stringify({
        clientName: "Sidecar",
        webUrl: "https://sidecar.example.com",
        apiUrl: "https://sidecar-api.example.com",
        requireSignin: true,
        logoUrl: null,
      }))

      const resolution = await resolveInstallerConfig({
        env: {
          OPENWORK_INSTALLER_CLIENT_NAME: "Env",
          OPENWORK_INSTALLER_WEB_URL: "https://env.example.com",
          OPENWORK_INSTALLER_API_URL: "https://env-api.example.com",
        },
        execPath,
      })

      expect(resolution.source).toBe("env")
      expect(resolution.config.clientName).toBe("Env")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // macOS-only semantics: .app bundles (and their slash-separated exec paths)
  // do not exist on Windows, where path.join builds a backslashed path the
  // bundle matcher rightly rejects.
  test.skipIf(process.platform === "win32")("reads sidecar next to the enclosing app bundle", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-app-sidecar-"))
    try {
      const macOsDir = path.join(dir, "OpenWork Installer.app", "Contents", "MacOS")
      mkdirSync(macOsDir, { recursive: true })
      const execPath = path.join(macOsDir, "OpenWork Installer")
      writeFileSync(execPath, "")
      writeFileSync(path.join(dir, "openwork-installer.json"), JSON.stringify({
        clientName: "Bundle Sidecar",
        webUrl: "https://bundle.example.com",
        apiUrl: "https://bundle-api.example.com",
        requireSignin: true,
        logoUrl: null,
      }))

      const resolution = await resolveInstallerConfig({ env: {}, execPath })
      expect(resolution.source).toBe("sidecar")
      expect(resolution.config.clientName).toBe("Bundle Sidecar")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("macOS App Translocation helpers", () => {
  test("parses a normal mount table line", () => {
    expect(parseMountTableLine("/private/tmp/OpenWork Installer.app on /private/var/folders/abc/T/AppTranslocation/123 (nullfs, local, read-only)")).toEqual({
      source: "/private/tmp/OpenWork Installer.app",
      mountPoint: "/private/var/folders/abc/T/AppTranslocation/123",
      options: "nullfs, local, read-only",
    })
  })

  test("parses paths with spaces and on in the source", () => {
    expect(parseMountTableLine("/private/tmp/folder with spaces/source on disk/OpenWork Installer.app on /private/var/folders/abc/T/AppTranslocation/UUID With Space (nullfs, local)")).toEqual({
      source: "/private/tmp/folder with spaces/source on disk/OpenWork Installer.app",
      mountPoint: "/private/var/folders/abc/T/AppTranslocation/UUID With Space",
      options: "nullfs, local",
    })
  })

  test("ignores junk mount table lines", () => {
    expect(parseMountTableLine("not a mount table line")).toBeNull()
    expect(parseMountTableLine("/private/tmp/OpenWork Installer.app on /private/var/folders/abc/T/AppTranslocation/123")).toBeNull()
  })

  test("resolves the original app through the translocated /d path", () => {
    const mountPoint = "/private/var/folders/abc/T/AppTranslocation/123"
    const source = "/private/tmp/OpenWork Installer.app"
    const execPath = `${mountPoint}/d/OpenWork Installer.app/Contents/MacOS/openwork-installer`

    expect(resolveTranslocatedOriginalPath(execPath, `${source} on ${mountPoint} (nullfs, local, nodev)\n`)).toBe(source)
  })

  test("skips non-nullfs mounts", () => {
    const mountPoint = "/private/var/folders/abc/T/AppTranslocation/123"
    const source = "/private/tmp/OpenWork Installer.app"
    const execPath = `${mountPoint}/d/OpenWork Installer.app/Contents/MacOS/openwork-installer`

    expect(resolveTranslocatedOriginalPath(execPath, `${source} on ${mountPoint} (apfs, local)\n`)).toBeNull()
  })

  test("requires a mountpoint path-prefix boundary", () => {
    const mountPoint = "/private/var/folders/abc/T/AppTranslocation/123"
    const source = "/private/tmp/OpenWork Installer.app"
    const execPath = `${mountPoint}-suffix/d/OpenWork Installer.app/Contents/MacOS/openwork-installer`

    expect(resolveTranslocatedOriginalPath(execPath, `${source} on ${mountPoint} (nullfs, local)\n`)).toBeNull()
  })

  test("returns null when no translocation mount matches", () => {
    const execPath = "/private/var/folders/abc/T/AppTranslocation/123/d/OpenWork Installer.app/Contents/MacOS/openwork-installer"
    const mountTable = "/private/tmp/OpenWork Installer.app on /private/var/folders/abc/T/AppTranslocation/other (nullfs, local)\n"

    expect(resolveTranslocatedOriginalPath(execPath, mountTable)).toBeNull()
  })

  test("detects App Translocation paths", () => {
    expect(isTranslocatedPath("/private/var/folders/abc/T/AppTranslocation/123/d/OpenWork Installer.app/Contents/MacOS/openwork-installer")).toBe(true)
    expect(isTranslocatedPath("/Applications/OpenWork Installer.app/Contents/MacOS/openwork-installer")).toBe(false)
  })

  test("reads the sidecar next to the original translocated app", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-translocated-"))
    try {
      const originalAppPath = path.join(dir, "OpenWork Installer.app")
      const mountPoint = "/private/var/folders/abc/T/AppTranslocation/123"
      const execPath = `${mountPoint}/d/OpenWork Installer.app/Contents/MacOS/openwork-installer`
      mkdirSync(originalAppPath, { recursive: true })
      writeFileSync(path.join(dir, "openwork-installer.json"), JSON.stringify({
        clientName: "Translocated Sidecar",
        webUrl: "https://translocated.example.com",
        apiUrl: "https://translocated-api.example.com",
        requireSignin: true,
        logoUrl: null,
      }))

      expect(readSidecarConfig({
        execPath,
        readMountTable: () => `${originalAppPath} on ${mountPoint} (nullfs, local, read-only)\n`,
        warn: () => undefined,
      })).toEqual({
        clientName: "Translocated Sidecar",
        webUrl: "https://translocated.example.com",
        apiUrl: "https://translocated-api.example.com",
        requireSignin: true,
        logoUrl: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls through when the translocation mount is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-translocated-missing-"))
    try {
      const originalAppPath = path.join(dir, "OpenWork Installer.app")
      const execPath = "/private/var/folders/abc/T/AppTranslocation/123/d/OpenWork Installer.app/Contents/MacOS/openwork-installer"
      writeFileSync(path.join(dir, "openwork-installer.json"), JSON.stringify({
        clientName: "Missing Mount Sidecar",
        webUrl: "https://missing.example.com",
        apiUrl: "https://missing-api.example.com",
        requireSignin: false,
        logoUrl: null,
      }))

      expect(readSidecarConfig({
        execPath,
        readMountTable: () => `${originalAppPath} on /private/var/folders/abc/T/AppTranslocation/other (nullfs, local)\n`,
        warn: () => undefined,
      })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("install link helpers", () => {
  test("parses filename stamps and install config URLs", () => {
    expect(parseInstallerFilenameTag("OpenWork-Installer--127.0.0.1_8790--abcDEF12.exe")).toEqual({
      host: "127.0.0.1:8790",
      token: "abcDEF12",
    })
    expect(parseInstallerFilenameTag("OpenWork-Installer--api.example.com--abcDEF12")).toEqual({
      host: "api.example.com",
      token: "abcDEF12",
    })
    expect(installConfigUrlFor("127.0.0.1:8790", "abcDEF12")).toBe("http://127.0.0.1:8790/v1/install-config?token=abcDEF12")
    expect(installConfigUrlFor("api.example.com", "abcDEF12")).toBe("https://api.example.com/v1/install-config?token=abcDEF12")
  })

  test("parses pasted install-link inputs", () => {
    expect(parseInstallLinkInput("https://app.example.com/install?token=abcDEF12")?.url).toBe(
      "https://app.example.com/api/den/v1/install-config?token=abcDEF12",
    )
    expect(parseInstallLinkInput("https://api.example.com/v1/install-config?token=abcDEF12")?.url).toBe(
      "https://api.example.com/v1/install-config?token=abcDEF12",
    )
    expect(parseInstallLinkInput("api.example.com abcDEF12")?.url).toBe(
      "https://api.example.com/v1/install-config?token=abcDEF12",
    )
    expect(parseInstallLinkInput("http://api.example.com/install?token=abcDEF12")).toBeNull()
  })
})

describe("writeBootstrapConfig", () => {
  test("writes the deployment config and preserves existing extra fields", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-test-"))
    const target = path.join(dir, "desktop-bootstrap.json")
    try {
      writeFileSync(target, JSON.stringify({ baseUrl: "https://old.example.com", handoff: { grant: "keep-me" } }))
      const written = writeBootstrapConfig(
        { clientName: "Acme", webUrl: "https://openwork.acme.com", apiUrl: "https://openwork-api.acme.com", requireSignin: true, logoUrl: null },
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
