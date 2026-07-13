import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

const singleOrgSlug = "invite-duplicates-test"
const future = new Date(Date.now() + 1000 * 60 * 60)
const past = new Date(Date.now() - 1000 * 60 * 60)

const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const ownerUserId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")
const otherOwnerMemberId = createDenTypeId("member")

const invitedUserId = createDenTypeId("user")
const ssoInviteUserId = createDenTypeId("user")
const reconcileNoMembershipUserId = createDenTypeId("user")
const reconcileOwnerUserId = createDenTypeId("user")
const noPendingUserId = createDenTypeId("user")
const noInviteUserId = createDenTypeId("user")
const mergeUserId = createDenTypeId("user")
const ownerMergeUserId = createDenTypeId("user")
const acceptedInviteUserId = createDenTypeId("user")
const expiredInviteUserId = createDenTypeId("user")
const nonMatchingInviteUserId = createDenTypeId("user")
const otherOrgInviteUserId = createDenTypeId("user")

const ownerEmail = `owner+${ownerUserId}@invite-duplicates.test`
const invitedEmail = `invited+${invitedUserId}@invite-duplicates.test`
const ssoInviteEmail = `sso-invited+${ssoInviteUserId}@invite-duplicates.test`
const reconcileNoMembershipEmail = `reconcile-no-member+${reconcileNoMembershipUserId}@invite-duplicates.test`
const reconcileOwnerEmail = `reconcile-owner+${reconcileOwnerUserId}@invite-duplicates.test`
const noPendingEmail = `no-pending+${noPendingUserId}@invite-duplicates.test`
const noInviteEmail = `no-invite+${noInviteUserId}@invite-duplicates.test`
const mergeEmail = `merge+${mergeUserId}@invite-duplicates.test`
const ownerMergeEmail = `owner-merge+${ownerMergeUserId}@invite-duplicates.test`
const acceptedInviteEmail = `accepted+${acceptedInviteUserId}@invite-duplicates.test`
const expiredEmail = `expired+${expiredInviteUserId}@invite-duplicates.test`
const nonMatchingEmail = `non-matching+${nonMatchingInviteUserId}@invite-duplicates.test`
const otherOrgEmail = `other-org+${otherOrgInviteUserId}@invite-duplicates.test`

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

const userIds = [
  ownerUserId,
  invitedUserId,
  ssoInviteUserId,
  reconcileNoMembershipUserId,
  reconcileOwnerUserId,
  noPendingUserId,
  noInviteUserId,
  mergeUserId,
  ownerMergeUserId,
  acceptedInviteUserId,
  expiredInviteUserId,
  nonMatchingInviteUserId,
  otherOrgInviteUserId,
]

async function deleteOrganizations(organizationIds: string[]) {
  if (!db || !schema || !drizzle || organizationIds.length === 0) {
    return
  }

  await db.delete(schema.DesktopPolicyMemberTable).where(drizzle.inArray(schema.DesktopPolicyMemberTable.organizationId, organizationIds))
  await db.delete(schema.DesktopPolicyTable).where(drizzle.inArray(schema.DesktopPolicyTable.organizationId, organizationIds))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.organizationId, organizationIds))
  await db.delete(schema.InvitationTable).where(drizzle.inArray(schema.InvitationTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
}

async function cleanup() {
  if (!db || !schema || !drizzle) {
    return
  }

  const staleOrgs = await db
    .select({ id: schema.OrganizationTable.id })
    .from(schema.OrganizationTable)
    .where(drizzle.eq(schema.OrganizationTable.slug, singleOrgSlug))
  await deleteOrganizations([...staleOrgs.map((row) => row.id), organizationId, otherOrganizationId])
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, userIds))
}

