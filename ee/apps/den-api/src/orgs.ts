import { and, asc, count, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AuthUserTable,
  ConnectedAccountTable,
  InvitationTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  SsoConnectionTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { revokeOrganizationApiKeysForMember } from "./api-keys.js"
import { revokeMembershipSessionCredentials } from "./credential-revocation.js"
import { db } from "./db.js"
import { env } from "./env.js"
import {
  getRoleValueAfterOwnershipTransfer,
  roleIncludesPrivileged,
  roleIncludesOwner as guardRoleIncludesOwner,
  validateOrganizationMemberRemoval,
  validateOrganizationMemberRoleChange,
  type MemberLifecycleValidation,
} from "./organization-member-guards.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import {
  DEFAULT_ORGANIZATION_LIMITS,
  normalizeOrganizationMetadata,
  serializeOrganizationMetadata,
  type ManagedBrandAssetMetadata,
} from "./organization-limits.js"
import {
  denDefaultDynamicOrganizationRoles,
  denOrganizationStaticRoles,
  filterOrganizationPermissionRecord,
  type OrganizationPermissionRecord,
} from "./organization-access.js"
import { ensureDefaultDesktopPolicyForOrganization } from "./desktop-policies.js"
import { isSingleOrgOwnerEmailEligible } from "./single-org-policy.js"
import {
  admitOrganizationMember,
  createOrganizationWithInitialOwner,
  ensureOrganizationAdmissionPolicy,
  hashOrganizationInvitationToken,
  normalizeAdmissionDomain,
  normalizeAdmissionEmail,
} from "./organization-admission.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type SessionId = typeof AuthSessionTable.$inferSelect.id
type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberRow = typeof MemberTable.$inferSelect
type MemberId = MemberRow["id"]
type InvitationRow = typeof InvitationTable.$inferSelect
export type AllowedEmailDomains = string[] | null

type MemberLifecycleValidationFailure = Extract<MemberLifecycleValidation, { ok: false }>

type MemberMutationFailure = {
  ok: false
  error: "member_not_found" | MemberLifecycleValidationFailure["error"]
  message: string
}

type MemberMutationResult = {
  ok: true
  member: MemberRow
} | MemberMutationFailure

type OwnershipTransferFailure = {
  ok: false
  error: "owner_not_found" | "target_member_not_found" | "owner_transfer_invalid"
  message: string
}

type OwnershipTransferResult = {
  ok: true
  previousOwner: MemberRow
  newOwner: MemberRow
  previousOwnerRole: string
  newOwnerRole: string
} | OwnershipTransferFailure

type OwnershipRecoveryResult = {
  ok: true
  previousOwnerCount: number
  newOwner: MemberRow
  newOwnerRole: string
} | OwnershipTransferFailure

export type InvitationStatus = "pending" | "accepted" | "canceled" | "expired"

export type InvitationPreview = {
  invitation: {
    id: string
    email: string
    role: string
    status: InvitationStatus
    expiresAt: Date
    createdAt: Date
  }
  organization: {
    id: OrgId
    name: string
    slug: string
    allowedEmailDomains: AllowedEmailDomains
  }
}

export type UserOrgSummary = {
  id: OrgId
  name: string
  slug: string
  logo: string | null
  metadata: string | null
  role: string
  orgMemberId: string
  membershipId: string
  memberCount: number
  createdAt: Date
  updatedAt: Date
}

export type OrganizationContext = {
  organization: {
    id: OrgId
    name: string
    slug: string
    logo: string | null
    allowedEmailDomains: AllowedEmailDomains
    metadata: string | null
    createdAt: Date
    updatedAt: Date
  }
  currentMember: {
    id: MemberId
    userId: UserId
    role: string
    createdAt: Date
    joinedAt: Date | null
    admissionSource: MemberRow["admissionSource"]
    admissionPolicyVersion: number | null
    admittedAt: Date | null
    isOwner: boolean
  }
  members: Array<{
    id: MemberId
    userId: UserId | null
    inviteId: InvitationRow["id"] | null
    role: string
    createdAt: Date
    joinedAt: Date | null
    admissionSource: MemberRow["admissionSource"]
    admissionPolicyVersion: number | null
    admittedAt: Date | null
    isOwner: boolean
    user: {
      id: UserId | MemberId
      email: string
      name: string
      image: string | null
    }
  }>
  invitations: Array<{
    id: string
    email: string
    role: string
    status: string
    expiresAt: Date
    createdAt: Date
  }>
  roles: Array<{
    id: string
    role: string
    permission: OrganizationPermissionRecord
    builtIn: boolean
    protected: boolean
    createdAt: Date | null
    updatedAt: Date | null
  }>
  teams: Array<{
    id: typeof TeamTable.$inferSelect.id
    name: string
    createdAt: Date
    updatedAt: Date
    memberIds: MemberId[]
  }>
}

