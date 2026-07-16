import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { generateConnectLinkKeyPair, verifyConnectLinkToken } from "@openwork/connect-link/node"
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

type InstallExperienceDependencies = import("../src/routes/org/install-links.js").InstallExperienceDependencies

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_INSTALL_LINKS_GATING_ENABLED = "true"
}

const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const organizationId = createDenTypeId("organization")
const installLinkId = createDenTypeId("installLink")
const insertedRows: unknown[] = []
const revokedRows: unknown[] = []
const officialWindowsInstallerUrl = "https://github.com/different-ai/openwork/releases/download/v9.9.9/openwork-win-x64-9.9.9.exe"
const connectKeyPair = generateConnectLinkKeyPair()
const connectKeyId = "owc-route-test"

function defaultOrganizationMetadata(): Record<string, unknown> {
  return {
    brandAppName: "Acme Work",
    brandLogoUrl: "https://assets.blueyonder.test/wordmark.svg",
    brandIconUrl: "https://assets.blueyonder.test/icon.png",
  }
}

let role = "member"
let isOwner = false
let installLinksCapabilityOverride: boolean | null = null
let failInstallLinkInsert = false
let sessionCreatedAt = new Date()
let organizationMetadata = defaultOrganizationMetadata()

mock.module("../src/db.js", () => ({
  db: {
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        if (failInstallLinkInsert && isRecord(values) && typeof values.tokenHash === "string") {
          return Promise.reject(new Error("install link storage unavailable"))
        }
        insertedRows.push(values)
        return Promise.resolve()
      },
    }),
    select: (selection: unknown) => {
      const rows = isRecord(selection) && "installLink" in selection && "organization" in selection
        ? [{
            installLink: { id: installLinkId, organizationId },
            organization: {
              id: organizationId,
              name: "Acme Robotics",
              slug: "acme-robotics",
              logo: null,
              metadata: organizationMetadata,
            },
          }]
        : []
      const where = (_condition: unknown) => ({
        limit: (_count: number) => Promise.resolve(rows),
      })
      return {
        from: (_table: unknown) => ({
          where,
          innerJoin: (_joinedTable: unknown, _condition: unknown) => ({ where }),
        }),
      }
    },
    update: (_table: unknown) => ({
      set: (values: unknown) => ({
        where: (_condition: unknown) => {
          revokedRows.push(values)
          return Promise.resolve()
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_condition: unknown) => Promise.resolve(),
    }),
  },
}))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function insertedInstallLinks() {
  return insertedRows.filter((row) => isRecord(row) && typeof row.tokenHash === "string")
}

function organizationContextMetadata() {
  if (installLinksCapabilityOverride === null) {
    return organizationMetadata
  }

  const capabilities = isRecord(organizationMetadata.capabilities) ? organizationMetadata.capabilities : {}
  return {
    ...organizationMetadata,
    capabilities: { ...capabilities, installLinks: installLinksCapabilityOverride },
  }
}

mock.module("../src/orgs.js", () => ({
  getOrganizationContextForUser: (input: { organizationId: string; userId: string }) => Promise.resolve(
    input.organizationId === organizationId && input.userId === userId
      ? {
          organization: {
            id: organizationId,
            name: "Acme Robotics",
            slug: "acme-robotics",
            logo: null,
            metadata: organizationContextMetadata(),
          },
          currentMember: {
            id: memberId,
            userId,
            role,
            isOwner,
            createdAt: new Date(),
          },
          members: [],
          invitations: [],
          roles: [],
          teams: [],
          currentMemberTeams: [],
        }
      : null,
  ),
  listTeamsForMember: () => Promise.resolve([]),
  resolveUserOrganizations: () => Promise.resolve({ orgs: [], activeOrgId: null, activeOrgSlug: null }),
  setSessionActiveOrganization: () => Promise.resolve(),
}))

let installLinkModule: typeof import("../src/routes/org/install-links.js")
let installLinkMintingModule: typeof import("../src/install-links.js")
let envModule: typeof import("../src/env.js")

beforeAll(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  installLinkMintingModule = await import("../src/install-links.js")
  installLinkModule = await import("../src/routes/org/install-links.js")
  mock.restore()
})

beforeEach(() => {
  envModule.env.installLinksGatingEnabled = true
  envModule.env.connectLink = null
  envModule.env.devMode = true
  envModule.env.installerArtifactsDir = undefined
  envModule.env.installerReleaseRepo = "different-ai/openwork"
  envModule.env.installerReleaseTag = "v9.9.9"
  insertedRows.length = 0
  revokedRows.length = 0
  role = "member"
  isOwner = false
  installLinksCapabilityOverride = null
  failInstallLinkInsert = false
  sessionCreatedAt = new Date()
  organizationMetadata = defaultOrganizationMetadata()
})

