import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let scimAuthModule: typeof import("../src/routes/auth/scim.js")

beforeAll(async () => {
  seedRequiredEnv()
  scimAuthModule = await import("../src/routes/auth/scim.js")
})

test("SCIM mutation sync is skipped when the upstream SCIM mutation fails", async () => {
  let syncWasCalled = false

  const result = await scimAuthModule.syncScimMutationFromResponse({
    bearerToken: "scim-token",
    response: new Response(JSON.stringify({ detail: "Invalid SCIM token" }), { status: 401 }),
    syncResource: async () => {
      syncWasCalled = true
      return true
    },
  })

  expect(result).toEqual({ ok: true, required: false })
  expect(syncWasCalled).toBe(false)
})

test("SCIM mutation sync mirrors successful JSON user resources", async () => {
  const userId = createDenTypeId("user")
  let syncedResource: unknown = null

  const result = await scimAuthModule.syncScimMutationFromResponse({
    bearerToken: "scim-token",
    response: Response.json({ id: userId, userName: "member@example.com", active: true }, { status: 201 }),
    syncResource: async (input) => {
      syncedResource = input.resource
      return true
    },
  })

  expect(result).toEqual({ ok: true, required: true })
  expect(syncedResource).toEqual({ id: userId, userName: "member@example.com", active: true })
})

test("SCIM mutation sync mirrors 204 responses by fallback user id", async () => {
  const userId = createDenTypeId("user")
  let syncedUserId: string | null = null

  const result = await scimAuthModule.syncScimMutationFromResponse({
    bearerToken: "scim-token",
    response: new Response(null, { status: 204 }),
    fallbackUserId: userId,
    syncUserId: async (input) => {
      syncedUserId = input.userId
      return true
    },
  })

  expect(result).toEqual({ ok: true, required: true })
  expect(syncedUserId).toBe(userId)
})

test("SCIM mutation sync reports a retryable failure when the mirror cannot update", async () => {
  const result = await scimAuthModule.syncScimMutationFromResponse({
    bearerToken: "scim-token",
    response: Response.json({ id: createDenTypeId("user"), userName: "member@example.com" }, { status: 200 }),
    syncResource: async () => false,
  })

  expect(result).toEqual({
    ok: false,
    action: "sync_resource",
    message: "external identity sync returned false",
  })
})

test("SCIM mutation sync reports thrown mirror failures without exposing internals to clients", async () => {
  const result = await scimAuthModule.syncScimMutationFromResponse({
    bearerToken: "scim-token",
    response: Response.json({ id: createDenTypeId("user"), userName: "member@example.com" }, { status: 200 }),
    syncResource: async () => {
      throw new Error("database unavailable")
    },
  })

  expect(result).toEqual({
    ok: false,
    action: "sync_resource",
    message: "database unavailable",
  })

  const response = scimAuthModule.createScimSyncFailureResponse(result)
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("60")
  expect(response.headers.get("content-type")).toBe("application/scim+json")
  await expect(response.json()).resolves.toEqual({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail: "SCIM user mutation completed, but external identity sync failed; retry later.",
    status: "503",
    action: "sync_resource",
  })
})

test("SCIM sync failure response supports deprovision retry alerts", async () => {
  const response = scimAuthModule.createScimSyncFailureResponse({
    ok: false,
    action: "delete_user",
    message: "member removal failed",
  })

  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("60")
  await expect(response.json()).resolves.toEqual({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail: "SCIM user mutation completed, but external identity sync failed; retry later.",
    status: "503",
    action: "delete_user",
  })
})