export type MemberTeamSummary = {
  id: typeof TeamTable.$inferSelect.id
  name: string
  organizationId: typeof TeamTable.$inferSelect.organizationId
  createdAt: Date
  updatedAt: Date
}

function splitRoles(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function roleIncludesOwner(roleValue: string) {
  return guardRoleIncludesOwner(roleValue)
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function buildPersonalOrgName(input: {
  name?: string | null
  email?: string | null
}) {
  const normalizedName = input.name?.trim()
  if (normalizedName) {
    return `${normalizedName}'s Org`
  }

  const localPart = input.email?.split("@")[0] ?? "Personal"
  const normalized = titleCase(localPart.replace(/[._-]+/g, " ").trim()) || "Personal"
  const suffix = normalized.endsWith("s") ? "' Org" : "'s Org"
  return `${normalized}${suffix}`
}

function normalizeEmailDomainValue(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^@+/, "")
  if (!normalized) {
    return null
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    return null
  }

  return normalized
}

export function normalizeAllowedEmailDomains(input: readonly string[] | null | undefined): {
  domains: AllowedEmailDomains
  invalidDomains: string[]
} {
  if (!input || input.length === 0) {
    return {
      domains: null,
      invalidDomains: [],
    }
  }

  const normalized = new Set<string>()
  const invalidDomains: string[] = []

  for (const value of input) {
    const nextDomain = normalizeEmailDomainValue(value)
    if (!nextDomain) {
      invalidDomains.push(value)
      continue
    }
    normalized.add(nextDomain)
  }

  return {
    domains: normalized.size > 0 ? [...normalized].sort() : null,
    invalidDomains,
  }
}

function getEmailDomain(email: string) {
  const normalized = email.trim().toLowerCase()
  const atIndex = normalized.lastIndexOf("@")
  if (atIndex === -1 || atIndex + 1 >= normalized.length) {
    return null
  }
  return normalizeAdmissionDomain(normalized.slice(atIndex + 1))
}

function getEmailLocalPart(email: string) {
  const atIndex = email.indexOf("@")
  return atIndex > 0 ? email.slice(0, atIndex) : email
}

function getEmailDomainName(email: string) {
  const domain = getEmailDomain(email)
  return domain?.split(".")[0] ?? "invited"
}

function getInvitedMemberName(email: string) {
  return `${getEmailLocalPart(email)} ${getEmailDomainName(email)}`.trim()
}

export function isEmailAllowedForOrganization(allowedEmailDomains: readonly string[] | null | undefined, email: string) {
  if (!allowedEmailDomains || allowedEmailDomains.length === 0) {
    return true
  }

  const emailDomain = getEmailDomain(email)
  if (!emailDomain) {
    return false
  }

  return allowedEmailDomains.includes(emailDomain)
}

function normalizeStoredAllowedEmailDomains(value: unknown): AllowedEmailDomains {
  const values = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null
  return normalizeAllowedEmailDomains(values).domains
}

export function parsePermissionRecord(value: string | null) {
  if (!value) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(value)
    const permission: OrganizationPermissionRecord = {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return permission
    }

    for (const [resource, actions] of Object.entries(parsed)) {
      if (!Array.isArray(actions)) {
        continue
      }
      permission[resource] = actions.filter((entry): entry is string => typeof entry === "string")
    }

    return filterOrganizationPermissionRecord(permission)
  } catch {
    return {}
  }
}

export function serializePermissionRecord(value: OrganizationPermissionRecord) {
  return JSON.stringify(value)
}

export class OrganizationEmailDomainRestrictionError extends Error {
  readonly emailDomain: string | null
  readonly allowedEmailDomains: string[]

  constructor(email: string, allowedEmailDomains: string[]) {
    const emailDomain = getEmailDomain(email)
    super(
      allowedEmailDomains.length === 1
        ? `This workspace only allows ${allowedEmailDomains[0]} email addresses.`
        : `This workspace only allows email addresses from these domains: ${allowedEmailDomains.join(", ")}.`,
    )
    this.name = "OrganizationEmailDomainRestrictionError"
    this.emailDomain = emailDomain
    this.allowedEmailDomains = allowedEmailDomains
  }
}

export class OrganizationEmailVerificationRequiredError extends Error {
  constructor() {
    super("Verify the account email before creating an organization.")
    this.name = "OrganizationEmailVerificationRequiredError"
  }
}

function clonePermissionRecord(value: Record<string, readonly string[]>) {
  const permission: OrganizationPermissionRecord = {}
  for (const [resource, actions] of Object.entries(value)) {
    permission[resource] = [...actions]
  }
  return permission
}

async function listMembershipRows(userId: UserId) {
  return db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
    .orderBy(asc(MemberTable.createdAt))
}

function getInvitationStatus(invitation: Pick<InvitationRow, "status" | "expiresAt">): InvitationStatus {
  if (invitation.status !== "pending") {
    return invitation.status as Exclude<InvitationStatus, "expired">
  }

  return invitation.expiresAt > new Date() ? "pending" : "expired"
}

