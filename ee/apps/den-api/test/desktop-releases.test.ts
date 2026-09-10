import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { MIN_SUPPORTED_DESKTOP_VERSION, PUBLISHED_DESKTOP_VERSIONS } from "../src/generated/desktop-versions.js"

type EnvModule = typeof import("../src/env.js")
type DesktopReleasesModule = typeof import("../src/desktop-releases.js")

let envModule: EnvModule
let desktopReleases: DesktopReleasesModule
let server: ReturnType<typeof Bun.serve>
let failureRequests = 0
let emptyRequests = 0
let successRequestUrl: string | null = null

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/failure/")) {
        failureRequests += 1
        return new Response("unavailable", { status: 503 })
      }
      if (url.pathname.startsWith("/empty/")) {
        emptyRequests += 1
        return Response.json([])
      }
      successRequestUrl = request.url
      return Response.json([
        { draft: false, prerelease: false, tag_name: "v0.18.9" },
        { draft: false, prerelease: false, tag_name: "v1.0.0" },
        { draft: false, prerelease: false, tag_name: "v0.18.10" },
        { draft: false, prerelease: false, tag_name: "v0.18.10" },
        { draft: false, prerelease: true, tag_name: "v9.0.0" },
        { draft: true, prerelease: false, tag_name: "v8.0.0" },
        { draft: false, prerelease: false, tag_name: "v0.16.99" },
        { draft: false, prerelease: false, tag_name: `v${MIN_SUPPORTED_DESKTOP_VERSION}` },
        { draft: false, prerelease: false, tag_name: "release-7.0.0" },
      ])
    },
  })

  envModule = await import("../src/env.js")
  desktopReleases = await import("../src/desktop-releases.js")
})

beforeEach(() => {
  failureRequests = 0
  emptyRequests = 0
  successRequestUrl = null
  envModule.env.desktopReleasesMode = "github"
  envModule.env.desktopReleasesBaseUrl = server.url.origin
  envModule.env.installerReleaseRepo = "different-ai/openwork"
  envModule.env.installerReleaseTag = `v${PUBLISHED_DESKTOP_VERSIONS[0]}`
  envModule.env.installerReleaseTagExplicit = false
  envModule.env.orgMode = "multi_org"
  envModule.env.serviceVersion = "dev"
})

afterAll(() => {
  server.stop(true)
  envModule.env.desktopReleasesMode = "static"
})

describe("desktop release discovery", () => {
  test("sorts and deduplicates stable published releases while applying the support floor", async () => {
    const source = desktopReleases.createDesktopReleaseSource()

    await expect(source.getDesktopReleaseMetadata()).resolves.toEqual({
      minAppVersion: MIN_SUPPORTED_DESKTOP_VERSION,
      latestAppVersion: "1.0.0",
      publishedDesktopVersions: ["1.0.0", "0.18.10", "0.18.9", MIN_SUPPORTED_DESKTOP_VERSION],
    })
    expect(successRequestUrl).toBe(`${server.url.origin}/repos/different-ai/openwork/releases?per_page=100`)
  })

  test("excludes draft and prerelease rollback releases", async () => {
    const metadata = await desktopReleases.createDesktopReleaseSource().getDesktopReleaseMetadata()

    expect(metadata.publishedDesktopVersions).not.toContain("9.0.0")
    expect(metadata.publishedDesktopVersions).not.toContain("8.0.0")
  })

  test("falls back to the committed snapshot after a fetch failure without a request storm", async () => {
    envModule.env.desktopReleasesBaseUrl = `${server.url.origin}/failure`
    const source = desktopReleases.createDesktopReleaseSource()

    expect(await source.getDesktopReleaseMetadata()).toEqual({
      minAppVersion: MIN_SUPPORTED_DESKTOP_VERSION,
      latestAppVersion: PUBLISHED_DESKTOP_VERSIONS[0],
      publishedDesktopVersions: [...PUBLISHED_DESKTOP_VERSIONS],
    })
    await source.getDesktopReleaseMetadata()
    expect(failureRequests).toBe(1)
  })

  test("treats an empty fetched release list as a failure", async () => {
    envModule.env.desktopReleasesBaseUrl = `${server.url.origin}/empty`
    const metadata = await desktopReleases.createDesktopReleaseSource().getDesktopReleaseMetadata()

    expect(metadata.publishedDesktopVersions).toEqual([...PUBLISHED_DESKTOP_VERSIONS])
    expect(emptyRequests).toBe(1)
  })

  test("honors the explicit installer release tag before runtime discovery", async () => {
    envModule.env.desktopReleasesBaseUrl = `${server.url.origin}/failure`
    envModule.env.installerReleaseTag = "v7.6.5"
    envModule.env.installerReleaseTagExplicit = true

    await expect(desktopReleases.createDesktopReleaseSource().resolveInstallerReleaseTag()).resolves.toBe("v7.6.5")
    expect(failureRequests).toBe(0)
  })

  test("multi-org installs the latest published release", async () => {
    envModule.env.serviceVersion = "0.18.45"

    await expect(desktopReleases.createDesktopReleaseSource().resolveInstallerReleaseTag()).resolves.toBe("v1.0.0")
    expect(successRequestUrl).not.toBeNull()
  })

  test("single-org installs the Den's own release without runtime discovery", async () => {
    envModule.env.orgMode = "single_org"
    envModule.env.serviceVersion = "0.18.45"
    envModule.env.desktopReleasesBaseUrl = `${server.url.origin}/failure`

    await expect(desktopReleases.createDesktopReleaseSource().resolveInstallerReleaseTag()).resolves.toBe("v0.18.45")
    expect(failureRequests).toBe(0)
  })

  test("single-org dev and commit builds keep runtime discovery", async () => {
    envModule.env.orgMode = "single_org"

    for (const serviceVersion of ["dev", "commit a0d6bd1", "0.18.45-rc.1"]) {
      envModule.env.serviceVersion = serviceVersion
      await expect(desktopReleases.createDesktopReleaseSource().resolveInstallerReleaseTag()).resolves.toBe("v1.0.0")
    }
  })

  test("single-org honors the explicit installer release tag over the Den's own release", async () => {
    envModule.env.orgMode = "single_org"
    envModule.env.serviceVersion = "0.18.45"
    envModule.env.installerReleaseTag = "v7.6.5"
    envModule.env.installerReleaseTagExplicit = true

    await expect(desktopReleases.createDesktopReleaseSource().resolveInstallerReleaseTag()).resolves.toBe("v7.6.5")
  })
})
