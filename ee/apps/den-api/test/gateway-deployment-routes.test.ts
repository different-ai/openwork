import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import { generateSpecs } from "hono-openapi"
import * as validation from "../src/middleware/validation.js"
import { buildGatewayProviderConfig } from "../src/llm/inference-provider-config.js"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"

// No database client is created. Reaching storage is an explicit test sentinel.
let storageCalls = 0
const storageReached = () => { storageCalls++; throw new Error("fixture_storage_reached") }
mock.module("../src/db.js", () => ({ db: { select: storageReached, transaction: storageReached } }))
// This suite isolates deployment admission, not cookie authentication. Keep
// Better Auth's startup seeding away from the deliberately throwing DB sentinel;
// inference-provider-oauth.test.ts covers the real signed-cookie boundary.
mock.module("../src/session.js", () => ({ readSignedSessionCookieToken: async () => null }))

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
process.env.DEN_DB_ENCRYPTION_KEY = "fixture-encryption-key-not-a-secret-32"
process.env.BETTER_AUTH_SECRET = "fixture-auth-key-not-a-secret-32-characters"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.OPENWORK_DEV_MODE = "1"
process.env.GATEWAY_ENABLED = "false"
process.env.GATEWAY_PROXY_BASE_URL = "http://gateway:8791"
process.env.GATEWAY_PUBLIC_BASE_URL = "https://gateway.example.test"
process.env.INFERENCE_PROXY_BASE_URL = "https://models.example.test"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
let authenticated = true
let role = "owner"
let fresh = true
let legacyDashboard: unknown = false
const memberRoute: MiddlewareHandler = async (c, next) => {
  if (!authenticated) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", {
    organization: { id: organizationId, metadata: { capabilities: { gatewayDashboard: legacyDashboard } } },
    currentMember: { id: memberId, role, isOwner: role === "owner" },
  })
  c.set("session", { createdAt: new Date(Date.now() - (fresh ? 0 : 3_600_000)) })
  await next()
}
mock.module("../src/middleware/index.js", () => ({
  ...validation,
  orgMemberRoute: () => memberRoute,
  userSessionRoute: () => memberRoute,
  publicRoute: async (_c: unknown, next: () => Promise<void>) => next(),
}))

const { env } = await import("../src/env.js")
const { buildOpenWorkProviderConfig, readInferenceMetadata } = await import("../src/inference.js")
const { deploymentCapabilities } = await import("../src/gateway-deployment.js")
const { registerOrgInferenceProviderRoutes } = await import("../src/routes/org/inference-providers.js")
const { publicGatewayPinnedModelIds } = await import("../src/llm/gateway-matrix.js")
const app = new Hono()
app.onError((error, c) => {
  if (error.message === "fixture_storage_reached") return c.json({ error: error.message }, 503)
  throw error
})
registerOrgInferenceProviderRoutes(app)

beforeEach(() => {
  env.gatewayEnabled = false
  authenticated = true
  role = "owner"
  fresh = true
  legacyDashboard = false
  storageCalls = 0
})
afterAll(() => mock.restore())

const providerId = createDenTypeId("inferenceProvider")
const resource = `/v1/inference-providers/${providerId}`
const managementRoutes = [
  ["GET", "/v1/inference-providers?scope=manageable"],
  ["GET", "/v1/inference-providers/usage"],
  ["POST", "/v1/inference-providers/migrate-from-llm-provider"],
  ["POST", "/v1/inference-providers"],
  ["GET", resource], ["PATCH", resource], ["DELETE", resource],
  ["GET", `${resource}/models`],
  ["DELETE", `${resource}/access/fixture-id`],
  ...["model-groups", "credential-sets", "access-grants"].flatMap((collection) => [
    ["GET", `${resource}/${collection}`], ["POST", `${resource}/${collection}`],
    ["PATCH", `${resource}/${collection}/fixture-id`], ["DELETE", `${resource}/${collection}/fixture-id`],
  ]),
]

