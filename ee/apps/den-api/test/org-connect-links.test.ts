import { verifyConnectLinkToken } from "@openwork/connect-link/node"
import { generateConnectLinkKeyPair } from "@openwork/connect-link/node"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

const KEY_PAIR = generateConnectLinkKeyPair()
const KID = "owc-test-2026"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  // Https origins so minted claims pass the https-only rule without dev mode.
  process.env.DEN_BETTER_AUTH_TRUSTED_ORIGINS = "https://openwork.acme.test"
  process.env.DEN_API_PUBLIC_URL = "https://api.openwork.acme.test"
  process.env.DEN_CONNECT_LINKS_GATING_ENABLED = "true"
  process.env.DEN_CONNECT_LINK_PRIVATE_KEY = KEY_PAIR.privateKeyPem
  process.env.DEN_CONNECT_LINK_KEY_ID = KID
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const organizationId = createDenTypeId("organization")

let role = "member"
let isOwner = true
let capabilityEnabled = true
let sessionCreatedAt = new Date()
let userEmail: string | null = "riley@acme.test"
let rateLimitRow: { id: string; count: number; lastRequest: number } | null = null
const sentEmails: Array<Record<string, unknown>> = []
let failEmailSend = false

class FakeEmailSendError extends Error {
  reason: string
  detail: string | null
  constructor(reason: string, detail: string | null = null) {
    super(`email send failed: ${reason}`)
    this.reason = reason
    this.detail = detail
  }
}

mock.module("../src/utils/email/send-email.js", () => ({
  DenEmailSendError: FakeEmailSendError,
  sendEmail: (input: unknown) => {
    if (failEmailSend) {
      return Promise.reject(new FakeEmailSendError("email_not_configured"))
    }
    if (isRecord(input)) sentEmails.push(input)
    return Promise.resolve()
  },
  listDevEmails: () => [],
  getLastDevEmail: () => null,
}))

mock.module("../src/db.js", () => ({
  db: {
    insert: (_table: unknown) => ({
      values: (_values: unknown) => Promise.resolve(),
    }),
    select: (selection: unknown) => {
      const isRateLimitSelect = isRecord(selection) && "count" in selection && "lastRequest" in selection
      const rows = isRateLimitSelect && rateLimitRow ? [rateLimitRow] : []
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
      set: (_values: unknown) => ({
        where: (_condition: unknown) => Promise.resolve(),
      }),
    }),
  },
}))

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
              capabilities: { connectLinks: capabilityEnabled },
              brandAppName: "Acme Work",
              brandLogoUrl: "https://assets.acme.test/wordmark.svg",
              brandIconUrl: "https://assets.acme.test/icon.png",
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

let connectLinkModule: typeof import("../src/routes/org/connect-links.js")
let envModule: typeof import("../src/env.js")

beforeAll(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  connectLinkModule = await import("../src/routes/org/connect-links.js")
})

beforeEach(() => {
  envModule.env.connectLinksGatingEnabled = true
  envModule.env.connectLink = { privateKeyPem: KEY_PAIR.privateKeyPem, kid: KID }
  role = "member"
  isOwner = true
  capabilityEnabled = true
  sessionCreatedAt = new Date()
  userEmail = "riley@acme.test"
  rateLimitRow = null
  sentEmails.length = 0
  failEmailSend = false
})

function createApp() {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: userEmail,
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
  connectLinkModule.registerOrgConnectLinkRoutes(app)
  return app
}

