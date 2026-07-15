import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"
}

const organizationId = createDenTypeId("organization")
const ownerUserId = createDenTypeId("user")
const verifiedUserId = createDenTypeId("user")
const unverifiedUserId = createDenTypeId("user")
const subdomainUserId = createDenTypeId("user")
const teamId = createDenTypeId("team")

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let admission: typeof import("../src/organization-admission.js")
let envModule: typeof import("../src/env.js")

async function cleanup() {
  const orgId = normalizeDenTypeId("org", organizationId)
  await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, orgId))
  await db.delete(schema.WorkspaceClaimTable).where(drizzle.eq(schema.WorkspaceClaimTable.organizationId, organizationId))
  await db.delete(schema.WorkspaceBootstrapTable).where(drizzle.eq(schema.WorkspaceBootstrapTable.organizationId, organizationId))
  await db.delete(schema.SsoConnectionTable).where(drizzle.eq(schema.SsoConnectionTable.organizationId, organizationId))
  await db.delete(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.organizationId, organizationId))
  await db.delete(schema.ScimProviderTable).where(drizzle.eq(schema.ScimProviderTable.organizationId, organizationId))
  await db.delete(schema.TeamMemberTable).where(drizzle.eq(schema.TeamMemberTable.teamId, teamId))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.organizationId, organizationId))
  await db.delete(schema.OrganizationAdmissionPolicyTable).where(drizzle.eq(schema.OrganizationAdmissionPolicyTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, verifiedUserId, unverifiedUserId, subdomainUserId]))
}

async function setPolicy(input: {
  methods: Array<"self_join" | "invitation" | "sso_jit" | "scim">
  domainMode?: "any" | "allowlist"
  domains?: string[]
  authenticationRequirement?: "any" | "organization_sso"
  lifecycleAuthority?: "local" | "scim"
}) {
  await db
    .update(schema.OrganizationAdmissionPolicyTable)
    .set({
      version: 2,
      admissionMethods: input.methods,
      emailDomainMode: input.domainMode ?? "any",
      allowedEmailDomains: input.domains ?? [],
      authenticationRequirement: input.authenticationRequirement ?? "any",
      lifecycleAuthority: input.lifecycleAuthority ?? "local",
    })
    .where(drizzle.eq(schema.OrganizationAdmissionPolicyTable.organizationId, organizationId))
}

async function createInvitation(input: { token: string; email?: string; status?: string; expiresAt?: Date; role?: string; teamId?: typeof teamId }) {
  const id = createDenTypeId("invitation")
  await db.insert(schema.InvitationTable).values({
    id,
    organizationId,
    email: input.email ?? "member@example.com",
    role: input.role ?? "member",
    status: input.status ?? "pending",
    inviterId: ownerUserId,
    teamId: input.teamId ?? null,
    inviteTokenHash: admission.hashOrganizationInvitationToken(input.token),
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
  })
  await db.insert(schema.MemberTable).values({
    id: createDenTypeId("member"),
    organizationId,
    userId: null,
    inviteId: id,
    role: input.role ?? "member",
  })
  return id
}

beforeAll(async () => {
  seedRequiredEnv()
  ;[{ db }, schema, drizzle, admission, envModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/organization-admission.js"),
    import("../src/env.js"),
  ])
  await cleanup()
  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "Owner", email: "owner@example.com", emailVerified: true },
    { id: verifiedUserId, name: "Member", email: "member@example.com", emailVerified: true },
    { id: unverifiedUserId, name: "Unverified", email: "new@example.com", emailVerified: false },
    { id: subdomainUserId, name: "Subdomain", email: "person@sub.example.com", emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "Admission Test", slug: `admission-${organizationId}` })
  await db.insert(schema.OrganizationAdmissionPolicyTable).values({
    organizationId,
    version: 1,
    admissionMethods: ["self_join", "invitation"],
    emailDomainMode: "any",
    allowedEmailDomains: [],
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  })
  await db.insert(schema.OrganizationRoleTable).values([
    { id: createDenTypeId("organizationRole"), organizationId, role: "owner", permission: {} },
    { id: createDenTypeId("organizationRole"), organizationId, role: "admin", permission: {} },
    { id: createDenTypeId("organizationRole"), organizationId, role: "member", permission: {} },
  ])
  await db.insert(schema.MemberTable).values({ id: createDenTypeId("member"), organizationId, userId: ownerUserId, role: "owner", admissionSource: "legacy", admissionPolicyVersion: 1 })
})

