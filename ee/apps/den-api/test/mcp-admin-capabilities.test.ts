import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let capabilities: typeof import("../src/mcp/admin-capabilities.js")

beforeAll(async () => {
  seedRequiredEnv()
  capabilities = await import("../src/mcp/admin-capabilities.js")
})

test("admin capability search returns namespaced MCP tools", async () => {
  const matches = await capabilities.searchAdminCapabilities("Den admin overview", 10)

  expect(matches).toContainEqual(expect.objectContaining({
    name: "admin:den_overview",
    method: "MCP",
    path: "/mcp/admin",
  }))
})

test("admin capability execution reuses the existing admin toolset", async () => {
  const result = await capabilities.executeAdminCapability("admin:den_admin_version", undefined)
  const payload = JSON.parse(result?.content[0]?.text ?? "{}")

  expect(payload.name).toBe("den-admin")
  expect(payload.toolsetVersion).toBeString()
})

test("only namespaced admin capability names are parsed", () => {
  expect(capabilities.parseAdminCapabilityName("admin:den_overview")).toBe("den_overview")
  expect(capabilities.parseAdminCapabilityName("den_overview")).toBeNull()
  expect(capabilities.parseAdminCapabilityName("admin:")).toBeNull()
})

test("ordinary members cannot discover or directly execute admin capabilities", async () => {
  const matches = await capabilities.searchAvailableAdminCapabilities(false, "Den admin overview", 10)
  const result = await capabilities.executeAvailableAdminCapability(false, "admin:den_overview", undefined)

  expect(matches).toEqual([])
  expect(result?.isError).toBe(true)
  expect(JSON.parse(result?.content[0]?.text ?? "{}")).toEqual(expect.objectContaining({
    error: "unknown_capability",
  }))
})
