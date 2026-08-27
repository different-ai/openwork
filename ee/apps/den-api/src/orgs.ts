import { and, asc, count, eq, gt, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AuthUserTable,
  ConnectedAccountTable,
  InvitationTable,
  LlmProviderAccessTable,
  LlmProviderMemberCredentialTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  ScimProviderTable,
  ScimUserTombstoneTable,
  SsoConnectionTable,
  SsoProviderTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { revokeOrganizationApiKeysForMember } from "./api-keys.js"
import { cache } from "./cache.js"
import { revokeMembershipSessionCredentials } from "./credential-revocation.js"
import { db } from "./db.js"
import { env } from "./env.js"
import {
  getRoleValueAfterOwnershipTransfer,
  roleIncludesOwner as guardRoleIncludesOwner,
  roleIncludesSuperAdmin,
  validateOrganizationMemberRemoval,
  validateOrganizationMemberRoleChange,
  type MemberLifecycleValidation,
} from "./organization-member-guards.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { getScimManagedTeamIds } from "./scim-groups.js"
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
import { isProtectedOrganizationRoleName, shouldRevokeSessionsForRoleChange } from "./organization-role-hierarchy.js"
import { appLogger } from "./observability/logger.js"
import { isSingleOrgOwnerEmailEligible, resolveSingleOrgMembershipRole } from "./single-org-policy.js"

const logger = appLogger.child({ component: "organizations" })

type UserId = typeof AuthUserTable.$inferSelect.id
type SessionId = typeof AuthSessionTable.$inferSelect.id
type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberRow = typeof MemberTable.$inferSelect
type MemberId = MemberRow["id"]
type InvitationRow = typeof InvitationTable.$inferSelect
export type AllowedEmailDomains = string[] | null
type OrganizationMetadataInput = Record<string, unknown> | string | null | undefined

export type AcceptInvitationForUserResult = {
  status: "accepted"
  invitation: InvitationRow
  member: MemberRow
} | {
  status: "membership_removed"
  invitation: InvitationRow
} | {
  status: "scim_deprovisioned"
  invitation: InvitationRow
}

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

type MemberRoleUpdateResult = {
  ok: true
  member: MemberRow
  previousRole: string
  nextRole: string
  changed: boolean
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
  previousOwnerCount: number
} | OwnershipTransferFailure

type OwnershipTransferCommitResult = {
  ok: true
  previousOwner: MemberRow
  newOwner: MemberRow
  previousOwnerRole: string
  newOwnerRole: string
  previousOwnerCount: number
  demotedOwners: MemberRow[]
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
    branding: {
      appName: string
      logoUrl: string | null
      iconUrl: string | null
    }
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
    isOwner: boolean
  }
  members: Array<{
    id: MemberId
    userId: UserId | null
    inviteId: InvitationRow["id"] | null
    role: string
    createdAt: Date
    joinedAt: Date | null
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
    inviteToken: string | null
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
    managedByScim: boolean
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
  return normalized.slice(atIndex + 1)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadataRecord(input: OrganizationMetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

function serializeMetadataRecord(metadata: Record<string, unknown>) {
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
}

export function serializeMemberFacingOrganizationMetadata(input: OrganizationMetadataInput) {
  const metadata = parseMetadataRecord(input)
  const capabilities = isRecord(metadata.capabilities) ? metadata.capabilities : null
  if (!capabilities || !("cloud" in capabilities)) {
    return serializeOrganizationMetadata(input)
  }

  const nextCapabilities = { ...capabilities }
  delete nextCapabilities.cloud
  const nextMetadata = { ...metadata }
  if (Object.keys(nextCapabilities).length > 0) {
    nextMetadata.capabilities = nextCapabilities
  } else {
    delete nextMetadata.capabilities
  }

  return serializeMetadataRecord(nextMetadata)
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
    .where(eq(InvitationTable.inviteToken, invitationIdRaw))
    .limit(1)

  if (tokenRows[0]) {
    return tokenRows[0]
  }

  let invitationId
  try {
    invitationId = normalizeDenTypeId("invitation", invitationIdRaw)
  } catch {
    return null
  }

  const rows = await db
    .select()
    .from(InvitationTable)
    .where(eq(InvitationTable.id, invitationId))
    .limit(1)

  return rows[0] ?? null
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

function normalizeAssignableRole(input: string, availableRoles: Set<string>, fallbackRole = "member") {
  const roles = splitRoles(input).filter((role) => availableRoles.has(role))
  if (roles.length === 0) {
    return fallbackRole
  }
  return roles.join(",")
}

export async function listAssignableRoles(orgId: OrgId) {
  const rows = await db
    .select({ role: OrganizationRoleTable.role })
    .from(OrganizationRoleTable)
    .where(eq(OrganizationRoleTable.organizationId, orgId))

  return new Set(rows.map((row) => row.role))
}

async function insertMemberIfMissing(input: {
  organizationId: OrgId
  userId: UserId
  role: string
  email?: string | null
}) {
  const existing = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
    .limit(1)

  const existingMember = existing[0] ?? null
  if (existingMember) {
    return existingMember
  }

  const invitedMember = await acceptPendingInvitationForBootstrapMembership({
    organizationId: input.organizationId,
    userId: input.userId,
    email: input.email ?? null,
    defaultRole: input.role,
  })
  if (invitedMember) {
    // Accepting an invite materializes membership data; cached org/member reads
    // must be invalidated here because hot cache hits do not re-check the DB.
    await cache.org.deleteMemberList(input.organizationId)
    await cache.org.deleteMembership({ organizationId: input.organizationId, userId: input.userId })
    return invitedMember
  }

  const removedMember = await findSoftRemovedMemberForUser({
    organizationId: input.organizationId,
    userId: input.userId,
  })
  if (removedMember) {
    return null
  }

  try {
    await db.insert(MemberTable).values({
      id: createDenTypeId("member"),
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      joinedAt: new Date(),
    })
    // Joining an org changes both the aggregate list and this user's membership cache.
    await cache.org.deleteMemberList(input.organizationId)
    await cache.org.deleteMembership({ organizationId: input.organizationId, userId: input.userId })
  } catch {}

  const created = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
    .limit(1)

  if (!created[0]) {
    throw new Error("failed_to_create_member")
  }

  return created[0]
}

async function findSoftRemovedMemberForUser(input: {
  organizationId: OrgId
  userId: UserId
}) {
  const rows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNotNull(MemberTable.removedAt)))
    .limit(1)

  return rows[0] ?? null
}

export async function ensureBootstrapMembershipForOrganization(input: {
  organizationId: OrgId
  userId: UserId
  role: string
  email?: string | null
}) {
  return insertMemberIfMissing(input)
}

export async function acceptPendingInvitationForBootstrapMembership(input: {
  organizationId: OrgId
  userId: UserId
  email: string | null
  defaultRole: string
}) {
  const email = input.email?.trim().toLowerCase()
  if (!email) {
    return null
  }

  const invitationRows = await db
    .select()
    .from(InvitationTable)
    .where(and(
      eq(InvitationTable.organizationId, input.organizationId),
      eq(InvitationTable.status, "pending"),
      gt(InvitationTable.expiresAt, new Date()),
      sql`lower(${InvitationTable.email}) = ${email}`,
    ))
    .limit(1)

  const invitation = invitationRows.find((row) => (
    row.organizationId === input.organizationId
    && row.status === "pending"
    && row.expiresAt > new Date()
    && row.email.trim().toLowerCase() === email
  )) ?? null
  if (!invitation) {
    return null
  }

  // Bootstrap paths already grant same-org membership before email verification.
  // organization-join-verification.ts keeps that gate on the explicit accept endpoint.
  const accepted = await acceptInvitation(invitation, input.userId, { fallbackRole: input.defaultRole })
  return accepted?.status === "accepted" ? accepted.member : null
}

export async function reconcilePendingInvitationsForUser(userId: UserId) {
  const userRows = await db
    .select({ email: AuthUserTable.email })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)
  const email = userRows[0]?.email.trim().toLowerCase()
  if (!email) {
    return 0
  }

  const now = new Date()
  const invitations = await db
    .select()
    .from(InvitationTable)
    .where(and(
      eq(InvitationTable.status, "pending"),
      gt(InvitationTable.expiresAt, now),
      sql`lower(${InvitationTable.email}) = ${email}`,
    ))
    .limit(20)

  let acceptedCount = 0
  for (const invitation of invitations) {
    if (invitation.status !== "pending" || invitation.expiresAt <= now || invitation.email.trim().toLowerCase() !== email) {
      continue
    }

    const existingMemberRows = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, invitation.organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
      .limit(1)
    if (!existingMemberRows[0]) {
      // No cross-org auto-join here; organization-join-verification.ts keeps
      // that email-verification boundary on the explicit accept endpoint.
      continue
    }

    const accepted = await acceptInvitation(invitation, userId)
    if (accepted?.status === "accepted") {
      acceptedCount += 1
    }
  }

  return acceptedCount
}

async function acceptInvitation(invitation: InvitationRow, userId: UserId, options?: { fallbackRole?: string }) {
  const scimConnections = await db
    .select({ id: ScimProviderTable.id })
    .from(ScimProviderTable)
    .where(eq(ScimProviderTable.organizationId, invitation.organizationId))
    .limit(1)
  if (scimConnections[0]) {
    const tombstones = await db
      .select({ id: ScimUserTombstoneTable.id })
      .from(ScimUserTombstoneTable)
      .where(and(
        eq(ScimUserTombstoneTable.organizationId, invitation.organizationId),
        eq(ScimUserTombstoneTable.email, invitation.email.trim().toLowerCase()),
      ))
      .limit(1)
    if (tombstones[0]) {
      logger.info("skipped invitation acceptance for SCIM-deprovisioned member", {
        organization_id: invitation.organizationId,
        invitation_id: invitation.id,
      })
      return { status: "scim_deprovisioned" as const, invitation }
    }
  }

  const availableRoles = await listAssignableRoles(invitation.organizationId)
  return db.transaction(async (tx) => {
    const lockedInvitations = await tx
      .select()
      .from(InvitationTable)
      .where(and(
        eq(InvitationTable.id, invitation.id),
        eq(InvitationTable.organizationId, invitation.organizationId),
      ))
      .for("update")
    const currentInvitation = lockedInvitations[0] ?? null
    if (!currentInvitation) {
      return null
    }

    const existingMemberRows = await tx
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, currentInvitation.organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
      .limit(1)
      .for("update")
    const existingMember = existingMemberRows[0] ?? null
    const invitationStatus = getInvitationStatus(currentInvitation)
    if (invitationStatus !== "pending") {
      return invitationStatus === "accepted" && existingMember
        ? { status: "accepted" as const, invitation: currentInvitation, member: existingMember, newlyAccepted: false }
        : null
    }

    const role = normalizeAssignableRole(currentInvitation.role, availableRoles, options?.fallbackRole)
    const joinedAt = new Date()
    const invitedMemberRows = await tx
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.inviteId, currentInvitation.id), eq(MemberTable.organizationId, currentInvitation.organizationId), isNull(MemberTable.removedAt)))
      .limit(1)
      .for("update")
    const invitedMember = invitedMemberRows[0] ?? null
    const removedMemberRows = existingMember
      ? []
      : await tx
          .select()
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, currentInvitation.organizationId), eq(MemberTable.userId, userId), isNotNull(MemberTable.removedAt)))
          .limit(1)
          .for("update")
    const removedMember = removedMemberRows[0] ?? null
    let member = existingMember

    if (existingMember && invitedMember) {
      const existingJoinedAt = existingMember.joinedAt ?? joinedAt
      const existingRole = roleIncludesOwner(existingMember.role) ? existingMember.role : role
      await tx
        .update(MemberTable)
        .set({ role: existingRole, joinedAt: existingJoinedAt })
        .where(eq(MemberTable.id, existingMember.id))
      if (invitedMember.id !== existingMember.id) {
        await tx.delete(MemberTable).where(eq(MemberTable.id, invitedMember.id))
      }
      member = { ...existingMember, role: existingRole, joinedAt: existingJoinedAt }
    }

    if (!member && removedMember && invitedMember) {
      // A new explicit invitation is a new access lifecycle. Keep the removed
      // row for audit history, but activate the invitation placeholder so any
      // teams or direct grants assigned while the invite was pending remain
      // attached to the member who joins.
      await tx
        .update(MemberTable)
        .set({ userId: null })
        .where(eq(MemberTable.id, removedMember.id))
      await tx
        .update(MemberTable)
        .set({ userId, role, joinedAt })
        .where(eq(MemberTable.id, invitedMember.id))
      member = {
        ...invitedMember,
        userId,
        role,
        joinedAt,
      }
    }

    if (!member && removedMember) {
      const memberId = createDenTypeId("member")
      // Legacy invitations may not have a pending member placeholder. They
      // still represent a fresh access lifecycle, so detach the audit row and
      // create a new membership instead of reviving stale membership grants.
      await tx
        .update(MemberTable)
        .set({ userId: null })
        .where(eq(MemberTable.id, removedMember.id))
      await tx.insert(MemberTable).values({
        id: memberId,
        organizationId: currentInvitation.organizationId,
        userId,
        role,
        joinedAt,
        inviteId: currentInvitation.id,
        invitedByOrgMember: currentInvitation.orgMemberId,
      })
      const createdMembers = await tx
        .select()
        .from(MemberTable)
        .where(eq(MemberTable.id, memberId))
        .limit(1)
      member = createdMembers[0]
      if (!member) {
        throw new Error("failed_to_create_member")
      }
    }

    if (!member && invitedMember) {
      await tx
        .update(MemberTable)
        .set({ userId, role, joinedAt })
        .where(eq(MemberTable.id, invitedMember.id))
      member = { ...invitedMember, userId, role, joinedAt }
    }

    if (!member) {
      const memberId = createDenTypeId("member")
      await tx.insert(MemberTable).values({
        id: memberId,
        organizationId: currentInvitation.organizationId,
        userId,
        role,
        joinedAt,
        inviteId: currentInvitation.id,
        invitedByOrgMember: currentInvitation.orgMemberId,
      })
      const createdMembers = await tx
        .select()
        .from(MemberTable)
        .where(eq(MemberTable.id, memberId))
        .limit(1)
      member = createdMembers[0]
      if (!member) {
        throw new Error("failed_to_create_member")
      }
    }

    if (currentInvitation.teamId) {
      const teams = await tx
        .select({ id: TeamTable.id })
        .from(TeamTable)
        .where(and(
          eq(TeamTable.id, currentInvitation.teamId),
          eq(TeamTable.organizationId, currentInvitation.organizationId),
        ))
        .limit(1)

      if (teams[0]) {
        const existingTeamMember = await tx
          .select({ id: TeamMemberTable.id })
          .from(TeamMemberTable)
          .where(and(eq(TeamMemberTable.teamId, currentInvitation.teamId), eq(TeamMemberTable.orgMembershipId, member.id)))
          .limit(1)

        if (!existingTeamMember[0]) {
          await tx.insert(TeamMemberTable).values({
            id: createDenTypeId("teamMember"),
            teamId: currentInvitation.teamId,
            orgMembershipId: member.id,
          })
        }
      }
    }

    await tx
      .update(InvitationTable)
      .set({ status: "accepted" })
      .where(and(eq(InvitationTable.id, currentInvitation.id), eq(InvitationTable.status, "pending")))

    return { status: "accepted" as const, invitation: currentInvitation, member, newlyAccepted: true }
  })
}