beforeEach(async () => {
  await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, normalizeDenTypeId("org", organizationId)))
  await db.delete(schema.WorkspaceClaimTable).where(drizzle.eq(schema.WorkspaceClaimTable.organizationId, organizationId))
  await db.delete(schema.WorkspaceBootstrapTable).where(drizzle.eq(schema.WorkspaceBootstrapTable.organizationId, organizationId))
  await db.delete(schema.SsoConnectionTable).where(drizzle.eq(schema.SsoConnectionTable.organizationId, organizationId))
  await db.delete(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.organizationId, organizationId))
  await db.delete(schema.ScimProviderTable).where(drizzle.eq(schema.ScimProviderTable.organizationId, organizationId))
  await db.delete(schema.TeamMemberTable).where(drizzle.eq(schema.TeamMemberTable.teamId, teamId))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.organizationId, organizationId))
  await db
    .update(schema.OrganizationTable)
    .set({ metadata: { limits: { members: 5, workers: 20 } } })
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.insert(schema.MemberTable).values({ id: createDenTypeId("member"), organizationId, userId: ownerUserId, role: "owner", admissionSource: "legacy", admissionPolicyVersion: 1 })
  await setPolicy({ methods: ["self_join", "invitation"] })
})

afterAll(cleanup)

test("open self-join is explicit and records membership provenance", async () => {
  const evaluated = await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } })
  expect(evaluated).toMatchObject({ decision: "allow", source: "self_join", existing: false })
  const before = await db.select().from(schema.MemberTable).where(drizzle.eq(schema.MemberTable.userId, verifiedUserId))
  expect(before).toHaveLength(0)
  const committed = await admission.admitOrganizationMember({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } })
  expect(committed).toMatchObject({ decision: "allow", source: "self_join", existing: false })
  const after = await db.select().from(schema.MemberTable).where(drizzle.eq(schema.MemberTable.userId, verifiedUserId))
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ admissionSource: "self_join", admissionPolicyVersion: 2 })
})

test("organization creation commits the policy and verified initial owner together", async () => {
  const createdOrganizationId = createDenTypeId("organization")
  const deniedOrganizationId = createDenTypeId("organization")
  try {
    const created = await admission.createOrganizationWithInitialOwner({
      organizationId: createdOrganizationId,
      userId: verifiedUserId,
      name: "Atomic Organization",
      slug: createdOrganizationId,
      logo: null,
      metadata: {},
    })
    expect(normalizeDenTypeId("member", created.memberId)).toBe(created.memberId)
    expect(await admission.getOrganizationAdmissionPolicy(createdOrganizationId)).toMatchObject({ version: 1, admissionMethods: ["invitation"] })
    const [owner] = await db.select().from(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, created.memberId)).limit(1)
    expect(owner).toMatchObject({ role: "owner", admissionSource: "initial_owner", admissionPolicyVersion: 1 })

    await expect(admission.createOrganizationWithInitialOwner({
      organizationId: deniedOrganizationId,
      userId: unverifiedUserId,
      name: "Denied Organization",
      slug: deniedOrganizationId,
      logo: null,
      metadata: {},
    })).rejects.toThrow("organization_admission_state_changed")
    expect(await db.select().from(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, deniedOrganizationId))).toHaveLength(0)
  } finally {
    await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, normalizeDenTypeId("org", createdOrganizationId)))
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, createdOrganizationId))
    await db.delete(schema.OrganizationAdmissionPolicyTable).where(drizzle.eq(schema.OrganizationAdmissionPolicyTable.organizationId, createdOrganizationId))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, createdOrganizationId))
  }
})

