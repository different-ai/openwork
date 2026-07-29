import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

const singleOrgSlug = "member-removal-rejoin-test"
const future = new Date(Date.now() + 1000 * 60 * 60)
const past = new Date(Date.now() - 1000 * 60 * 60)

const organizationId = createDenTypeId("organization")
const ownerUserId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")
const removedUserId = createDenTypeId("user")
const bootstrapUserId = createDenTypeId("user")
const reviveUserId = createDenTypeId("user")
const legacyReviveUserId = createDenTypeId("user")
const oldInviteUserId = createDenTypeId("user")
const scimUserId = createDenTypeId("user")

const ownerEmail = `owner+${ownerUserId}@member-removal.test`
const removedEmail = `removed+${removedUserId}@member-removal.test`
const bootstrapEmail = `bootstrap+${bootstrapUserId}@member-removal.test`
const reviveEmail = `revive+${reviveUserId}@member-removal.test`
const legacyReviveEmail = `legacy-revive+${legacyReviveUserId}@member-removal.test`
const oldInviteEmail = `old-invite+${oldInviteUserId}@member-removal.test`
const scimEmail = `scim+${scimUserId}@member-removal.test`

const userIds = [ownerUserId, removedUserId, bootstrapUserId, reviveUserId, legacyReviveUserId, oldInviteUserId, scimUserId]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "single_org"
  process.env.DEN_SINGLE_ORG_SLUG = singleOrgSlug
  process.env.DEN_SINGLE_ORG_OWNER_EMAILS = ownerEmail
}

let db: typeof import("../src/db.js").db | null = null
let schema: typeof import("@openwork-ee/den-db/schema") | null = null
let drizzle: typeof import("@openwork-ee/den-db/drizzle") | null = null
let orgs: typeof import("../src/orgs.js") | null = null
let scim: typeof import("../src/scim.js") | null = null

async function cleanup() {
  if (!db || !schema || !drizzle) {
    return
  }

  const staleOrgs = await db
    .select({ id: schema.OrganizationTable.id })
    .from(schema.OrganizationTable)
    .where(drizzle.eq(schema.OrganizationTable.slug, singleOrgSlug))
  const organizationIds = [...staleOrgs.map((row) => row.id), organizationId]

  await db.delete(schema.DesktopPolicyMemberTable).where(drizzle.inArray(schema.DesktopPolicyMemberTable.organizationId, organizationIds))
  await db.delete(schema.DesktopPolicyTable).where(drizzle.inArray(schema.DesktopPolicyTable.organizationId, organizationIds))
  await db.delete(schema.ScimUserTombstoneTable).where(drizzle.inArray(schema.ScimUserTombstoneTable.organizationId, organizationIds))
  await db.delete(schema.ExternalIdentityTable).where(drizzle.inArray(schema.ExternalIdentityTable.organizationId, organizationIds))
  await db.delete(schema.ScimProviderTable).where(drizzle.inArray(schema.ScimProviderTable.organizationId, organizationIds))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.organizationId, organizationIds))
  await db.delete(schema.InvitationTable).where(drizzle.inArray(schema.InvitationTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, userIds))
}

async function createInvitation(input: {
  invitationId: string
  memberId: string
  email: string
  role: string
  status?: string
  createPlaceholder?: boolean
}) {
  if (!db || !schema) {
    throw new Error("test database not initialized")
  }

  await db.insert(schema.InvitationTable).values({
    id: input.invitationId,
    organizationId,
    email: input.email,
    role: input.role,
    status: input.status ?? "pending",
    inviterId: ownerUserId,
    orgMemberId: ownerMemberId,
    inviteToken: `token-${input.invitationId.slice(-20)}`,
    expiresAt: future,
  })

  if (input.createPlaceholder ?? true) {
    await db.insert(schema.MemberTable).values({
      id: input.memberId,
      organizationId,
      userId: null,
      inviteId: input.invitationId,
      invitedByOrgMember: ownerMemberId,
      role: input.role,
      joinedAt: null,
    })
  }
}

