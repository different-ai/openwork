import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { installConfigUrlFor } from "@openwork/install-config"

import {
  appleScriptString,
  buildCompressedDmgArgs,
  buildFinderLayoutScript,
  buildReadWriteDmgArgs,
  buildTiffutilArgs,
  dmgBackgroundPaths,
  dmgLayout,
  dmgWindowBounds,
} from "../scripts/dmg-layout.mjs"
import { desktopBootstrapPath, legacyDesktopBootstrapPath } from "../src/bootstrap-path"
import { buildConstantsConfig, parseInstallLinkInput, resolveInstallerConfig } from "../src/config"
import { removableInstallerBundlePath, windowsInstalledExePath, writeBootstrapConfig } from "../src/install"
import { releaseAssetFor } from "../src/release-asset"
import { startInstallerServer } from "../src/server"

describe("mac DMG layout helpers", () => {
  test("builds the approved Finder window and icon layout", () => {
    expect(dmgWindowBounds(dmgLayout.window)).toEqual([100, 100, 760, 500])

    const script = buildFinderLayoutScript({
      appName: "Install OpenWork.app",
      backgroundPath: "/Volumes/Install OpenWork/.background/bg.tiff",
      mountPoint: "/Volumes/Install OpenWork",
    })

    expect(script).toContain("set bounds of dmgWindow to {100, 100, 760, 500}")
    expect(script).toContain("set icon size of viewOptions to 128")
    expect(script).toContain("set label position of viewOptions to bottom")
    expect(script).toContain("set background picture of viewOptions to backgroundFile")
    expect(script).toContain('set position of item "Install OpenWork.app" of dmgWindow to {330, 180}')
  })

  test("builds DMG background and hdiutil arguments", () => {
    expect(dmgBackgroundPaths("/tmp/root")).toEqual({
      backgroundDir: "/tmp/root/.background",
      tiff: "/tmp/root/.background/bg.tiff",
    })
    expect(buildTiffutilArgs("/assets/dmg-background", "/tmp/root/.background/bg.tiff")).toEqual([
      "-cathidpicheck",
      "/assets/dmg-background/bg.png",
      "/assets/dmg-background/bg@2x.png",
      "-out",
      "/tmp/root/.background/bg.tiff",
    ])
    expect(buildReadWriteDmgArgs({ sourceFolder: "/tmp/root", outputPath: "/tmp/openwork.rw.dmg" })).toEqual([
      "create",
      "-format",
      "UDRW",
      "-volname",
      "Install OpenWork",
      "-srcfolder",
      "/tmp/root",
      "-ov",
      "/tmp/openwork.rw.dmg",
    ])
    expect(buildCompressedDmgArgs({ inputPath: "/tmp/openwork.rw.dmg", outputPath: "/tmp/OpenWork.dmg" })).toEqual([
      "convert",
      "/tmp/openwork.rw.dmg",
      "-format",
      "UDZO",
      "-ov",
      "-o",
      "/tmp/OpenWork.dmg",
    ])
  })

  test("escapes AppleScript strings", () => {
    expect(appleScriptString('/tmp/Install "OpenWork"/back\\ground.tiff')).toBe('/tmp/Install \\"OpenWork\\"/back\\\\ground.tiff')
  })
})