export async function acceptInvitationForUser(input: {
  userId: UserId
  email: string
  invitationId: string | null
}): Promise<AcceptInvitationForUserResult | null> {
  if (!input.invitationId) {
    return null
  }

  const invitation = await getInvitationById(input.invitationId)

  if (!invitation) {
    return null
  }

  if (invitation.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) {
    return null
  }

  const invitationStatus = getInvitationStatus(invitation)
  if (invitationStatus !== "pending") {
    if (invitationStatus === "accepted") {
      const memberRows = await db
        .select()
        .from(MemberTable)
        .where(and(eq(MemberTable.organizationId, invitation.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
        .limit(1)
      const member = memberRows[0]
      if (member) {
        return {
          status: "accepted",
          invitation,
          member,
        }
      }

      const removedMember = await findSoftRemovedMemberForUser({
        organizationId: invitation.organizationId,
        userId: input.userId,
      })
      if (removedMember) {
        return {
          status: "membership_removed",
          invitation,
        }
      }
    }

    return null
  }

  const organizationRows = await db
    .select({ allowedEmailDomains: OrganizationTable.allowedEmailDomains })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, invitation.organizationId))
    .limit(1)

  const allowedEmailDomains = normalizeStoredAllowedEmailDomains(organizationRows[0]?.allowedEmailDomains)
  if (!isEmailAllowedForOrganization(allowedEmailDomains, input.email)) {
    throw new OrganizationEmailDomainRestrictionError(input.email, allowedEmailDomains ?? [])
  }

  const accepted = await acceptInvitation(invitation, input.userId)
  if (!accepted) {
    const currentInvitation = await getInvitationById(input.invitationId)
    if (currentInvitation && getInvitationStatus(currentInvitation) === "accepted") {
      const removedMember = await findSoftRemovedMemberForUser({
        organizationId: currentInvitation.organizationId,
        userId: input.userId,
      })
      if (removedMember) {
        return {
          status: "membership_removed",
          invitation: currentInvitation,
        }
      }
    }
    return null
  }
  if (accepted.status === "scim_deprovisioned") {
    return accepted
  }
  if (accepted.newlyAccepted) {
    await runPostOrganizationMemberChangeHooks({
      organizationId: accepted.invitation.organizationId,
      memberId: accepted.member.id,
      change: "added",
    })
  }
  return {
    status: "accepted",
    invitation: accepted.invitation,
    member: accepted.member,
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
        logo: OrganizationTable.logo,
        metadata: OrganizationTable.metadata,
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

  const organizationMetadata = normalizeOrganizationMetadata(row.organization.metadata).metadata

  return {
    invitation: {
      ...row.invitation,
      status: getInvitationStatus(row.invitation),
    },
    organization: {
      id: row.organization.id,
      name: row.organization.name,
      slug: row.organization.slug,
      allowedEmailDomains: normalizeStoredAllowedEmailDomains(row.organization.allowedEmailDomains),
      branding: {
        appName: typeof organizationMetadata.brandAppName === "string" ? organizationMetadata.brandAppName : "OpenWork",
        logoUrl: typeof organizationMetadata.brandLogoUrl === "string" ? organizationMetadata.brandLogoUrl : row.organization.logo,
        iconUrl: typeof organizationMetadata.brandIconUrl === "string" ? organizationMetadata.brandIconUrl : null,
      },
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
  const organizationId = createDenTypeId("organization")
  const metadata =
    input.metadata ?? {
      limits: {
        members: DEFAULT_ORGANIZATION_LIMITS.members,
        workers: DEFAULT_ORGANIZATION_LIMITS.workers,
      },
    }

  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: input.name,
    slug: input.slug ?? organizationId,
    logo: input.logo ?? null,
    metadata,
  })

  const ownerMemberId = createDenTypeId("member")
  await db.insert(MemberTable).values({
    id: ownerMemberId,
    organizationId,
    userId: input.userId,
    role: "owner",
  })

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
      organizationSlug,
      signInPath: fallbackSignInPath,
    }
  }

  const rows = await db
    .select({ signInPath: SsoConnectionTable.signInPath })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(SsoConnectionTable.organizationId, SsoProviderTable.organizationId),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .where(and(
      eq(SsoConnectionTable.organizationId, organization.id),
      eq(SsoConnectionTable.status, "enabled"),
    ))
    .limit(1)
  const signInPath = rows[0]?.signInPath || fallbackSignInPath

  return {
    configured: Boolean(rows[0]),
    organizationSlug,
    signInPath,
  }
}