afterAll(() => {
  mock.restore()
})

function createApp(options: {
  installerDirectUrl?: string
  configuredArtifact?: { filePath: string; size: number }
  artifactFileNames?: string[]
  grantOverrides?: Partial<Pick<InstallExperienceDependencies, "mintConnectGrant" | "previewConnectGrant" | "consumeConnectGrant">>
} = {}) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: "riley@acme.test",
      emailVerified: true,
      name: "Riley",
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", {
      id: createDenTypeId("session"),
      activeOrganizationId: organizationId,
      createdAt: sessionCreatedAt,
    })
    await next()
  })
  const shouldResolveConfiguredArtifact = options.configuredArtifact !== undefined || options.artifactFileNames !== undefined
  const overrides: Partial<InstallExperienceDependencies> = {
    ...(shouldResolveConfiguredArtifact
      ? {
          resolveConfiguredArtifact: (fileName: string) => {
            options.artifactFileNames?.push(fileName)
            return Promise.resolve(options.configuredArtifact ?? null)
          },
        }
      : {}),
    ...(options.installerDirectUrl
      ? { resolveDirectUrl: () => options.installerDirectUrl ?? officialWindowsInstallerUrl }
      : {}),
    ...options.grantOverrides,
  }
  installLinkModule.registerOrgInstallLinkRoutes(app, overrides)
  return app
}

function mint(app: Hono, input: { rotate?: boolean } = {}) {
  return app.request(`http://den.local/v1/orgs/${organizationId}/install-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
}

test("members can mint non-rotating install links without revoking earlier links", async () => {
  const app = createApp()
  const first = await mint(app)
  const second = await mint(app, { rotate: false })

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(insertedInstallLinks()).toHaveLength(2)
  expect(revokedRows).toHaveLength(0)
})

test("ordinary members cannot rotate organization install links", async () => {
  const response = await mint(createApp(), { rotate: true })

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({
    error: "forbidden",
    message: "Only workspace owners and admins can rotate install links.",
  })
  expect(insertedInstallLinks()).toHaveLength(0)
  expect(revokedRows).toHaveLength(0)
})

test("admins with a fresh session can explicitly rotate install links", async () => {
  role = "admin"
  const response = await mint(createApp(), { rotate: true })

  expect(response.status).toBe(200)
  expect(revokedRows).toHaveLength(1)
  expect(insertedInstallLinks()).toHaveLength(1)
})

test("explicit rotation still requires a fresh privileged session", async () => {
  role = "admin"
  sessionCreatedAt = new Date(Date.now() - 16 * 60 * 1000)
  const response = await mint(createApp(), { rotate: true })

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({ error: "reauth", reason: "fresh_auth_required" })
  expect(insertedInstallLinks()).toHaveLength(0)
  expect(revokedRows).toHaveLength(0)
})

test("explicit installLinks false kill switch refuses member install links", async () => {
  installLinksCapabilityOverride = false
  const response = await mint(createApp())

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({ error: "capability_disabled", capability: "installLinks" })
  expect(insertedInstallLinks()).toHaveLength(0)
})

test("deprecated deployment gate stays inert when installLinks metadata is absent", async () => {
  envModule.env.installLinksGatingEnabled = true
  organizationMetadata = defaultOrganizationMetadata()
  installLinksCapabilityOverride = null
  const response = await mint(createApp())

  expect(response.status).toBe(200)
  expect(insertedInstallLinks()).toHaveLength(1)
})

test("invitation downloads mint the same org install page without storing the raw token", async () => {
  const downloadUrl = await installLinkMintingModule.resolveInvitationDownloadUrl({
    organizationId,
    createdByUserId: userId,
    metadata: { capabilities: { installLinks: true } },
  })

  const url = new URL(downloadUrl)
  const token = url.searchParams.get("token")
  const rows = insertedInstallLinks()

  expect(url.pathname).toBe("/install")
  expect(url.origin).toBe(new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790").origin)
  expect(token).toBeTruthy()
  expect(rows).toHaveLength(1)
  expect(rows[0]).not.toHaveProperty("token")
  expect(rows[0]).not.toHaveProperty("installPageUrl")
  expect(isRecord(rows[0]) ? rows[0].tokenHash : null).toBe(installLinkMintingModule.hashInstallLinkToken(token ?? ""))
  expect(revokedRows).toHaveLength(0)
})

test("invitation downloads keep the generic URL when install links are disabled", async () => {
  const downloadUrl = await installLinkMintingModule.resolveInvitationDownloadUrl({
    organizationId,
    createdByUserId: userId,
    metadata: { capabilities: { installLinks: false } },
  })

  expect(downloadUrl).toBe("https://openworklabs.com/download")
  expect(insertedInstallLinks()).toHaveLength(0)
})

test("invitation delivery can fall back when install-link storage fails", async () => {
  failInstallLinkInsert = true

  const downloadUrl = await installLinkMintingModule.resolveInvitationDownloadUrl({
    organizationId,
    createdByUserId: userId,
    metadata: { capabilities: { installLinks: true } },
  })

  expect(downloadUrl).toBe("https://openworklabs.com/download")
  expect(insertedInstallLinks()).toHaveLength(0)
})

test("members cannot mint an install link for another organization", async () => {
  const otherOrganizationId = createDenTypeId("organization")
  const response = await createApp().request(`http://den.local/v1/orgs/${otherOrganizationId}/install-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rotate: false }),
  })

  expect(response.status).toBe(404)
  await expect(response.json()).resolves.toEqual({ error: "organization_not_found" })
  expect(insertedInstallLinks()).toHaveLength(0)
})