async function createInvitation(input: {
  invitationId: string
  memberId: string
  organizationId: string
  email: string
  role: string
  expiresAt: Date
  inviterMemberId: string
}) {
  if (!db || !schema) {
    throw new Error("test database not initialized")
  }

  await db.insert(schema.InvitationTable).values({
    id: input.invitationId,
    organizationId: input.organizationId,
    email: input.email,
    role: input.role,
    status: "pending",
    inviterId: ownerUserId,
    orgMemberId: input.inviterMemberId,
    inviteToken: `token-${input.invitationId.slice(-20)}`,
    expiresAt: input.expiresAt,
  })
  await db.insert(schema.MemberTable).values({
    id: input.memberId,
    organizationId: input.organizationId,
    userId: null,
    inviteId: input.invitationId,
    invitedByOrgMember: input.inviterMemberId,
    role: input.role,
    joinedAt: null,
  })
}

async function membersForOrganization(organizationIdToRead: string) {
  if (!db || !schema || !drizzle) {
    throw new Error("test database not initialized")
  }

  return db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.organizationId, organizationIdToRead))
}

async function invitationStatus(invitationId: string) {
  if (!db || !schema || !drizzle) {
    throw new Error("test database not initialized")
  }

  const rows = await db
    .select({ status: schema.InvitationTable.status })
    .from(schema.InvitationTable)
    .where(drizzle.eq(schema.InvitationTable.id, invitationId))
    .limit(1)
  return rows[0]?.status ?? null
}

