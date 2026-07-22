import { beforeAll, expect, test } from "bun:test"
import { buildOperationId } from "../src/openapi.js"
import { isMcpOperationAllowed, requiredScopeForMethod } from "../src/mcp/policy.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let shared: typeof import("../src/routes/memory/shared.js")

beforeAll(async () => {
  seedRequiredEnv()
  shared = await import("../src/routes/memory/shared.js")
})

// TASK-3: the real MCP tool names must be exactly these (buildOperationId strips v1), stay
// <= 49 chars, and be distinct — the prompt (Stage 4) and catalog must not drift (B1).
test("memory operationIds resolve to the pinned MCP tool names", () => {
  expect(buildOperationId("POST", "/v1/memory")).toBe("postMemory")
  expect(buildOperationId("GET", "/v1/memory/search")).toBe("getMemorySearch")
  expect(buildOperationId("GET", "/v1/memory")).toBe("getMemory")
  expect(buildOperationId("DELETE", "/v1/memory/:id")).toBe("deleteMemoryById")

  const names = ["postMemory", "getMemorySearch", "getMemory", "deleteMemoryById"]
  expect(new Set(names).size).toBe(names.length)
  for (const name of names) {
    expect(name.length).toBeLessThanOrEqual(49)
  }
  // memory_save / memory_search must never be produced.
  expect(names).not.toContain("memory_save")
  expect(names).not.toContain("memory_search")
})

test("Memory-tagged operations are MCP-allowed with the right scopes", () => {
  expect(
    isMcpOperationAllowed({ method: "POST", path: "/v1/memory", operation: { operationId: "postMemory", tags: ["Memory"] } }),
  ).toBe(true)
  expect(
    isMcpOperationAllowed({ method: "GET", path: "/v1/memory/search", operation: { operationId: "getMemorySearch", tags: ["Memory"] } }),
  ).toBe(true)
  expect(requiredScopeForMethod("POST")).toBe("mcp:write")
  expect(requiredScopeForMethod("DELETE")).toBe("mcp:write")
  expect(requiredScopeForMethod("GET")).toBe("mcp:read")
})

test("save payload accepts a minimal body and ignores client-supplied scope/source", () => {
  const parsed = shared.saveMemorySchema.parse({ content: "deploys via daytona", scope: "org", source: "modal" })
  expect(parsed.content).toBe("deploys via daytona")
  // scope + source are not part of the schema, so a client cannot set them — the server does.
  expect("scope" in parsed).toBe(false)
  expect("source" in parsed).toBe(false)
})

test("save payload enforces input bounds", () => {
  expect(shared.saveMemorySchema.safeParse({ content: "" }).success).toBe(false)
  expect(shared.saveMemorySchema.safeParse({ content: "x".repeat(shared.MAX_CONTENT_LENGTH + 1) }).success).toBe(false)
  expect(
    shared.saveMemorySchema.safeParse({
      content: "ok",
      contexts: Array.from({ length: shared.MAX_CONTEXTS + 1 }, () => ({ snippet: "s" })),
    }).success,
  ).toBe(false)
  expect(
    shared.saveMemorySchema.safeParse({ content: "ok", tags: Array.from({ length: shared.MAX_TAGS + 1 }, () => "t") })
      .success,
  ).toBe(false)
  // a context requires a snippet
  expect(shared.saveMemorySchema.safeParse({ content: "ok", contexts: [{ conversation_id: "c" }] }).success).toBe(false)
})

test("search query defaults + caps the limit and requires q", () => {
  const parsed = shared.searchMemoryQuerySchema.parse({ q: "acme" })
  expect(parsed.limit).toBe(shared.DEFAULT_LIMIT)
  expect(shared.searchMemoryQuerySchema.safeParse({ q: "acme", limit: shared.MAX_SEARCH_LIMIT + 1 }).success).toBe(false)
  expect(shared.searchMemoryQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
})