async function countActiveOwners(organizationId: OrgId) {
  const rows = await db
    .select({ role: MemberTable.role })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))

  return rows.filter((row) => roleIncludesOwner(row.role)).length
}

export async function ensureSingletonOrganizationForUser(userId: UserId, options?: { forceOwner?: boolean }) {
  const userRows = await db
    .select({
      email: AuthUserTable.email,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)
  const userEmail = userRows[0]?.email ?? null

  let organization = await getSingletonOrganization()
  if (!organization) {
    if (!options?.forceOwner && !isSingleOrgOwnerEmailEligible({
      email: userEmail,
      ownerEmails: env.singleOrg.ownerEmails,
    })) {
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

  const activeOwnerCount = await countActiveOwners(organization.id)
  const role = options?.forceOwner && activeOwnerCount === 0
    ? "owner"
    : resolveSingleOrgMembershipRole({
        activeOwnerCount,
        email: userEmail,
        ownerEmails: env.singleOrg.ownerEmails,
      })
  if (!role) {
    return null
  }

  const member = await ensureBootstrapMembershipForOrganization({
    organizationId: organization.id,
    userId,
    role,
    email: userEmail,
  })
  if (!member) {
    return null
  }

  await ensureDefaultDesktopPolicyForOrganization({
    organizationId: organization.id,
    createdByOrgMemberId: member.id,
  })

  return organization.id
}

export async function ensureUserOrgAccess(input: {
  userId: UserId
}) {
  if (env.orgMode === "single_org") {
    return ensureSingletonOrganizationForUser(input.userId)
  }

  const memberships = await listMembershipRows(input.userId)
  if (memberships.length > 0) {
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

  const rows = await db
    .select({ token: AuthSessionTable.token })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.id, sessionId))
    .limit(1)
  const session = rows[0]
  if (session) {
    await cache.auth.deleteSession(session.token)
  }
  await cache.auth.deleteSessionId(sessionId)
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
    metadata: serializeMemberFacingOrganizationMetadata(row.organization.metadata),
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

  const members = await cache.org.members(organization.id)

  const invitations = await db
    .select({
      id: InvitationTable.id,
      email: InvitationTable.email,
      role: InvitationTable.role,
      status: InvitationTable.status,
      expiresAt: InvitationTable.expiresAt,
      createdAt: InvitationTable.createdAt,
      inviteToken: InvitationTable.inviteToken,
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
      isOwner: roleIncludesOwner(currentMember.role),
    },
    members,
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
      ...dynamicRoles.map((role) => {
        const builtIn = isProtectedOrganizationRoleName(role.role)
        return {
          id: role.id,
          role: role.role,
          permission: parsePermissionRecord(role.permission),
          builtIn,
          protected: builtIn,
          createdAt: role.createdAt,
          updatedAt: role.updatedAt,
        }
      }),
    ],
    teams,
  } satisfies OrganizationContext
}

async function listOrganizationTeams(organizationId: OrgId) {
  const [teams, scimManagedTeamIds] = await Promise.all([
    db
      .select({
        id: TeamTable.id,
        name: TeamTable.name,
        createdAt: TeamTable.createdAt,
        updatedAt: TeamTable.updatedAt,
      })
      .from(TeamTable)
      .where(eq(TeamTable.organizationId, organizationId))
      .orderBy(asc(TeamTable.createdAt)),
    getScimManagedTeamIds(organizationId),
  ])

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
    if (!membership.orgMembershipId) {
      continue
    }
    const existing = memberIdsByTeamId.get(membership.teamId) ?? []
    existing.push(membership.orgMembershipId)
    memberIdsByTeamId.set(membership.teamId, existing)
  }

  return teams.map((team) => ({
    ...team,
    memberIds: memberIdsByTeamId.get(team.id) ?? [],
    managedByScim: scimManagedTeamIds.has(team.id),
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

function memberNotFound(): MemberMutationFailure {
  return {
    ok: false,
    error: "member_not_found",
    message: "The organization member could not be found.",
  }
}

function ownershipTransferFailure(
  error: OwnershipTransferFailure["error"],
  message: string,
): OwnershipTransferFailure {
  return { ok: false, error, message }
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

export async function updateOrganizationMemberRole(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
  nextRole: string
}): Promise<MemberRoleUpdateResult> {
  const updated = await db.transaction(async (tx): Promise<MemberRoleUpdateResult> => {
    const activeRows = await tx
      .select({ member: MemberTable, userId: AuthUserTable.id })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
      .for("update")

    const memberRow = activeRows.find((row) => row.member.id === input.memberId) ?? null
    if (!memberRow) {
      return memberNotFound()
    }

    const validation = validateOrganizationMemberRoleChange({
      member: memberRow.member,
      activeMembers: activeRows.map((row) => ({
        id: row.member.id,
        role: row.member.role,
        userId: row.userId,
      })),
      nextRole: input.nextRole,
    })
    if (!validation.ok) {
      return validation
    }

    if (memberRow.member.role === input.nextRole) {
      return {
        ok: true,
        member: memberRow.member,
        previousRole: memberRow.member.role,
        nextRole: input.nextRole,
        changed: false,
      }
    }

    await tx
      .update(MemberTable)
      .set({ role: input.nextRole })
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))

    return {
      ok: true,
      member: memberRow.member,
      previousRole: memberRow.member.role,
      nextRole: input.nextRole,
      changed: true,
    }
  })

  if (updated.ok && updated.changed) {
    // Role edits change authorization decisions served from membership cache.
    await cache.org.deleteMemberList(input.organizationId)
    if (updated.member.userId) {
      await cache.org.deleteMembership({ organizationId: input.organizationId, userId: updated.member.userId })
    }
    await revokeOrganizationApiKeysForMember({
      organizationId: input.organizationId,
      orgMembershipId: updated.member.id,
      userId: updated.member.userId,
    })
    // Revocation prevents a live session from retaining access it just lost.
    // An upgrade removes no access, so there is nothing to revoke.
    if (shouldRevokeSessionsForRoleChange(updated.previousRole, updated.nextRole)) {
      await revokeMembershipSessionCredentials({
        organizationId: input.organizationId,
        userId: updated.member.userId,
      })
    }
  }

  return updated
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
    return ownershipTransferFailure(
      "owner_transfer_invalid",
      "Choose a different active member to become workspace owner.",
    )
  }

  const transfer: OwnershipTransferCommitResult = await db.transaction(async (tx): Promise<OwnershipTransferCommitResult> => {
    const memberRows = await tx
      .select({ member: MemberTable, userId: AuthUserTable.id })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(
        eq(MemberTable.organizationId, input.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .for("update")

    const currentOwnerRow = memberRows.find((row) => row.member.id === input.currentOwnerMemberId) ?? null
    if (!currentOwnerRow || !currentOwnerRow.userId || !roleIncludesOwner(currentOwnerRow.member.role)) {
      return ownershipTransferFailure(
        "owner_not_found",
        "The current workspace owner could not be found.",
      )
    }

    const targetRow = memberRows.find((row) => row.member.id === input.targetMemberId) ?? null
    if (!targetRow || !targetRow.userId) {
      return ownershipTransferFailure(
        "target_member_not_found",
        "Choose an active member to become workspace owner.",
      )
    }

    if (roleIncludesOwner(targetRow.member.role)) {
      return ownershipTransferFailure(
        "owner_transfer_invalid",
        "This member is already a workspace owner.",
      )
    }

    if (!roleIncludesSuperAdmin(targetRow.member.role)) {
      return ownershipTransferFailure(
        "owner_transfer_invalid",
        "Choose an active workspace super-admin to become owner.",
      )
    }

    const roles = getRoleValueAfterOwnershipTransfer({
      currentRole: currentOwnerRow.member.role,
      targetRole: targetRow.member.role,
    })
    const demotedOwnerRows = memberRows.filter((row) => row.member.id !== targetRow.member.id && roleIncludesOwner(row.member.role))
    const demotedRoleByMemberId = new Map<string, string>()

    for (const ownerRow of demotedOwnerRows) {
      const ownerRoles = getRoleValueAfterOwnershipTransfer({
        currentRole: ownerRow.member.role,
        targetRole: targetRow.member.role,
      })
      demotedRoleByMemberId.set(ownerRow.member.id, ownerRoles.previousOwnerRole)
      await tx
        .update(MemberTable)
        .set({ role: ownerRoles.previousOwnerRole })
        .where(eq(MemberTable.id, ownerRow.member.id))
    }

    await tx
      .update(MemberTable)
      .set({ role: roles.newOwnerRole })
      .where(eq(MemberTable.id, targetRow.member.id))

    return {
      ok: true,
      previousOwner: currentOwnerRow.member,
      newOwner: targetRow.member,
      previousOwnerRole: demotedRoleByMemberId.get(currentOwnerRow.member.id) ?? roles.previousOwnerRole,
      newOwnerRole: roles.newOwnerRole,
      previousOwnerCount: demotedOwnerRows.length,
      demotedOwners: demotedOwnerRows.map((row) => row.member),
    }
  })

  if (!transfer.ok) {
    return transfer
  }

  // Ownership transfer edits multiple member roles; clear all org membership keys.
  await cache.org.deleteMembers(input.organizationId)

  for (const ownerRow of transfer.demotedOwners) {
    await revokeOrganizationApiKeysForMember({
      organizationId: input.organizationId,
      orgMembershipId: ownerRow.id,
      userId: ownerRow.userId,
    })
    await revokeMembershipSessionCredentials({
      organizationId: input.organizationId,
      userId: ownerRow.userId,
    })
  }

  await revokeOrganizationApiKeysForMember({
    organizationId: input.organizationId,
    orgMembershipId: transfer.newOwner.id,
    userId: transfer.newOwner.userId,
  })
  await revokeMembershipSessionCredentials({
    organizationId: input.organizationId,
    userId: transfer.newOwner.userId,
  })

  return {
    ok: true,
    previousOwner: transfer.previousOwner,
    newOwner: transfer.newOwner,
    previousOwnerRole: transfer.previousOwnerRole,
    newOwnerRole: transfer.newOwnerRole,
    previousOwnerCount: transfer.previousOwnerCount,
  }
}

export async function removeOrganizationMember(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
  removedByOrgMemberId?: MemberRow["id"]
}): Promise<MemberMutationResult> {
  const removed = await db.transaction(async (tx): Promise<MemberMutationResult> => {
    const activeRows = await tx
      .select({ member: MemberTable, userId: AuthUserTable.id })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
      .for("update")

    const memberRow = activeRows.find((row) => row.member.id === input.memberId) ?? null
    if (!memberRow) {
      return memberNotFound()
    }

    const validation = validateOrganizationMemberRemoval({
      member: memberRow.member,
      activeMembers: activeRows.map((row) => ({
        id: row.member.id,
        role: row.member.role,
        userId: row.userId,
      })),
    })
    if (!validation.ok) {
      return validation
    }

    const member = memberRow.member

    await tx
      .delete(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, member.id),
      ))

    await tx
      .delete(LlmProviderMemberCredentialTable)
      .where(and(
        eq(LlmProviderMemberCredentialTable.organizationId, input.organizationId),
        eq(LlmProviderMemberCredentialTable.orgMembershipId, member.id),
      ))

    await tx
      .delete(TeamMemberTable)
      .where(eq(TeamMemberTable.orgMembershipId, member.id))

    await tx
      .delete(LlmProviderAccessTable)
      .where(eq(LlmProviderAccessTable.orgMembershipId, member.id))

    await tx
      .update(MemberTable)
      .set({ removedAt: new Date(), removedByOrgMember: input.removedByOrgMemberId ?? null })
      .where(and(eq(MemberTable.id, member.id), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))

    return { ok: true, member }
  })

  if (!removed.ok) {
    return removed
  }

  await revokeOrganizationApiKeysForMember({
    organizationId: input.organizationId,
    orgMembershipId: removed.member.id,
    userId: removed.member.userId,
  })
  await revokeMembershipSessionCredentials({
    organizationId: input.organizationId,
    userId: removed.member.userId,
  })

  await runPostOrganizationMemberChangeHooks({ organizationId: input.organizationId, memberId: removed.member.id, change: "removed" })

  return removed
}
