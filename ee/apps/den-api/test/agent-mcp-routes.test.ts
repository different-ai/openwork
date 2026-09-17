import { beforeAll, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp", "http://127.0.0.1:8790/mcp/agent", "http://127.0.0.1:8790/mcp/admin"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))

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

  test("unauthenticated remote-session capability calls are rejected before dispatch", async () => {
    const app = buildApp()
    for (const capability of [
      { name: "remote-session:create", body: { target: "desktop", prompt: "Inspect the repo" } },
      { name: "remote-session:send", body: { sessionId: "ses_fixture", prompt: "Continue" } },
      { name: "remote-session:read", body: { commandId: "rsc_fixture" } },
    ]) {
      const res = await app.request(`${ORIGIN}/mcp/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_capability", arguments: capability },
        }),
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
    }
  })

  test("unauthenticated GET /mcp/agent returns an RFC 9728 discovery challenge", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/mcp/agent`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    })

    expect(res.status).toBe(401)
    const challenge = res.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/agent"`)
    expect(challenge).toContain(`scope="mcp:read mcp:write offline_access"`)
    const body = await res.json()
    expect(body).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
  })
})
