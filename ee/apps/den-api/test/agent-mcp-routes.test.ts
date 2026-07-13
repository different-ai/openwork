import { beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
}

let registerAgentMcpRoutes: typeof import("../src/mcp/agent.js")["registerAgentMcpRoutes"]

beforeAll(async () => {
  seedRequiredEnv()
  registerAgentMcpRoutes = (await import("../src/mcp/agent.js")).registerAgentMcpRoutes
})

function buildApp() {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => {
    c.set("requestId", "req_agent_route")
    await next()
  })
  registerAgentMcpRoutes(app)
  return app
}

const ORIGIN = "http://127.0.0.1:8790"

describe("agent MCP OAuth protected-resource discovery", () => {
  test("serves exact agent metadata at the path-aware well-known URL", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/agent`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe(`${ORIGIN}/mcp/agent`)
    expect(body.authorization_servers).toEqual([`${ORIGIN}/api/auth`])
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write", "offline_access"])
  })

  test("unauthenticated /mcp/agent returns an RFC 9728 discovery challenge", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/mcp/agent`, { method: "POST" })
    expect(res.status).toBe(401)
    const challenge = res.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/agent"`)
    expect(challenge).toContain(`scope="mcp:read mcp:write offline_access"`)
    const body = await res.json()
    expect(body).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
  })
})
