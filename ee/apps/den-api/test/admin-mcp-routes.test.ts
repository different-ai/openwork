import { beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let registerAdminMcpRoutes: typeof import("../src/mcp/admin.js")["registerAdminMcpRoutes"]

beforeAll(async () => {
  seedRequiredEnv()
  registerAdminMcpRoutes = (await import("../src/mcp/admin.js")).registerAdminMcpRoutes
})

function buildApp() {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => {
    c.set("requestId", "req_admin_route")
    await next()
  })
  registerAdminMcpRoutes(app)
  return app
}

const ORIGIN = "http://127.0.0.1:8790"

describe("admin MCP OAuth protected-resource discovery", () => {
  // A spec-compliant MCP client connecting to /mcp/admin self-constructs the
  // protected-resource metadata URL (RFC 9728). Without these routes the
  // OAuth handshake 404s and the admin MCP never connects.
  test("serves metadata at the path-aware well-known URL", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/admin`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Admin discovery keeps the legacy parent resource for first-party desktop
    // and legacy metadata consumers; public JWTs authenticate only /mcp/agent.
    expect(body.resource).toBe(`${ORIGIN}/mcp`)
    expect(body.authorization_servers).toEqual([`${ORIGIN}/api/auth`])
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write", "offline_access"])
  })

  test("serves metadata at the path-suffixed well-known URL", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/mcp/admin/.well-known/oauth-protected-resource`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe(`${ORIGIN}/mcp`)
  })

  test("unauthenticated /mcp/admin returns a 401 challenge pointing at /mcp metadata", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/mcp/admin`, { method: "POST" })
    expect(res.status).toBe(401)
    const challenge = res.headers.get("www-authenticate") ?? ""
    // The challenge must advertise the canonical /mcp resource metadata, which
    // is registered — not the admin child resource.
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
    expect(challenge).toContain(`scope="mcp:read mcp:write offline_access"`)
    const body = await res.json()
    expect(body).toMatchObject({ error: "missing_mcp_token", referenceId: "req_admin_route" })
  })
})
