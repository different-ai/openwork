import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import * as validation from "../src/middleware/validation.js"
import { buildGatewayProviderConfig } from "../src/llm/inference-provider-config.js"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"

// No database client is created. Reaching storage is an explicit test sentinel.
let storageCalls = 0
const storageReached = () => { storageCalls++; throw new Error("fixture_storage_reached") }
mock.module("../src/db.js", () => ({ db: { select: storageReached, transaction: storageReached } }))

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
let dashboard = false
const memberRoute: MiddlewareHandler = async (c, next) => {
  if (!authenticated) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", {
    organization: { id: organizationId, metadata: { capabilities: { gatewayDashboard: dashboard } } },
    currentMember: { id: memberId, role, isOwner: role === "owner" },
  })
  c.set("session", { createdAt: new Date(Date.now() - (fresh ? 0 : 3_600_000)) })
  await next()
}
mock.module("../src/middleware/index.js", () => ({
  ...validation,
  orgMemberRoute: () => memberRoute,
  publicRoute: async (_c: unknown, next: () => Promise<void>) => next(),
}))

const { env } = await import("../src/env.js")
const { buildOpenWorkProviderConfig, readInferenceMetadata } = await import("../src/inference.js")
const { deploymentCapabilities } = await import("../src/gateway-deployment.js")
const { registerOrgInferenceProviderRoutes } = await import("../src/routes/org/inference-providers.js")
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
  dashboard = false
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
  test(`disabled deployment blocks ${method} ${path} regardless of dashboard exposure`, async () => {
    for (const gatewayDashboard of [false, true]) {
      dashboard = gatewayDashboard
      const response = await app.request(path, { method })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: "gateway_not_enabled" })
      expect(storageCalls).toBe(0)
    }
  })
}

test("deployment capability stays separate from dashboard metadata and storage health", () => {
  expect(deploymentCapabilities()).toEqual({ version: 1, aiGateway: false })
  env.gatewayEnabled = true
  expect(deploymentCapabilities()).toEqual({ version: 1, aiGateway: true })
  expect(storageCalls).toBe(0)
})

test("enabled management retains admin checks and privileged-session checks", async () => {
  for (const enabled of [false, true]) {
    env.gatewayEnabled = enabled
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

test("enabled management reaches existing handlers even with dashboard exposure off", async () => {
  env.gatewayEnabled = true
  for (const path of [resource, "/v1/inference-providers?scope=manageable", "/v1/inference-providers/usage"]) {
    const response = await app.request(path)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "fixture_storage_reached" })
  }
  expect(storageCalls).toBe(3)
  const write = await app.request("/v1/inference-providers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  expect(write.status).toBe(400)
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

test("public OAuth callback remains reachable without management enablement or a member session", async () => {
  authenticated = false
  const response = await app.request("/v1/inference-providers/oauth/callback?error=access_denied")
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toContain("text/html")
  expect(storageCalls).toBe(0)
})

test("enabled deployment with a non-opted organization keeps Models and Gateway desktop destinations separate", () => {
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