test("concurrent admission commits one membership and one allow audit", async () => {
  const attempts = await Promise.all([
    admission.admitOrganizationMember({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } }),
    admission.admitOrganizationMember({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } }),
  ])
  expect(attempts.filter((decision) => decision.decision === "allow" && !decision.existing)).toHaveLength(1)
  expect(attempts.filter((decision) => decision.decision === "allow" && decision.existing)).toHaveLength(1)

  const members = await db
    .select({ id: schema.MemberTable.id })
    .from(schema.MemberTable)
    .where(drizzle.and(
      drizzle.eq(schema.MemberTable.organizationId, organizationId),
      drizzle.eq(schema.MemberTable.userId, verifiedUserId),
    ))
  expect(members).toHaveLength(1)

  const allowAudits = await db
    .select({ id: schema.AuditEventTable.id })
    .from(schema.AuditEventTable)
    .where(drizzle.and(
      drizzle.eq(schema.AuditEventTable.org_id, normalizeDenTypeId("org", organizationId)),
      drizzle.eq(schema.AuditEventTable.actor_user_id, verifiedUserId),
      drizzle.eq(schema.AuditEventTable.action, "organization.admission.allowed"),
    ))
  expect(allowAudits).toHaveLength(1)
})

test("email admission requires verification and exact normalized domains", async () => {
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: unverifiedUserId, evidence: { kind: "self_join" } })).toEqual({ decision: "require_email_verification" })
  await setPolicy({ methods: ["self_join"], domainMode: "allowlist", domains: ["example.com"] })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: subdomainUserId, evidence: { kind: "self_join" } })).toEqual({ decision: "deny", reason: "domain_not_allowed" })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } })).toMatchObject({ decision: "allow" })
})

test("invite-only cannot be bypassed by self-join", async () => {
  await setPolicy({ methods: ["invitation"] })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } })).toEqual({ decision: "require_invitation" })
})

test("invitations are exact-email, one-use, expiring, cancelable, and rotatable", async () => {
  await setPolicy({ methods: ["invitation"] })
  await createInvitation({ token: "correct-token-000000", email: "other@example.com" })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "correct-token-000000" } })).toEqual({ decision: "deny", reason: "invitation_invalid" })
  await createInvitation({ token: "expired-token-000000", expiresAt: new Date(Date.now() - 1) })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "expired-token-000000" } })).toEqual({ decision: "deny", reason: "invitation_invalid" })
  await createInvitation({ token: "canceled-token-0000", status: "canceled" })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "canceled-token-0000" } })).toEqual({ decision: "deny", reason: "invitation_invalid" })
  await db.insert(schema.TeamTable).values({ id: teamId, organizationId, name: "Invited team" })
  const rotatedId = await createInvitation({ token: "old-rotated-token-00", teamId })
  await db.update(schema.InvitationTable).set({ inviteTokenHash: admission.hashOrganizationInvitationToken("new-rotated-token-00") }).where(drizzle.eq(schema.InvitationTable.id, rotatedId))
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "old-rotated-token-00" } })).toEqual({ decision: "deny", reason: "invitation_invalid" })
  const decision = await admission.admitOrganizationMember({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "new-rotated-token-00" } })
  expect(decision).toMatchObject({ decision: "allow", source: "invitation" })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "new-rotated-token-00" } })).toMatchObject({ decision: "allow", existing: true })
  const invitation = await db.select().from(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.id, rotatedId)).limit(1)
  expect(invitation[0]).toMatchObject({ status: "accepted", inviteTokenHash: null })
  const teamMemberships = await db
    .select({ orgMembershipId: schema.TeamMemberTable.orgMembershipId })
    .from(schema.TeamMemberTable)
    .where(drizzle.eq(schema.TeamMemberTable.teamId, teamId))
  expect(teamMemberships).toEqual([{ orgMembershipId: decision.decision === "allow" ? decision.membershipId : null }])
  const auditPayloads = JSON.stringify((await db
    .select({ payload: schema.AuditEventTable.payload })
    .from(schema.AuditEventTable)
    .where(drizzle.eq(schema.AuditEventTable.org_id, normalizeDenTypeId("org", organizationId))))
    .map((event) => event.payload))
  expect(auditPayloads).not.toContain("member@example.com")
  expect(auditPayloads).not.toContain("new-rotated-token-00")
})

