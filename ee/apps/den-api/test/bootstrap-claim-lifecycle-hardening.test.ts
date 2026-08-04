import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"
import { createHash } from "node:crypto"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_bootstrap_claim_lifecycle"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
  process.env.OPENWORK_DEV_MODE = "1"
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const organizationId = createDenTypeId("organization")
const setupMemberId = createDenTypeId("member")
const bootstrapId = createDenTypeId("workspaceBootstrap")
const replayClaimId = createDenTypeId("workspaceClaim")
const removedClaimId = createDenTypeId("workspaceClaim")
const firstUserId = createDenTypeId("user")
const secondUserId = createDenTypeId("user")
const removedUserId = createDenTypeId("user")
const removedMemberId = createDenTypeId("member")
const firstSessionId = createDenTypeId("session")
const secondSessionId = createDenTypeId("session")
const removedSessionId = createDenTypeId("session")
const firstSessionToken = `bootstrap-claim-first-${firstSessionId}`
const secondSessionToken = `bootstrap-claim-second-${secondSessionId}`
const removedSessionToken = `bootstrap-claim-removed-${removedSessionId}`
const replayToken = `bootstrap-replay-${replayClaimId}`
const removedToken = `bootstrap-removed-${removedClaimId}`
let firstCookie = ""
let secondCookie = ""
let removedCookie = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appModule, dbModule, schemaModule, drizzleModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  app = appModule.default
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 60_000)
  await db.insert(schema.AuthUserTable).values([
    { id: firstUserId, name: "First claimant", email: `first+${firstUserId}@bootstrap.test`, emailVerified: true },
    { id: secondUserId, name: "Second claimant", email: `second+${secondUserId}@bootstrap.test`, emailVerified: true },
    { id: removedUserId, name: "Removed claimant", email: `removed+${removedUserId}@bootstrap.test`, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Bootstrap claim lifecycle",
    slug: `bootstrap-claim-${organizationId}`,
    metadata: { bootstrap: { provisional: true, bootstrapId } },
  })
  await db.insert(schema.MemberTable).values([
    {
      id: setupMemberId,
      organizationId,
      userId: null,
      role: "owner",
    },
    {
      id: removedMemberId,
      organizationId,
      userId: removedUserId,
      role: "admin",
      removedAt: now,
    },
  ])
  await db.insert(schema.WorkspaceBootstrapTable).values({
    id: bootstrapId,
    organizationId,
    setupMemberId,
    status: "provisional",
    expiresAt,
  })
  await db.insert(schema.WorkspaceClaimTable).values([
    {
      id: replayClaimId,
      bootstrapId,
      organizationId,
      tokenHash: sha256(replayToken),
      role: "member",
      status: "pending",
      expiresAt,
    },
    {
      id: removedClaimId,
      bootstrapId,
      organizationId,
      tokenHash: sha256(removedToken),
      role: "owner",
      status: "pending",
      expiresAt,
    },
  ])
  await db.insert(schema.AuthSessionTable).values([
    { id: firstSessionId, userId: firstUserId, activeOrganizationId: null, token: firstSessionToken, expiresAt },
    { id: secondSessionId, userId: secondUserId, activeOrganizationId: null, token: secondSessionToken, expiresAt },
    { id: removedSessionId, userId: removedUserId, activeOrganizationId: null, token: removedSessionToken, expiresAt },
  ])

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  firstCookie = await serializeSignedCookie("better-auth.session_token", firstSessionToken, betterAuthSecret)
  secondCookie = await serializeSignedCookie("better-auth.session_token", secondSessionToken, betterAuthSecret)
  removedCookie = await serializeSignedCookie("better-auth.session_token", removedSessionToken, betterAuthSecret)
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }

  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.id, [firstSessionId, secondSessionId, removedSessionId]))
  await db.delete(schema.WorkspaceClaimTable).where(drizzle.eq(schema.WorkspaceClaimTable.organizationId, organizationId))
  await db.delete(schema.WorkspaceBootstrapTable).where(drizzle.eq(schema.WorkspaceBootstrapTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [firstUserId, secondUserId, removedUserId]))
  mock.restore()
})

function acceptClaim(token: string, cookie: string) {
  return app.fetch(new Request(`${API_ORIGIN}/v1/bootstrap/claims/accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({ token }),
  }))
}

test("one bootstrap claim token can create only one membership", async () => {
  const responses = await Promise.all([
    acceptClaim(replayToken, firstCookie),
    acceptClaim(replayToken, secondCookie),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([200, 404])

  const claims = await db
    .select()
    .from(schema.WorkspaceClaimTable)
    .where(drizzle.eq(schema.WorkspaceClaimTable.id, replayClaimId))
  expect(claims[0]?.status).toBe("claimed")
  expect([firstUserId, secondUserId]).toContain(claims[0]?.claimedByUserId)

  const memberships = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.and(
      drizzle.eq(schema.MemberTable.organizationId, organizationId),
      drizzle.inArray(schema.MemberTable.userId, [firstUserId, secondUserId]),
      drizzle.isNull(schema.MemberTable.removedAt),
    ))
  expect(memberships).toHaveLength(1)
})

test("a pre-removal bootstrap claim cannot reactivate stale membership", async () => {
  const response = await acceptClaim(removedToken, removedCookie)
  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({
    error: "membership_removed",
    message: "Your access to this workspace was removed. Ask a workspace admin for a new invite.",
  })

  const claims = await db
    .select()
    .from(schema.WorkspaceClaimTable)
    .where(drizzle.eq(schema.WorkspaceClaimTable.id, removedClaimId))
  expect(claims[0]?.status).toBe("pending")
  expect(claims[0]?.claimedByUserId).toBeNull()

  const members = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.id, removedMemberId))
  expect(members[0]?.userId).toBe(removedUserId)
  expect(members[0]?.role).toBe("admin")
  expect(members[0]?.removedAt).toBeInstanceOf(Date)
})
