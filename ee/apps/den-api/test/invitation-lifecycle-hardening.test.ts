import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_invitation_lifecycle"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
  process.env.OPENWORK_DEV_MODE = "1"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const invitedUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const invitedMemberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const invitationId = createDenTypeId("invitation")
const teamId = createDenTypeId("team")
const teamMemberId = createDenTypeId("teamMember")
const ownerSessionToken = `invitation-lifecycle-owner-${ownerSessionId}`
const invitedEmail = `invitation-lifecycle+${invitedUserId}@test.local`
const originalInviteToken = `expired-${invitationId}`
let ownerCookie = ""

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

  await db.insert(schema.AuthUserTable).values([
    {
      id: ownerUserId,
      name: "Invitation Lifecycle Owner",
      email: `invitation-lifecycle-owner+${ownerUserId}@test.local`,
      emailVerified: true,
    },
    {
      id: invitedUserId,
      name: "Invitation Lifecycle Member",
      email: invitedEmail,
      emailVerified: true,
    },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Invitation Lifecycle Hardening",
    slug: `invitation-lifecycle-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    {
      id: ownerMemberId,
      organizationId,
      userId: ownerUserId,
      role: "owner",
    },
    {
      id: invitedMemberId,
      organizationId,
      userId: null,
      inviteId: invitationId,
      invitedByOrgMember: ownerMemberId,
      role: "member",
      joinedAt: null,
    },
  ])
  await db.insert(schema.AuthSessionTable).values({
    id: ownerSessionId,
    userId: ownerUserId,
    activeOrganizationId: organizationId,
    token: ownerSessionToken,
    expiresAt: new Date(Date.now() + 60_000),
  })
  await db.insert(schema.InvitationTable).values({
    id: invitationId,
    organizationId,
    email: invitedEmail,
    role: "member",
    status: "pending",
    inviterId: ownerUserId,
    orgMemberId: ownerMemberId,
    inviteToken: originalInviteToken,
    expiresAt: new Date(Date.now() - 60_000),
  })
  await db.insert(schema.TeamTable).values({
    id: teamId,
    organizationId,
    name: "Invitation Lifecycle Team",
  })
  await db.insert(schema.TeamMemberTable).values({
    id: teamMemberId,
    teamId,
    orgMembershipId: invitedMemberId,
  })

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  ownerCookie = await serializeSignedCookie(
    "better-auth.session_token",
    ownerSessionToken,
    betterAuthSecret,
  )
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }

  await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, organizationId))
  await db.delete(schema.TeamMemberTable).where(drizzle.eq(schema.TeamMemberTable.teamId, teamId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, ownerSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.organizationId, organizationId))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(
    drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, invitedUserId]),
  )
  mock.restore()
})

test("resending an expired invite refreshes its pending member and assignments in place", async () => {
  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/invitations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({ email: invitedEmail, role: "admin" }),
  }))
  const payload: unknown = await response.json()

  expect(response.status).toBe(200)
  expect(isRecord(payload) && payload.invitationId).toBe(invitationId)

  const invitations = await db
    .select()
    .from(schema.InvitationTable)
    .where(drizzle.and(
      drizzle.eq(schema.InvitationTable.organizationId, organizationId),
      drizzle.eq(schema.InvitationTable.email, invitedEmail),
    ))
  expect(invitations).toHaveLength(1)
  expect(invitations[0]?.id).toBe(invitationId)
  expect(invitations[0]?.inviteToken).not.toBe(originalInviteToken)
  expect(invitations[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now())

  const pendingMembers = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.and(
      drizzle.eq(schema.MemberTable.organizationId, organizationId),
      drizzle.eq(schema.MemberTable.inviteId, invitationId),
      drizzle.isNull(schema.MemberTable.removedAt),
    ))
  expect(pendingMembers).toHaveLength(1)
  expect(pendingMembers[0]?.id).toBe(invitedMemberId)
  expect(pendingMembers[0]?.role).toBe("admin")

  const teamMembers = await db
    .select()
    .from(schema.TeamMemberTable)
    .where(drizzle.eq(schema.TeamMemberTable.orgMembershipId, invitedMemberId))
  expect(teamMembers).toHaveLength(1)
  expect(teamMembers[0]?.id).toBe(teamMemberId)
})

test("an accepted invitation cannot be canceled by stale admin state", async () => {
  await db
    .update(schema.InvitationTable)
    .set({ status: "accepted" })
    .where(drizzle.eq(schema.InvitationTable.id, invitationId))
  await db
    .update(schema.MemberTable)
    .set({ userId: invitedUserId, joinedAt: new Date() })
    .where(drizzle.eq(schema.MemberTable.id, invitedMemberId))

  const response = await app.fetch(new Request(
    `${API_ORIGIN}/v1/invitations/${invitationId}/cancel`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
        origin: API_ORIGIN,
      },
      body: JSON.stringify({}),
    },
  ))
  const payload: unknown = await response.json()

  expect(response.status).toBe(409)
  expect(payload).toEqual({
    error: "invitation_not_pending",
    message: "Only pending invitations can be canceled.",
    status: "accepted",
  })

  const invitations = await db
    .select()
    .from(schema.InvitationTable)
    .where(drizzle.eq(schema.InvitationTable.id, invitationId))
  expect(invitations[0]?.status).toBe("accepted")

  const members = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.id, invitedMemberId))
  expect(members[0]?.removedAt).toBeNull()
})