async function getInvitationById(invitationIdRaw: string) {
  const tokenRows = await db
    .select()
    .from(InvitationTable)
    .where(eq(InvitationTable.inviteTokenHash, hashOrganizationInvitationToken(invitationIdRaw)))
    .limit(1)

  if (tokenRows[0]) {
    return tokenRows[0]
  }
  return null
}

async function ensureDefaultDynamicRoles(orgId: OrgId) {
  for (const [role, permission] of Object.entries(denDefaultDynamicOrganizationRoles)) {
    const serializedPermission = serializePermissionRecord(clonePermissionRecord(permission))
    await db
      .insert(OrganizationRoleTable)
      .values({
        id: createDenTypeId("organizationRole"),
        organizationId: orgId,
        role,
        permission: serializedPermission,
      })
      .onDuplicateKeyUpdate({
        set: {
          permission: serializedPermission,
        },
      })
  }
}

export async function listAssignableRoles(orgId: OrgId) {
  await ensureDefaultDynamicRoles(orgId)

  const rows = await db
    .select({ role: OrganizationRoleTable.role })
    .from(OrganizationRoleTable)
    .where(eq(OrganizationRoleTable.organizationId, orgId))

  return new Set(rows.map((row) => row.role))
}

export async function acceptInvitationForUser(input: {
  userId: UserId
  email: string
  invitationId: string | null
  sessionId?: SessionId | null
}) {
  if (!input.invitationId) {
    return null
  }

  const invitation = await getInvitationById(input.invitationId)

  if (!invitation) {
    return null
  }

  if (normalizeAdmissionEmail(invitation.email) !== normalizeAdmissionEmail(input.email)) {
    return null
  }

  const assuranceRows = input.sessionId
    ? await db
        .select({
          providerId: AuthSessionTable.authenticationProviderId,
          organizationId: AuthSessionTable.authenticationOrganizationId,
        })
        .from(AuthSessionTable)
        .where(eq(AuthSessionTable.id, input.sessionId))
        .limit(1)
    : []
  const decision = await admitOrganizationMember({
    organizationId: invitation.organizationId,
    userId: input.userId,
    evidence: { kind: "invitation", token: input.invitationId },
    assurance: assuranceRows[0] ?? null,
  })
  const member = decision.decision === "allow" && decision.membershipId
    ? (await db.select().from(MemberTable).where(eq(MemberTable.id, normalizeDenTypeId("member", decision.membershipId))).limit(1))[0] ?? null
    : null
  return {
    invitation,
    decision,
    member,
  }
}

export async function getInvitationPreview(invitationIdRaw: string): Promise<InvitationPreview | null> {
  const invitation = await getInvitationById(invitationIdRaw)
  if (!invitation) {
    return null
  }

  const rows = await db
    .select({
      invitation: {
        id: InvitationTable.id,
        email: InvitationTable.email,
        role: InvitationTable.role,
        status: InvitationTable.status,
        expiresAt: InvitationTable.expiresAt,
        createdAt: InvitationTable.createdAt,
      },
      organization: {
        id: OrganizationTable.id,
        name: OrganizationTable.name,
        slug: OrganizationTable.slug,
        allowedEmailDomains: OrganizationTable.allowedEmailDomains,
      },
    })
    .from(InvitationTable)
    .innerJoin(OrganizationTable, eq(InvitationTable.organizationId, OrganizationTable.id))
    .where(eq(InvitationTable.id, invitation.id))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }

  return {
    invitation: {
      ...row.invitation,
      status: getInvitationStatus(row.invitation),
    },
    organization: {
      ...row.organization,
      allowedEmailDomains: normalizeStoredAllowedEmailDomains(row.organization.allowedEmailDomains),
    },
  }
}

async function createOrganizationRecord(input: {
  userId: UserId
  name: string
  slug?: string
  logo?: string | null
  metadata?: Record<string, unknown> | null
}) {
  const userRows = await db
    .select({ emailVerified: AuthUserTable.emailVerified })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, input.userId))
    .limit(1)
  if (!userRows[0]?.emailVerified) {
    throw new OrganizationEmailVerificationRequiredError()
  }

  const organizationId = createDenTypeId("organization")
  const metadata =
    input.metadata ?? {
      limits: {
        members: DEFAULT_ORGANIZATION_LIMITS.members,
        workers: DEFAULT_ORGANIZATION_LIMITS.workers,
      },
    }

  const created = await createOrganizationWithInitialOwner({
    organizationId,
    userId: input.userId,
    name: input.name,
    slug: input.slug ?? organizationId,
    logo: input.logo ?? null,
    metadata,
  })
  const ownerMemberId = created.memberId

  await ensureDefaultDesktopPolicyForOrganization({
    organizationId,
    createdByOrgMemberId: ownerMemberId,
  })

  await ensureDefaultDynamicRoles(organizationId)

  return organizationId
}

