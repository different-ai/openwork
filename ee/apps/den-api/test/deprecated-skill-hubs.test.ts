import { beforeAll, describe, expect, test } from "bun:test"

type DenApiApp = typeof import("../src/app.js").default
type RouteMethod = "DELETE" | "GET" | "PATCH" | "POST"

type DeprecatedSkillHubRouteCase = {
  method: RouteMethod
  openApiMethod: Lowercase<RouteMethod>
  openApiPath: string
  path: string
}

const deprecatedSkillHubResponse = {
  error: "deprecated",
  message: "Skill hubs are deprecated. Use plugins instead.",
}

const deprecatedSkillHubRoutes: DeprecatedSkillHubRouteCase[] = [
  { method: "POST", openApiMethod: "post", openApiPath: "/v1/skill-hubs", path: "/v1/skill-hubs" },
  { method: "GET", openApiMethod: "get", openApiPath: "/v1/skill-hubs", path: "/v1/skill-hubs" },
  { method: "PATCH", openApiMethod: "patch", openApiPath: "/v1/skill-hubs/{skillHubId}", path: "/v1/skill-hubs/skillhub_123" },
  { method: "DELETE", openApiMethod: "delete", openApiPath: "/v1/skill-hubs/{skillHubId}", path: "/v1/skill-hubs/skillhub_123" },
  { method: "POST", openApiMethod: "post", openApiPath: "/v1/skill-hubs/{skillHubId}/skills", path: "/v1/skill-hubs/skillhub_123/skills" },
  { method: "DELETE", openApiMethod: "delete", openApiPath: "/v1/skill-hubs/{skillHubId}/skills/{skillId}", path: "/v1/skill-hubs/skillhub_123/skills/skill_123" },
  { method: "POST", openApiMethod: "post", openApiPath: "/v1/skill-hubs/{skillHubId}/access", path: "/v1/skill-hubs/skillhub_123/access" },
  { method: "DELETE", openApiMethod: "delete", openApiPath: "/v1/skill-hubs/{skillHubId}/access/{accessId}", path: "/v1/skill-hubs/skillhub_123/access/access_123" },
]

let app: DenApiApp

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function objectProperty(value: unknown, key: string) {
  if (!isJsonObject(value)) {
    throw new Error(`${key} parent was not an object`)
  }

  return value[key]
}

function objectAtPath(value: unknown, keys: string[]) {
  let current = value
  for (const key of keys) {
    current = objectProperty(current, key)
  }
  if (!isJsonObject(current)) {
    throw new Error(`${keys.join(".")} was not an object`)
  }

  return current
}

beforeAll(async () => {
  seedRequiredEnv()
  app = (await import("../src/app.js")).default
})

describe("deprecated skill hub REST routes", () => {
  for (const route of deprecatedSkillHubRoutes) {
    test(`${route.method} ${route.path} returns 410`, async () => {
      const response = await app.request(`http://den.local${route.path}`, { method: route.method })

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual(deprecatedSkillHubResponse)
    })

    test(`legacy org proxy ${route.method} ${route.path} returns 410`, async () => {
      const response = await app.request(`http://den.local/v1/orgs/org_123${route.path.slice(3)}`, { method: route.method })

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual(deprecatedSkillHubResponse)
    })
  }

  test("OpenAPI marks deprecated skill hub routes with 410 responses", async () => {
    const response = await app.request("http://den.local/openapi.json")
    const document = await response.json()

    expect(response.status).toBe(200)

    for (const route of deprecatedSkillHubRoutes) {
      const operation = objectAtPath(document, ["paths", route.openApiPath, route.openApiMethod])
      const responseContent = objectAtPath(operation, ["responses", "410", "content", "application/json"])

      expect(operation.deprecated).toBe(true)
      expect(responseContent.schema).toBeDefined()
    }
  })
})
