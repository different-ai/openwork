import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const property = Object.getOwnPropertyDescriptor(value, key)?.value
  return typeof property === "object" && property !== null && !Array.isArray(property) ? property : null
}

let externalMcpEngineSchema: Record<string, unknown> | null = null

beforeAll(async () => {
  seedRequiredEnv()
  const app = (await import("../src/app.js")).default
  const response = await app.request("http://127.0.0.1:8790/openapi.json")
  const document: unknown = await response.json()
  const organizationContextSchema = recordProperty(
    recordProperty(recordProperty(document, "components"), "schemas"),
    "OrganizationContextResponse",
  )
  externalMcpEngineSchema = recordProperty(
    recordProperty(recordProperty(recordProperty(organizationContextSchema, "properties"), "capabilities"), "properties"),
    "externalMcpEngine",
  )
})

describe("organization context OpenAPI contract", () => {
  test("documents the effective external MCP engine and its source", () => {
    const properties = recordProperty(externalMcpEngineSchema, "properties")
    expect(recordProperty(properties, "effective")).toEqual(expect.objectContaining({
      type: "string",
      enum: ["enterprise", "legacy"],
    }))
    expect(recordProperty(properties, "source")).toEqual(expect.objectContaining({
      type: "string",
      enum: ["org", "default"],
    }))
  })
})
