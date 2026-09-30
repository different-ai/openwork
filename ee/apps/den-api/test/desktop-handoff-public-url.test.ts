import { afterEach, describe, expect, test } from "bun:test"
import { typeId } from "@openwork-ee/utils/typeid"

const organizationId = typeId.generator("organization")
const otherOrganizationId = typeId.generator("organization")
const webOrigin = "https://web.selfhost.example.test"

// No database in unit tests: the organization has no Cloud instance previews.
const noSignedPreviews = () => Promise.resolve([])

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
  orgMode?: "multi_org" | "single_org"
}) {
  const { env } = await import("../src/env.js")
  env.orgMode = input.orgMode ?? "multi_org"
  env.gatewayOrigin = input.gatewayOrigin
}

const approvalLookups: Array<{ origin: string; organizationId?: string }> = []

async function approveWebOriginForOrganization(approvedOrganizationId: string, approvedOrigin: string) {
  const { setWebOriginApprovalLookupForTest } = await import("../src/organization-web-origins.js")
  approvalLookups.length = 0
  setWebOriginApprovalLookupForTest(async (input) => {
    approvalLookups.push(input)
    return input.organizationId === approvedOrganizationId && input.origin === approvedOrigin
  })
}

afterEach(async () => {
  const { setWebOriginApprovalLookupForTest } = await import("../src/organization-web-origins.js")
  setWebOriginApprovalLookupForTest(null)
  approvalLookups.length = 0
})

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

  test("approves an origin the active organization approved in Org settings", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({})
    await approveWebOriginForOrganization(organizationId, webOrigin)

    for (const returnUrl of [`${webOrigin}/`, `${webOrigin}/signin`, webOrigin]) {
      expect(await resolveApprovedWebHandoffReturnUrl({
        activeOrganizationId: organizationId,
        returnUrl,
        loadSignedPreviewUrls: noSignedPreviews,
      })).toBe(`${webOrigin}/signin`)
    }
    expect(approvalLookups).toEqual([
      { origin: webOrigin, organizationId },
      { origin: webOrigin, organizationId },
      { origin: webOrigin, organizationId },
    ])
  })

  test("org-approved origins reject the wrong organization, no organization, and single-org mode", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({})
    await approveWebOriginForOrganization(organizationId, webOrigin)

    expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: otherOrganizationId, returnUrl: `${webOrigin}/signin`, loadSignedPreviewUrls: noSignedPreviews })).toBeNull()
    expect(approvalLookups).toEqual([{ origin: webOrigin, organizationId: otherOrganizationId }])

    approvalLookups.length = 0
    expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: null, returnUrl: `${webOrigin}/signin` })).toBeNull()
    expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: "not-an-org-id", returnUrl: `${webOrigin}/signin` })).toBeNull()

    await configureDesktopHandoffEnv({ orgMode: "single_org" })
    expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: organizationId, returnUrl: `${webOrigin}/signin`, loadSignedPreviewUrls: noSignedPreviews })).toBeNull()
    expect(approvalLookups).toEqual([])
    await configureDesktopHandoffEnv({})
  })

  test("org-approved origins reject unlisted, lookalike, and unsafe return URLs", async () => {
    const { resolveApprovedWebHandoffReturnUrl } = await loadDesktopHandoffRoutes()
    await configureDesktopHandoffEnv({})
    await approveWebOriginForOrganization(organizationId, webOrigin)

    for (const returnUrl of [
      "https://other.example.test/signin",
      "https://web.selfhost.example.test.evil.test/signin",
      "https://sub.web.selfhost.example.test/signin",
      "https://web.selfhost.example.test:444/signin",
    ]) {
      expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: organizationId, returnUrl, loadSignedPreviewUrls: noSignedPreviews })).toBeNull()
    }
    expect(approvalLookups.map((lookup) => lookup.origin)).toEqual([
      "https://other.example.test",
      "https://web.selfhost.example.test.evil.test",
      "https://sub.web.selfhost.example.test",
      "https://web.selfhost.example.test:444",
    ])

    approvalLookups.length = 0
    for (const returnUrl of [
      "http://web.selfhost.example.test/signin",
      "https://user@web.selfhost.example.test/signin",
      `${webOrigin}/dashboard/../signin`,
      `${webOrigin}/%2e%2e/signin`,
      `${webOrigin}/other`,
      `${webOrigin}/signin#fragment`,
      "not a url",
    ]) {
      expect(await resolveApprovedWebHandoffReturnUrl({ activeOrganizationId: organizationId, returnUrl, loadSignedPreviewUrls: noSignedPreviews })).toBeNull()
    }
    expect(approvalLookups).toEqual([])
  })

  describe("member organizations", () => {
    const userId = typeId.generator("user")
    const outsiderId = typeId.generator("user")
    const memberLookups: Array<{ userId: string; origin: string }> = []

    async function membersApprove(memberships: Record<string, string[]>) {
      const { setMemberWebOriginLookupForTest } = await import("../src/organization-web-origins.js")
      memberLookups.length = 0
      setMemberWebOriginLookupForTest(async (input) => {
        memberLookups.push(input)
        return input.origin === webOrigin ? (memberships[input.userId] ?? []).map((id) => typeId.schema("organization").parse(id)) : []
      })
    }

    afterEach(async () => {
      const { setMemberWebOriginLookupForTest } = await import("../src/organization-web-origins.js")
      setMemberWebOriginLookupForTest(null)
    })

    test("a fresh multi-organization session with no active organization is approved and lands in the approving organization", async () => {
      const { resolveWebHandoffApproval } = await loadDesktopHandoffRoutes()
      await configureDesktopHandoffEnv({})
      await approveWebOriginForOrganization(organizationId, webOrigin)
      await membersApprove({ [userId]: [organizationId] })

      expect(await resolveWebHandoffApproval({ activeOrganizationId: null, userId, returnUrl: `${webOrigin}/` }))
        .toEqual({ returnUrl: `${webOrigin}/signin`, organizationId })
      expect(approvalLookups).toEqual([])
      expect(memberLookups).toEqual([{ userId, origin: webOrigin }])
    })

    test("a member active in another organization is approved by an organization they belong to", async () => {
      const { resolveWebHandoffApproval } = await loadDesktopHandoffRoutes()
      await configureDesktopHandoffEnv({})
      await approveWebOriginForOrganization(organizationId, webOrigin)
      await membersApprove({ [userId]: [organizationId] })

      expect(await resolveWebHandoffApproval({ activeOrganizationId: otherOrganizationId, userId, returnUrl: webOrigin, loadSignedPreviewUrls: noSignedPreviews }))
        .toEqual({ returnUrl: `${webOrigin}/signin`, organizationId })
      expect(approvalLookups).toEqual([{ origin: webOrigin, organizationId: otherOrganizationId }])
    })

    test("the active organization's own approval keeps the session where it is", async () => {
      const { resolveWebHandoffApproval } = await loadDesktopHandoffRoutes()
      await configureDesktopHandoffEnv({})
      await approveWebOriginForOrganization(organizationId, webOrigin)
      await membersApprove({ [userId]: [otherOrganizationId, organizationId] })

      expect(await resolveWebHandoffApproval({ activeOrganizationId: organizationId, userId, returnUrl: webOrigin }))
        .toEqual({ returnUrl: `${webOrigin}/signin`, organizationId })
      expect(memberLookups).toEqual([])
    })

    test("people outside every approving organization, unsafe URLs, and single-org mode stay refused", async () => {
      const { resolveWebHandoffApproval } = await loadDesktopHandoffRoutes()
      await configureDesktopHandoffEnv({})
      await approveWebOriginForOrganization(organizationId, webOrigin)
      await membersApprove({ [userId]: [organizationId] })

      expect(await resolveWebHandoffApproval({ activeOrganizationId: null, userId: outsiderId, returnUrl: webOrigin })).toBeNull()
      expect(await resolveWebHandoffApproval({ activeOrganizationId: null, userId: "not-a-user-id", returnUrl: webOrigin })).toBeNull()
      for (const returnUrl of ["https://web.selfhost.example.test.evil.test/", `${webOrigin}:444/`, `${webOrigin}/other`, `http://web.selfhost.example.test/`]) {
        expect(await resolveWebHandoffApproval({ activeOrganizationId: null, userId, returnUrl })).toBeNull()
      }
      expect(memberLookups).toEqual([{ userId: outsiderId, origin: webOrigin }, ...["https://web.selfhost.example.test.evil.test", `${webOrigin}:444`].map((origin) => ({ userId, origin }))])

      memberLookups.length = 0
      await configureDesktopHandoffEnv({ orgMode: "single_org" })
      expect(await resolveWebHandoffApproval({ activeOrganizationId: null, userId, returnUrl: webOrigin })).toBeNull()
      expect(memberLookups).toEqual([])
      await configureDesktopHandoffEnv({})
    })
  })
})