test("zero-config downloads redirect the browser to the official release", async () => {
  const response = await createApp({ installerDirectUrl: officialWindowsInstallerUrl }).request("http://den.local/v1/install/win-x64?token=opaque-token", {
    redirect: "manual",
  })

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(officialWindowsInstallerUrl)
  expect(response.headers.get("location")).not.toContain("opaque-token")
})

test("unordered organization allowed desktop versions select the maximum direct release URL", async () => {
  organizationMetadata = {
    ...defaultOrganizationMetadata(),
    allowedDesktopVersions: ["0.17.26", "0.17.25", "0.17.27"],
  }

  const response = await createApp().request("http://den.local/v1/install/win-x64?token=opaque-token", {
    redirect: "manual",
  })

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe("https://github.com/different-ai/openwork/releases/download/v0.17.27/openwork-win-x64-0.17.27.exe")
  expect(response.headers.get("location")).not.toContain("v9.9.9")
  expect(response.headers.get("location")).not.toContain("opaque-token")
})

test("mounted artifact lookup uses the organization-specific allowed desktop version filename", async () => {
  organizationMetadata = {
    ...defaultOrganizationMetadata(),
    allowedDesktopVersions: ["0.17.26", "0.17.27"],
  }
  const artifactFileNames: string[] = []
  const installer = Buffer.from("signed-standard-windows-installer", "utf8")
  const artifactPath = path.join(mkdtempSync(path.join(os.tmpdir(), "openwork-installer-route-")), "installer.exe")
  writeFileSync(artifactPath, installer)

  const response = await createApp({
    artifactFileNames,
    configuredArtifact: { filePath: artifactPath, size: installer.byteLength },
  }).request("http://den.local/v1/install/win-x64?token=opaque-token")

  expect(response.status).toBe(200)
  expect(artifactFileNames).toEqual(["openwork-win-x64-0.17.27.exe"])
  expect(response.headers.get("content-disposition")).toContain("openwork-win-x64-0.17.27.exe")
  expect(Buffer.from(await response.arrayBuffer())).toEqual(installer)
})

test("unrestricted organizations use Den's configured installer release tag", async () => {
  organizationMetadata = {
    ...defaultOrganizationMetadata(),
    allowedDesktopVersions: [],
  }

  const response = await createApp().request("http://den.local/v1/install/win-x64?token=opaque-token", {
    redirect: "manual",
  })

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(officialWindowsInstallerUrl)
  expect(response.headers.get("location")).not.toContain("opaque-token")
})

test("install token organization policy applies to member and admin downloads", async () => {
  organizationMetadata = {
    ...defaultOrganizationMetadata(),
    allowedDesktopVersions: ["0.17.26", "0.17.27"],
  }
  const expectedUrl = "https://github.com/different-ai/openwork/releases/download/v0.17.27/openwork-win-x64-0.17.27.exe"

  for (const nextRole of ["member", "admin"]) {
    role = nextRole
    const response = await createApp().request("http://den.local/v1/install/win-x64?token=opaque-token", {
      redirect: "manual",
    })

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(expectedUrl)
  }
})