export async function getSingletonOrganization() {
  const rows = await db
    .select()
    .from(OrganizationTable)
    .where(eq(OrganizationTable.slug, env.singleOrg.slug))
    .limit(1)

  return rows[0] ?? null
}

export async function getSingletonSsoStatus() {
  const organization = await getSingletonOrganization()
  const organizationSlug = organization?.slug || env.singleOrg.slug
  const fallbackSignInPath = `/sso/${encodeURIComponent(organizationSlug)}`

  if (!organization) {
    return {
      configured: false,
      required: false,
      organizationSlug,
      signInPath: fallbackSignInPath,
    }
  }

  const rows = await db
    .select({ signInPath: SsoConnectionTable.signInPath })
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organization.id))
    .limit(1)
  const signInPath = rows[0]?.signInPath || fallbackSignInPath
  const policy = await ensureOrganizationAdmissionPolicy(organization.id)

  return {
    configured: Boolean(rows[0]),
    required: policy?.authenticationRequirement === "organization_sso",
    organizationSlug,
    signInPath,
  }
}

export async function ensureSingletonOrganizationForUser(userId: UserId) {
  const userRows = await db
    .select({
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)
  const userEmail = userRows[0]?.email ?? null

  let organization = await getSingletonOrganization()
  if (!organization) {
    if (!isSingleOrgOwnerEmailEligible({
      email: userEmail,
      ownerEmails: env.singleOrg.ownerEmails,
    })) {
      return null
    }

    // Account creation and organization admission are separate boundaries.
    // The eligible initial owner can finish authentication before verification,
    // but the singleton organization is not created until its owner can be
    // admitted with verified email evidence.
    if (userRows[0]?.emailVerified !== true) {
      return null
    }

    try {
      const organizationId = await createOrganizationRecord({
        userId,
        name: env.singleOrg.name,
        slug: env.singleOrg.slug,
      })
      return organizationId
    } catch {
      organization = await getSingletonOrganization()
      if (!organization) {
        throw new Error("failed_to_create_single_org")
      }
    }
  }

  const membershipRows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, organization.id),
      eq(MemberTable.userId, userId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return membershipRows[0] ? organization.id : null
}

export async function ensureUserOrgAccess(input: {
  userId: UserId
}) {
  if (env.orgMode === "single_org") {
    return ensureSingletonOrganizationForUser(input.userId)
  }

  const memberships = await listMembershipRows(input.userId)
  if (memberships.length > 0) {
    const organizationIds = [...new Set(memberships.map((membership) => membership.organizationId))]
    await Promise.all(organizationIds.map((organizationId) => ensureDefaultDynamicRoles(organizationId)))
    return memberships[0].organizationId
  }

  return null
}

export async function ensurePersonalOrganizationForUser(userId: UserId) {
  const existingOrgId = await ensureUserOrgAccess({ userId })
  if (existingOrgId) {
    return existingOrgId
  }

  if (env.orgMode === "single_org") {
    return null
  }

  const userRows = await db
    .select({
      name: AuthUserTable.name,
      email: AuthUserTable.email,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  const user = userRows[0]
  const organizationId = await createOrganizationRecord({
    userId,
    name: buildPersonalOrgName({
      name: user?.name,
      email: user?.email,
    }),
  })

  return organizationId
}

export async function createOrganizationForUser(input: {
  userId: UserId
  name: string
}) {
  return createOrganizationRecord({
    userId: input.userId,
    name: input.name.trim(),
  })
}

export async function updateOrganizationName(input: {
  organizationId: OrgId
  name: string
}) {
  return updateOrganizationSettings({
    organizationId: input.organizationId,
    name: input.name,
  })
}

export async function updateOrganizationSettings(input: {
  organizationId: OrgId
  name?: string
  allowedEmailDomains?: readonly string[] | null
  allowedDesktopVersions?: readonly string[] | null
  requireSso?: boolean
  brandAppName?: string | null
  brandLogoUrl?: string | null
  brandIconUrl?: string | null
  brandLogoAsset?: ManagedBrandAssetMetadata | null
  brandIconAsset?: ManagedBrandAssetMetadata | null
  brandAccentColor?: string | null
}) {
  const nextName = typeof input.name === "string" ? input.name.trim() : null
  if (typeof input.name === "string" && !nextName) {
    return null
  }

  const updates: Partial<typeof OrganizationTable.$inferInsert> = {}
  if (nextName) {
    updates.name = nextName
  }
  if (input.allowedEmailDomains !== undefined) {
    updates.allowedEmailDomains = normalizeAllowedEmailDomains(input.allowedEmailDomains).domains
  }
  if (input.allowedDesktopVersions !== undefined || input.requireSso !== undefined || input.brandAppName !== undefined || input.brandLogoUrl !== undefined || input.brandIconUrl !== undefined || input.brandLogoAsset !== undefined || input.brandIconAsset !== undefined || input.brandAccentColor !== undefined) {
    const rows = await db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId))
      .limit(1)

    const existingOrganization = rows[0]
    if (!existingOrganization) {
      return null
    }

    const nextMetadata = {
      ...normalizeOrganizationMetadata(existingOrganization.metadata).metadata,
    } as Record<string, unknown>

    if (input.allowedDesktopVersions !== undefined) {
      if (input.allowedDesktopVersions === null) {
        delete nextMetadata.allowedDesktopVersions
      } else {
        nextMetadata.allowedDesktopVersions = input.allowedDesktopVersions
      }
    }

    if (input.requireSso !== undefined) {
      nextMetadata.requireSso = input.requireSso
    }

    if (input.brandAppName !== undefined) {
      if (input.brandAppName === null) {
        delete nextMetadata.brandAppName
      } else {
        nextMetadata.brandAppName = input.brandAppName
      }
    }

    if (input.brandLogoUrl !== undefined) {
      if (input.brandLogoUrl === null) {
        delete nextMetadata.brandLogoUrl
      } else {
        nextMetadata.brandLogoUrl = input.brandLogoUrl
      }
      if (input.brandLogoAsset === undefined) {
        delete nextMetadata.brandLogoAsset
      }
    }

    if (input.brandIconUrl !== undefined) {
      if (input.brandIconUrl === null) {
        delete nextMetadata.brandIconUrl
      } else {
        nextMetadata.brandIconUrl = input.brandIconUrl
      }
      if (input.brandIconAsset === undefined) {
        delete nextMetadata.brandIconAsset
      }
    }

    if (input.brandLogoAsset !== undefined) {
      if (input.brandLogoAsset === null) {
        delete nextMetadata.brandLogoAsset
      } else {
        nextMetadata.brandLogoAsset = input.brandLogoAsset
      }
    }

    if (input.brandIconAsset !== undefined) {
      if (input.brandIconAsset === null) {
        delete nextMetadata.brandIconAsset
      } else {
        nextMetadata.brandIconAsset = input.brandIconAsset
      }
    }

    if (input.brandAccentColor !== undefined) {
      if (input.brandAccentColor === null) {
        delete nextMetadata.brandAccentColor
      } else {
        nextMetadata.brandAccentColor = input.brandAccentColor
      }
    }

    updates.metadata = normalizeOrganizationMetadata(nextMetadata).metadata
  }

  if (Object.keys(updates).length === 0) {
    return null
  }

  await db
    .update(OrganizationTable)
    .set(updates)
    .where(eq(OrganizationTable.id, input.organizationId))

  const rows = await db
    .select()
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)

  return rows[0] ?? null
}