for (const [method, path] of managementRoutes) {
  test(`disabled deployment blocks ${method} ${path} regardless of retired org rollout metadata`, async () => {
    for (const gatewayDashboard of [undefined, null, false, true, "true", 1, {}, []]) {
      legacyDashboard = gatewayDashboard
      const response = await app.request(path, { method })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: "gateway_not_enabled" })
      expect(storageCalls).toBe(0)
    }
  })
}

test("OpenAPI authorization requests optionally carry the same model contract as ready models", async () => {
  const spec = await generateSpecs(app)
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  const record = (value: unknown) => {
    if (!isRecord(value)) throw new Error("Expected schema object")
    return value
  }
  for (const name of ["GatewayProviderSummary", "GatewayProviderDetails"]) {
    const properties = record(record(spec.components?.schemas?.[name]).properties)
    const authorizationRequest = record(record(properties.authorizationRequests).items)
    const pendingModels = record(authorizationRequest.properties).models
    expect(pendingModels).toEqual(properties.models)
    expect(pendingModels).toMatchObject({ type: "array", items: { type: "object", properties: { id: { type: "string" }, config: { type: "object" } } } })
    expect(authorizationRequest.required).toEqual(["credentialSetId", "name", "authUrl"])
  }
  expect(storageCalls).toBe(0)
})

test("deployment capability stays separate from dashboard metadata and storage health", () => {
  expect(deploymentCapabilities()).toEqual({ version: 1, aiGateway: false })
  env.gatewayEnabled = true
  expect(deploymentCapabilities()).toEqual({ version: 1, aiGateway: true })
  expect(storageCalls).toBe(0)
})

test("enabled management retains admin checks and privileged-session checks", async () => {
  for (const enabled of [false, true]) for (const gatewayDashboard of [undefined, null, false, true, "true", 1, {}, []]) {
    env.gatewayEnabled = enabled
    legacyDashboard = gatewayDashboard
    role = "member"
    for (const path of [resource, "/v1/inference-providers?scope=manageable", "/v1/inference-providers/usage"]) {
      const response = await app.request(path)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: "forbidden" })
    }
    role = "owner"
    fresh = false
    const response = await app.request(resource, { method: "DELETE" })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "reauth" })
    expect(storageCalls).toBe(0)
  }
})

test("public pin projection preserves configured order, expands usable aliases and drops revoked access", () => {
  const models = [
    { id: "gwm_alpha", upstreamModelId: "alpha" },
    { id: "gwm_beta_group_one", upstreamModelId: "beta" },
    { id: "gwm_beta_group_two", upstreamModelId: "beta" },
  ]
  const pins = ["beta", "not-granted", "alpha"]
  expect(publicGatewayPinnedModelIds(pins, models)).toEqual(["gwm_beta_group_one", "gwm_beta_group_two", "gwm_alpha"])
  expect(publicGatewayPinnedModelIds(pins, models.filter((model) => model.upstreamModelId !== "beta"))).toEqual(["gwm_alpha"])
  expect(publicGatewayPinnedModelIds(pins, [])).toEqual([])
  expect(publicGatewayPinnedModelIds([], models)).toEqual([])
  expect(publicGatewayPinnedModelIds(["beta", "beta"], models)).toEqual(["gwm_beta_group_one", "gwm_beta_group_two"])
  expect(storageCalls).toBe(0)
})

test("pin-only PATCH requires fresh admin access and rejects duplicate, mixed or malformed pins before storage", async () => {
  env.gatewayEnabled = true
  const patch = (body: unknown) => app.request(resource, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  role = "member"
  expect((await patch({ pinnedModelIds: [] })).status).toBe(403)
  role = "owner"
  fresh = false
  expect((await patch({ pinnedModelIds: [] })).status).toBe(403)
  fresh = true
  for (const body of [
    { pinnedModelIds: ["model", "model"] },
    { pinnedModelIds: [" model", "model "] },
    { pinnedModelIds: [""] },
    { pinnedModelIds: [42] },
    { pinnedModelIds: Array.from({ length: 501 }, (_, index) => `model-${index}`) },
    { pinnedModelIds: null },
    { pinnedModelIds: [], modelIds: [] },
    { pinnedModelIds: [], name: "Unrelated rename" },
    { pinnedModelIds: [], unknown: true },
  ]) expect((await patch(body)).status).toBe(400)
  expect(storageCalls).toBe(0)
  for (const pinnedModelIds of [[], ["beta", "alpha"]]) {
    const response = await patch({ pinnedModelIds })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "fixture_storage_reached" })
  }
  expect(storageCalls).toBe(2)
})

