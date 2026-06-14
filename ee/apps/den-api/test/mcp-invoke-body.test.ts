import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { z } from "zod"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let invokeModule: typeof import("../src/mcp/invoke.js")
let validationModule: typeof import("../src/middleware/validation.js")

beforeAll(async () => {
  seedRequiredEnv()
  invokeModule = await import("../src/mcp/invoke.js")
  validationModule = await import("../src/middleware/validation.js")
})

const principal = {
  userId: createDenTypeId("user"),
  organizationId: createDenTypeId("organization"),
  scopes: new Set(["mcp:read", "mcp:write"]),
  payload: {},
}

function createPrincipal(scopes: string[]) {
  return {
    userId: createDenTypeId("user"),
    organizationId: createDenTypeId("organization"),
    scopes: new Set(scopes),
    payload: {},
  }
}

const inviteOperation = {
  name: "postV1Invitations",
  method: "POST",
  path: "/v1/invitations",
  operation: {},
  inputSchema: z.object({}),
}

const listMembersOperation = {
  name: "getV1Members",
  method: "GET",
  path: "/v1/members",
  operation: {},
  inputSchema: z.object({}),
}

function createInviteApp() {
  const inviteMemberSchema = z.object({
    email: z.string().email(),
    role: z.string().trim().min(1).max(64),
  })
  const app = new Hono()
  app.post("/v1/invitations", validationModule.jsonValidator(inviteMemberSchema), (c) => {
    return c.json({ received: c.req.valid("json") }, 200)
  })
  return app
}

function createMembersApp() {
  const app = new Hono()
  app.get("/v1/members", (c) => {
    return c.json({ members: [{ id: "member_1", role: "member" }] }, 200)
  })
  return app
}

test("normalizeToolBody parses JSON-encoded string bodies into objects", () => {
  expect(invokeModule.normalizeToolBody('{"email":"ben+demogods@openworklabs.com","role":"member"}')).toEqual({
    email: "ben+demogods@openworklabs.com",
    role: "member",
  })
  expect(invokeModule.normalizeToolBody('  [{"a":1}]  ')).toEqual([{ a: 1 }])
})

test("normalizeToolBody leaves objects and non-JSON strings untouched", () => {
  const body = { email: "x@y.com", role: "admin" }
  expect(invokeModule.normalizeToolBody(body)).toBe(body)
  expect(invokeModule.normalizeToolBody("plain text")).toBe("plain text")
  expect(invokeModule.normalizeToolBody("{not valid json")).toBe("{not valid json")
  expect(invokeModule.normalizeToolBody(undefined)).toBeUndefined()
  expect(invokeModule.normalizeToolBody(42)).toBe(42)
})

test("invitation POST forwarded with an object body passes route validation", async () => {
  const result = await invokeModule.invokeMcpOperation({
    app: createInviteApp(),
    env: {},
    operation: inviteOperation,
    principal,
    toolInput: { body: { email: "ben+demogods@openworklabs.com", role: "member" } },
  })

  expect(result.isError).toBe(false)
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    received: { email: "ben+demogods@openworklabs.com", role: "member" },
  })
})

test("read-only MCP principals can invoke read operations", async () => {
  const result = await invokeModule.invokeMcpOperation({
    app: createMembersApp(),
    env: {},
    operation: listMembersOperation,
    principal: createPrincipal(["mcp:read"]),
    toolInput: {},
  })

  expect(result.isError).toBe(false)
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    members: [{ id: "member_1", role: "member" }],
  })
})

test("read-only MCP principals cannot invoke write operations", async () => {
  let routeWasInvoked = false
  const app = new Hono()
  app.post("/v1/invitations", (c) => {
    routeWasInvoked = true
    return c.json({ ok: true }, 200)
  })

  const result = await invokeModule.invokeMcpOperation({
    app,
    env: {},
    operation: inviteOperation,
    principal: createPrincipal(["mcp:read"]),
    toolInput: { body: { email: "ben+demogods@openworklabs.com", role: "member" } },
  })

  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toBe('{"error":"insufficient_mcp_scope","requiredScope":"mcp:write"}')
  expect(routeWasInvoked).toBe(false)
})

test("write-only MCP principals cannot invoke read operations", async () => {
  let routeWasInvoked = false
  const app = new Hono()
  app.get("/v1/members", (c) => {
    routeWasInvoked = true
    return c.json({ members: [] }, 200)
  })

  const result = await invokeModule.invokeMcpOperation({
    app,
    env: {},
    operation: listMembersOperation,
    principal: createPrincipal(["mcp:write"]),
    toolInput: {},
  })

  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toBe('{"error":"insufficient_mcp_scope","requiredScope":"mcp:read"}')
  expect(routeWasInvoked).toBe(false)
})

test("invitation POST forwarded with a JSON-encoded string body no longer fails with 'expected object, received string'", async () => {
  const result = await invokeModule.invokeMcpOperation({
    app: createInviteApp(),
    env: {},
    operation: inviteOperation,
    principal,
    toolInput: { body: '{"email":"ben+demogods@openworklabs.com","role":"member"}' },
  })

  expect(result.isError).toBe(false)
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    received: { email: "ben+demogods@openworklabs.com", role: "member" },
  })
})

test("genuinely invalid bodies are still rejected by route validation", async () => {
  const result = await invokeModule.invokeMcpOperation({
    app: createInviteApp(),
    env: {},
    operation: inviteOperation,
    principal,
    toolInput: { body: '{"email":"not-an-email"}' },
  })

  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toContain("invalid_request")
})
