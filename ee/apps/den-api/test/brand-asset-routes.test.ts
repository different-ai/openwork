import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import sharp from "sharp"
import type { BrandAssetStorage, BrandAssetStorageKey } from "../src/brand-assets.js"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
let owner = true
const settingsUpdates: Array<Record<string, unknown>> = []
const storedAssets = new Map<string, ArrayBuffer>()

function storageKey(key: BrandAssetStorageKey) {
  return `${key.organizationId}/${key.kind}/${key.version}.${key.extension}`
}

const storage: BrandAssetStorage = {
  async put(key, bytes) {
    storedAssets.set(storageKey(key), bytes.slice(0))
  },
  async read(key) {
    return storedAssets.get(storageKey(key))?.slice(0) ?? null
  },
}

function organizationContext() {
  return {
    organization: {
      id: organizationId,
      slug: "example-corp",
      name: "Example Corp",
      metadata: {},
    },
    currentMember: {
      id: memberId,
      role: owner ? "owner" : "member",
      isOwner: owner,
    },
    currentMemberTeams: [],
    members: [],
    teams: [],
    roles: [],
  }
}

mock.module("../src/entitlements.js", () => ({
  checkEntitlement: () => ({ ok: true }),
}))

mock.module("../src/db.js", () => ({
  db: {},
}))

mock.module("../src/env.js", () => ({
  env: {
    apiPublicUrl: "https://den.examplecorp.test",
    port: 8788,
  },
}))

mock.module("../src/orgs.js", () => ({
  getOrganizationContextForUser: () => Promise.resolve(organizationContext()),
  listTeamsForMember: () => Promise.resolve([]),
  resolveUserOrganizations: () => Promise.resolve({
    orgs: [],
    activeOrgId: organizationId,
    activeOrgSlug: "example-corp",
  }),
  setSessionActiveOrganization: () => Promise.resolve(),
  updateOrganizationSettings: (input: Record<string, unknown>) => {
    settingsUpdates.push(input)
    return Promise.resolve(organizationContext().organization)
  },
}))

let app: Hono

beforeAll(async () => {
  const { registerOrgBrandAssetRoutes } = await import("../src/routes/org/brand-assets.js")
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", { id: userId })
    c.set("session", { id: "session_brand_assets", createdAt: new Date(), activeOrganizationId: organizationId })
    c.set("activeOrganizationId", organizationId)
    await next()
  })
  registerOrgBrandAssetRoutes(app, {
    storage,
    publicBaseUrl: "https://den.examplecorp.test",
    signingSecret: "brand-assets-test-secret-with-at-least-32-characters",
  })
})

beforeEach(() => {
  owner = true
  settingsUpdates.length = 0
  storedAssets.clear()
})

async function pngFile(name: string, width: number, height: number) {
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 16, g: 73, b: 128, alpha: 1 },
    },
  }).png().toBuffer()
  return new File([Uint8Array.from(bytes)], name, { type: "image/png" })
}

test("an owner uploads both assets and members can read immutable Den URLs", async () => {
  const form = new FormData()
  form.set("logo", await pngFile("example-corp-wordmark.png", 640, 160))
  form.set("icon", await pngFile("example-corp-icon.png", 256, 256))

  const response = await app.request("http://den.local/v1/org/brand-assets", {
    method: "POST",
    body: form,
  })
  const payload = await response.json()

  expect(response.status).toBe(200)
  expect(payload.assets.logo.url).toStartWith(`https://den.examplecorp.test/v1/brand-assets/${organizationId}/logo/`)
  expect(payload.assets.icon.url).toStartWith(`https://den.examplecorp.test/v1/brand-assets/${organizationId}/icon/`)
  expect(settingsUpdates).toHaveLength(1)
  expect(settingsUpdates[0]).toMatchObject({
    organizationId,
    brandLogoUrl: payload.assets.logo.url,
    brandIconUrl: payload.assets.icon.url,
  })

  const signedAssetUrl = new URL(payload.assets.icon.url)
  const assetResponse = await app.request(`${signedAssetUrl.pathname}${signedAssetUrl.search}`)
  expect(assetResponse.status).toBe(200)
  expect(assetResponse.headers.get("content-type")).toBe("image/png")
  expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(assetResponse.headers.get("etag")).toBe(`"${payload.assets.icon.version}"`)
  expect((await assetResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)

  const unsignedAssetUrl = new URL(payload.assets.icon.url)
  unsignedAssetUrl.search = ""
  const unsignedResponse = await app.request(`${unsignedAssetUrl.pathname}${unsignedAssetUrl.search}`)
  expect(unsignedResponse.status).toBe(404)

  const tamperedAssetUrl = new URL(payload.assets.icon.url)
  tamperedAssetUrl.searchParams.set("signature", "invalid")
  const tamperedResponse = await app.request(`${tamperedAssetUrl.pathname}${tamperedAssetUrl.search}`)
  expect(tamperedResponse.status).toBe(404)
})

test("a non-owner cannot upload managed brand assets", async () => {
  owner = false
  const form = new FormData()
  form.set("icon", await pngFile("example-corp-icon.png", 256, 256))

  const response = await app.request("http://den.local/v1/org/brand-assets", {
    method: "POST",
    body: form,
  })

  expect(response.status).toBe(403)
  expect(settingsUpdates).toHaveLength(0)
  expect(storedAssets.size).toBe(0)
})

test("the upload route reports which intended use failed validation", async () => {
  const form = new FormData()
  form.set("icon", await pngFile("wide-wordmark-is-not-an-icon.png", 640, 160))

  const response = await app.request("http://den.local/v1/org/brand-assets", {
    method: "POST",
    body: form,
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: "invalid_brand_asset",
    kind: "icon",
    reason: "invalid-aspect",
  })
  expect(settingsUpdates).toHaveLength(0)
})