export async function seedDefaultOrganizationRoles(orgId: OrgId) {
  await ensureDefaultDynamicRoles(orgId)
}

export async function setSessionActiveOrganization(sessionId: SessionId, organizationId: OrgId | null) {
  await db
    .update(AuthSessionTable)
    .set({ activeOrganizationId: organizationId })
    .where(eq(AuthSessionTable.id, sessionId))
}

export async function listUserOrgs(userId: UserId) {
  const memberships = await db
    .select({
      membershipId: MemberTable.id,
      role: MemberTable.role,
      organization: {
        id: OrganizationTable.id,
        name: OrganizationTable.name,
        slug: OrganizationTable.slug,
        logo: OrganizationTable.logo,
        allowedEmailDomains: OrganizationTable.allowedEmailDomains,
        metadata: OrganizationTable.metadata,
        createdAt: OrganizationTable.createdAt,
        updatedAt: OrganizationTable.updatedAt,
      },
    })
    .from(MemberTable)
    .innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
    .where(and(eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
    .orderBy(asc(MemberTable.createdAt))

  const organizationIds = memberships.map((row) => row.organization.id)
  const memberCounts = new Map<OrgId, number>()
  if (organizationIds.length > 0) {
    const counts = await db
      .select({
        organizationId: MemberTable.organizationId,
        memberCount: count(),
      })
      .from(MemberTable)
      .where(and(inArray(MemberTable.organizationId, organizationIds), isNull(MemberTable.removedAt)))
      .groupBy(MemberTable.organizationId)
    for (const row of counts) {
      memberCounts.set(row.organizationId, row.memberCount)
    }
  }

  return memberships.map((row) => ({
    id: row.organization.id,
    name: row.organization.name,
    slug: row.organization.slug,
    logo: row.organization.logo,
    allowedEmailDomains: normalizeStoredAllowedEmailDomains(row.organization.allowedEmailDomains),
    metadata: serializeOrganizationMetadata(row.organization.metadata),
    role: row.role,
    orgMemberId: row.membershipId,
    membershipId: row.membershipId,
    memberCount: memberCounts.get(row.organization.id) ?? 0,
    createdAt: row.organization.createdAt,
    updatedAt: row.organization.updatedAt,
  })) satisfies UserOrgSummary[]
}

export async function resolveUserOrganizations(input: {
  activeOrganizationId?: string | null
  userId: UserId
}) {
  await ensureUserOrgAccess({ userId: input.userId })

  const visibleOrgs = await listUserOrgs(input.userId)
  const orgs = env.orgMode === "single_org"
    ? visibleOrgs.filter((org) => org.slug === env.singleOrg.slug)
    : visibleOrgs

  const availableOrgIds = new Set(orgs.map((org) => org.id))

  let activeOrgId: OrgId | null = null
  if (input.activeOrganizationId) {
    try {
      const normalized = normalizeDenTypeId("organization", input.activeOrganizationId)
      if (availableOrgIds.has(normalized)) {
        activeOrgId = normalized
      }
    } catch {
      activeOrgId = null
    }
  }

  if (!activeOrgId && orgs.length === 1) {
    activeOrgId = orgs[0].id
  }

  const activeOrg = orgs.find((org) => org.id === activeOrgId) ?? null

  return {
    orgs,
    activeOrgId,
    activeOrgSlug: activeOrg?.slug ?? null,
  }
}

export async function getOrganizationContextForUser(input: {
  userId: UserId
  organizationId: OrgId
}) {
  const organizationRows = await db
    .select()
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)

  const organization = organizationRows[0]
  if (!organization) {
    return null
  }

  const currentMemberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organization.id), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
    .limit(1)

  const currentMember = currentMemberRows[0]
  if (!currentMember) {
    return null
  }

  if (!currentMember.userId) {
    return null
  }

  await ensureDefaultDynamicRoles(organization.id)

  const members = await db
    .select({
      id: MemberTable.id,
      userId: MemberTable.userId,
      inviteId: MemberTable.inviteId,
      role: MemberTable.role,
      createdAt: MemberTable.createdAt,
      joinedAt: MemberTable.joinedAt,
      admissionSource: MemberTable.admissionSource,
      admissionPolicyVersion: MemberTable.admissionPolicyVersion,
      admittedAt: MemberTable.admittedAt,
      user: {
        id: AuthUserTable.id,
        email: AuthUserTable.email,
        name: AuthUserTable.name,
        image: AuthUserTable.image,
      },
      invitation: {
        email: InvitationTable.email,
      },
    })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(and(eq(MemberTable.organizationId, organization.id), isNull(MemberTable.removedAt)))
    .orderBy(asc(MemberTable.createdAt))

  const invitations = await db
    .select({
      id: InvitationTable.id,
      email: InvitationTable.email,
      role: InvitationTable.role,
      status: InvitationTable.status,
      expiresAt: InvitationTable.expiresAt,
      createdAt: InvitationTable.createdAt,
    })
    .from(InvitationTable)
    .where(eq(InvitationTable.organizationId, organization.id))
    .orderBy(asc(InvitationTable.createdAt))

  const dynamicRoles = await db
    .select()
    .from(OrganizationRoleTable)
    .where(eq(OrganizationRoleTable.organizationId, organization.id))
    .orderBy(asc(OrganizationRoleTable.createdAt))

  const teams = await listOrganizationTeams(organization.id)

  const builtInDynamicRoleNames = new Set(Object.keys(denDefaultDynamicOrganizationRoles))

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      allowedEmailDomains: normalizeStoredAllowedEmailDomains(organization.allowedEmailDomains),
      metadata: serializeOrganizationMetadata(organization.metadata),
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    },
    currentMember: {
      id: currentMember.id,
      userId: currentMember.userId,
      role: currentMember.role,
      createdAt: currentMember.createdAt,
      joinedAt: currentMember.joinedAt,
      admissionSource: currentMember.admissionSource,
      admissionPolicyVersion: currentMember.admissionPolicyVersion,
      admittedAt: currentMember.admittedAt,
      isOwner: roleIncludesOwner(currentMember.role),
    },
    members: members.map((member) => {
      const email = member.user?.email ?? member.invitation?.email ?? "invited@example.com"
      const name = member.user?.name ?? getInvitedMemberName(email)
      return {
        id: member.id,
        userId: member.userId,
        inviteId: member.inviteId,
        role: member.role,
        createdAt: member.createdAt,
        joinedAt: member.joinedAt,
        admissionSource: member.admissionSource,
        admissionPolicyVersion: member.admissionPolicyVersion,
        admittedAt: member.admittedAt,
        isOwner: roleIncludesOwner(member.role),
        user: {
          id: member.user?.id ?? member.id,
          email,
          name,
          image: member.user?.image ?? null,
        },
      }
    }),
    invitations,
    roles: [
      {
        id: "builtin-owner",
        role: "owner",
        permission: clonePermissionRecord(denOrganizationStaticRoles.owner.statements),
        builtIn: true,
        protected: true,
        createdAt: null,
        updatedAt: null,
      },
      ...dynamicRoles.map((role) => ({
        id: role.id,
        role: role.role,
        permission: parsePermissionRecord(role.permission),
        builtIn: builtInDynamicRoleNames.has(role.role),
        protected: false,
        createdAt: role.createdAt,
        updatedAt: role.updatedAt,
      })),
    ],
    teams,
  } satisfies OrganizationContext
}