test.each(["mac-arm64", "win-x64", "linux-x64", "linux-arm64"])(
  "zero-config %s downloads redirect immediately to the normal installer without forwarding the token",
  async (platform) => {
    const directUrl = `https://github.com/different-ai/openwork/releases/download/v9.9.9/${platform}`
    const response = await createApp({ installerDirectUrl: directUrl }).request(
      `http://den.local/v1/install/${platform}?token=opaque-token`,
      { redirect: "manual" },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(directUrl)
    expect(response.headers.get("location")).not.toContain("opaque-token")
  },
)

test("guided semi-air-gapped downloads return a provisioned standard installer without ZIP wrapping", async () => {
  const installer = Buffer.from("signed-standard-windows-installer", "utf8")
  const artifactPath = path.join(mkdtempSync(path.join(os.tmpdir(), "openwork-installer-route-")), "installer.exe")
  writeFileSync(artifactPath, installer)
  const response = await createApp({
    configuredArtifact: { filePath: artifactPath, size: installer.byteLength },
  }).request(
    "http://den.local/v1/install/win-x64?token=opaque-token",
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/vnd.microsoft.portable-executable")
  expect(response.headers.get("content-disposition")).toContain("openwork-win-x64-")
  expect(Buffer.from(await response.arrayBuffer())).toEqual(installer)
})

test("zero-config install config mints a short-lived exchange without storing the raw code", async () => {
  const response = await createApp().request("http://127.0.0.1:8790/v1/install-config?token=opaque-token")

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.connectUrl).toStartWith("openwork://connect?code=")
  expect(body.requireSignin).toBe(true)
  expect(Date.parse(body.connectExpiresAt)).toBeGreaterThan(Date.now())

  const url = new URL(body.connectUrl)
  const code = url.searchParams.get("code") ?? ""
  expect(code.length).toBeGreaterThanOrEqual(24)
  expect(url.searchParams.get("apiBaseUrl")).toBe("http://127.0.0.1:8790")

  const grant = insertedRows.find((row) => isRecord(row) && typeof row.codeHash === "string")
  expect(grant).toMatchObject({
    installLinkId,
    consumedAt: null,
    consumedNonce: null,
    claims: {
      org: { name: "Acme Robotics" },
      brand: {
        appName: "Acme Work",
        logoUrl: "https://assets.blueyonder.test/wordmark.svg",
        iconUrl: "https://assets.blueyonder.test/icon.png",
      },
      requireSignin: true,
    },
  })
  expect(grant).not.toHaveProperty("code")
  expect(JSON.stringify(grant)).not.toContain(code)
})

test("keyless preview is read-only and exchange consumes the grant once", async () => {
  const code = "abcdefghijklmnopqrstuvwxyz123456"
  const claims = {
    iss: "http://127.0.0.1:8790",
    aud: "openwork-desktop-connect",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: "grant-jti-123456",
    v: 1,
    org: { name: "Acme Robotics" },
    brand: { appName: "OpenWork", logoUrl: null, iconUrl: null },
    den: { baseUrl: "http://127.0.0.1:8790", apiBaseUrl: "http://127.0.0.1:8790" },
    requireSignin: true,
  }
  let consumed = false
  const app = createApp({
    grantOverrides: {
      previewConnectGrant: () => Promise.resolve(consumed
        ? { ok: false, code: "replayed" }
        : { ok: true, claims }),
      consumeConnectGrant: () => {
        if (consumed) return Promise.resolve({ ok: false, code: "replayed" })
        consumed = true
        return Promise.resolve({ ok: true, claims })
      },
    },
  })
  const request = (mode: "preview" | "exchange") => app.request(`http://den.local/v1/install-connect/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })

  const firstPreview = await request("preview")
  expect(firstPreview.status).toBe(200)
  expect(consumed).toBe(false)
  const exchange = await request("exchange")
  expect(exchange.status).toBe(200)
  expect(consumed).toBe(true)
  const replay = await request("exchange")
  expect(replay.status).toBe(409)
  await expect(replay.json()).resolves.toEqual({ error: "connect_grant_replayed" })
})

test("signed handoffs use the same direct standard-installer route", async () => {
  envModule.env.connectLink = { privateKeyPem: "unused by download route", kid: "test" }
  const response = await createApp({ installerDirectUrl: officialWindowsInstallerUrl }).request(
    "http://den.local/v1/install/win-x64?token=opaque-token",
    { redirect: "manual" },
  )

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(officialWindowsInstallerUrl)
})

test("install config includes a fresh signed organization handoff while preserving normal sign-in", async () => {
  envModule.env.connectLink = { privateKeyPem: connectKeyPair.privateKeyPem, kid: connectKeyId }
  const response = await createApp().request("http://127.0.0.1:8790/v1/install-config?token=opaque-token")

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.connectUrl).toStartWith("openwork://connect?token=")
  expect(body.requireSignin).toBe(true)

  const token = new URL(body.connectUrl).searchParams.get("token") ?? ""
  const verified = verifyConnectLinkToken({
    token,
    publicKeys: { [connectKeyId]: connectKeyPair.publicKeyPem },
    allowInsecureLoopback: true,
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error("expected install handoff token to verify")
  expect(verified.claims.org.name).toBe("Acme Robotics")
  expect(verified.claims.brand).toEqual({
    appName: "Acme Work",
    logoUrl: "https://assets.blueyonder.test/wordmark.svg",
    iconUrl: "https://assets.blueyonder.test/icon.png",
  })
  expect(verified.claims.den.baseUrl).toBe(process.env.BETTER_AUTH_URL)
  expect(verified.claims.den.apiBaseUrl).toBe("http://127.0.0.1:8790")
  expect(verified.claims.requireSignin).toBe(true)
})
