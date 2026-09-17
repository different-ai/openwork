import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayRouterDefinitionSchema, gatewayRouterUpdateSchema, isGatewayRouterTargetNpm } from "@openwork/types/den/gateway-router"
import { Hono, type MiddlewareHandler } from "hono"
import { z } from "zod"
import * as validation from "../src/middleware/validation.js"

const organizationId = createDenTypeId("organization"), memberId = createDenTypeId("member"), routerId = createDenTypeId("gatewayRouter")
const providerId = createDenTypeId("inferenceProvider")
const suffix = "00000000000000000000000001"
const model = `gwm_${suffix}_${suffix}_${suffix}`
const definition = { name: "Private router", status: "active", routes: [
  { id: "fast", description: "Short requests", inferenceProviderId: providerId, model },
  { id: "deep", description: "Complex requests", inferenceProviderId: providerId, model },
], fallbackRouteId: "deep", minConfidence: 0.7 }
const row = { id: routerId, organization_id: organizationId, created_by_org_membership_id: memberId, name: definition.name, status: definition.status, configuration: { routes: definition.routes, fallbackRouteId: definition.fallbackRouteId, minConfidence: definition.minConfidence }, revision: 2, created_at: new Date(), updated_at: new Date() }
let selections: unknown[][] = []
let predicates: { sql: string; params: unknown[] }[] = []
let writes = 0
let enabled = true
let authenticated = true
let usableModels = [{ id: model, name: "Test model" }]
function predicateEvidence(predicate: SQL) {
  const params: unknown[] = []
  function visit(chunk: unknown): string {
    if (typeof chunk !== "object" || chunk === null) return ""
    if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(visit).join("")
    if ("name" in chunk && typeof chunk.name === "string") return chunk.name
    if ("value" in chunk) {
      if (Array.isArray(chunk.value)) return chunk.value.join("")
      params.push(chunk.value)
      return "?"
    }
    return ""
  }
  return { sql: visit(predicate), params }
}
const database = {
  select: () => ({ from: () => ({ where: (predicate: SQL) => {
    predicates.push(predicateEvidence(predicate))
    const result = selections.shift()
    if (!result) throw new Error("Unexpected storage read")
    const promise = Promise.resolve(result)
    return Object.assign(promise, { for: () => promise, orderBy: () => promise })
  } }) }),
  transaction: async <T>(callback: (tx: typeof database) => Promise<T>): Promise<T> => callback(database),
  insert: () => ({ values: async () => { writes++ } }),
  update: () => ({ set: () => ({ where: async () => { writes++ } }) }),
  delete: () => ({ where: async () => { writes++ } }),
}
mock.module("../src/db.js", () => ({ db: database }))
mock.module("../src/env.js", () => ({ env: { gatewayPublicBaseUrl: "https://gateway.example.test" } }))
mock.module("../src/gateway-deployment.js", () => ({ gatewayManagementUnavailable: () => enabled ? null : { error: "gateway_not_enabled" }, gatewayManagementUnavailableSchema: z.object({ error: z.string() }) }))
class GatewayWriteError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message) }
}
mock.module("../src/llm/gateway-matrix.js", () => ({ GatewayWriteError, gatewaySummary: async () => ({ models: usableModels }) }))
const membership: MiddlewareHandler = async (c, next) => {
  if (!authenticated) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", { organization: { id: organizationId }, currentMember: { id: memberId, role: "member", isOwner: false } })
  await next()
}
mock.module("../src/middleware/index.js", () => ({ ...validation, orgMemberRoute: () => membership }))
const { registerOrgGatewayRouterRoutes } = await import("../src/routes/org/gateway-routers.js")
const app = new Hono()
registerOrgGatewayRouterRoutes(app)
const path = `/v1/gateway-routers/${routerId}`
const member = [{ userId: createDenTypeId("user") }]
function request(method: string, body?: unknown, url = path) {
  return app.request(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })
}
beforeEach(() => { selections = []; predicates = []; writes = 0; enabled = true; authenticated = true; usableModels = [{ id: model, name: "Test model" }] })
afterAll(() => mock.restore())