test("external admission cannot grant owner and administrative removal is sticky", async () => {
  await setPolicy({ methods: ["invitation"] })
  const ownerInviteId = await createInvitation({ token: "owner-token-0000000", role: "owner" })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "owner-token-0000000" } })).toEqual({ decision: "deny", reason: "owner_role_forbidden" })
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.inviteId, ownerInviteId))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.id, ownerInviteId))

  await db.insert(schema.MemberTable).values({
    id: createDenTypeId("member"),
    organizationId,
    userId: verifiedUserId,
    role: "member",
    removedAt: new Date(),
    removalSource: "admin",
  })
  expect(await admission.evaluateOrganizationAdmission({ organizationId, userId: verifiedUserId, evidence: { kind: "self_join" } })).toEqual({ decision: "deny", reason: "membership_removed" })

  const restoreInviteId = await createInvitation({ token: "restore-token-00000" })
  const restored = await admission.admitOrganizationMember({ organizationId, userId: verifiedUserId, evidence: { kind: "invitation", token: "restore-token-00000" } })
  expect(restored).toMatchObject({ decision: "allow", source: "invitation" })
  const subjectMemberships = await db.select().from(schema.MemberTable).where(drizzle.and(
    drizzle.eq(schema.MemberTable.organizationId, organizationId),
    drizzle.eq(schema.MemberTable.userId, verifiedUserId),
  ))
  expect(subjectMemberships).toHaveLength(1)
  expect(subjectMemberships[0]?.removedAt).toBeNull()
  const placeholders = await db.select().from(schema.MemberTable).where(drizzle.eq(schema.MemberTable.inviteId, restoreInviteId))
  expect(placeholders).toHaveLength(0)
})

test("administrative restoration requires a trusted active admin membership", async () => {
  await db.insert(schema.MemberTable).values({
    id: createDenTypeId("member"),
    organizationId,
    userId: verifiedUserId,
    role: "member",
    removedAt: new Date(),
    removalSource: "admin",
  })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "admin_restore", role: "member", actorMemberId: createDenTypeId("member") },
  })).toEqual({ decision: "deny", reason: "identity_conflict" })
  const [owner] = await db.select().from(schema.MemberTable).where(drizzle.eq(schema.MemberTable.userId, ownerUserId)).limit(1)
  const restored = await admission.admitOrganizationMember({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "admin_restore", role: "member", actorMemberId: owner!.id },
  })
  expect(restored).toMatchObject({ decision: "allow", source: "admin_restore" })
})