describe("desktopBootstrapPath", () => {
  test("honors the explicit override", () => {
    expect(desktopBootstrapPath({ OPENWORK_DESKTOP_BOOTSTRAP_PATH: "/tmp/custom.json" }, "darwin")).toBe("/tmp/custom.json")
  })

  test("prefers XDG_CONFIG_HOME on every platform", () => {
    expect(desktopBootstrapPath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "openwork", "desktop-bootstrap.json"))
    expect(desktopBootstrapPath({ XDG_CONFIG_HOME: "/xdg" }, "win32")).toBe(path.join("/xdg", "openwork", "desktop-bootstrap.json"))
  })

  test("uses LOCALAPPDATA on Windows and ~/.config elsewhere", () => {
    expect(desktopBootstrapPath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "openwork", "desktop-bootstrap.json"),
    )
    expect(desktopBootstrapPath({}, "darwin")).toBe(path.join(os.homedir(), ".config", "openwork", "desktop-bootstrap.json"))
  })

  test("resolves the legacy bootstrap path under ~/.config on every platform", () => {
    expect(legacyDesktopBootstrapPath({ HOME: "/Users/u" }, "darwin")).toBe(
      path.join("/Users/u", ".config", "openwork", "desktop-bootstrap.json"),
    )
    expect(legacyDesktopBootstrapPath({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe(
      path.join("C:\\Users\\u", ".config", "openwork", "desktop-bootstrap.json"),
    )
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

describe("windowsInstalledExePath", () => {
  test("reports the installed electron-builder package directory", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "openwork-installed-path-"))
    const installed = path.join(temp, "Programs", "@openworkdesktop", "OpenWork.exe")
    mkdirSync(path.dirname(installed), { recursive: true })
    writeFileSync(installed, "")
    try {
      expect(windowsInstalledExePath(temp)).toBe(installed)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})

describe("resolveInstallerConfig", () => {
  test("reads env overrides and normalizes URLs", async () => {
    const { config, source } = await resolveInstallerConfig({ env: {
      OPENWORK_INSTALLER_APP_NAME: "Acme Work",
      OPENWORK_INSTALLER_CLIENT_NAME: "Acme Corp",
      OPENWORK_INSTALLER_WEB_URL: "https://openwork.acme.com/",
      OPENWORK_INSTALLER_API_URL: "https://openwork-api.acme.com",
      OPENWORK_INSTALLER_REQUIRE_SIGNIN: "true",
    } })
    expect(source).toBe("env")
    expect(config).toEqual({
      appName: "Acme Work",
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
    await expect(resolveInstallerConfig({ env: {} })).rejects.toThrow()
  })

  test("prefers env overrides over pasted install links", async () => {
    const resolution = await resolveInstallerConfig({
      env: {
        OPENWORK_INSTALLER_CLIENT_NAME: "Env",
        OPENWORK_INSTALLER_WEB_URL: "https://env.example.com",
        OPENWORK_INSTALLER_API_URL: "https://env-api.example.com",
      },
      installLink: "not an install link",
    })

    expect(resolution.source).toBe("env")
    expect(resolution.config.clientName).toBe("Env")
  })

  test("reads build constants before pasted install links", async () => {
    const resolution = await resolveInstallerConfig({
      env: {},
      buildConstants: {
        appName: "Build Work",
        clientName: "Build Corp",
        webUrl: "https://build.example.com/",
        apiUrl: "https://build-api.example.com/",
        logoUrl: "https://build.example.com/logo.svg",
        requireSignin: true,
      },
      installLink: "https://app.example.com/install?token=abcDEF12",
      fetcher: () => {
        throw new Error("install link should not be fetched when build constants exist")
      },
    })

    expect(resolution.source).toBe("build")
    expect(resolution.config).toEqual({
      appName: "Build Work",
      clientName: "Build Corp",
      webUrl: "https://build.example.com",
      apiUrl: "https://build-api.example.com",
      logoUrl: "https://build.example.com/logo.svg",
      requireSignin: true,
    })
  })

  test("ignores empty placeholder build constants", () => {
    expect(buildConstantsConfig({
      appName: "",
      clientName: "",
      webUrl: "",
      apiUrl: "",
      logoUrl: "",
      requireSignin: false,
    })).toBeNull()
  })

  test("resolves pasted install links", async () => {
    const configServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({
        clientName: "Linked Corp",
        webUrl: "https://linked.example.com/",
        apiUrl: "https://linked-api.example.com/",
        requireSignin: true,
        logoUrl: null,
      }),
    })
    try {
      const resolution = await resolveInstallerConfig({
        env: {},
        installLink: `http://127.0.0.1:${configServer.port}/install?token=abcDEF12`,
      })

      expect(resolution.source).toBe("install-link")
      expect(resolution.config).toEqual({
        appName: "OpenWork",
        clientName: "Linked Corp",
        webUrl: "https://linked.example.com",
        apiUrl: "https://linked-api.example.com",
        requireSignin: true,
        logoUrl: null,
      })
    } finally {
      configServer.stop(true)
    }
  })
})

describe("install link helpers", () => {
  test("builds install config URLs", () => {
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

describe("resolve-link API", () => {
  test("maps missing install configs to the expired-link message", async () => {
    const configServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("missing", { status: 404, statusText: "Not Found" }),
    })
    const installerServer = startInstallerServer(null, () => undefined)
    try {
      const response = await fetch(`${installerServer.url}api/resolve-link`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-installer-token": installerServer.token },
        body: JSON.stringify({ installLink: `http://127.0.0.1:${configServer.port}/install?token=abcDEF12` }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: "install_link_expired",
        message: "This install link has expired or was replaced. Ask your workspace admin for a fresh one from the Members page.",
      })
    } finally {
      installerServer.stop()
      configServer.stop(true)
    }
  })

  test("keeps generic copy for other install config failures", async () => {
    const configServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("error", { status: 500, statusText: "Internal Server Error" }),
    })
    const installerServer = startInstallerServer(null, () => undefined)
    try {
      const response = await fetch(`${installerServer.url}api/resolve-link`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-installer-token": installerServer.token },
        body: JSON.stringify({ installLink: `http://127.0.0.1:${configServer.port}/install?token=abcDEF12` }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: "install_link_invalid",
        message: "Install link could not be resolved.",
      })
    } finally {
      installerServer.stop()
      configServer.stop(true)
    }
  })
})

describe("writeBootstrapConfig", () => {
  test("migrates a legacy organization config instead of replacing it with hosted defaults", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-test-"))
    const env = {
      LOCALAPPDATA: path.join(dir, "LocalAppData"),
      USERPROFILE: path.join(dir, "profile"),
    }
    const target = desktopBootstrapPath(env, "win32")
    const legacy = legacyDesktopBootstrapPath(env, "win32")
    try {
      mkdirSync(path.dirname(target), { recursive: true })
      mkdirSync(path.dirname(legacy), { recursive: true })
      writeFileSync(target, JSON.stringify({
        baseUrl: "https://app.openworklabs.com/api/den/",
        writtenAt: "2026-07-10T13:00:00.000Z",
      }))
      writeFileSync(legacy, JSON.stringify({
        baseUrl: "https://openwork.organization.internal.example",
        apiBaseUrl: "https://api.organization.internal.example",
        handoff: { grant: "drop-me" },
        prepared: { orgId: "org_example" },
        claimLinks: [{ id: "claim_example" }],
        writtenAt: "2026-07-09T12:00:00.000Z",
      }))
      const written = writeBootstrapConfig(
        { appName: "OpenWork", clientName: "Hosted", webUrl: "https://app.openworklabs.com/", apiUrl: "https://api.openworklabs.com/", requireSignin: false, logoUrl: null },
        env,
        "win32",
      )
      expect(written).toBe(target)
      const parsed = JSON.parse(readFileSync(target, "utf8"))
      expect(parsed.baseUrl).toBe("https://openwork.organization.internal.example")
      expect(parsed.apiBaseUrl).toBe("https://api.organization.internal.example")
      expect(parsed.handoff).toBeUndefined()
      expect(parsed.prepared).toEqual({ orgId: "org_example" })
      expect(parsed.claimLinks).toEqual([{ id: "claim_example" }])
      expect(Number.isFinite(Date.parse(parsed.writtenAt))).toBe(true)
      expect(existsSync(legacy)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps a canonical organization config across repeated hosted reinstalls", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-test-"))
    const env = {
      LOCALAPPDATA: path.join(dir, "LocalAppData"),
      USERPROFILE: path.join(dir, "profile"),
    }
    const target = desktopBootstrapPath(env, "win32")
    try {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify({
        baseUrl: "https://openwork.organization.internal.example",
        apiBaseUrl: "https://api.organization.internal.example",
        handoff: { grant: "drop-me" },
        prepared: { orgId: "org_example" },
        claimLinks: [{ id: "claim_example" }],
      }))
      const hostedConfig = {
        appName: "OpenWork",
        clientName: "Hosted",
        webUrl: "https://api.openworklabs.com/v1/",
        apiUrl: "https://api.openworklabs.com/",
        requireSignin: false,
        logoUrl: null,
      }

      writeBootstrapConfig(hostedConfig, env, "win32")
      writeBootstrapConfig(hostedConfig, env, "win32")

      const parsed = JSON.parse(readFileSync(target, "utf8"))
      expect(parsed.baseUrl).toBe("https://openwork.organization.internal.example")
      expect(parsed.apiBaseUrl).toBe("https://api.organization.internal.example")
      expect(parsed.handoff).toBeUndefined()
      expect(parsed.prepared).toEqual({ orgId: "org_example" })
      expect(parsed.claimLinks).toEqual([{ id: "claim_example" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("replaces an installed hosted default with a custom organization config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-test-"))
    const env = {
      LOCALAPPDATA: path.join(dir, "LocalAppData"),
      USERPROFILE: path.join(dir, "profile"),
    }
    const target = desktopBootstrapPath(env, "win32")
    try {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify({
        baseUrl: "https://app.openworklabs.com/api/den/",
        apiBaseUrl: "https://api.openworklabs.com/",
        prepared: { orgId: "org_example" },
        claimLinks: [{ id: "claim_example" }],
      }))

      writeBootstrapConfig(
        {
          appName: "Example Org Work",
          clientName: "Example Org",
          webUrl: "https://openwork.custom.internal.example",
          apiUrl: "https://api.custom.internal.example",
          requireSignin: true,
          logoUrl: "https://openwork.custom.internal.example/assets/wordmark.svg",
        },
        env,
        "win32",
      )

      const parsed = JSON.parse(readFileSync(target, "utf8"))
      expect(parsed.baseUrl).toBe("https://openwork.custom.internal.example")
      expect(parsed.apiBaseUrl).toBe("https://api.custom.internal.example")
      expect(parsed.requireSignin).toBe(true)
      expect(parsed.brandAppName).toBe("Example Org Work")
      expect(parsed.brandLogoUrl).toBe("https://openwork.custom.internal.example/assets/wordmark.svg")
      expect(parsed.prepared).toEqual({ orgId: "org_example" })
      expect(parsed.claimLinks).toEqual([{ id: "claim_example" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("removableInstallerBundlePath", () => {
  const homeDir = "/Users/example"
  const executablePath = "Contents/MacOS/openwork-installer"

  test("allows only the installer app bundle in common writable locations", () => {
    expect(removableInstallerBundlePath(`/Applications/Install OpenWork.app/${executablePath}`, homeDir, "darwin")).toBe(
      "/Applications/Install OpenWork.app",
    )
    expect(removableInstallerBundlePath(`${homeDir}/Applications/Install OpenWork.app/${executablePath}`, homeDir, "darwin")).toBe(
      `${homeDir}/Applications/Install OpenWork.app`,
    )
    expect(removableInstallerBundlePath(`${homeDir}/Downloads/Install OpenWork.app/${executablePath}`, homeDir, "darwin")).toBe(
      `${homeDir}/Downloads/Install OpenWork.app`,
    )
  })

  test("rejects DMG mounts, wrong app names, nested copies, and other platforms", () => {
    expect(removableInstallerBundlePath(`/Volumes/Install OpenWork/Install OpenWork.app/${executablePath}`, homeDir, "darwin")).toBeNull()
    expect(removableInstallerBundlePath(`/Applications/OpenWork.app/${executablePath}`, homeDir, "darwin")).toBeNull()
    expect(removableInstallerBundlePath(`${homeDir}/Downloads/OpenWork/Install OpenWork.app/${executablePath}`, homeDir, "darwin")).toBeNull()
    expect(removableInstallerBundlePath(`/Applications/Install OpenWork.app/${executablePath}`, homeDir, "linux")).toBeNull()
  })
})
