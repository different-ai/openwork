import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

const adminUserId = createDenTypeId("user")

const allowAdminMiddleware: MiddlewareHandler = async (_c, next) => {
  await next()
}

mock.module("../src/middleware/admin.js", () => ({
  isAdminEmailAllowed: () => Promise.resolve(true),
  isPlatformAdminUserId: () => Promise.resolve(true),
  requireAdminMiddleware: allowAdminMiddleware,
}))

mock.module("../src/db.js", () => ({
  db: {
    select: (_selection: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          limit: (_count: number) => Promise.resolve([]),
        }),
      }),
    }),
  },
}))

let adminRoutesModule: typeof import("../src/routes/admin/index.js")

beforeAll(async () => {
  seedRequiredEnv()
  adminRoutesModule = await import("../src/routes/admin/index.js")
  mock.restore()
})

afterAll(() => {
  mock.restore()
})

function createApp() {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: adminUserId,
      name: "Admin User",
      email: "admin-delete-user@test.local",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", null)
    c.set("apiKey", null)
    await next()
  })
  adminRoutesModule.registerAdminRoutes(app)
  return app
}

test("admin user delete accepts real usr_ TypeIDs before looking up the user", async () => {
  const targetUserId = createDenTypeId("user")
  const response = await createApp().request(`http://den.local/v1/admin/users/${targetUserId}`, {
    method: "DELETE",
  })

  expect(response.status).toBe(404)
  await expect(response.json()).resolves.toEqual({ error: "not_found", message: "User not found." })
})

test("admin user delete rejects garbage user ids", async () => {
  const response = await createApp().request("http://den.local/v1/admin/users/user_123", {
    method: "DELETE",
  })

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual({ error: "invalid_request", message: "Invalid user id." })
})