beforeAll(async () => {
  seedRequiredEnv()
  const [dbModule, schemaModule, drizzleModule, orgsModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/orgs.js"),
  ])
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  orgs = orgsModule

  await cleanup()

  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "Invite Owner", email: ownerEmail, emailVerified: true },
    { id: invitedUserId, name: "Invited User", email: invitedEmail.toUpperCase(), emailVerified: false },
    { id: ssoInviteUserId, name: "SSO Invited User", email: ssoInviteEmail.toUpperCase(), emailVerified: false },
    { id: reconcileNoMembershipUserId, name: "Reconcile No Member", email: reconcileNoMembershipEmail.toUpperCase(), emailVerified: false },
    { id: reconcileOwnerUserId, name: "Reconcile Owner", email: reconcileOwnerEmail.toUpperCase(), emailVerified: false },
    { id: noPendingUserId, name: "No Pending", email: noPendingEmail, emailVerified: false },
    { id: noInviteUserId, name: "No Invite", email: noInviteEmail, emailVerified: false },
    { id: mergeUserId, name: "Merge User", email: mergeEmail, emailVerified: true },
    { id: ownerMergeUserId, name: "Owner Merge", email: ownerMergeEmail, emailVerified: true },
    { id: acceptedInviteUserId, name: "Accepted Invite", email: acceptedInviteEmail, emailVerified: false },
    { id: expiredInviteUserId, name: "Expired Invite", email: expiredEmail, emailVerified: false },
    { id: nonMatchingInviteUserId, name: "Non Matching", email: nonMatchingEmail, emailVerified: false },
    { id: otherOrgInviteUserId, name: "Other Org", email: otherOrgEmail, emailVerified: false },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: organizationId, name: "Invite Duplicates Test", slug: singleOrgSlug },
    { id: otherOrganizationId, name: "Invite Duplicates Other", slug: `invite-duplicates-other-${otherOrganizationId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: otherOwnerMemberId, organizationId: otherOrganizationId, userId: ownerUserId, role: "owner" },
  ])
})

afterAll(async () => {
  await cleanup()
})

test("single-org bootstrap adopts a pending invitation instead of creating a duplicate member", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const placeholderId = createDenTypeId("member")
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: invitedEmail.toLowerCase(),
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })

  const member = await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: invitedUserId,
    role: "member",
    email: invitedEmail.toUpperCase(),
  })
  expect(member.organizationId).toBe(organizationId)

  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((member) => member.userId === invitedUserId || member.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.id).toBe(placeholderId)
  expect(relatedMembers[0]?.userId).toBe(invitedUserId)
  expect(relatedMembers[0]?.role).toBe("admin")
  expect(relatedMembers[0]?.joinedAt).toBeInstanceOf(Date)
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")
})

test("single-org bootstrap without a pending invitation keeps the default member insert behavior", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }

  const member = await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: noInviteUserId,
    role: "member",
    email: noInviteEmail,
  })
  expect(member.organizationId).toBe(organizationId)

  const rows = (await membersForOrganization(organizationId)).filter((member) => member.userId === noInviteUserId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.role).toBe("member")
  expect(rows[0]?.inviteId).toBeNull()
})

test("reconcilePendingInvitationsForUser merges a raw SSO JIT membership with its pending invitation", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const placeholderId = createDenTypeId("member")
  const rawSsoMemberId = createDenTypeId("member")
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: ssoInviteEmail.toLowerCase(),
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })
  await db.insert(schema.MemberTable).values({
    id: rawSsoMemberId,
    organizationId,
    userId: ssoInviteUserId,
    role: "member",
    joinedAt: null,
  })

  await expect(orgs.reconcilePendingInvitationsForUser(ssoInviteUserId)).resolves.toBe(1)

  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((row) => row.userId === ssoInviteUserId || row.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.id).toBe(rawSsoMemberId)
  expect(relatedMembers[0]?.role).toBe("admin")
  expect(relatedMembers[0]?.joinedAt).toBeInstanceOf(Date)
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")
})

test("reconcilePendingInvitationsForUser leaves invitations pending when no same-org membership exists", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const placeholderId = createDenTypeId("member")
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: reconcileNoMembershipEmail.toLowerCase(),
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })

  await expect(orgs.reconcilePendingInvitationsForUser(reconcileNoMembershipUserId)).resolves.toBe(0)

  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((row) => row.userId === reconcileNoMembershipUserId || row.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.id).toBe(placeholderId)
  expect(relatedMembers[0]?.userId).toBeNull()
  await expect(invitationStatus(invitationId)).resolves.toBe("pending")
})

test("reconcilePendingInvitationsForUser never downgrades an existing owner", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const ownerMemberToReconcileId = createDenTypeId("member")
  const placeholderId = createDenTypeId("member")
  await db.insert(schema.MemberTable).values({
    id: ownerMemberToReconcileId,
    organizationId,
    userId: reconcileOwnerUserId,
    role: "owner",
    joinedAt: null,
  })
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: reconcileOwnerEmail.toLowerCase(),
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })

  await expect(orgs.reconcilePendingInvitationsForUser(reconcileOwnerUserId)).resolves.toBe(1)

  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((row) => row.userId === reconcileOwnerUserId || row.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.id).toBe(ownerMemberToReconcileId)
  expect(relatedMembers[0]?.role).toBe("owner")
  expect(relatedMembers[0]?.joinedAt).toBeInstanceOf(Date)
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")
})

test("reconcilePendingInvitationsForUser is a no-op when the user has no pending invitations", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }

  await expect(orgs.reconcilePendingInvitationsForUser(noPendingUserId)).resolves.toBe(0)
  const rows = (await membersForOrganization(organizationId)).filter((member) => member.userId === noPendingUserId)
  expect(rows).toHaveLength(0)
})

test("acceptInvitation merges an existing member with the invitation placeholder", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const existingMemberId = createDenTypeId("member")
  const placeholderId = createDenTypeId("member")

  await db.insert(schema.MemberTable).values({
    id: existingMemberId,
    organizationId,
    userId: mergeUserId,
    role: "member",
    joinedAt: null,
  })
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: mergeEmail,
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })

  const accepted = await orgs.acceptInvitationForUser({
    userId: mergeUserId,
    email: mergeEmail,
    invitationId,
  })

  expect(accepted?.member.id).toBe(existingMemberId)
  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((member) => member.userId === mergeUserId || member.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.id).toBe(existingMemberId)
  expect(relatedMembers[0]?.role).toBe("admin")
  expect(relatedMembers[0]?.joinedAt).toBeInstanceOf(Date)
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")
})

test("acceptInvitation does not downgrade an existing owner while removing the placeholder", async () => {
  if (!db || !schema || !orgs) {
    throw new Error("test modules not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const ownerMemberToMergeId = createDenTypeId("member")
  const placeholderId = createDenTypeId("member")

  await db.insert(schema.MemberTable).values({
    id: ownerMemberToMergeId,
    organizationId,
    userId: ownerMergeUserId,
    role: "owner",
    joinedAt: null,
  })
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: ownerMergeEmail,
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })

  const accepted = await orgs.acceptInvitationForUser({
    userId: ownerMergeUserId,
    email: ownerMergeEmail,
    invitationId,
  })

  expect(accepted?.member.id).toBe(ownerMemberToMergeId)
  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((member) => member.userId === ownerMergeUserId || member.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.role).toBe("owner")
  expect(relatedMembers[0]?.joinedAt).toBeInstanceOf(Date)
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")
})

test("acceptInvitationForUser returns the existing member when bootstrap already accepted the invite", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }
  const invitationId = createDenTypeId("invitation")
  const placeholderId = createDenTypeId("member")
  await createInvitation({
    invitationId,
    memberId: placeholderId,
    organizationId,
    email: acceptedInviteEmail,
    role: "member",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })

  const bootstrapMember = await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: acceptedInviteUserId,
    role: "member",
    email: acceptedInviteEmail,
  })
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")

  const accepted = await orgs.acceptInvitationForUser({
    userId: acceptedInviteUserId,
    email: acceptedInviteEmail,
    invitationId,
  })

  expect(accepted?.invitation.id).toBe(invitationId)
  expect(accepted?.member.id).toBe(bootstrapMember.id)
})

test("bootstrap ignores expired, non-matching, and other-org invitations", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }
  const expiredInvitationId = createDenTypeId("invitation")
  const nonMatchingInvitationId = createDenTypeId("invitation")
  const otherOrgInvitationId = createDenTypeId("invitation")

  await createInvitation({
    invitationId: expiredInvitationId,
    memberId: createDenTypeId("member"),
    organizationId,
    email: expiredEmail,
    role: "admin",
    expiresAt: past,
    inviterMemberId: ownerMemberId,
  })
  await createInvitation({
    invitationId: nonMatchingInvitationId,
    memberId: createDenTypeId("member"),
    organizationId,
    email: `different-${nonMatchingEmail}`,
    role: "admin",
    expiresAt: future,
    inviterMemberId: ownerMemberId,
  })
  await createInvitation({
    invitationId: otherOrgInvitationId,
    memberId: createDenTypeId("member"),
    organizationId: otherOrganizationId,
    email: otherOrgEmail,
    role: "admin",
    expiresAt: future,
    inviterMemberId: otherOwnerMemberId,
  })

  await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: expiredInviteUserId,
    role: "member",
    email: expiredEmail,
  })
  await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: nonMatchingInviteUserId,
    role: "member",
    email: nonMatchingEmail,
  })
  await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: otherOrgInviteUserId,
    role: "member",
    email: otherOrgEmail,
  })

  const singletonMembers = await membersForOrganization(organizationId)
  expect(singletonMembers.filter((member) => member.userId === expiredInviteUserId && member.role === "member")).toHaveLength(1)
  expect(singletonMembers.filter((member) => member.inviteId === expiredInvitationId && member.userId === null)).toHaveLength(1)
  expect(singletonMembers.filter((member) => member.userId === nonMatchingInviteUserId && member.role === "member")).toHaveLength(1)
  expect(singletonMembers.filter((member) => member.inviteId === nonMatchingInvitationId && member.userId === null)).toHaveLength(1)

  const otherOrgMembers = await membersForOrganization(otherOrganizationId)
  expect(singletonMembers.filter((member) => member.userId === otherOrgInviteUserId && member.role === "member")).toHaveLength(1)
  expect(otherOrgMembers.filter((member) => member.userId === otherOrgInviteUserId)).toHaveLength(0)
  expect(otherOrgMembers.filter((member) => member.inviteId === otherOrgInvitationId && member.userId === null)).toHaveLength(1)
  await expect(invitationStatus(expiredInvitationId)).resolves.toBe("pending")
  await expect(invitationStatus(nonMatchingInvitationId)).resolves.toBe("pending")
  await expect(invitationStatus(otherOrgInvitationId)).resolves.toBe("pending")
})
