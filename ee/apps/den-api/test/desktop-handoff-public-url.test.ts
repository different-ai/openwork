import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { typeId } from "@openwork-ee/utils/typeid"

const organizationId = typeId.generator("organization")
const otherOrganizationId = typeId.generator("organization")
const webOrigin = "https://web.selfhost.example.test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = "https://public.example.test"
}

async function loadDesktopHandoffRoutes() {
  seedRequiredEnv()
  return import("../src/routes/auth/desktop-handoff.js")
}

async function configureDesktopHandoffEnv(input: {
  gatewayOrigin?: string
}) {
  const { env } = await import("../src/env.js")
  env.orgMode = "multi_org"
  env.gatewayOrigin = input.gatewayOrigin
  env.webHandoffReturnOriginsByOrg = new Map()
}

describe("desktop handoff public URL", () => {
  test("does not send 0.0.0.0 to desktop clients", async () => {
    seedRequiredEnv()
    process.env.BETTER_AUTH_URL = "https://public.example.test"

    const { resolveDesktopDenBaseUrl } = await loadDesktopHandoffRoutes()
    const { env } = await import("../src/env.js")
    const originalWebUrl = env.webUrl
    const originalDesktopDenBaseUrl = env.desktopDenBaseUrl
    try {
      env.webUrl = "https://public.example.test"
      env.desktopDenBaseUrl = undefined
      expect(resolveDesktopDenBaseUrl(new Request("http://0.0.0.0:8788/v1/auth/desktop-handoff", {
        headers: { origin: "http://0.0.0.0:3005" },
      }))).toBe("https://public.example.test/api/den")

      expect(resolveDesktopDenBaseUrl(new Request("http://127.0.0.1:8788/v1/auth/desktop-handoff", {
        headers: {
          "x-forwarded-host": "0.0.0.0:3005",
          "x-forwarded-proto": "https",
        },
      }))).toBe("https://public.example.test/api/den")
    } finally {
      env.webUrl = originalWebUrl
      env.desktopDenBaseUrl = originalDesktopDenBaseUrl
    }
  })

  test("approves a web returnUrl on the exact active Cloud instance origin", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrl({
      orgMode: "multi_org",
      signedPreviewUrl: "https://8787-active.daytonaproxy01.net/signed",
      returnUrl: "https://8787-active.daytonaproxy01.net/",
    })).toBe("https://8787-active.daytonaproxy01.net/signin")
  })

  test("approves a web returnUrl matching any Cloud instance preview origin in the org", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      signedPreviewUrls: [
        "https://8787-alice.daytonaproxy01.net/signed",
        "https://8787-bob.daytonaproxy01.net/signed",
      ],
      returnUrl: "https://8787-bob.daytonaproxy01.net/signin",
    })).toBe("https://8787-bob.daytonaproxy01.net/signin")
  })

  test("approves a web returnUrl on the exact configured gateway origin", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      gatewayOrigin: "https://web.openworklabs.com",
      signedPreviewUrls: [],
      returnUrl: "https://web.openworklabs.com/",
    })).toBe("https://web.openworklabs.com/signin")
  })

  test("rejects a gateway web returnUrl when the gateway origin is unset", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      signedPreviewUrls: ["https://8787-active.daytonaproxy01.net/signed"],
      returnUrl: "https://web.openworklabs.com/signin",
    })).toBeNull()
  })

  test("rejects a gateway web returnUrl on a different origin", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      gatewayOrigin: "https://web.openworklabs.com",
      signedPreviewUrls: [],
      returnUrl: "https://app.openworklabs.com/signin",
    })).toBeNull()
  })

  test("approves the configured gateway web returnUrl without an active organization", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({ gatewayOrigin: "https://web.openworklabs.com" })

    expect(await resolveApprovedWebHandoffReturnUrl({
      activeOrganizationId: null,
      returnUrl: "https://web.openworklabs.com/",
    })).toBe("https://web.openworklabs.com/signin")
  })

  test("rejects a different web returnUrl origin without an active organization", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({ gatewayOrigin: "https://web.openworklabs.com" })

    expect(await resolveApprovedWebHandoffReturnUrl({
      activeOrganizationId: null,
      returnUrl: "https://app.openworklabs.com/signin",
    })).toBeNull()
  })

  test("rejects a gateway web returnUrl without a configured gateway origin or active organization", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({})

    expect(await resolveApprovedWebHandoffReturnUrl({
      activeOrganizationId: null,
      returnUrl: "https://web.openworklabs.com/signin",
    })).toBeNull()
  })

  test("rejects signed-preview web returnUrls without an active organization", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({})

    expect(await resolveApprovedWebHandoffReturnUrl({
      activeOrganizationId: null,
      returnUrl: "https://8787-active.daytonaproxy01.net/signin",
    })).toBeNull()
  })

  test("rejects an http gateway web returnUrl", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      gatewayOrigin: "https://web.openworklabs.com",
      signedPreviewUrls: [],
      returnUrl: "http://web.openworklabs.com/signin",
    })).toBeNull()
  })

  test("rejects a rotated hostname even on the same preview suffix (shared proxy zone)", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    // Every Daytona customer gets origins under the same proxy zone, so a
    // suffix match would approve an attacker-controlled sandbox.
    expect(approveWebHandoffReturnUrl({
      orgMode: "multi_org",
      signedPreviewUrl: "https://8787-old.daytonaproxy01.net/signed",
      returnUrl: "https://8787-new.daytonaproxy01.net/signin",
    })).toBe(null)
  })

  test("rejects an http web returnUrl", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrl({
      orgMode: "multi_org",
      signedPreviewUrl: "https://8787-active.daytonaproxy01.net/signed",
      returnUrl: "http://8787-active.daytonaproxy01.net/signin",
    })).toBeNull()
  })

  test("rejects a web returnUrl with the wrong preview suffix", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrl({
      orgMode: "multi_org",
      signedPreviewUrl: "https://8787-active.daytonaproxy01.net/signed",
      returnUrl: "https://8787-active.evil.example/signin",
    })).toBeNull()
  })

  test("rejects a web returnUrl in single_org mode", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrl({
      orgMode: "single_org",
      signedPreviewUrl: "https://8787-active.daytonaproxy01.net/signed",
      returnUrl: "https://8787-active.daytonaproxy01.net/signin",
    })).toBeNull()
  })

  test("rejects a web returnUrl with path traversal", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrl({
      orgMode: "multi_org",
      signedPreviewUrl: "https://8787-active.daytonaproxy01.net/signed",
      returnUrl: "https://8787-active.daytonaproxy01.net/dashboard/../signin",
    })).toBeNull()
  })

  test("rejects a web returnUrl with userinfo", async () => {
    const { approveWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()

    expect(approveWebHandoffReturnUrl({
      orgMode: "multi_org",
      signedPreviewUrl: "https://8787-active.daytonaproxy01.net/signed",
      returnUrl: "https://user@8787-active.daytonaproxy01.net/signin",
    })).toBeNull()
  })

  test("approves the exact operator-configured origin for the active organization", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    const { env, parseWebHandoffReturnOriginsByOrg } = await import("../src/env.js")
    await configureDesktopHandoffEnv({})
    env.webHandoffReturnOriginsByOrg = parseWebHandoffReturnOriginsByOrg(JSON.stringify({ [organizationId]: [webOrigin] }))

    expect(await resolveApprovedWebHandoffReturnUrl({
      activeOrganizationId: organizationId,
      returnUrl: `${webOrigin}/`,
    })).toBe(`${webOrigin}/signin`)
  })

  test("org-scoped origins reject the wrong organization, no organization, and single-org mode", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews, resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    const { env } = await import("../src/env.js")
    await configureDesktopHandoffEnv({})
    env.webHandoffReturnOriginsByOrg = new Map([[organizationId, [webOrigin]]])

    expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: null, returnUrl: `${webOrigin}/signin` })).toBeNull()
    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      activeOrganizationId: otherOrganizationId,
      webHandoffReturnOriginsByOrg: env.webHandoffReturnOriginsByOrg,
      signedPreviewUrls: [],
      returnUrl: `${webOrigin}/signin`,
    })).toBeNull()
    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "multi_org",
      activeOrganizationId: null,
      webHandoffReturnOriginsByOrg: env.webHandoffReturnOriginsByOrg,
      signedPreviewUrls: [],
      returnUrl: `${webOrigin}/signin`,
    })).toBeNull()
    expect(approveWebHandoffReturnUrlForSignedPreviews({
      orgMode: "single_org",
      activeOrganizationId: organizationId,
      webHandoffReturnOriginsByOrg: env.webHandoffReturnOriginsByOrg,
      signedPreviewUrls: [],
      returnUrl: `${webOrigin}/signin`,
    })).toBeNull()
  })

  test("org-scoped origins reject unlisted, lookalike, and unsafe return URLs", async () => {
    const { approveWebHandoffReturnUrlForSignedPreviews } = await loadDesktopHandoffRoutes()
    const origins = new Map([[organizationId, [webOrigin]]])
    for (const returnUrl of [
      "https://other.example.test/signin",
      "https://web.selfhost.example.test.evil.test/signin",
      "https://sub.web.selfhost.example.test/signin",
      "https://web.selfhost.example.test:444/signin",
      "http://web.selfhost.example.test/signin",
      "https://user@web.selfhost.example.test/signin",
      `${webOrigin}/dashboard/../signin`,
      `${webOrigin}/%2e%2e/signin`,
      `${webOrigin}/other`,
      `${webOrigin}/signin#fragment`,
    ]) {
      expect(approveWebHandoffReturnUrlForSignedPreviews({
        orgMode: "multi_org",
        activeOrganizationId: organizationId,
        webHandoffReturnOriginsByOrg: origins,
        signedPreviewUrls: [],
        returnUrl,
      })).toBeNull()
    }
  })

  test("rejects malformed operator origins and fails startup", async () => {
    seedRequiredEnv()
    const { parseWebHandoffReturnOriginsByOrg } = await import("../src/env.js")
    expect(parseWebHandoffReturnOriginsByOrg("").size).toBe(0)
    const invalid = [
      "[]", "null", "{", JSON.stringify({ not_an_org: [webOrigin] }),
      JSON.stringify({ [organizationId]: webOrigin }),
      ...[
        "*", "https://*.example.test", "http://web.example.test", "https://user@web.example.test",
        "https://web.example.test/", "https://web.example.test/path", "https://web.example.test?query=1",
        "https://web.example.test#fragment", "https://web.example.test.evil.test/path",
      ].map((origin) => JSON.stringify({ [organizationId]: [origin] })),
    ]
    for (const value of invalid) {
      expect(() => parseWebHandoffReturnOriginsByOrg(value)).toThrow("DEN_WEB_HANDOFF_RETURN_ORIGINS_BY_ORG")
    }
    const result = spawnSync(process.execPath, ["--conditions", "development", "--eval", 'await import("./src/env.ts")'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
        DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
        BETTER_AUTH_SECRET: "y".repeat(32),
        BETTER_AUTH_URL: "https://public.example.test",
        DEN_WEB_HANDOFF_RETURN_ORIGINS_BY_ORG: JSON.stringify({ [organizationId]: ["https://web.example.test/path"] }),
      },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("DEN_WEB_HANDOFF_RETURN_ORIGINS_BY_ORG")
  })
})
