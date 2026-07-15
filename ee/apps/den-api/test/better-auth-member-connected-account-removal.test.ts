import { afterAll, beforeAll, expect, test } from "bun:test"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"

const cleanupOrganizationIds: DenTypeId<"organization">[] = []
const cleanupUserIds: DenTypeId<"user">[] = []

let authModule: typeof import("../src/auth.js")
let dbModule: typeof import("../src/db.js")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")
let schema: typeof import("@openwork-ee/den-db/schema")

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_gwsreconnect"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"

  authModule = await import("../src/auth.js")
  dbModule = await import("../src/db.js")
  drizzle = await import("@openwork-ee/den-db/drizzle")
  oauthCredentials = await import("../src/capability-sources/oauth-credentials.js")
  schema = await import("@openwork-ee/den-db/schema")
})

afterAll(async () => {
  const { db } = dbModule
  for (const organizationId of cleanupOrganizationIds) {
    await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
    await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  }
  for (const userId of cleanupUserIds) {
    await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.userId, userId))
    await db.delete(schema.AuthAccountTable).where(drizzle.eq(schema.AuthAccountTable.userId, userId))
    await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  }
})

function sessionHeaders(response: Response) {
  const setCookie = response.headers.get("set-cookie") ?? ""
  const cookie = setCookie.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;]+)/)?.[1]
  if (!cookie) throw new Error("Better Auth did not return a session cookie.")
  return new Headers({ cookie })
}

test("Better Auth's native remove and leave routes delete the member's connected account", async () => {
  const { auth } = authModule
  const { db } = dbModule
  const suffix = crypto.randomUUID()
  const ownerEmail = `native-removal-owner+${suffix}@test.local`
  const password = "OpenWork-test-password-123!"

  const signup = await auth.api.signUpEmail({
    body: { email: ownerEmail, name: "Native Removal Owner", password },
  })
  const ownerUserId = normalizeDenTypeId("user", signup.user.id)
  const targetUserId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const targetMemberId = createDenTypeId("member")
  cleanupUserIds.push(ownerUserId, targetUserId)
  cleanupOrganizationIds.push(organizationId)

  await db.insert(schema.AuthUserTable).values({
    id: targetUserId,
    name: "Native Removal Target",
    email: `native-removal-target+${suffix}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Native Removal Org",
    slug: `native-removal-${suffix}`,
  })
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: targetMemberId, organizationId, userId: targetUserId, role: "member" },
  ])
  const account = await oauthCredentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: targetMemberId,
    providerId: "microsoft-365",
    accessToken: "member-access-token",
    refreshToken: "member-refresh-token",
  })

  const signInResponse = await auth.api.signInEmail({
    body: { email: ownerEmail, password },
    asResponse: true,
  })
  expect(signInResponse.status).toBe(200)
  const removed = await auth.api.removeMember({
    body: { memberIdOrEmail: targetMemberId, organizationId },
    headers: sessionHeaders(signInResponse),
  })

  expect(removed.member.id).toBe(targetMemberId)
  await expect(oauthCredentials.getConnectedAccount({
    organizationId,
    orgMembershipId: targetMemberId,
    providerId: "microsoft-365",
  })).resolves.toBeNull()
  const accountRows = await db.select({ id: schema.ConnectedAccountTable.id })
    .from(schema.ConnectedAccountTable)
    .where(drizzle.eq(schema.ConnectedAccountTable.id, account.id))
  const memberRows = await db.select({ id: schema.MemberTable.id })
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.id, targetMemberId))
  expect(accountRows).toEqual([])
  expect(memberRows).toEqual([])

  const remainingOwnerUserId = createDenTypeId("user")
  const remainingOwnerMemberId = createDenTypeId("member")
  cleanupUserIds.push(remainingOwnerUserId)
  await db.insert(schema.AuthUserTable).values({
    id: remainingOwnerUserId,
    name: "Remaining Owner",
    email: `native-removal-remaining-owner+${suffix}@test.local`,
  })
  await db.insert(schema.MemberTable).values({
    id: remainingOwnerMemberId,
    organizationId,
    userId: remainingOwnerUserId,
    role: "owner",
  })
  const ownerAccount = await oauthCredentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: ownerMemberId,
    providerId: "microsoft-365",
    accessToken: "owner-access-token",
    refreshToken: "owner-refresh-token",
  })

  const left = await auth.api.leaveOrganization({
    body: { organizationId },
    headers: sessionHeaders(signInResponse),
  })
  expect(left.id).toBe(ownerMemberId)
  const ownerAccountRows = await db.select({ id: schema.ConnectedAccountTable.id })
    .from(schema.ConnectedAccountTable)
    .where(drizzle.eq(schema.ConnectedAccountTable.id, ownerAccount.id))
  const ownerMemberRows = await db.select({ id: schema.MemberTable.id })
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.id, ownerMemberId))
  expect(ownerAccountRows).toEqual([])
  expect(ownerMemberRows).toEqual([])
})
