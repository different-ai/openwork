import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

type EnvModule = typeof import("../src/env.js")
type InstallLinksModule = typeof import("../src/routes/org/install-links.js")

let envModule: EnvModule
let installLinks: InstallLinksModule

mock.module("../src/db.js", () => ({ db: {} }))
mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

  envModule = await import("../src/env.js")
  installLinks = await import("../src/routes/org/install-links.js")
})

beforeEach(() => {
  // Self-hosted release image: single-org, DEN_API_VERSION baked at build,
  // GitHub discovery pointed at an unreachable host so any fallthrough fails loudly.
  envModule.env.orgMode = "single_org"
  envModule.env.serviceVersion = "0.18.45"
  envModule.env.desktopReleasesMode = "github"
  envModule.env.desktopReleasesBaseUrl = "http://127.0.0.1:9"
  envModule.env.installerReleaseTag = "v0.18.23"
  envModule.env.installerReleaseTagExplicit = false
})

describe("install link release tag for a self-hosted Den", () => {
  test("installs the Den's own release when allowedDesktopVersions is unset", async () => {
    for (const metadata of [null, {}, JSON.stringify({ limits: { members: 5 } }), { allowedDesktopVersions: [] }]) {
      await expect(installLinks.installerReleaseTagForMetadata(metadata)).resolves.toBe("v0.18.45")
    }
  })

  test("installs max(allowedDesktopVersions) when the policy is set, above or below the Den's release", async () => {
    await expect(installLinks.installerReleaseTagForMetadata({ allowedDesktopVersions: ["0.18.42", "0.18.45"] })).resolves.toBe("v0.18.45")
    await expect(installLinks.installerReleaseTagForMetadata({ allowedDesktopVersions: ["0.18.42"] })).resolves.toBe("v0.18.42")
    await expect(installLinks.installerReleaseTagForMetadata({ allowedDesktopVersions: ["0.18.42", "0.18.99"] })).resolves.toBe("v0.18.99")
  })

  test("OPENWORK_INSTALLER_RELEASE_TAG overrides the Den's own release", async () => {
    envModule.env.installerReleaseTag = "v0.18.44"
    envModule.env.installerReleaseTagExplicit = true

    await expect(installLinks.installerReleaseTagForMetadata({})).resolves.toBe("v0.18.44")
    await expect(installLinks.installerReleaseTagForMetadata({ allowedDesktopVersions: ["0.18.42"] })).resolves.toBe("v0.18.42")
  })
})