async function listOrganizationTeams(organizationId: OrgId) {
  const teams = await db
    .select({
      id: TeamTable.id,
      name: TeamTable.name,
      createdAt: TeamTable.createdAt,
      updatedAt: TeamTable.updatedAt,
    })
    .from(TeamTable)
    .where(eq(TeamTable.organizationId, organizationId))
    .orderBy(asc(TeamTable.createdAt))

  if (teams.length === 0) {
    return []
  }

  const memberships = await db
    .select({
      teamId: TeamMemberTable.teamId,
      orgMembershipId: TeamMemberTable.orgMembershipId,
    })
    .from(TeamMemberTable)
    .where(inArray(TeamMemberTable.teamId, teams.map((team) => team.id)))

  const memberIdsByTeamId = new Map<typeof TeamTable.$inferSelect.id, MemberId[]>()
  for (const membership of memberships) {
    const existing = memberIdsByTeamId.get(membership.teamId) ?? []
    existing.push(membership.orgMembershipId)
    memberIdsByTeamId.set(membership.teamId, existing)
  }

  return teams.map((team) => ({
    ...team,
    memberIds: memberIdsByTeamId.get(team.id) ?? [],
  }))
}

export async function listTeamsForMember(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
}) {
  return db
    .select({
      id: TeamTable.id,
      name: TeamTable.name,
      organizationId: TeamTable.organizationId,
      createdAt: TeamTable.createdAt,
      updatedAt: TeamTable.updatedAt,
    })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.memberId)))
    .orderBy(asc(TeamTable.createdAt))
}

