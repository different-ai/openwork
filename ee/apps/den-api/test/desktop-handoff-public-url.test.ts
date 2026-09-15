import { afterAll, describe, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { DesktopHandoffGrantTable } from "@openwork-ee/den-db/schema"
import { Hono } from "hono"
import type { AuthContextVariables } from "../src/session.js"

const insertGrant = mock(async (_grant: typeof DesktopHandoffGrantTable.$inferInsert) => [])
// Sessions are supplied below; do not initialize Better Auth's database-backed OAuth resources.
mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "test-client",
  DEN_MCP_FIRST_PARTY_RESOURCES: [],
  DEN_MCP_GRANT_ID_CLAIM: "test-grant-id",
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "test-access-",
  DEN_MCP_ORG_ID_CLAIM: "test-org-id",
  DEN_MCP_OAUTH_RESOURCE: "https://public.example.test/mcp",
  DEN_MCP_RESOURCE: "https://public.example.test/mcp",
  DEN_MCP_RESOURCE_CLAIM: "test-resource",
  DEN_MCP_TOKEN_USE_CLAIM: "test-token-use",
}))
mock.module("../src/db.js", () => ({ db: { insert: () => ({ values: insertGrant }) } }))
afterAll(() => mock.restore())

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
}

describe("desktop handoff public URL", () => {
  test("issues links only for registered desktop schemes and defaults to OpenWork", async () => {
    const { registerDesktopAuthRoutes } = await loadDesktopHandoffRoutes()
    const app = new Hono<{ Variables: AuthContextVariables }>()
    const userId = createDenTypeId("user")
    const sessionId = createDenTypeId("session")
    const now = new Date()
    app.use("*", async (c, next) => {
      c.set("user", { id: userId, name: "Member", email: "member@example.test", emailVerified: true, image: null, createdAt: now, updatedAt: now })
      c.set("session", { id: sessionId, token: "test-session-token", userId, activeOrganizationId: null, activeTeamId: null, expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null })
      c.set("apiKey", null)
      await next()
    })
    registerDesktopAuthRoutes(app)
    const request = (desktopScheme: string | undefined) => app.request("https://app.example.test/v1/auth/desktop-handoff", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://app.example.test" }, body: JSON.stringify({ desktopScheme }),
    })
    for (const desktopScheme of [undefined, "openwork", "opencoworker"]) {
      insertGrant.mockClear()
      const response = await request(desktopScheme)
      expect(response.status).toBe(200)
      const payload = await response.json()
      const link = new URL(payload.openworkUrl)
      expect(link.protocol).toBe(`${desktopScheme ?? "openwork"}:`)
      expect(link.hostname).toBe("den-auth")
      expect(link.searchParams.get("grant")).toBe(payload.grant)
      expect(link.searchParams.get("denBaseUrl")).toBe("https://app.example.test/api/den")
      expect(insertGrant).toHaveBeenCalledTimes(1)
      expect(insertGrant.mock.calls[0][0]).toMatchObject({ id: payload.grant, user_id: userId, session_token: "test-session-token", consumed_at: null })
      expect(payload).not.toHaveProperty("token")
    }
    for (const desktopScheme of ["untrusted-app", "https", "openwork-untrusted", "opencoworker-untrusted", "opencoworker://", "OpenCoworker", ""]) {
      insertGrant.mockClear()
      const response = await request(desktopScheme)
      expect(response.status).toBe(400)
      const payload = await response.json()
      expect(payload).not.toHaveProperty("grant")
      expect(payload).not.toHaveProperty("openworkUrl")
      expect(insertGrant).not.toHaveBeenCalled()
    }
    const signedOut = new Hono<{ Variables: AuthContextVariables }>()
    registerDesktopAuthRoutes(signedOut)
    expect((await signedOut.request("https://app.example.test/v1/auth/desktop-handoff", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ desktopScheme: "opencoworker" }),
    })).status).toBe(401)
    expect(insertGrant).not.toHaveBeenCalled()
  })

  test("does not send 0.0.0.0 to desktop clients", async () => {
    seedRequiredEnv()
    process.env.BETTER_AUTH_URL = "https://public.example.test"

    const { resolveDesktopDenBaseUrl } = await loadDesktopHandoffRoutes()

    expect(resolveDesktopDenBaseUrl(new Request("http://0.0.0.0:8788/v1/auth/desktop-handoff", {
      headers: { origin: "http://0.0.0.0:3005" },
    }))).toBe("https://public.example.test/api/den")

    expect(resolveDesktopDenBaseUrl(new Request("http://127.0.0.1:8788/v1/auth/desktop-handoff", {
      headers: {
        "x-forwarded-host": "0.0.0.0:3005",
        "x-forwarded-proto": "https",
      },
    }))).toBe("https://public.example.test/api/den")
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
})
