import { afterAll, beforeAll, expect, mock, test } from "bun:test"

// Auth initializes OAuth resource seeds even when only its organization hooks are
// used. Represent already-seeded resources without opening an ambient database.
const rows = { from: () => rows, where: async () => [{ id: "fixture-resource" }] }
mock.module("../src/db.js", () => ({ db: { select: () => rows } }))

let auth: typeof import("../src/auth.js")["auth"]

beforeAll(async () => {
  process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/not_connected"
  process.env.DB_MODE = "mysql"
  process.env.GATEWAY_ENABLED = "false"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  auth = (await import("../src/auth.js")).auth
  await auth.$context
})

afterAll(() => mock.restore())

async function beforeCreate(metadata: unknown) {
  // Invoke the registered hook, not the DB-backed organization creation endpoint.
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id === "organization") {
      return plugin.options.organizationHooks.beforeCreateOrganization({
        // Better Auth types only objects; the runtime boundary also needs malformed/string coverage.
        organization: { name: "Test Workspace", slug: "test-workspace", metadata: metadata as Record<string, unknown> },
        user: { id: "test-user", name: "Member", email: "member@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
      })
    }
  }
  throw new Error("Organization hook not registered")
}

test.each([true, false, null, "true", 1])("public creation cannot set platform-managed gatewayDashboard to %s", async (value) => {
  const metadata = { capabilities: { gatewayDashboard: value } }
  for (const input of [metadata, JSON.stringify(metadata)]) {
    await expect(beforeCreate(input)).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { message: "capabilities.gatewayDashboard is reserved for internal platform administration." },
    })
  }
})

test("ordinary metadata and other capability overrides retain their existing behavior", async () => {
  for (const metadata of [undefined, null, {}, { label: "test" }, { capabilities: {} }, { capabilities: { inference: false, desktop: true } }]) {
    await expect(beforeCreate(metadata)).resolves.toBeUndefined()
    if (metadata !== undefined) await expect(beforeCreate(JSON.stringify(metadata === null ? {} : metadata))).resolves.toBeUndefined()
  }
})

test("existing malformed metadata and dpaSigned denials are preserved", async () => {
  for (const metadata of ["not-json", "[]", "true", 42, []]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({ status: "BAD_REQUEST" })
  }
  for (const metadata of [{ dpaSigned: true }, JSON.stringify({ dpaSigned: false })]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({
      status: "FORBIDDEN", body: { message: "dpaSigned is reserved for internal platform administration." },
    })
  }
})

test("public organization updates cannot replace capability metadata", async () => {
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id !== "organization") continue
    for (const metadata of [{}, { capabilities: { gatewayDashboard: true } }, { capabilities: { gatewayDashboard: false } }]) {
      await expect(plugin.options.organizationHooks.beforeUpdateOrganization({
        organization: { metadata },
        user: { id: "test-user", name: "Member", email: "member@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
        member: { id: "test-member", organizationId: "test-org", userId: "test-user", role: "owner", createdAt: new Date(0) },
      })).rejects.toMatchObject({ status: "FORBIDDEN" })
    }
    return
  }
  throw new Error("Organization hook not registered")
})
