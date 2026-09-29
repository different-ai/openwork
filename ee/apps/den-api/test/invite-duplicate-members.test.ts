import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { withSsoEmailDomainProof } from "../src/sso-email-domain-proof.js"

const singleOrgSlug = "invite-duplicates-test"
const future = new Date(Date.now() + 1000 * 60 * 60)
const past = new Date(Date.now() - 1000 * 60 * 60)

const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const organizationIds = [organizationId, otherOrganizationId]
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
let cache: typeof import("../src/cache.js").cache | null = null
let restoreCacheDependencies: (() => void) | null = null
const cacheDeleteCalls: string[] = []
const cachedValues = new Map<string, string>()

const redis = {
  get: (key: string) => Promise.resolve(cachedValues.get(key) ?? null),
  set: (key: string, value: string, _mode: "EX", _ttl: number) => {
    cachedValues.set(key, value)
    return Promise.resolve("OK")
  },
  del: (...keys: string[]) => {
    cacheDeleteCalls.push(...keys)
    for (const key of keys) cachedValues.delete(key)
    return Promise.resolve(keys.length)
  },
}

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

async function deleteOrganizations(organizationIds: DenTypeId<"organization">[]) {
  if (!db || !schema || !drizzle || organizationIds.length === 0) {
    return
  }

  await db.delete(schema.SsoConnectionTable).where(drizzle.inArray(schema.SsoConnectionTable.organizationId, organizationIds))
  await db.delete(schema.SsoProviderTable).where(drizzle.inArray(schema.SsoProviderTable.organizationId, organizationIds))
  await db.delete(schema.ScimUserTombstoneTable).where(drizzle.inArray(schema.ScimUserTombstoneTable.organizationId, organizationIds))
  await db.delete(schema.ScimProviderTable).where(drizzle.inArray(schema.ScimProviderTable.organizationId, organizationIds))
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
  await deleteOrganizations([...staleOrgs.map((row) => row.id), ...organizationIds])
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, userIds))
}

async function createInvitation(input: {
  invitationId: DenTypeId<"invitation">
  memberId: DenTypeId<"member">
  organizationId: DenTypeId<"organization">
  email: string
  role: string
  expiresAt: Date
  inviterMemberId: DenTypeId<"member">
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

async function membersForOrganization(organizationIdToRead: DenTypeId<"organization">) {
  if (!db || !schema || !drizzle) {
    throw new Error("test database not initialized")
  }

  return db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.eq(schema.MemberTable.organizationId, organizationIdToRead))
}

async function invitationStatus(invitationId: DenTypeId<"invitation">) {
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
  const [dbModule, schemaModule, drizzleModule, orgsModule, cacheModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/orgs.js"),
    import("../src/cache.js"),
  ])
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  orgs = orgsModule
  cache = cacheModule.cache
  restoreCacheDependencies = cacheModule.setCacheDependenciesForTest({ redis })

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
  await orgs.seedDefaultOrganizationRoles(organizationId)
  await orgs.seedDefaultOrganizationRoles(otherOrganizationId)
})

beforeEach(() => {
  cacheDeleteCalls.length = 0
  cachedValues.clear()
})

afterAll(async () => {
  restoreCacheDependencies?.()
  await cleanup()
})

test("single-org bootstrap adopts a pending invitation and invalidates the member cache", async () => {
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
  if (!member) {
    throw new Error("bootstrap membership was not created")
  }
  expect(member.organizationId).toBe(organizationId)

  const relatedMembers = (await membersForOrganization(organizationId))
    .filter((member) => member.userId === invitedUserId || member.inviteId === invitationId)
  expect(relatedMembers).toHaveLength(1)
  expect(relatedMembers[0]?.id).toBe(placeholderId)
  expect(relatedMembers[0]?.userId).toBe(invitedUserId)
  expect(relatedMembers[0]?.role).toBe("admin")
  expect(relatedMembers[0]?.joinedAt).toBeInstanceOf(Date)
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")
  expect(cacheDeleteCalls).toEqual([`cache:org:members:${organizationId}`, `cache:org:member:${organizationId}:${invitedUserId}`])
})