async function listActiveOrganizationMemberGuardRows(organizationId: OrgId) {
  return db
    .select({
      id: MemberTable.id,
      role: MemberTable.role,
      userId: AuthUserTable.id,
    })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
}

export async function organizationHasActiveOwner(organizationId: OrgId) {
  const activeMembers = await listActiveOrganizationMemberGuardRows(organizationId)
  return activeMembers.some((member) => member.userId && roleIncludesOwner(member.role))
}

function memberNotFound(): MemberMutationFailure {
  return {
    ok: false,
    error: "member_not_found",
    message: "The organization member could not be found.",
  }
}

export async function validateOrganizationMemberRoleUpdate(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
  nextRole: string
}): Promise<MemberMutationResult> {
  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)

  const member = memberRows[0] ?? null
  if (!member) {
    return memberNotFound()
  }

  const activeMembers = await listActiveOrganizationMemberGuardRows(input.organizationId)
  const validation = validateOrganizationMemberRoleChange({
    member,
    activeMembers,
    nextRole: input.nextRole,
  })
  if (!validation.ok) {
    return validation
  }

  return { ok: true, member }
}

export async function validateOrganizationMemberRemovalForHook(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
}): Promise<MemberMutationResult> {
  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)

  const member = memberRows[0] ?? null
  if (!member) {
    return memberNotFound()
  }

  const activeMembers = await listActiveOrganizationMemberGuardRows(input.organizationId)
  const validation = validateOrganizationMemberRemoval({ member, activeMembers })
  if (!validation.ok) {
    return validation
  }

  return { ok: true, member }
}

export async function transferOrganizationOwnership(input: {
  organizationId: OrgId
  currentOwnerMemberId: MemberRow["id"]
  targetMemberId: MemberRow["id"]
}): Promise<OwnershipTransferResult> {
  if (input.currentOwnerMemberId === input.targetMemberId) {
    return {
      ok: false,
      error: "owner_transfer_invalid",
      message: "Choose a different active member to become workspace owner.",
    }
  }

  const memberRows = await db
    .select({ member: MemberTable, userId: AuthUserTable.id })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      inArray(MemberTable.id, [input.currentOwnerMemberId, input.targetMemberId]),
      isNull(MemberTable.removedAt),
    ))

  const currentOwnerRow = memberRows.find((row) => row.member.id === input.currentOwnerMemberId) ?? null
  if (!currentOwnerRow || !currentOwnerRow.userId || !roleIncludesOwner(currentOwnerRow.member.role)) {
    return {
      ok: false,
      error: "owner_not_found",
      message: "The current workspace owner could not be found.",
    }
  }

  const targetRow = memberRows.find((row) => row.member.id === input.targetMemberId) ?? null
  if (!targetRow || !targetRow.userId) {
    return {
      ok: false,
      error: "target_member_not_found",
      message: "Choose an active member to become workspace owner.",
    }
  }

  if (roleIncludesOwner(targetRow.member.role)) {
    return {
      ok: false,
      error: "owner_transfer_invalid",
      message: "This member is already a workspace owner.",
    }
  }

  const roles = getRoleValueAfterOwnershipTransfer({
    currentRole: currentOwnerRow.member.role,
    targetRole: targetRow.member.role,
  })

  await db.transaction(async (tx) => {
    await tx
      .update(MemberTable)
      .set({ role: roles.previousOwnerRole })
      .where(eq(MemberTable.id, currentOwnerRow.member.id))
    await tx
      .update(MemberTable)
      .set({ role: roles.newOwnerRole })
      .where(eq(MemberTable.id, targetRow.member.id))
  })

  await revokeOrganizationApiKeysForMember({
    organizationId: input.organizationId,
    orgMembershipId: currentOwnerRow.member.id,
    userId: currentOwnerRow.member.userId,
  })
  await revokeOrganizationApiKeysForMember({
    organizationId: input.organizationId,
    orgMembershipId: targetRow.member.id,
    userId: targetRow.member.userId,
  })
  await revokeMembershipSessionCredentials({
    organizationId: input.organizationId,
    userId: currentOwnerRow.member.userId,
  })
  await revokeMembershipSessionCredentials({
    organizationId: input.organizationId,
    userId: targetRow.member.userId,
  })

  return {
    ok: true,
    previousOwner: currentOwnerRow.member,
    newOwner: targetRow.member,
    previousOwnerRole: roles.previousOwnerRole,
    newOwnerRole: roles.newOwnerRole,
  }
}

