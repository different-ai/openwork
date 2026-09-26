import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let connections: typeof import("../src/routes/org/mcp-connections.js")
let invitations: typeof import("../src/routes/org/invitations.js")
let webOrigin = ""

beforeAll(async () => {
  seedRequiredEnv()
  const { env } = await import("../src/env.js")
  webOrigin = new URL(env.betterAuthUrl).origin
  connections = await import("../src/routes/org/mcp-connections.js")
  invitations = await import("../src/routes/org/invitations.js")
})

test("a new MCP connection hands the agent a one-click browser sign-in link for that connection", () => {
  const link = new URL(connections.memberSignInLink({
    id: "emc_01abc",
    organizationId: "org_01xyz",
    name: "Linear & Co",
  }))

  expect(link.origin).toBe(webOrigin)
  expect(link.pathname).toBe("/connect/mcp")
  expect(link.searchParams.get("connectionId")).toBe("emc_01abc")
  expect(link.searchParams.get("org")).toBe("org_01xyz")
  expect(link.searchParams.get("name")).toBe("Linear & Co")
})

test("the seat-billing refusal points the agent at the billing page", () => {
  const url = new URL(invitations.invitationBillingUrl())
  expect(url.origin).toBe(webOrigin)
  expect(url.pathname).toBe("/dashboard/billing")
})