test("single-org bootstrap invalidates the member cache after a default member insert", async () => {
  if (!orgs) {
    throw new Error("orgs module not initialized")
  }

  const member = await orgs.ensureBootstrapMembershipForOrganization({
    organizationId,
    userId: noInviteUserId,
    role: "member",
    email: noInviteEmail,
  })
  if (!member) {
    throw new Error("bootstrap membership was not created")
  }
  expect(member.organizationId).toBe(organizationId)

  const rows = (await membersForOrganization(organizationId)).filter((member) => member.userId === noInviteUserId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.role).toBe("member")
  expect(rows[0]?.inviteId).toBeNull()
  expect(cacheDeleteCalls).toEqual([`cache:org:members:${organizationId}`, `cache:org:member:${organizationId}:${noInviteUserId}`])
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
  if (!accepted || accepted.status !== "accepted") {
    throw new Error("invite was not accepted")
  }

  expect(accepted.member.id).toBe(existingMemberId)
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
  if (!accepted || accepted.status !== "accepted") {
    throw new Error("invite was not accepted")
  }

  expect(accepted.member.id).toBe(ownerMemberToMergeId)
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
  if (!bootstrapMember) {
    throw new Error("bootstrap membership was not created")
  }
  await expect(invitationStatus(invitationId)).resolves.toBe("accepted")

  const accepted = await orgs.acceptInvitationForUser({
    userId: acceptedInviteUserId,
    email: acceptedInviteEmail,
    invitationId,
  })
  if (!accepted || accepted.status !== "accepted") {
    throw new Error("invite was not accepted")
  }

  expect(accepted.invitation.id).toBe(invitationId)
  expect(accepted.member.id).toBe(bootstrapMember.id)
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

async function createSsoFixture(input: {
  emailVerified?: boolean
  domainVerified?: boolean
  emailDomainProof?: boolean
  protocol?: "oidc" | "saml"
  status?: string
  emailDomain?: string
  providerDomain?: string
  allowedEmailDomains?: string[]
  memberRole?: string
  membership?: "active" | "removed" | "absent"
  invitation?: "pending" | "expired" | "canceled" | "absent"
} = {}) {
  if (!db || !schema || !drizzle || !orgs) throw new Error("test modules not initialized")
  const userId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")
  const ownerMemberId = createDenTypeId("member")
  const memberId = createDenTypeId("member")
  const invitationId = createDenTypeId("invitation")
  const placeholderId = createDenTypeId("member")
  const providerId = `sso-${organizationId}`
  const domain = input.providerDomain ?? "sso-invites.test"
  const email = `member+${userId}@${input.emailDomain ?? "sso-invites.test"}`
  userIds.push(userId)
  organizationIds.push(organizationId)
  await db.insert(schema.AuthUserTable).values({ id: userId, name: "SSO Invite Member", email: email.toUpperCase(), emailVerified: input.emailVerified ?? true })
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "SSO Invite Workspace", slug: providerId, allowedEmailDomains: input.allowedEmailDomains ?? null })
  await orgs.seedDefaultOrganizationRoles(organizationId)
  await db.insert(schema.MemberTable).values({ id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" })
  const protocol = input.protocol ?? "oidc"
  const config = withSsoEmailDomainProof({}, input.emailDomainProof === false ? null : {
    version: 1, organizationId, providerId, domain, method: "dns-txt", verifiedAt: new Date().toISOString(),
  })
  await db.insert(schema.SsoProviderTable).values({
    id: createDenTypeId("ssoProvider"), providerId, organizationId, userId: ownerUserId,
    issuer: "https://idp.sso-invites.test", domain, domainVerified: input.domainVerified ?? true,
    oidcConfig: protocol === "oidc" ? config : null,
    samlConfig: protocol === "saml" ? config : null,
  })
  await db.insert(schema.SsoConnectionTable).values({
    id: createDenTypeId("ssoConnection"), providerId, organizationId, kind: protocol,
    issuer: "https://idp.sso-invites.test", domain, status: input.status ?? "enabled", signInPath: `/sso/${providerId}`,
  })
  if (input.invitation !== "absent") {
    await createInvitation({ invitationId, memberId: placeholderId, organizationId, email, role: "admin", expiresAt: input.invitation === "expired" ? past : future, inviterMemberId: ownerMemberId })
    if (input.invitation === "canceled") {
      await db.update(schema.InvitationTable).set({ status: "canceled" }).where(drizzle.eq(schema.InvitationTable.id, invitationId))
    }
  }
  if (input.membership !== "absent") {
    await db.insert(schema.MemberTable).values({
      id: memberId, organizationId, userId, role: input.memberRole ?? "member", joinedAt: null,
      removedAt: input.membership === "removed" ? past : null,
    })
  }
  return { userId, organizationId, memberId, invitationId, placeholderId, providerId, email }
}

test("successful provider-scoped reconciliation merges JIT once, applies the invited role, and leaves another organization's invite untouched", async () => {
  if (!db || !schema || !orgs || !cache) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture()
  const otherInvitationId = createDenTypeId("invitation")
  const otherPlaceholderId = createDenTypeId("member")
  await createInvitation({
    invitationId: otherInvitationId, memberId: otherPlaceholderId, organizationId: otherOrganizationId,
    email: fixture.email, role: "admin", expiresAt: future, inviterMemberId: otherOwnerMemberId,
  })
  await db.insert(schema.MemberTable).values({ id: createDenTypeId("member"), organizationId: otherOrganizationId, userId: fixture.userId, role: "member" })
  // Warm real read-through caches with the duplicate pending/JIT state and old
  // role. A DB-only assertion would miss the stale /v1/org response regression.
  expect((await cache.org.members(fixture.organizationId)).filter((member) => member.userId === fixture.userId || member.inviteId === fixture.invitationId)).toHaveLength(2)
  expect(await cache.org.membership(fixture)).toMatchObject({ role: "member" })
  await cache.org.members(otherOrganizationId)
  const otherCachedMembers = cachedValues.get(`cache:org:members:${otherOrganizationId}`)

  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(1)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("accepted")
  const members = (await membersForOrganization(fixture.organizationId)).filter((member) => member.userId === fixture.userId || member.inviteId === fixture.invitationId)
  expect(members).toHaveLength(1)
  expect(members[0]).toMatchObject({ id: fixture.memberId, userId: fixture.userId, role: "admin", removedAt: null })
  expect(members[0]?.joinedAt).toBeInstanceOf(Date)
  const visibleMembers = (await cache.org.members(fixture.organizationId)).filter((member) => member.userId === fixture.userId || member.inviteId === fixture.invitationId)
  expect(visibleMembers).toHaveLength(1)
  expect(visibleMembers[0]).toMatchObject({ id: fixture.memberId, role: "admin" })
  expect(visibleMembers[0]?.joinedAt).toBeInstanceOf(Date)
  expect(await cache.org.membership(fixture)).toMatchObject({ id: fixture.memberId, role: "admin" })
  expect(cacheDeleteCalls).toContain(`cache:org:members:${fixture.organizationId}`)
  expect(cacheDeleteCalls).toContain(`cache:org:member:${fixture.organizationId}:${fixture.userId}`)

  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(0)
  await expect(invitationStatus(otherInvitationId)).resolves.toBe("pending")
  expect((await membersForOrganization(otherOrganizationId)).find((member) => member.id === otherPlaceholderId)?.userId).toBeNull()
  expect((await membersForOrganization(otherOrganizationId)).find((member) => member.userId === fixture.userId)?.role).toBe("member")
  expect(cachedValues.get(`cache:org:members:${otherOrganizationId}`)).toBe(otherCachedMembers)
  expect((await membersForOrganization(fixture.organizationId)).filter((member) => member.userId === fixture.userId || member.inviteId === fixture.invitationId)).toHaveLength(1)
})

test("SAML reconciliation uses the same genuine exact-domain proof and preserves the invited role", async () => {
  if (!orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture({ protocol: "saml" })
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(1)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("accepted")
  const members = (await membersForOrganization(fixture.organizationId)).filter((member) => member.userId === fixture.userId || member.inviteId === fixture.invitationId)
  expect(members).toHaveLength(1)
  expect(members[0]?.role).toBe("admin")
})

test("SSO reconciliation cannot borrow another organization's domain proof", async () => {
  if (!db || !schema || !drizzle || !orgs) throw new Error("test modules not initialized")
  const source = await createSsoFixture()
  const target = await createSsoFixture()
  const [provider] = await db.select({ config: schema.SsoProviderTable.oidcConfig }).from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.providerId, source.providerId))
  if (!provider?.config) throw new Error("source proof fixture missing")
  await db.update(schema.SsoProviderTable).set({ oidcConfig: provider.config }).where(drizzle.eq(schema.SsoProviderTable.providerId, target.providerId))
  await expect(orgs.reconcileSsoInvitationsForUser(target)).resolves.toBe(0)
  await expect(invitationStatus(target.invitationId)).resolves.toBe("pending")
  await expect(invitationStatus(source.invitationId)).resolves.toBe("pending")
})

const ssoDenialCases: Array<{ name: string; input: Parameters<typeof createSsoFixture>[0] }> = [
  { name: "unverified email", input: { emailVerified: false } },
  { name: "unverified provider domain", input: { domainVerified: false } },
  { name: "legacy verification flag without genuine domain proof", input: { emailDomainProof: false } },
  { name: "disabled provider", input: { status: "disabled" } },
  { name: "different email domain", input: { emailDomain: "other.test" } },
  { name: "email subdomain is not the provider domain", input: { emailDomain: "sub.sso-invites.test" } },
  { name: "provider wildcard is not an exact domain", input: { providerDomain: "*.sso-invites.test" } },
  { name: "provider domain list is not an exact domain", input: { providerDomain: "sso-invites.test,other.test" } },
  { name: "organization disallows the email domain", input: { allowedEmailDomains: ["other.test"] } },
  { name: "no JIT membership", input: { membership: "absent" } },
  { name: "removed membership", input: { membership: "removed" } },
]

test.each(ssoDenialCases)("provider-scoped reconciliation fails closed: $name", async ({ input }) => {
  if (!db || !schema || !drizzle || !orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture(input)
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(0)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("pending")
  const members = await membersForOrganization(fixture.organizationId)
  expect(members.find((member) => member.id === fixture.placeholderId)?.userId).toBeNull()
  const joined = members.filter((member) => member.userId === fixture.userId && !member.removedAt)
  expect(joined).toHaveLength(input?.membership === "absent" || input?.membership === "removed" ? 0 : 1)
  if (joined[0]) expect(joined[0].role).toBe("member")
  const [user] = await db.select({ emailVerified: schema.AuthUserTable.emailVerified }).from(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, fixture.userId))
  expect(user?.emailVerified).toBe(input?.emailVerified ?? true)
  expect(cacheDeleteCalls).toEqual([])
})

test.each(["missing provider", "missing connection", "different provider ID", "different organization", "unknown callback provider"])("provider-scoped reconciliation requires the connection and provider to be bound: %s", async (scenario) => {
  if (!db || !schema || !drizzle || !orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture()
  if (scenario === "missing provider") {
    await db.delete(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.providerId, fixture.providerId))
  } else if (scenario === "missing connection") {
    await db.delete(schema.SsoConnectionTable).where(drizzle.eq(schema.SsoConnectionTable.providerId, fixture.providerId))
  } else if (scenario === "different provider ID") {
    await db.update(schema.SsoProviderTable).set({ providerId: `different-${fixture.providerId}` }).where(drizzle.eq(schema.SsoProviderTable.providerId, fixture.providerId))
  } else if (scenario === "different organization") {
    await db.update(schema.SsoProviderTable).set({ organizationId: otherOrganizationId }).where(drizzle.eq(schema.SsoProviderTable.providerId, fixture.providerId))
  }
  await expect(orgs.reconcileSsoInvitationsForUser({ userId: fixture.userId, providerId: scenario === "unknown callback provider" ? "unknown-provider" : fixture.providerId })).resolves.toBe(0)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("pending")
  expect((await membersForOrganization(fixture.organizationId)).find((member) => member.id === fixture.placeholderId)?.userId).toBeNull()
  expect(cacheDeleteCalls).toEqual([])
})

test("SSO reconciliation reads current email proof from the database and never upgrades it from an invitation", async () => {
  if (!db || !schema || !drizzle || !orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture({ emailVerified: false, allowedEmailDomains: ["sso-invites.test"] })
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(0)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("pending")
  await db.update(schema.AuthUserTable).set({ emailVerified: true }).where(drizzle.eq(schema.AuthUserTable.id, fixture.userId))
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(1)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("accepted")
})

test("successful JIT without an invitation refreshes the cached member list and membership immediately", async () => {
  if (!db || !schema || !orgs || !cache) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture({ invitation: "absent", membership: "absent" })
  expect((await cache.org.members(fixture.organizationId)).some((member) => member.userId === fixture.userId)).toBe(false)
  await expect(cache.org.membership(fixture)).resolves.toBeNull()
  await db.insert(schema.MemberTable).values({ id: fixture.memberId, organizationId: fixture.organizationId, userId: fixture.userId, role: "member" })
  // Raw SDK JIT does not invalidate the previously loaded list.
  expect((await cache.org.members(fixture.organizationId)).some((member) => member.userId === fixture.userId)).toBe(false)
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(0)
  expect(cacheDeleteCalls).toContain(`cache:org:members:${fixture.organizationId}`)
  expect(cacheDeleteCalls).toContain(`cache:org:member:${fixture.organizationId}:${fixture.userId}`)
  expect((await cache.org.members(fixture.organizationId)).find((member) => member.userId === fixture.userId)).toMatchObject({ id: fixture.memberId, role: "member" })
  await expect(cache.org.membership(fixture)).resolves.toMatchObject({ id: fixture.memberId, role: "member" })
})

test.each(["expired", "canceled"])("SSO reconciliation preserves %s invitations", async (status) => {
  if (!orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture({ invitation: status === "expired" ? "expired" : "canceled" })
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(0)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe(status === "expired" ? "pending" : "canceled")
  expect((await membersForOrganization(fixture.organizationId)).find((member) => member.userId === fixture.userId)?.role).toBe("member")
  expect((await membersForOrganization(fixture.organizationId)).find((member) => member.id === fixture.placeholderId)?.userId).toBeNull()
})

test("SSO reconciliation preserves owner authority while removing the duplicate placeholder", async () => {
  if (!orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture({ memberRole: "owner" })
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(1)
  const members = (await membersForOrganization(fixture.organizationId)).filter((member) => member.userId === fixture.userId || member.inviteId === fixture.invitationId)
  expect(members).toHaveLength(1)
  expect(members[0]).toMatchObject({ id: fixture.memberId, role: "owner" })
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("accepted")
})

test("SSO reconciliation cannot accept an invitation for a SCIM-deprovisioned email", async () => {
  if (!db || !schema || !orgs) throw new Error("test modules not initialized")
  const fixture = await createSsoFixture()
  await db.insert(schema.ScimProviderTable).values({ id: createDenTypeId("scimProvider"), organizationId: fixture.organizationId, providerId: fixture.providerId, scimToken: "test-scim-token", userId: ownerUserId })
  await db.insert(schema.ScimUserTombstoneTable).values({ id: createDenTypeId("scimUserTombstone"), organizationId: fixture.organizationId, providerId: fixture.providerId, deprovisionedUserId: fixture.userId, email: fixture.email })
  await expect(orgs.reconcileSsoInvitationsForUser(fixture)).resolves.toBe(0)
  await expect(invitationStatus(fixture.invitationId)).resolves.toBe("pending")
  expect((await membersForOrganization(fixture.organizationId)).find((member) => member.userId === fixture.userId)?.role).toBe("member")
  expect((await membersForOrganization(fixture.organizationId)).find((member) => member.id === fixture.placeholderId)?.userId).toBeNull()
})