export async function recoverOrganizationOwnership(input: {
  organizationId: OrgId
  targetMemberId: MemberRow["id"]
}): Promise<OwnershipRecoveryResult> {
  if (await organizationHasActiveOwner(input.organizationId)) {
    return {
      ok: false,
      error: "owner_transfer_invalid",
      message: "Only the current workspace owner can transfer ownership while an active owner exists.",
    }
  }

  const memberRows = await db
    .select({ member: MemberTable, userId: AuthUserTable.id })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))

  const targetRow = memberRows.find((row) => row.member.id === input.targetMemberId) ?? null
  if (!targetRow || !targetRow.userId || !roleIncludesPrivileged(targetRow.member.role)) {
    return {
      ok: false,
      error: "target_member_not_found",
      message: "Choose an active workspace admin to become owner.",
    }
  }

  const previousOwnerRows = memberRows.filter((row) => roleIncludesOwner(row.member.role))
  const roles = getRoleValueAfterOwnershipTransfer({
    currentRole: "owner",
    targetRole: targetRow.member.role,
  })

  await db.transaction(async (tx) => {
    for (const ownerRow of previousOwnerRows) {
      const ownerRoles = getRoleValueAfterOwnershipTransfer({
        currentRole: ownerRow.member.role,
        targetRole: targetRow.member.role,
      })
      await tx
        .update(MemberTable)
        .set({ role: ownerRoles.previousOwnerRole })
        .where(eq(MemberTable.id, ownerRow.member.id))
    }

    await tx
      .update(MemberTable)
      .set({ role: roles.newOwnerRole })
      .where(eq(MemberTable.id, targetRow.member.id))
  })

  await revokeOrganizationApiKeysForMember({
    organizationId: input.organizationId,
    orgMembershipId: targetRow.member.id,
    userId: targetRow.member.userId,
  })
  await revokeMembershipSessionCredentials({
    organizationId: input.organizationId,
    userId: targetRow.member.userId,
  })

  return {
    ok: true,
    previousOwnerCount: previousOwnerRows.length,
    newOwner: targetRow.member,
    newOwnerRole: roles.newOwnerRole,
  }
}

export async function removeOrganizationMember(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
  removedByOrgMemberId?: MemberRow["id"]
  removalSource?: "admin" | "self" | "scim" | "system"
}): Promise<MemberMutationResult> {
  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)

  const member = memberRows[0] ?? null
  if (!member) {
    return memberNotFound()
  }

  const activeMembers = await listActiveOrganizationMemberGuardRows(input.organizationId)
  const validation = validateOrganizationMemberRemoval({ member, activeMembers })
  if (!validation.ok) {
    return validation
  }

  await revokeOrganizationApiKeysForMember({
    organizationId: input.organizationId,
    orgMembershipId: member.id,
    userId: member.userId,
  })
  await revokeMembershipSessionCredentials({
    organizationId: input.organizationId,
    userId: member.userId,
  })

  const removed = await db.transaction(async (tx) => {
    const lockedMembers = await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.id, member.id),
        eq(MemberTable.organizationId, input.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .limit(1)
      .for("update")
    if (!lockedMembers[0]) return false

    await tx
      .delete(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, member.id),
      ))

    await tx
      .delete(TeamMemberTable)
      .where(eq(TeamMemberTable.orgMembershipId, member.id))

    await tx
      .update(MemberTable)
      .set({
        removedAt: new Date(),
        removedByOrgMember: input.removedByOrgMemberId ?? null,
        removalSource: input.removalSource ?? (input.removedByOrgMemberId ? "admin" : "system"),
      })
      .where(eq(MemberTable.id, member.id))
    return true
  })
  if (!removed) return memberNotFound()

  await runPostOrganizationMemberChangeHooks({ organizationId: input.organizationId, memberId: member.id, change: "removed" })

  return { ok: true, member }
}
