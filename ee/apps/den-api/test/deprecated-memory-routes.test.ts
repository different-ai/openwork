import { beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AuthContextVariables } from "../src/session.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
}

let isMcpOperationAllowed: typeof import("../src/mcp/policy.js")["isMcpOperationAllowed"]
let registerDeprecatedMemoryRoutes: typeof import("../src/routes/deprecated-memory.js")["registerDeprecatedMemoryRoutes"]

beforeAll(async () => {
  seedRequiredEnv()
  isMcpOperationAllowed = (await import("../src/mcp/policy.js")).isMcpOperationAllowed
  registerDeprecatedMemoryRoutes = (await import("../src/routes/deprecated-memory.js")).registerDeprecatedMemoryRoutes
})

/**
 * Published desktop builds keep calling GET /v1/memory and DELETE
 * /v1/memory/:id from the Memory settings screen after the Memory Bank
 * removal. These tests pin the deprecation stubs to the exact payloads that
 * shipped client tolerates (see apps/app/src/app/lib/den.ts listMemory and
 * deleteMemory): an empty `memories` list and an idempotent-success 404.
 */

type FakeUser = AuthContextVariables["user"]

function buildApp(user: FakeUser) {
  const app = new Hono<{ Variables: AuthContextVariables }>()
  app.use("*", async (c, next) => {
    c.set("user", user)
    c.set("session", null)
    c.set("apiKey", null)
    await next()
  })
  registerDeprecatedMemoryRoutes(app)
  return app
}

// The stubs only read user.id through requireUserMiddleware; the remaining
// fields exist to satisfy the session type without a live auth store.
const signedInUser = {
  id: "user_01memstub",
  name: "Stub User",
  email: "stub@example.com",
  emailVerified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as AuthContextVariables["user"]

describe("deprecated memory routes", () => {
  test("GET /v1/memory returns the empty list shape the desktop settings screen renders", async () => {
    const response = await buildApp(signedInUser).request("/v1/memory")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ memories: [] })
  })

  test("GET /v1/memory/search returns an empty result set instead of an error", async () => {
    const response = await buildApp(signedInUser).request("/v1/memory/search?q=anything")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ results: [] })
  })

  test("DELETE /v1/memory/:id returns the 404 the desktop client treats as idempotent success", async () => {
    const response = await buildApp(signedInUser).request("/v1/memory/mem_01gone", { method: "DELETE" })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "memory_not_found" })
  })

  test("POST /v1/memory refuses loudly so no caller believes a memory was saved", async () => {
    const response = await buildApp(signedInUser).request("/v1/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "remember me" }),
    })

    expect(response.status).toBe(410)
    const payload = await response.json()
    expect(payload.error).toBe("deprecated")
    expect(typeof payload.message).toBe("string")
  })

  test("reads and deletes still require a signed-in caller", async () => {
    const app = buildApp(null)

    for (const request of [
      app.request("/v1/memory"),
      app.request("/v1/memory/search?q=x"),
      app.request("/v1/memory/mem_01gone", { method: "DELETE" }),
    ]) {
      const response = await request
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "unauthorized" })
    }
  })

  test("deprecated memory operations stay out of the MCP capability catalog", () => {
    for (const operation of [
      { method: "GET", path: "/v1/memory", operation: { operationId: "getMemory", tags: ["Deprecated"] } },
      { method: "GET", path: "/v1/memory/search", operation: { operationId: "getMemorySearch", tags: ["Deprecated"] } },
      { method: "POST", path: "/v1/memory", operation: { operationId: "postMemory", tags: ["Deprecated"] } },
      { method: "DELETE", path: "/v1/memory/:id", operation: { operationId: "deleteMemoryById", tags: ["Deprecated"] } },
    ]) {
      expect(isMcpOperationAllowed(operation)).toBe(false)
    }

    // The Memory tag itself is no longer safe-listed, so even a stale
    // Memory-tagged operation cannot re-enter the catalog.
    expect(
      isMcpOperationAllowed({ method: "GET", path: "/v1/memory", operation: { operationId: "getMemory", tags: ["Memory"] } }),
    ).toBe(false)
  })
})
