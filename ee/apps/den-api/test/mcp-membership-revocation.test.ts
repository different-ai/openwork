import { beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let selectedRows: Array<{ id: string }> = []
let jwtPayload: Record<string, unknown> = {}
let mcpAuth: typeof import("../src/mcp/auth.js")

beforeAll(async () => {
  seedRequiredEnv()

  mock.module("../src/auth.js", () => ({
    auth: {
      handler: () => Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 })),
    },
    DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
    DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
    DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
    DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
    DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
    DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
  }))

  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(selectedRows),
          }),
        }),
      }),
    },
  }))

  mock.module("better-auth/oauth2", () => ({
    verifyJwsAccessToken: () => Promise.resolve(jwtPayload),
  }))

  mcpAuth = await import("../src/mcp/auth.js")
})

test("MCP principals require an active organization membership", async () => {
  const userId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")

  selectedRows = [{ id: createDenTypeId("member") }]
  await expect(mcpAuth.hasActiveMcpMembership({
    userId,
    organizationId,
  })).resolves.toBe(true)

  selectedRows = []
  await expect(mcpAuth.hasActiveMcpMembership({
    userId,
    organizationId,
  })).resolves.toBe(false)
})

test("MCP membership check rejects malformed principals", async () => {
  selectedRows = [{ id: "member_active" }]
  await expect(mcpAuth.hasActiveMcpMembership({
    userId: "not-a-user-id",
    organizationId: createDenTypeId("organization"),
  })).resolves.toBe(false)
})

test("MCP bearer tokens tied to deleted sessions are rejected", async () => {
  const sessionId = createDenTypeId("session")

  selectedRows = [{ id: sessionId }]
  await expect(mcpAuth.hasActiveMcpSession(sessionId)).resolves.toBe(true)

  selectedRows = []
  await expect(mcpAuth.hasActiveMcpSession(sessionId)).resolves.toBe(false)
  await expect(mcpAuth.hasActiveMcpSession("not-a-session-id")).resolves.toBe(false)
})

test("MCP JWTs without session claims are rejected", async () => {
  jwtPayload = {
    sub: createDenTypeId("user"),
    scope: "mcp:read mcp:write",
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": "http://127.0.0.1:8790/mcp",
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
  }

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    await expect(response.json()).resolves.toEqual({ error: "mcp_session_required" })
  }
})