test("enabled management reaches existing handlers regardless of retired org rollout metadata", async () => {
  env.gatewayEnabled = true
  for (const gatewayDashboard of [undefined, null, false, true, "true", 1, {}, []]) {
    legacyDashboard = gatewayDashboard
    storageCalls = 0
    for (const path of [resource, "/v1/inference-providers?scope=manageable", "/v1/inference-providers/usage"]) {
      const response = await app.request(path)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: "fixture_storage_reached" })
    }
    expect(storageCalls).toBe(3)
    const write = await app.request("/v1/inference-providers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(write.status).toBe(400)
  }
})

test("member usable, connect, OAuth sign-in and revoke are not deployment-gated", async () => {
  role = "member"
  for (const [method, path] of [
    ["GET", "/v1/inference-providers"], ["GET", `${resource}/connect`],
    ["GET", `${resource}/oauth/start`], ["DELETE", `${resource}/oauth`],
  ]) {
    const response = await app.request(path, { method })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "fixture_storage_reached" })
  }
  expect(storageCalls).toBe(4)
})

test("management still requires authentication before the deployment gate", async () => {
  authenticated = false
  for (const [method, path] of managementRoutes) {
    expect((await app.request(path, { method })).status).toBe(401)
  }
  expect(storageCalls).toBe(0)
})

test("OAuth callback requires browser sign-in even without management enablement", async () => {
  authenticated = false
  const response = await app.request("/v1/inference-providers/oauth/callback?error=access_denied")
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toContain("text/html")
  expect(await response.text()).toContain("Sign in to Den in this browser")
  expect(storageCalls).toBe(0)
})

test("enabled deployment ignores retired false metadata and keeps Models and Gateway desktop destinations separate", () => {
  env.gatewayEnabled = true
  const metadata = { capabilities: { gatewayDashboard: false }, inference: { enabled: true, tier: "tier1" } }
  expect(() => assertManagedModelsAllowed(metadata)).not.toThrow()
  expect(readInferenceMetadata(metadata)).toEqual({ enabled: true, tier: "tier1" })
  expect(buildOpenWorkProviderConfig()).toEqual({
    id: "openwork", name: "OpenWork", npm: "@openrouter/ai-sdk-provider", env: ["OPENWORK_API_KEY"],
    doc: "OpenWork-managed inference proxy for organization models.",
    api: "https://models.example.test/api/v1", options: { baseURL: "https://models.example.test/api/v1" },
  })
  const config = buildGatewayProviderConfig({ id: providerId, provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] } }, env.gatewayPublicBaseUrl)
  expect(config.api).toBe(`https://gateway.example.test/api/v1/providers/${providerId}`)
  expect(config.options).toMatchObject({ baseURL: config.api })
  expect(env.inferenceProxyBaseUrl).toBe("http://gateway:8791")
  expect(storageCalls).toBe(0)
})

test("disabled startup keeps public Models client config and member Gateway config without enabling management", () => {
  expect(deploymentCapabilities()).toEqual({ version: 1, aiGateway: false })
  expect(buildOpenWorkProviderConfig()).toMatchObject({
    api: "https://models.example.test/api/v1", options: { baseURL: "https://models.example.test/api/v1" },
  })
  expect(buildGatewayProviderConfig({ id: providerId, provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] } }, env.gatewayPublicBaseUrl).api).toBe(`https://gateway.example.test/api/v1/providers/${providerId}`)
  expect(env.inferenceProxyBaseUrl).toBe("http://gateway:8791")
  expect(storageCalls).toBe(0)
})
