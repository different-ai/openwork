import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

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
const insertedRows: unknown[] = []
const revokedRows: unknown[] = []
const officialWindowsInstallerUrl = "https://github.com/different-ai/openwork/releases/download/v9.9.9/openwork-win-x64-9.9.9.exe"

let role = "member"
let isOwner = false
let capabilityEnabled = true
let failInstallLinkInsert = false
let sessionCreatedAt = new Date()

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
            installLink: { organizationId },
            organization: {
              id: organizationId,
              name: "Acme Robotics",
              slug: "acme-robotics",
              logo: null,
              metadata: {
                capabilities: { installLinks: true },
                brandIconUrl: "https://assets.blueyonder.test/icon.png",
              },
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
  },
}))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function insertedInstallLinks() {
  return insertedRows.filter((row) => isRecord(row) && typeof row.tokenHash === "string")
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
            metadata: {
              capabilities: { installLinks: capabilityEnabled },
              brandIconUrl: "https://assets.blueyonder.test/icon.png",
            },
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
})

beforeEach(() => {
  envModule.env.installLinksGatingEnabled = true
  insertedRows.length = 0
  revokedRows.length = 0
  role = "member"
  isOwner = false
  capabilityEnabled = true
  failInstallLinkInsert = false
  sessionCreatedAt = new Date()
})

function createApp(options: { installerFallbackUrl?: string; installerArtifact?: Buffer } = {}) {
  const app = new Hono()
  const installerFallbackUrl = options.installerFallbackUrl
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
  installLinkModule.registerOrgInstallLinkRoutes(
    app,
    installerFallbackUrl || options.installerArtifact
      ? {
          resolveArtifact: () => Promise.resolve(options.installerArtifact ?? null),
          resolveFallbackUrl: () => Promise.resolve(installerFallbackUrl ?? officialWindowsInstallerUrl),
        }
      : undefined,
  )
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

test("the organization capability still gates member install links", async () => {
  capabilityEnabled = false
  const response = await mint(createApp())

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({ error: "capability_disabled", capability: "installLinks" })
  expect(insertedInstallLinks()).toHaveLength(0)
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

test("missing server-side artifacts redirect the browser to the official release", async () => {
  const response = await createApp({ installerFallbackUrl: officialWindowsInstallerUrl }).request("http://den.local/v1/install/win-x64?token=opaque-token", {
    redirect: "manual",
  })

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(officialWindowsInstallerUrl)
  expect(response.headers.get("location")).not.toContain("opaque-token")
})

test.each([
  ["mac-arm64", ".dmg"],
  ["win-x64", ".exe"],
])("organization %s downloads contain the untouched standard installer and desktop bootstrap", async (platform, extension) => {
  const installerArtifact = Buffer.from(`signed-standard-${platform}-bytes`, "utf8")
  const response = await createApp({ installerArtifact }).request(`http://den.local/v1/install/${platform}?token=opaque-token`)

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/zip")
  expect(response.headers.get("content-disposition")).toContain(`OpenWork-acme-robotics-${platform}.zip`)

  const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-org-download-"))
  try {
    const archivePath = path.join(dir, "download.zip")
    const outputDir = path.join(dir, "output")
    mkdirSync(outputDir)
    writeFileSync(archivePath, new Uint8Array(await response.arrayBuffer()))
    const unzip = spawnSync("unzip", ["-q", archivePath, "-d", outputDir], { encoding: "utf8" })
    if (unzip.status !== 0) {
      throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout}`)
    }

    const entries = readdirSync(outputDir)
    const installerName = entries.find((entry) => entry.endsWith(extension))
    expect(installerName).toBeTruthy()
    expect(entries).toContain("desktop-bootstrap.json")
    expect(entries.some((entry) => entry.includes("openwork-installer"))).toBe(false)
    expect(readFileSync(path.join(outputDir, installerName ?? "missing"))).toEqual(installerArtifact)

    const bootstrap = JSON.parse(readFileSync(path.join(outputDir, "desktop-bootstrap.json"), "utf8"))
    expect(bootstrap).toMatchObject({
      baseUrl: process.env.BETTER_AUTH_URL,
      requireSignin: true,
      brandAppName: "OpenWork",
      brandIconUrl: "https://assets.blueyonder.test/icon.png",
    })
    expect(bootstrap.apiBaseUrl).toBe("http://den.local")
    expect(Number.isFinite(Date.parse(bootstrap.writtenAt))).toBe(true)
    expect(JSON.stringify(bootstrap)).not.toContain("opaque-token")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