async function memberById(memberId: string) {
  if (!db || !schema || !drizzle) {
    throw new Error("test database not initialized")
  }

  const rows = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.id, memberId))
    .limit(1)
  return rows[0] ?? null
}

async function membersForUser(userId: string) {
  if (!db || !schema || !drizzle) {
    throw new Error("test database not initialized")
  }

  return db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.and(drizzle.eq(schema.MemberTable.organizationId, organizationId), drizzle.eq(schema.MemberTable.userId, userId)))
}

beforeAll(async () => {
  seedRequiredEnv()
  const [dbModule, schemaModule, drizzleModule, orgsModule, scimModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/orgs.js"),
    import("../src/scim.js"),
  ])
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  orgs = orgsModule
  scim = scimModule

  await cleanup()

  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "Removal Owner", email: ownerEmail, emailVerified: true },
    { id: removedUserId, name: "Removed User", email: removedEmail, emailVerified: true },
    { id: bootstrapUserId, name: "Bootstrap Removed", email: bootstrapEmail, emailVerified: true },
    { id: reviveUserId, name: "Revive Removed", email: reviveEmail, emailVerified: true },
    { id: legacyReviveUserId, name: "Legacy Revive Removed", email: legacyReviveEmail, emailVerified: true },
    { id: oldInviteUserId, name: "Old Invite Removed", email: oldInviteEmail, emailVerified: true },
    { id: scimUserId, name: "SCIM Removed", email: scimEmail, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "Member Removal Rejoin Test", slug: singleOrgSlug })
  await db.insert(schema.MemberTable).values({ id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" })
})

afterAll(async () => {
  await cleanup()
})

test("removeOrganizationMember keeps userId while setting removedAt", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }

  const memberId = createDenTypeId("member")
  await db.insert(schema.MemberTable).values({ id: memberId, organizationId, userId: removedUserId, role: "member" })

  const removed = await orgs.removeOrganizationMember({
    organizationId,
    memberId,
    removedByOrgMemberId: ownerMemberId,
  })
  if (!removed.ok) {
    throw new Error(removed.message)
  }

  const row = await memberById(memberId)
  expect(row?.userId).toBe(removedUserId)
  expect(row?.removedAt).toBeInstanceOf(Date)
  expect(row?.removedByOrgMember).toBe(ownerMemberId)
})

test("bootstrap returns null for a user with a removed member row", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }

  const memberId = createDenTypeId("member")
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId: bootstrapUserId,
    role: "member",
    joinedAt: past,
    removedAt: past,
    removedByOrgMember: ownerMemberId,
  })

  const bootstrapped = await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: bootstrapUserId,
    role: "member",
    email: bootstrapEmail,
  })

  expect(bootstrapped).toBeNull()
  const rows = await membersForUser(bootstrapUserId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.id).toBe(memberId)
  expect(rows[0]?.removedAt).toBeInstanceOf(Date)
})

test("a new explicit invitation activates its placeholder as a fresh member lifecycle", async () => {
  if (!db || !schema || !orgs || !drizzle) {
    throw new Error("test modules not initialized")
  }

  const removedMemberId = createDenTypeId("member")
  const invitationId = createDenTypeId("invitation")
  const placeholderId = createDenTypeId("member")
  await db.insert(schema.MemberTable).values({
    id: removedMemberId,
    organizationId,
    userId: reviveUserId,
    role: "owner",
    joinedAt: past,
    removedAt: past,
    removedByOrgMember: ownerMemberId,
  })
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    email: reviveEmail,
    role: "admin",
  })

  const accepted = await orgs.acceptInvitationForUser({
    userId: reviveUserId,
    email: reviveEmail,
    invitationId,
  })
  if (!accepted || accepted.status !== "accepted") {
    throw new Error("invite was not accepted")
  }

  expect(accepted.member.id).toBe(placeholderId)
  const rows = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.inArray(schema.MemberTable.id, [removedMemberId, placeholderId]))
  expect(rows).toHaveLength(2)

  const removedRow = rows.find((row) => row.id === removedMemberId)
  expect(removedRow?.userId).toBeNull()
  expect(removedRow?.role).toBe("owner")
  expect(removedRow?.removedAt).toBeInstanceOf(Date)
  expect(removedRow?.removedByOrgMember).toBe(ownerMemberId)

  const acceptedRow = rows.find((row) => row.id === placeholderId)
  expect(acceptedRow?.userId).toBe(reviveUserId)
  expect(acceptedRow?.role).toBe("admin")
  expect(acceptedRow?.removedAt).toBeNull()
  expect(acceptedRow?.removedByOrgMember).toBeNull()
  expect(acceptedRow?.inviteId).toBe(invitationId)
  expect(acceptedRow?.invitedByOrgMember).toBe(ownerMemberId)
  expect(acceptedRow?.joinedAt).toBeInstanceOf(Date)
})

