import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_role_invitation_lifecycle"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const renameRoleId = createDenTypeId("organizationRole")
const deleteRoleId = createDenTypeId("organizationRole")
const blockedRoleId = createDenTypeId("organizationRole")
const ownerSessionToken = `role-lifecycle-owner-${ownerSessionId}`
let ownerCookie = ""

async function cleanup() {
  await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, organizationId))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, ownerSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, ownerUserId))
}

async function insertInvitation(input: {
  role: string
  status: "pending" | "accepted" | "canceled"
}) {
  const id = createDenTypeId("invitation")
  await db.insert(schema.InvitationTable).values({
    id,
    organizationId,
    email: `${input.status}-${input.role}+${id}@test.local`,
    role: input.role,
    status: input.status,
    inviterId: ownerUserId,
    orgMemberId: ownerMemberId,
    inviteToken: `role-lifecycle-${id}`,
    expiresAt: new Date(Date.now() + 60_000),
  })
  return id
}

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

  await cleanup()
  await db.insert(schema.AuthUserTable).values({
    id: ownerUserId,
    name: "Role Lifecycle Owner",
    email: `role-lifecycle-owner+${ownerUserId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Role Invitation Lifecycle",
    slug: `role-invitation-lifecycle-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: ownerMemberId,
    organizationId,
    userId: ownerUserId,
    role: "owner",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: ownerSessionId,
    userId: ownerUserId,
    activeOrganizationId: organizationId,
    token: ownerSessionToken,
    expiresAt: new Date(Date.now() + 60_000),
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
  if (db && schema && drizzle) {
    await cleanup()
  }
  mock.restore()
})

test("renaming a role updates pending invitations without rewriting invitation history", async () => {
  await db.insert(schema.OrganizationRoleTable).values({
    id: renameRoleId,
    organizationId,
    role: "operator",
    permission: "{}",
  })
  const pendingInvitationId = await insertInvitation({ role: "operator", status: "pending" })
  const acceptedInvitationId = await insertInvitation({ role: "operator", status: "accepted" })
  const canceledInvitationId = await insertInvitation({ role: "operator", status: "canceled" })

  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/roles/${renameRoleId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({ roleName: "support-operator" }),
  }))
  expect(response.status).toBe(200)

  const invitations = await db
    .select({ id: schema.InvitationTable.id, role: schema.InvitationTable.role })
    .from(schema.InvitationTable)
    .where(drizzle.inArray(
      schema.InvitationTable.id,
      [pendingInvitationId, acceptedInvitationId, canceledInvitationId],
    ))
  const roleByInvitationId = new Map(invitations.map((invitation) => [invitation.id, invitation.role]))
  expect(roleByInvitationId.get(pendingInvitationId)).toBe("support-operator")
  expect(roleByInvitationId.get(acceptedInvitationId)).toBe("operator")
  expect(roleByInvitationId.get(canceledInvitationId)).toBe("operator")
})

test("historical invitations do not block role deletion", async () => {
  await db.insert(schema.OrganizationRoleTable).values({
    id: deleteRoleId,
    organizationId,
    role: "temporary-reviewer",
    permission: "{}",
  })
  const acceptedInvitationId = await insertInvitation({
    role: "temporary-reviewer",
    status: "accepted",
  })
  const canceledInvitationId = await insertInvitation({
    role: "temporary-reviewer",
    status: "canceled",
  })

  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/roles/${deleteRoleId}`, {
    method: "DELETE",
    headers: {
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
  }))
  expect(response.status).toBe(204)

  const roles = await db
    .select()
    .from(schema.OrganizationRoleTable)
    .where(drizzle.eq(schema.OrganizationRoleTable.id, deleteRoleId))
  expect(roles).toHaveLength(0)

  const invitations = await db
    .select({ id: schema.InvitationTable.id, role: schema.InvitationTable.role })
    .from(schema.InvitationTable)
    .where(drizzle.inArray(
      schema.InvitationTable.id,
      [acceptedInvitationId, canceledInvitationId],
    ))
  const roleByInvitationId = new Map(invitations.map((invitation) => [invitation.id, invitation.role]))
  expect(roleByInvitationId.get(acceptedInvitationId)).toBe("temporary-reviewer")
  expect(roleByInvitationId.get(canceledInvitationId)).toBe("temporary-reviewer")
})

test("a pending invitation still blocks role deletion", async () => {
  await db.insert(schema.OrganizationRoleTable).values({
    id: blockedRoleId,
    organizationId,
    role: "pending-reviewer",
    permission: "{}",
  })
  await insertInvitation({ role: "pending-reviewer", status: "pending" })

  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/roles/${blockedRoleId}`, {
    method: "DELETE",
    headers: {
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
  }))
  const payload: unknown = await response.json()
  expect(response.status).toBe(400)
  expect(isRecord(payload) ? payload.error : null).toBe("role_in_use")

  const roles = await db
    .select()
    .from(schema.OrganizationRoleTable)
    .where(drizzle.eq(schema.OrganizationRoleTable.id, blockedRoleId))
  expect(roles).toHaveLength(1)
})
