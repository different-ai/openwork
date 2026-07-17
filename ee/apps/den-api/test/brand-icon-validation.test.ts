import { deflateSync } from "node:zlib"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { BRAND_ICON_FETCH_USER_AGENT, validateBrandIconUrl } from "../src/brand-icon-validation.js"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const organization = {
  id: organizationId,
  slug: "brand-icon-validation",
  name: "Brand Icon Validation",
  metadata: {},
}
const currentMember = {
  id: memberId,
  role: "owner",
  isOwner: true,
}
const updatedOrganization = {
  ...organization,
  metadata: {
    brandIconUrl: "https://cdn.example.com/icon.png",
  },
}
const updateOrganizationSettingsCalls: Array<{ brandIconUrl?: string | null }> = []

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type FetchCall = {
  input: FetchInput
  init: FetchInit | undefined
}

let app: Hono
let fetchCalls: FetchCall[] = []
const originalFetch = globalThis.fetch

class OrganizationEmailDomainRestrictionError extends Error {
  emailDomain = null
  allowedEmailDomains: string[] = []
}

mock.module("../src/auth.js", () => ({
  auth: {
    api: {
      setActiveOrganization: () => Promise.resolve(),
    },
  },
}))

mock.module("../src/db.js", () => ({
  db: {},
}))

mock.module("../src/entitlements.js", () => ({
  checkEntitlement: () => ({ ok: true }),
  getOrganizationEntitlements: () => ({}),
  parseOrganizationPlan: () => ({}),
}))

mock.module("../src/env.js", () => ({
  env: {
    orgMode: "multi_org",
    betterAuthTrustedOrigins: ["http://den.local"],
    betterAuthUrl: "http://den.local",
  },
}))

mock.module("../src/enterprise-auth-requirement.js", () => ({
  findEnterpriseAuthRequirementForEmail: () => Promise.resolve(null),
}))

mock.module("../src/organization-capabilities.js", () => ({
  normalizeOrganizationCapabilities: () => ({}),
}))

mock.module("../src/organization-join-verification.js", () => ({
  validateInvitationAcceptVerification: () => ({ ok: true }),
}))

mock.module("../src/organization-limits.js", () => ({
  normalizeOrganizationMetadata: () => ({ metadata: {} }),
}))

mock.module("../src/orgs.js", () => ({
  acceptInvitationForUser: () => Promise.resolve(null),
  createOrganizationForUser: () => Promise.resolve(organization),
  getInvitationPreview: () => Promise.resolve(null),
  getOrganizationContextForUser: () => Promise.resolve({
    organization,
    currentMember,
    currentMemberTeams: [],
    members: [],
    teams: [],
    roles: [],
  }),
  getSingletonSsoStatus: () => Promise.resolve({
    configured: false,
    organizationSlug: null,
    signInPath: "/signin",
  }),
  listTeamsForMember: () => Promise.resolve([]),
  normalizeAllowedEmailDomains: (domains: string[] | null | undefined) => ({
    domains,
    invalidDomains: [],
  }),
  OrganizationEmailDomainRestrictionError,
  resolveUserOrganizations: () => Promise.resolve({
    orgs: [organization],
    activeOrgId: organizationId,
    activeOrgSlug: organization.slug,
  }),
  setSessionActiveOrganization: () => Promise.resolve(),
  updateOrganizationSettings: (input: { brandIconUrl?: string | null }) => {
    updateOrganizationSettingsCalls.push(input)
    return Promise.resolve(updatedOrganization)
  },
}))

mock.module("../src/user.js", () => ({
  getRequiredUserEmail: () => "owner@example.test",
}))

beforeAll(async () => {
  const core = await import("../src/routes/org/core.js")
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", { id: userId })
    c.set("session", { id: "session_test", createdAt: new Date() })
    c.set("activeOrganizationId", organizationId)
    await next()
  })
  core.registerOrgCoreRoutes(app)
})

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    configurable: true,
    writable: true,
  })
  fetchCalls = []
  updateOrganizationSettingsCalls.length = 0
})

afterAll(() => {
  mock.restore()
})

function installFetchResponse(response: Response) {
  Object.defineProperty(globalThis, "fetch", {
    value: (input: FetchInput, init?: FetchInit) => {
      fetchCalls.push({ input, init })
      return Promise.resolve(response)
    },
    configurable: true,
    writable: true,
  })
}

function concatBytes(chunks: Uint8Array[]) {
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type)
  const chunk = new Uint8Array(12 + data.byteLength)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.byteLength)
  chunk.set(typeBytes, 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(concatBytes([typeBytes, data])))
  return chunk
}

function createPng(width: number, height: number) {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = new Uint8Array((width * 4 + 1) * height)
  return concatBytes([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ])
}

test("validateBrandIconUrl rejects non-http URLs before fetching", async () => {
  const result = await validateBrandIconUrl("file:///tmp/icon.png")
  expect(result).toEqual({
    ok: false,
    reason: "invalid-url",
    message: "Use an http or https URL for the brand icon.",
  })
})

test("PATCH /v1/org rejects brand icon URLs that resolve to HTML", async () => {
  installFetchResponse(new Response("<html></html>", {
    headers: { "content-type": "text/html" },
  }))

  const response = await app.request("http://den.local/v1/org", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brandIconUrl: "https://cdn.example.com/icon.png" }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: "invalid_brand_icon",
    reason: "not-an-image",
    message: "That link didn't return an image — it may redirect to a web page instead of the file (some logo CDNs block hotlinking). Use a direct PNG URL.",
  })
  expect(updateOrganizationSettingsCalls).toHaveLength(0)
  expect(fetchCalls[0]?.init?.redirect).toBe("follow")
  expect(fetchCalls[0]?.init?.headers).toEqual({
    "user-agent": BRAND_ICON_FETCH_USER_AGENT,
    accept: "image/*,*/*",
  })
})

test("PATCH /v1/org accepts a valid square PNG brand icon", async () => {
  const png = createPng(64, 64)
  installFetchResponse(new Response(png, {
    headers: {
      "content-type": "image/png",
      "content-length": String(png.byteLength),
    },
  }))

  const response = await app.request("http://den.local/v1/org", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brandIconUrl: "https://cdn.example.com/icon.png" }),
  })

  expect(response.status).toBe(200)
  expect(updateOrganizationSettingsCalls).toHaveLength(1)
  expect(updateOrganizationSettingsCalls[0]?.brandIconUrl).toBe("https://cdn.example.com/icon.png")
})