test("shared validation rejects malformed, ambiguous and upstream targets", () => {
  expect(gatewayRouterDefinitionSchema.safeParse(definition).success).toBe(true)
  for (const invalid of [
    { ...definition, routes: [definition.routes[0]] },
    { ...definition, routes: Array(13).fill(definition.routes[0]) },
    { ...definition, routes: [definition.routes[0], definition.routes[0]] },
    { ...definition, fallbackRouteId: "missing" },
    { ...definition, name: "n".repeat(101) },
    { ...definition, minConfidence: 1.01 },
    { ...definition, minConfidence: -0.1 },
    { ...definition, routes: definition.routes.map((route) => ({ ...route, model: "https://upstream.example.test" })) },
    { ...definition, routes: definition.routes.map((route) => ({ ...route, id: "Invalid ID" })) },
    { ...definition, routes: definition.routes.map((route) => ({ ...route, description: " " })) },
  ]) expect(gatewayRouterDefinitionSchema.safeParse(invalid).success).toBe(false)
  expect(gatewayRouterUpdateSchema.safeParse({ ...definition, revision: 0 }).success).toBe(false)
  expect(isGatewayRouterTargetNpm("@ai-sdk/openai-compatible")).toBe(true)
  expect(isGatewayRouterTargetNpm("@ai-sdk/anthropic")).toBe(false)
  expect(isGatewayRouterTargetNpm("@ai-sdk/google")).toBe(false)
})
test("every endpoint gates deployment and authentication with private no-store errors", async () => {
  for (const [method, url] of [["GET", "/v1/gateway-routers"], ["GET", "/v1/gateway-routers/targets"], ["POST", "/v1/gateway-routers"], ["GET", path], ["PUT", path], ["DELETE", path]]) {
    enabled = false
    const result = await request(method, undefined, url)
    expect(result.status).toBe(403)
    expect(result.headers.get("cache-control")).toBe("private, no-store")
    authenticated = false
    expect((await request(method, undefined, url)).status).toBe(401)
    authenticated = true
  }
  expect(predicates.length).toBe(0)
})
test("removed membership is rejected", async () => {
  selections = [[]]
  expect((await request("GET")).status).toBe(403)
})
test("cross-owner or cross-organization rows are not found through owner-scoped SQL", async () => {
  selections = [member, []]
  expect((await request("GET")).status).toBe(404)
  expect(predicates[1].sql).toContain("created_by_org_membership_id")
  expect(predicates[1].sql).toContain("organization_id")
  expect(predicates[1].params).toEqual([organizationId, memberId, routerId])
})
test("writes cannot cross ownership boundaries", async () => {
  for (const method of ["PUT", "DELETE"]) {
    selections = [member, member, []]
    predicates = []
    expect((await request(method, method === "PUT" ? { ...definition, revision: 2 } : undefined)).status).toBe(404)
    expect(predicates[2].params).toEqual([organizationId, memberId, routerId])
    expect(writes).toBe(0)
  }
})
test("list returns only the member scope with ISO timestamps", async () => {
  selections = [member, [row]]
  const result = await request("GET", undefined, "/v1/gateway-routers")
  expect(result.status).toBe(200)
  expect(predicates[1].params).toEqual([organizationId, memberId])
  expect(await result.json()).toMatchObject({ routers: [{ id: routerId, revision: 2, createdAt: row.created_at.toISOString() }] })
})
test("ordinary member can create and delete a router", async () => {
  selections = [member, [{ id: providerId, name: "Provider", provider_config: { npm: "@ai-sdk/openai" } }], member]
  const created = await request("POST", definition, "/v1/gateway-routers")
  expect(created.status).toBe(201)
  expect(await created.json()).toMatchObject({ router: { name: definition.name, revision: 1 } })
  selections = [member, member, [row]]
  const deleted = await request("DELETE")
  expect(deleted.status).toBe(204)
  expect(await deleted.text()).toBe("")
  expect(writes).toBe(2)
})
test("stale update returns 409 without writes or target lookup", async () => {
  selections = [member, member, [row]]
  const result = await request("PUT", { ...definition, revision: 1 })
  expect(result.status).toBe(409)
  expect(await result.json()).toMatchObject({ error: "gateway_router_revision_conflict" })
  expect(writes).toBe(0)
})
test("ordinary member can update their router and revision increments", async () => {
  selections = [member, member, [row], [{ id: providerId, name: "Provider", provider_config: { npm: "@ai-sdk/openai" } }]]
  const result = await request("PUT", { ...definition, revision: 2 })
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ router: { id: routerId, revision: 3 } })
  expect(writes).toBe(1)
})
test("unsupported providers cannot be saved", async () => {
  selections = [member, [{ id: providerId, provider_config: { npm: "@ai-sdk/anthropic" } }]]
  expect((await request("POST", definition, "/v1/gateway-routers")).status).toBe(403)
  expect(writes).toBe(0)
})
test("owner can disable after one target is revoked but cannot save or reenable active", async () => {
  const secondModel = `gwm_${suffix}_${suffix}_00000000000000000000000002`
  const input = { ...definition, routes: definition.routes.map((route) => ({ ...route, model: route.id === "deep" ? secondModel : model })) }
  const activeRow = { ...row, configuration: { ...row.configuration, routes: input.routes } }
  const providers = [{ id: providerId, name: "Provider", provider_config: { npm: "@ai-sdk/openai" } }]
  usableModels = [{ id: model, name: "Test model" }, { id: secondModel, name: "Second model" }]
  selections = [member, member, [activeRow], providers]
  expect((await request("PUT", { ...input, revision: 2 })).status).toBe(200)

  // The first route remains usable, but the second route's grant is revoked.
  usableModels = [{ id: model, name: "Test model" }]
  selections = [member, member, [{ ...activeRow, revision: 3 }], providers]
  expect((await request("PUT", { ...input, revision: 3 })).status).toBe(403)
  expect(writes).toBe(1)

  selections = [member, member, [{ ...activeRow, revision: 3 }]]
  const disabled = await request("PUT", { ...input, status: "disabled", revision: 3 })
  expect(disabled.status).toBe(200)
  expect(await disabled.json()).toMatchObject({ router: { status: "disabled", revision: 4 } })
  expect(selections).toHaveLength(0)
  expect(writes).toBe(2)

  selections = [member, member, [{ ...activeRow, status: "disabled", revision: 4 }], providers]
  const reenabled = await request("PUT", { ...input, revision: 4 })
  expect(reenabled.status).toBe(403)
  expect(await reenabled.json()).toMatchObject({ error: "gateway_router_target_unavailable" })
  expect(writes).toBe(2)
})
test("disabled create skips target availability but still validates model aliases", async () => {
  usableModels = []
  selections = [member, member]
  const created = await request("POST", { ...definition, status: "disabled" }, "/v1/gateway-routers")
  expect(created.status).toBe(201)
  expect(await created.json()).toMatchObject({ router: { status: "disabled", revision: 1 } })
  expect(selections).toHaveLength(0)
  selections = [member]
  const invalid = await request("POST", { ...definition, status: "disabled", routes: definition.routes.map((route) => ({ ...route, model: "https://upstream.example.test" })) }, "/v1/gateway-routers")
  expect(invalid.status).toBe(400)
  expect(writes).toBe(1)
})
test("disabled updates retain membership, ownership and revision checks", async () => {
  selections = [[]]
  expect((await request("PUT", { ...definition, status: "disabled", revision: 2 })).status).toBe(403)
  selections = [member, member, []]
  expect((await request("PUT", { ...definition, status: "disabled", revision: 2 })).status).toBe(404)
  selections = [member, member, [row]]
  expect((await request("PUT", { ...definition, status: "disabled", revision: 1 })).status).toBe(409)
  expect(writes).toBe(0)
})
test("targets expose only public fields and supported SDKs", async () => {
  selections = [member, [{ id: providerId, name: "Provider", provider_config: { npm: "@ai-sdk/openai" } }, { id: "unsupported", provider_config: { npm: "@ai-sdk/google" } }]]
  const result = await request("GET", undefined, "/v1/gateway-routers/targets")
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ targets: [{ inferenceProviderId: providerId, model, name: "Test model", providerName: "Provider" }] })
})