function mint(app: Hono, input: Record<string, unknown> = {}, orgId: string = organizationId) {
  return app.request(`https://api.openwork.acme.test/v1/orgs/${orgId}/connect-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
}

function tokenFrom(connectUrl: string) {
  const url = new URL(connectUrl)
  return url.searchParams.get("token") ?? ""
}

test("owners mint a signed connect link that verifies against the paired public key", async () => {
  const response = await mint(createApp())
  expect(response.status).toBe(200)
  const body = await response.json() as Record<string, unknown>

  expect(String(body.connectUrl)).toStartWith("openwork://connect?token=")
  expect(body.emailed).toBe(true)
  expect(body.recipient).toBe("riley@acme.test")

  const verified = verifyConnectLinkToken({
    token: tokenFrom(String(body.connectUrl)),
    publicKeys: { [KID]: KEY_PAIR.publicKeyPem },
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error("expected token to verify")
  expect(verified.kid).toBe(KID)
  expect(verified.claims.aud).toBe("openwork-desktop-connect")
  expect(verified.claims.v).toBe(1)
  expect(verified.claims.org).toEqual({ name: "Acme Robotics" })
  expect(verified.claims.brand).toEqual({
    appName: "Acme Work",
    logoUrl: "https://assets.acme.test/wordmark.svg",
    iconUrl: "https://assets.acme.test/icon.png",
  })
  expect(verified.claims.den.baseUrl).toBe("https://openwork.acme.test")
  expect(verified.claims.den.apiBaseUrl).toBe("https://api.openwork.acme.test")
  expect(verified.claims.requireSignin).toBe(true)
  expect(verified.claims.exp - verified.claims.iat).toBe(72 * 3600)
  expect(verified.claims.jti.length).toBeGreaterThanOrEqual(16)

  expect(sentEmails).toHaveLength(1)
  expect(sentEmails[0]).toMatchObject({
    to: "riley@acme.test",
    template: "connectDesktop",
  })
})

test("ttlHours and explicit recipients are honored", async () => {
  const response = await mint(createApp(), { email: "new-hire@acme.test", ttlHours: 24 })
  expect(response.status).toBe(200)
  const body = await response.json() as Record<string, unknown>
  expect(body.recipient).toBe("new-hire@acme.test")

  const verified = verifyConnectLinkToken({
    token: tokenFrom(String(body.connectUrl)),
    publicKeys: { [KID]: KEY_PAIR.publicKeyPem },
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error("expected token to verify")
  expect(verified.claims.exp - verified.claims.iat).toBe(24 * 3600)
})

test("send:false returns the link without emailing", async () => {
  const response = await mint(createApp(), { send: false })
  expect(response.status).toBe(200)
  const body = await response.json() as Record<string, unknown>
  expect(body.emailed).toBe(false)
  expect(body.recipient).toBeUndefined()
  expect(sentEmails).toHaveLength(0)
})

test("ordinary members cannot mint connect links", async () => {
  role = "member"
  isOwner = false
  const response = await mint(createApp())
  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({ error: "forbidden" })
  expect(sentEmails).toHaveLength(0)
})

test("minting requires a fresh privileged session", async () => {
  sessionCreatedAt = new Date(Date.now() - 16 * 60 * 1000)
  const response = await mint(createApp())
  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({ error: "reauth", reason: "fresh_auth_required" })
})

test("the connectLinks capability gates minting on gated deployments", async () => {
  capabilityEnabled = false
  const response = await mint(createApp())
  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({ error: "capability_disabled", capability: "connectLinks" })
})

test("deployments without a signing key return 503", async () => {
  envModule.env.connectLink = null
  const response = await mint(createApp())
  expect(response.status).toBe(503)
  await expect(response.json()).resolves.toMatchObject({ error: "connect_links_not_configured" })
})

test("minting is rate limited per user", async () => {
  rateLimitRow = { id: createDenTypeId("rateLimit"), count: 30, lastRequest: Date.now() }
  const response = await mint(createApp())
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBeTruthy()
  await expect(response.json()).resolves.toMatchObject({ error: "rate_limited" })
})

test("email provider failures surface as 502 without leaking the token", async () => {
  failEmailSend = true
  const response = await mint(createApp())
  expect(response.status).toBe(502)
  await expect(response.json()).resolves.toMatchObject({
    error: "connect_link_email_failed",
    reason: "email_not_configured",
  })
})

test("members cannot mint for another organization", async () => {
  const response = await mint(createApp(), {}, createDenTypeId("organization"))
  expect(response.status).toBe(404)
  await expect(response.json()).resolves.toEqual({ error: "organization_not_found" })
})
