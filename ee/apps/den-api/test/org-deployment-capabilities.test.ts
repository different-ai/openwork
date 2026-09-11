import { afterAll, expect, mock, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { parseDeploymentCapabilities } from "@openwork/types/den/deployment-capabilities"
import * as validation from "../src/middleware/validation.js"

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
process.env.DEN_DB_ENCRYPTION_KEY = "fixture-encryption-key-not-a-secret-32"
process.env.BETTER_AUTH_SECRET = "fixture-auth-key-not-a-secret-32-characters"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.OPENWORK_DEV_MODE = "1"
process.env.GATEWAY_ENABLED = "false"
process.env.DEN_ORG_MODE = "single_org"

const rows = { from: () => rows, where: () => rows, limit: async () => [] }
mock.module("../src/db.js", () => ({ db: { select: () => rows } }))
mock.module("../src/auth.js", () => ({ auth: { api: {} } }))

let authenticated = true
let dashboard = false
const memberRoute: MiddlewareHandler = async (c, next) => {
  if (!authenticated) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", {
    organization: { id: createDenTypeId("organization"), metadata: { capabilities: { gatewayDashboard: dashboard } } },
    currentMember: { id: createDenTypeId("member"), role: "owner", isOwner: true },
    members: [], teams: [], roles: [],
  })
  await next()
}
const passthrough: MiddlewareHandler = async (_c, next) => next()
mock.module("../src/middleware/index.js", () => ({
  ...validation,
  orgMemberRoute: () => memberRoute,
  orgRoleRoute: () => memberRoute,
  userSessionRoute: () => memberRoute,
  publicRoute: passthrough,
  resolveMemberTeamsMiddleware: passthrough,
}))

const { env } = await import("../src/env.js")
const { registerOrgCoreRoutes } = await import("../src/routes/org/core.js")
const app = new Hono()
registerOrgCoreRoutes(app)
afterAll(() => mock.restore())

test("authenticated GET /v1/org returns the versioned deployment capability independently of org dashboard flag", async () => {
  for (const enabled of [false, true]) for (const exposed of [false, true]) {
    env.gatewayEnabled = enabled
    dashboard = exposed
    const response = await app.request("/v1/org")
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.deploymentCapabilities).toEqual({ version: 1, aiGateway: enabled })
    expect(parseDeploymentCapabilities(payload.deploymentCapabilities).aiGateway).toBe(enabled)
    expect(payload.capabilities.gatewayDashboard).toBe(exposed)
    expect(payload.organization.deploymentCapabilities).toBeUndefined()
  }
})

test("unauthenticated callers do not receive deployment capabilities", async () => {
  authenticated = false
  const response = await app.request("/v1/org")
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: "unauthorized" })
})