test("a legacy invitation without a placeholder still creates a fresh member lifecycle", async () => {
  if (!db || !schema || !orgs || !drizzle) {
    throw new Error("test modules not initialized")
  }

  const removedMemberId = createDenTypeId("member")
  const invitationId = createDenTypeId("invitation")
  await db.insert(schema.MemberTable).values({
    id: removedMemberId,
    organizationId,
    userId: legacyReviveUserId,
    role: "admin",
    joinedAt: past,
    removedAt: past,
    removedByOrgMember: ownerMemberId,
  })
  await createInvitation({
    invitationId,
    memberId: createDenTypeId("member"),
    email: legacyReviveEmail,
    role: "member",
    createPlaceholder: false,
  })

  const accepted = await orgs.acceptInvitationForUser({
    userId: legacyReviveUserId,
    email: legacyReviveEmail,
    invitationId,
  })
  if (!accepted || accepted.status !== "accepted") {
    throw new Error("legacy invite was not accepted")
  }

  expect(accepted.member.id).not.toBe(removedMemberId)
  const rows = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.inArray(schema.MemberTable.id, [removedMemberId, accepted.member.id]))
  expect(rows).toHaveLength(2)

  const removedRow = rows.find((row) => row.id === removedMemberId)
  expect(removedRow?.userId).toBeNull()
  expect(removedRow?.removedAt).toBeInstanceOf(Date)

  const acceptedRow = rows.find((row) => row.id === accepted.member.id)
  expect(acceptedRow?.userId).toBe(legacyReviveUserId)
  expect(acceptedRow?.role).toBe("member")
  expect(acceptedRow?.inviteId).toBe(invitationId)
  expect(acceptedRow?.removedAt).toBeNull()
})

test("an old accepted invitation reports membership_removed for removed users", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }

  const invitationId = createDenTypeId("invitation")
  const memberId = createDenTypeId("member")
  await createInvitation({
    invitationId,
    memberId: createDenTypeId("member"),
    email: oldInviteEmail,
    role: "member",
    status: "accepted",
    createPlaceholder: false,
  })
  await db.insert(schema.MemberTable).values({ id: memberId, organizationId, userId: oldInviteUserId, inviteId: invitationId, role: "member" })

  const removed = await orgs.removeOrganizationMember({ organizationId, memberId, removedByOrgMemberId: ownerMemberId })
  if (!removed.ok) {
    throw new Error(removed.message)
  }

  const accepted = await orgs.acceptInvitationForUser({
    userId: oldInviteUserId,
    email: oldInviteEmail,
    invitationId,
  })

  expect(accepted?.status).toBe("membership_removed")
})

test("SCIM reactivation clears removed member userId memory", async () => {
  if (!db || !schema || !scim) {
    throw new Error("test modules not initialized")
  }

  const memberId = createDenTypeId("member")
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId: scimUserId,
    role: "member",
    joinedAt: past,
    removedAt: past,
    removedByOrgMember: ownerMemberId,
  })

  await scim.clearRemovedMemberMemoryForScimReactivation({ organizationId, userId: scimUserId })

  const row = await memberById(memberId)
  expect(row?.userId).toBeNull()
  expect(row?.removedAt).toBeInstanceOf(Date)
})
