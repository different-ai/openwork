import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type AdminToolResult = {
  isError?: boolean
  content: { type: "text"; text: string }[]
}

let adminCapabilities: typeof import("../src/mcp/admin-capabilities.js")

beforeAll(async () => {
  seedRequiredEnv()
  adminCapabilities = await import("../src/mcp/admin-capabilities.js")
})

function contentText(result: AdminToolResult | null) {
  if (result === null) {
    throw new Error("Expected admin capability result")
  }
  return result.content.map((entry) => entry.text).join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("executeAdminCapability", () => {
  test("forwards arguments when body is a plain object", async () => {
    const result = await adminCapabilities.executeAdminCapability("admin:den_query", { sql: "DELETE FROM user" })

    expect(result?.isError).toBe(true)
    expect(contentText(result)).toContain("Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed")
  })

  test("forwards arguments when body is a JSON-encoded string", async () => {
    const result = await adminCapabilities.executeAdminCapability("admin:den_query", JSON.stringify({ sql: "DELETE FROM user" }))

    expect(result?.isError).toBe(true)
    expect(contentText(result)).toContain("Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed")
  })

  test("treats non-object non-JSON bodies as empty arguments", async () => {
    const result = await adminCapabilities.executeAdminCapability("admin:den_admin_version", "not json")

    expect(result?.isError).toBeUndefined()
    expect(contentText(result)).toContain('"name": "den-admin"')
  })
})

describe("searchAdminCapabilities", () => {
  test("exposes argumentsSchema for tools that take input", async () => {
    const matches = await adminCapabilities.searchAdminCapabilities("den_query", 5)
    const match = matches.find((candidate) => candidate.name === "admin:den_query")

    expect(match).toBeDefined()
    if (!match) {
      throw new Error("Expected admin:den_query search match")
    }

    expect(match.hasBody).toBe(true)
    if (!isRecord(match)) {
      throw new Error("Expected admin:den_query match to be a record")
    }

    const argumentsSchema = match.argumentsSchema
    if (!isRecord(argumentsSchema) || !isRecord(argumentsSchema.properties)) {
      throw new Error("Expected admin:den_query to expose an object argumentsSchema")
    }
    expect(argumentsSchema.properties.sql).toMatchObject({ type: "string" })
    expect(match.invocation).toEqual({ argumentsField: "body" })
  })
})
