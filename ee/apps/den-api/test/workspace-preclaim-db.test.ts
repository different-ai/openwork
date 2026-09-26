import { afterAll, beforeAll, expect, test } from "bun:test"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { randomBytes } from "node:crypto"
import { seedDatabaseTestEnv } from "./database-test-env.js"

// Provision now, claim later, end to end through the Den app against MySQL:
// registration → JWT-bearer exchange → MCP gateway → pre-claim limits →
// claim code reissue → claim → reconcile revokes the agent's credentials.
// Run: DATABASE_URL=<prepared db> bun test --conditions development test/workspace-preclaim-db.test.ts
seedDatabaseTestEnv()
process.env.OPENWORK_DEV_MODE = "1"

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let preclaim: typeof import("../src/workspace-preclaim.js")

const humanUserId = createDenTypeId("user")
const humanSessionToken = `preclaim-human-${randomBytes(12).toString("hex")}`
const forwardedFor = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`

type Json = Record<string, unknown>
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null
}
async function json(response: Response): Promise<Json> {
  const parsed: unknown = await response.json().catch(() => null)
  return isRecord(parsed) ? parsed : {}
}
function field(value: Json, key: string): Json {
  const nested = value[key]
  if (!isRecord(nested)) throw new Error(`missing ${key}`)
  return nested
}

let organizationId = ""
let bootstrapId = ""
let assertion = ""
let accessToken = ""

function exchange(assertionValue: string) {
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": forwardedFor },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertionValue }).toString(),
  })
}

function mcpToolsList(token: string) {
  return app.request("/mcp/agent", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
}

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/workspace-preclaim.js"),
  ])
  app = modules[0].default
  db = modules[1].db
  schema = modules[2]
  drizzle = modules[3]
  preclaim = modules[4]
  await db.insert(schema.AuthUserTable).values({ id: humanUserId, name: "Claimant", email: `claimant+${humanUserId}@preclaim.test`, emailVerified: true })
  await db.insert(schema.AuthSessionTable).values({
    id: createDenTypeId("session"), userId: humanUserId, activeOrganizationId: null, token: humanSessionToken,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
})

afterAll(async () => {
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.userId, humanUserId))
  if (organizationId) {
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, normalizeOrg(organizationId)))
  }
})

function normalizeOrg(id: string) {
  return normalizeDenTypeId("organization", id)
}

test("registration returns claim links and an anonymous identity assertion bound to the token endpoint", async () => {
  const response = await app.request("/v1/bootstrap/workspace", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ workspaceName: "Preclaim studio", claimRoles: ["owner"] }),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = await json(response)
  organizationId = String(field(body, "organization").id)
  bootstrapId = String(field(body, "setup").id)
  const identity = field(body, "identity")
  expect(identity.type).toBe("anonymous")
  expect(identity.assertionType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
  expect(String(identity.tokenEndpoint)).toEndWith("/api/auth/oauth2/token")
  expect(Array.isArray(body.claimLinks) && body.claimLinks.length).toBe(1)
  assertion = String(identity.assertion)
  const [, payload] = assertion.split(".")
  const claims: unknown = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))
  expect(isRecord(claims) && claims.aud).toBe(identity.tokenEndpoint)
  expect(isRecord(claims) && claims.bid).toBe(bootstrapId)
})

test("the assertion exchanges (RFC 7523) for a short-lived MCP token; a tampered one does not", async () => {
  const bad = await exchange(`${assertion.slice(0, -4)}AAAA`)
  expect(bad.status).toBe(400)
  expect((await json(bad)).error).toBe("invalid_grant")

  const granted = await exchange(assertion)
  expect(granted.status).toBe(200)
  const body = await json(granted)
  expect(body.token_type).toBe("Bearer")
  expect(body.scope).toBe("mcp:read mcp:write")
  expect(Number(body.expires_in)).toBeLessThanOrEqual(15 * 60)
  expect("refresh_token" in body).toBe(false)
  accessToken = String(body.access_token)

  const listed = await mcpToolsList(accessToken)
  expect(listed.status).toBe(200)
  expect(await listed.text()).toContain("search_capabilities")
})

test("pre-claim limits: reads and skills are allowed, human-only actions return requires_claim", async () => {
  const allowed = [
    { method: "GET", path: "/v1/org" },
    { method: "POST", path: "/v1/plugins" },
    { method: "POST", path: "/v1/config-objects" },
    { method: "POST", path: `/v1/orgs/${organizationId}/install-links` },
  ]
  for (const entry of allowed) {
    expect(await preclaim.preclaimActionAllowed({ ...entry, readJson: async () => ({}) })).toBe(true)
  }
  expect(await preclaim.preclaimActionAllowed({ method: "POST", path: "/v1/mcp-connections", readJson: async () => ({ authType: "none", credentialMode: "per_member" }) })).toBe(true)
  expect(await preclaim.preclaimActionAllowed({ method: "POST", path: "/v1/mcp-connections", readJson: async () => ({ authType: "oauth", credentialMode: "shared" }) })).toBe(false)
  for (const path of ["/v1/invitations", "/v1/inference-providers", "/v1/billing/checkout", "/v1/api-keys"]) {
    expect(await preclaim.preclaimActionAllowed({ method: "POST", path, readJson: async () => ({}) })).toBe(false)
  }

  // Through the app as the agent user (a REST session stands in for the MCP
  // gateway's internal dispatch, which runs the same middleware).
  const [bootstrap] = await db.select().from(schema.WorkspaceBootstrapTable).where(drizzle.eq(schema.WorkspaceBootstrapTable.id, normalizeDenTypeId("workspaceBootstrap", bootstrapId))).limit(1)
  const agentToken = `preclaim-agent-${randomBytes(12).toString("hex")}`
  await db.insert(schema.AuthSessionTable).values({
    id: createDenTypeId("session"), userId: bootstrap?.agentUserId ?? createDenTypeId("user"), activeOrganizationId: normalizeOrg(organizationId),
    token: agentToken, expiresAt: new Date(Date.now() + 600_000),
  })
  const invite = await app.request("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ email: "someone@example.com", role: "member" }),
  })
  expect(invite.status).toBe(403)
  expect(invite.headers.get("www-authenticate")).toContain('error="insufficient_scope"')
  const error = await json(invite)
  expect(error).toMatchObject({ code: "requires_claim", retryable: false })
  expect(String(error.claim_url)).toEndWith("/claim")
})

test("each claim-code request cancels the previous unused code", async () => {
  const noAuth = await app.request(`/v1/bootstrap/workspace/${bootstrapId}/claim`, { method: "POST" })
  expect(noAuth.status).toBe(401)

  const first = await json(await app.request(`/v1/bootstrap/workspace/${bootstrapId}/claim`, { method: "POST", headers: { authorization: `Bearer ${assertion}` } }))
  const second = await json(await app.request(`/v1/bootstrap/workspace/${bootstrapId}/claim`, { method: "POST", headers: { authorization: `Bearer ${assertion}` } }))
  expect(second).toMatchObject({ expires_in: 900, interval: 5 })
  expect(String(second.verification_uri_complete)).toContain(`/claim?user_code=${encodeURIComponent(String(second.user_code))}`)
  expect(first.user_code).not.toBe(second.user_code)

  const human = { authorization: `Bearer ${humanSessionToken}` }
  const stale = await app.request(`/v1/bootstrap/claim-codes/${String(first.user_code).replace("-", "")}`, { headers: human })
  expect(stale.status).toBe(404)
  const current = await app.request(`/v1/bootstrap/claim-codes/${String(second.user_code)}`, { headers: human })
  expect(current.status).toBe(200)
  expect(field(await json(current), "organization").name).toBe("Preclaim studio")

  const state = await json(await app.request(`/v1/bootstrap/workspace/${bootstrapId}/claim`, { headers: { authorization: `Bearer ${assertion}` } }))
  expect(state).toEqual({ state: "pending", reconciled: false })

  // Claim: the person keeps it as a new organization and becomes owner.
  const accepted = await app.request("/v1/bootstrap/claim-codes/accept", {
    method: "POST",
    headers: { ...human, "content-type": "application/json" },
    body: JSON.stringify({ userCode: second.user_code, mode: "new_org" }),
  })
  expect(accepted.status).toBe(200)
  expect(field(await json(accepted), "organization").role).toBe("owner")
})

test("reconcile revokes the assertion and every pre-claim token", async () => {
  const state = await json(await app.request(`/v1/bootstrap/workspace/${bootstrapId}/claim`, { headers: { authorization: `Bearer ${assertion}` } }))
  expect(state).toEqual({ state: "reconciled", reconciled: true })

  const reexchange = await exchange(assertion)
  expect(reexchange.status).toBe(400)
  expect((await json(reexchange)).error).toBe("invalid_grant")

  const oldToken = await mcpToolsList(accessToken)
  expect(oldToken.status).toBe(401)

  const newCode = await app.request(`/v1/bootstrap/workspace/${bootstrapId}/claim`, { method: "POST", headers: { authorization: `Bearer ${assertion}` } })
  expect(newCode.status).toBe(401)

  const members = await db.select().from(schema.MemberTable).where(drizzle.and(
    drizzle.eq(schema.MemberTable.organizationId, normalizeOrg(organizationId)),
    drizzle.isNull(schema.MemberTable.removedAt),
  ))
  expect(members.map((member) => ({ userId: member.userId, role: member.role }))).toEqual([{ userId: humanUserId, role: "owner" }])
})