test("workspace claims atomically admit once and retire sibling claim links", async () => {
  await setPolicy({ methods: ["invitation"] })
  const setupMemberId = createDenTypeId("member")
  const bootstrapId = createDenTypeId("workspaceBootstrap")
  const ownerClaimId = createDenTypeId("workspaceClaim")
  const siblingClaimId = createDenTypeId("workspaceClaim")
  const expiresAt = new Date(Date.now() + 60_000)
  await db.insert(schema.MemberTable).values({ id: setupMemberId, organizationId, userId: null, role: "owner" })
  await db.insert(schema.WorkspaceBootstrapTable).values({
    id: bootstrapId,
    organizationId,
    setupMemberId,
    status: "provisional",
    expiresAt,
  })
  await db.insert(schema.WorkspaceClaimTable).values([
    {
      id: ownerClaimId,
      bootstrapId,
      organizationId,
      tokenHash: admission.hashOrganizationInvitationToken("workspace-owner-token"),
      role: "owner",
      status: "pending",
      expiresAt,
    },
    {
      id: siblingClaimId,
      bootstrapId,
      organizationId,
      tokenHash: admission.hashOrganizationInvitationToken("workspace-member-token"),
      role: "member",
      status: "pending",
      expiresAt,
    },
  ])

  const decision = await admission.admitOrganizationMember({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "workspace_claim", token: "workspace-owner-token" },
  })
  expect(decision).toMatchObject({ decision: "allow", role: "owner", source: "workspace_claim", existing: false })
  const [setupMember] = await db.select().from(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, setupMemberId)).limit(1)
  expect(setupMember).toMatchObject({ removalSource: "system" })
  expect(setupMember?.removedAt).toBeInstanceOf(Date)
  const claims = await db.select().from(schema.WorkspaceClaimTable).where(drizzle.eq(schema.WorkspaceClaimTable.bootstrapId, bootstrapId))
  expect(claims.find((claim) => claim.id === ownerClaimId)).toMatchObject({ status: "claimed", claimedByUserId: verifiedUserId })
  expect(claims.find((claim) => claim.id === siblingClaimId)).toMatchObject({ status: "canceled" })
  const [bootstrap] = await db.select().from(schema.WorkspaceBootstrapTable).where(drizzle.eq(schema.WorkspaceBootstrapTable.id, bootstrapId)).limit(1)
  expect(bootstrap).toMatchObject({ status: "claimed" })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "workspace_claim", token: "workspace-member-token" },
  })).toEqual({ decision: "deny", reason: "identity_conflict" })
})

test("organization SSO requires the exact provider assurance without consuming an invitation", async () => {
  const providerId = `sso-${crypto.randomUUID()}`
  await db.insert(schema.SsoProviderTable).values({
    id: createDenTypeId("ssoProvider"),
    issuer: "https://idp.example.test",
    domain: "example.com",
    userId: ownerUserId,
    providerId,
    organizationId,
    domainVerified: true,
  })
  await db.insert(schema.SsoConnectionTable).values({
    id: createDenTypeId("ssoConnection"),
    organizationId,
    providerId,
    kind: "oidc",
    issuer: "https://idp.example.test",
    domain: "example.com",
    status: "enabled",
    signInPath: `/api/auth/sso/sign-in/${providerId}`,
  })
  await setPolicy({ methods: ["invitation", "sso_jit"], authenticationRequirement: "organization_sso" })
  const invitationId = await createInvitation({ token: "sso-invite-token-000", role: "admin" })

  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "invitation", token: "sso-invite-token-000" },
    assurance: { organizationId: null, providerId: null },
  })).toMatchObject({ decision: "require_sso" })
  expect((await db.select({ status: schema.InvitationTable.status }).from(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.id, invitationId)).limit(1))[0]?.status).toBe("pending")

  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "invitation", token: "sso-invite-token-000" },
    assurance: { organizationId, providerId: "wrong-provider" },
  })).toMatchObject({ decision: "require_sso" })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "invitation", token: "sso-invite-token-000" },
    assurance: { organizationId, providerId },
  })).toMatchObject({ decision: "allow", role: "admin", source: "invitation" })

  await createInvitation({ token: "sso-authoritative-000", email: "new@example.com" })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "sso", providerId },
    assurance: { organizationId, providerId },
  })).toMatchObject({ decision: "allow", source: "invitation" })

  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "sso", providerId: "wrong-provider" },
  })).toEqual({ decision: "deny", reason: "provider_mismatch" })

  await db.delete(schema.SsoConnectionTable).where(drizzle.eq(schema.SsoConnectionTable.organizationId, organizationId))
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "self_join" },
  })).toEqual({ decision: "deny", reason: "policy_unavailable" })
})

