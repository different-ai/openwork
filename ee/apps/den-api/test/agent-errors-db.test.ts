import { afterAll, beforeAll, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { randomBytes } from "node:crypto"
import { seedDatabaseTestEnv } from "./database-test-env.js"

// Agent-facing errors and discovery: an admin-only action answers with the
// shared envelope and an insufficient_scope challenge, and the authorization
// server metadata advertises only the agent registration Den implements.
// Run: DATABASE_URL=<prepared db> bun test --conditions development test/agent-errors-db.test.ts
seedDatabaseTestEnv()
process.env.OPENWORK_DEV_MODE = "1"

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const organizationId = createDenTypeId("organization")
const memberUserId = createDenTypeId("user")
const memberToken = `agent-errors-${randomBytes(12).toString("hex")}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  app = modules[0].default
  db = modules[1].db
  schema = modules[2]
  drizzle = modules[3]
  await db.insert(schema.AuthUserTable).values({ id: memberUserId, name: "Plain member", email: `member+${memberUserId}@agent-errors.test`, emailVerified: true })
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "Agent errors", slug: `agent-errors-${organizationId}` })
  await db.insert(schema.MemberTable).values({ id: createDenTypeId("member"), organizationId, userId: memberUserId, role: "member" })
  await db.insert(schema.AuthSessionTable).values({
    id: createDenTypeId("session"), userId: memberUserId, activeOrganizationId: organizationId, token: memberToken,
    expiresAt: new Date(Date.now() + 600_000),
  })
})

afterAll(async () => {
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.userId, memberUserId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, memberUserId))
})

test("a member who tries to invite gets requires_admin with where to go, and a step-up challenge", async () => {
  const response = await app.request("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ email: "someone@example.com", role: "member" }),
  })
  expect(response.status).toBe(403)
  expect(response.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope"')
  const body: unknown = await response.json()
  expect(body).toMatchObject({ error: "forbidden", code: "requires_admin", retryable: false })
  expect(isRecord(body) && typeof body.message === "string" && body.message.length > 0).toBe(true)
  expect(isRecord(body) && String(body.action_url)).toEndWith("/dashboard/members")
})

test("authorization server metadata advertises anonymous agent registration and the JWT-bearer grant", async () => {
  const response = await app.request("/.well-known/oauth-authorization-server")
  expect(response.status).toBe(200)
  const metadata: unknown = await response.json()
  expect(isRecord(metadata)).toBe(true)
  if (!isRecord(metadata)) return
  expect(metadata.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:jwt-bearer")
  expect(metadata.grant_types_supported).toContain("authorization_code")
  const agentAuth = metadata.agent_auth
  expect(agentAuth).toMatchObject({ skill: "https://openworklabs.com/auth.md", identity_types_supported: ["anonymous"] })
  expect(isRecord(agentAuth) && String(agentAuth.identity_endpoint)).toEndWith("/v1/bootstrap/workspace")
  expect(isRecord(agentAuth) && String(agentAuth.claim_endpoint)).toEndWith("/v1/bootstrap/workspace/{bootstrap_id}/claim")
  expect(isRecord(agentAuth) && "events_endpoint" in agentAuth).toBe(false)
})
