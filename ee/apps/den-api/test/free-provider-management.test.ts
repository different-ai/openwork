import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { freeInferenceDefaultPinned, type FreeInferenceProviderSummary } from "@openwork/types/den/inference"
import * as validation from "../src/middleware/validation.js"

const organizationId = createDenTypeId("organization")
const foreignOrgId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
let role = "owner"
let fresh = true
let authenticated = true
let failRead = false
let metadata: Record<string, unknown> = {}
const reads: string[] = []
const writes: string[] = []
const summary: FreeInferenceProviderSummary = {
  state: "available", reason: null, defaultPinned: true, modelGroup: { id: "free", name: "Free" }, catalog: [],
  allowance: { usageScope: "organization", allowanceScope: "person", windowStartAt: "2026-09-14T00:00:00.000Z", resetsAt: "2026-09-21T00:00:00.000Z",
    weeklyLimitUsd: 5, joinedMembers: 3, eligibleMembers: 3, exhaustedMembers: 1, usedUsd: 2, reservedUsd: 0, retainedUsd: 0, requestCount: 4 },
}
const memberRoute: MiddlewareHandler = async (c, next) => {
  if (!authenticated) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", { organization: { id: organizationId, metadata }, currentMember: { id: memberId, role, isOwner: role === "owner" } })
  c.set("session", { createdAt: new Date(Date.now() - (fresh ? 0 : 3_600_000)) })
  await next()
}
mock.module("../src/middleware/index.js", () => ({ ...validation, orgMemberRoute: () => memberRoute, orgRoleRoute: () => memberRoute }))
mock.module("../src/env.js", () => ({ env: { inferenceFree: { enabled: false } } }))
mock.module("../src/inference.js", () => ({
  getFreeInferenceProviderSummary: async (orgId: string) => { reads.push(orgId); if (failRead) throw new Error("Unavailable"); return { ...summary, defaultPinned: freeInferenceDefaultPinned(metadata) } },
  getMemberInferenceAccess: async () => { throw new Error("Personal balances must not supply organization metrics") },
  ensureMemberFreeInferenceCredential: async () => { throw new Error("Pins must not issue credentials") },
  getInferenceStatus: async () => { throw new Error("Pins must not read paid accounting") },
  setInferenceEnabled: async () => { throw new Error("Pins must not enable inference") },
  allowFreeInferenceOffer: async () => { throw new Error("Pins must not change the free Auto opt-out") },
}))
mock.module("../src/organization-metadata.js", () => ({
  updateOrganizationMetadata: async (orgId: string, transform: (current: Record<string, unknown>) => Record<string, unknown>) => {
    writes.push(orgId)
    if (orgId !== organizationId) throw new Error("Cross-organization write")
    metadata = transform(metadata)
    return metadata
  },
  assertOrganizationManagedModelsAllowed: async () => { throw new Error("Pin preference must not provision models") },
}))
mock.module("../src/stripe-billing.js", () => ({ organizationHasActiveInferenceSubscription: async () => { throw new Error("Pins must not read paid billing") } }))
const { registerOrgInferenceRoutes } = await import("../src/routes/org/inference.js")
const app = new Hono()
registerOrgInferenceRoutes(app)
const patch = (body: unknown) => app.request("/v1/inference/free/pins", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
beforeEach(() => { role = "owner"; fresh = true; authenticated = true; failRead = false; metadata = {}; reads.length = 0; writes.length = 0 })
afterAll(() => mock.restore())

test("organization allowance counts are admin-only and scoped by authenticated context", async () => {
  for (const denied of ["member", "viewer", "provider-manager"]) {
    role = denied
    expect((await app.request("/v1/inference/free/provider")).status).toBe(403)
  }
  expect(reads).toEqual([])
  role = "admin"
  const response = await app.request(`/v1/inference/free/provider?organizationId=${foreignOrgId}`)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ provider: summary })
  expect(reads).toEqual([organizationId])
})

test("Auto pin writes require a fresh owner or admin and preserve DPA and unrelated metadata", async () => {
  role = "member"
  expect((await patch({ defaultPinned: false })).status).toBe(403)
  role = "admin"
  fresh = false
  expect((await patch({ defaultPinned: false })).status).toBe(403)
  expect(writes).toEqual([])
  fresh = true
  metadata = { dpaSigned: true, inference: { enabled: false }, inferenceFree: { offerAllowed: false, other: 7 }, unrelated: "retained" }
  const response = await patch({ defaultPinned: false })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ defaultPinned: false })
  expect(metadata).toEqual({ dpaSigned: true, inference: { enabled: false }, inferenceFree: { offerAllowed: false, other: 7, defaultPinned: false }, unrelated: "retained" })
  expect(writes).toEqual([organizationId])
  expect(reads).toEqual([])
})

test("pin writes reject caller-selected organizations, access flags and malformed values", async () => {
  for (const body of [{ defaultPinned: false, organizationId: foreignOrgId }, { defaultPinned: true, offerAllowed: true }, { defaultPinned: true, enabled: true }, { defaultPinned: "false" }, {}]) {
    expect((await patch(body)).status).toBe(400)
  }
  expect(writes).toEqual([])
})

test("summary failures return no fabricated or partial aggregate values", async () => {
  failRead = true
  const response = await app.request("/v1/inference/free/provider")
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: "free_provider_summary_unavailable" })
})

test("unsigned callers cannot read summaries or mutate Auto policy", async () => {
  authenticated = false
  expect((await app.request("/v1/inference/free/provider")).status).toBe(401)
  expect((await patch({ defaultPinned: false })).status).toBe(401)
  expect(reads).toEqual([])
  expect(writes).toEqual([])
})