test("SCIM evidence is authoritative but reactivation requires SCIM lifecycle authority", async () => {
  const providerId = `scim-${crypto.randomUUID()}`
  await db.insert(schema.ScimProviderTable).values({
    id: createDenTypeId("scimProvider"),
    providerId,
    scimToken: "hashed-test-token",
    organizationId,
  })
  await setPolicy({ methods: ["scim"], lifecycleAuthority: "scim" })

  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "scim", providerId, active: false },
  })).toEqual({ decision: "deny", reason: "provider_mismatch" })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "scim", providerId, active: true },
  })).toMatchObject({ decision: "allow", source: "scim" })

  await db.insert(schema.MemberTable).values({
    id: createDenTypeId("member"),
    organizationId,
    userId: unverifiedUserId,
    role: "member",
    removedAt: new Date(),
    removalSource: "scim",
  })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "scim", providerId, active: true },
  })).toMatchObject({ decision: "allow", source: "scim" })

  await setPolicy({ methods: ["scim"], lifecycleAuthority: "local" })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "scim", providerId, active: true },
  })).toEqual({ decision: "deny", reason: "membership_removed" })
})

test("existing active memberships remain available when a policy dependency is unavailable", async () => {
  await setPolicy({ methods: ["sso_jit"], authenticationRequirement: "organization_sso" })
  await db.insert(schema.MemberTable).values({
    id: createDenTypeId("member"),
    organizationId,
    userId: verifiedUserId,
    role: "member",
    admissionSource: "legacy",
    admissionPolicyVersion: 1,
  })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "self_join" },
  })).toMatchObject({ decision: "allow", existing: true })
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: unverifiedUserId,
    evidence: { kind: "sso", providerId: "missing-provider" },
  })).toEqual({ decision: "deny", reason: "policy_unavailable" })
})

test("seat exhaustion and missing policy fail closed for new membership", async () => {
  await setPolicy({ methods: ["self_join"] })
  await db.insert(schema.MemberTable).values(Array.from({ length: 4 }, () => ({
    id: createDenTypeId("member"),
    organizationId,
    userId: createDenTypeId("user"),
    role: "member",
    admissionSource: "legacy" as const,
    admissionPolicyVersion: 1,
  })))
  const originalStripe = { ...envModule.env.stripe }
  Object.assign(envModule.env.stripe, { secretKey: "sk_test_admission", seatPriceId: "price_admission" })
  try {
    expect(await admission.evaluateOrganizationAdmission({
      organizationId,
      userId: verifiedUserId,
      evidence: { kind: "self_join" },
    })).toEqual({ decision: "deny", reason: "seat_limit_reached" })
  } finally {
    Object.assign(envModule.env.stripe, originalStripe)
  }

  await db
    .update(schema.OrganizationAdmissionPolicyTable)
    .set({ admissionMethods: [] })
    .where(drizzle.eq(schema.OrganizationAdmissionPolicyTable.organizationId, organizationId))
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "self_join" },
  })).toEqual({ decision: "deny", reason: "policy_unavailable" })

  await db
    .delete(schema.OrganizationAdmissionPolicyTable)
    .where(drizzle.eq(schema.OrganizationAdmissionPolicyTable.organizationId, organizationId))
  expect(await admission.evaluateOrganizationAdmission({
    organizationId,
    userId: verifiedUserId,
    evidence: { kind: "self_join" },
  })).toEqual({ decision: "deny", reason: "policy_unavailable" })
  await db.insert(schema.OrganizationAdmissionPolicyTable).values({
    organizationId,
    version: 1,
    admissionMethods: ["self_join", "invitation"],
    emailDomainMode: "any",
    allowedEmailDomains: [],
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  })
})
