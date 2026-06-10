import { and, asc, count, desc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AuthAccountTable,
  AuthUserTable,
  InvitationTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { ensureEntraSsoMembership } from "./entra-sso.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { DEFAULT_ORGANIZATION_LIMITS, normalizeOrganizationMetadata, serializeOrganizationMetadata } from "./organization-limits.js"
import { denDefaultDynamicOrganizationRoles, denOrganizationStaticRoles } from "./organization-access.js"
import { ensureDefaultDesktopPolicyForOrganization } from "./desktop-policies.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type SessionId = typeof AuthSessionTable.$inferSelect.id
type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberRow = typeof MemberTable.$inferSelect
type MemberId = MemberRow["id"]
type InvitationRow = typeof InvitationTable.$inferSelect
export type AllowedEmailDomains = string[] | null

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
    isOwner: boolean
  }
  members: Array<{
    id: MemberId
    userId: UserId
    role: string
    createdAt: Date
    isOwner: boolean
    user: {
      id: UserId
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
    permission: Record<string, string[]>
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

function hasRole(roleValue: string, roleName: string) {
  return splitRoles(roleValue).includes(roleName)
}

export function roleIncludesOwner(roleValue: string) {
  return hasRole(roleValue, "owner")
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
    const parsed = JSON.parse(value) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([resource, actions]) => [
          resource,
          actions.filter((entry: unknown): entry is string => typeof entry === "string"),
        ]),
    )
  } catch {
    return {}
  }
}

export function serializePermissionRecord(value: Record<string, string[]>) {
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
  return Object.fromEntries(
    Object.entries(value).map(([resource, actions]) => [resource, [...actions]]),
  ) as Record<string, string[]>
}

async function listMembershipRows(userId: UserId) {
  return db
    .select()
    .from(MemberTable)
    .where(eq(MemberTable.userId, userId))
    .orderBy(asc(MemberTable.createdAt))
}

function getInvitationStatus(invitation: Pick<InvitationRow, "status" | "expiresAt">): InvitationStatus {
  if (invitation.status !== "pending") {
    return invitation.status as Exclude<InvitationStatus, "expired">
  }

  return invitation.expiresAt > new Date() ? "pending" : "expired"
}

export function parseInvitationLookupIdentifier(invitationIdOrTokenRaw: string) {
  const invitationIdOrToken = invitationIdOrTokenRaw.trim()
  let invitationId: InvitationRow["id"] | null = null
  try {
    invitationId = normalizeDenTypeId("invitation", invitationIdOrToken)
  } catch {}

  return { invitationId, inviteToken: invitationIdOrToken }
}

function getInvitationLookupWhere(invitationIdOrTokenRaw: string) {
  const { invitationId, inviteToken } = parseInvitationLookupIdentifier(invitationIdOrTokenRaw)

  return invitationId
    ? or(eq(InvitationTable.id, invitationId), eq(InvitationTable.inviteToken, inviteToken))
    : eq(InvitationTable.inviteToken, inviteToken)
}

async function getInvitationById(invitationIdRaw: string) {
  const rows = await db
    .select()
    .from(InvitationTable)
    .where(getInvitationLookupWhere(invitationIdRaw))
    .limit(1)

  return rows[0] ?? null
}

async function findActiveMemberForUser(input: {
  organizationId: OrgId
  userId: UserId
}): Promise<MemberRow | null> {
  const rows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
    .limit(1)

  return rows[0] ?? null
}

async function claimInvitationPlaceholderMember(input: {
  invitation: InvitationRow
  userId: UserId
  role: string
}): Promise<MemberRow | null> {
  const placeholderRows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.invitation.organizationId),
      eq(MemberTable.inviteId, input.invitation.id),
      isNull(MemberTable.userId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)

  const placeholder = placeholderRows[0]
  if (!placeholder) {
    return null
  }

  await db
    .update(MemberTable)
    .set({ userId: input.userId, role: input.role, joinedAt: new Date() })
    .where(eq(MemberTable.id, placeholder.id))

  const claimedRows = await db
    .select()
    .from(MemberTable)
    .where(eq(MemberTable.id, placeholder.id))
    .limit(1)

  return claimedRows[0] ?? null
}

async function ensureInvitationTeamMembership(input: {
  invitation: InvitationRow
  memberId: MemberId
}) {
  if (!input.invitation.teamId) {
    return
  }

  const teams = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(eq(TeamTable.id, input.invitation.teamId))
    .limit(1)

  if (!teams[0]) {
    return
  }

  const existingTeamMember = await db
    .select({ id: TeamMemberTable.id })
    .from(TeamMemberTable)
    .where(and(eq(TeamMemberTable.teamId, input.invitation.teamId), eq(TeamMemberTable.orgMembershipId, input.memberId)))
    .limit(1)

  if (existingTeamMember[0]) {
    return
  }

  await db.insert(TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId: input.invitation.teamId,
    orgMembershipId: input.memberId,
  })
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

function normalizeAssignableRole(input: string, availableRoles: Set<string>) {
  const roles = splitRoles(input).filter((role) => availableRoles.has(role))
  if (roles.length === 0) {
    return "member"
  }
  return roles.join(",")
}

export async function listAssignableRoles(orgId: OrgId) {
  await ensureDefaultDynamicRoles(orgId)

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
}) {
  const existing = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
    .limit(1)

  if (existing.length > 0) {
    return existing[0]
  }

  await db.insert(MemberTable).values({
    id: createDenTypeId("member"),
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
  })

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

async function resolveEntraAutoJoinOrganizationId(input: {
  organizationId?: string
  organizationSlug?: string
}): Promise<OrgId | null> {
  if (input.organizationId) {
    try {
      const organizationId = normalizeDenTypeId("organization", input.organizationId)
      const rows = await db
        .select({ id: OrganizationTable.id })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, organizationId))
        .limit(1)

      return rows[0]?.id ?? null
    } catch {
      return null
    }
  }

  const slug = input.organizationSlug?.trim()
  if (!slug) {
    return null
  }

  const rows = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.slug, slug))
    .limit(2)

  return rows.length === 1 ? rows[0].id : null
}

async function latestMicrosoftIdTokenForUser(userId: UserId) {
  const rows = await db
    .select({ idToken: AuthAccountTable.idToken })
    .from(AuthAccountTable)
    .where(and(eq(AuthAccountTable.userId, userId), eq(AuthAccountTable.providerId, "microsoft")))
    .orderBy(desc(AuthAccountTable.updatedAt))
    .limit(1)

  return rows[0]?.idToken ?? null
}

export async function ensureEntraSsoMembershipForAccount(input: {
  userId: UserId
  providerId?: string | null
  idToken?: string | null
}) {
  const idToken = input.idToken ?? await latestMicrosoftIdTokenForUser(input.userId)
  const result = await ensureEntraSsoMembership({
    userId: input.userId,
    providerId: input.providerId,
    idToken,
    config: env.entra,
    deps: {
      resolveOrganizationId: async (selector) => resolveEntraAutoJoinOrganizationId(selector) as Promise<string | null>,
      getExistingMember: async ({ organizationId, userId }) => {
        const existing = await db
          .select()
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, organizationId as OrgId), eq(MemberTable.userId, userId as UserId), isNull(MemberTable.removedAt)))
          .limit(1)

        return existing[0] ?? null
      },
      createMember: async ({ organizationId, userId, role }) => insertMemberIfMissing({
        organizationId: organizationId as OrgId,
        userId: userId as UserId,
        role,
      }),
      updateMemberRole: async ({ memberId, role }) => {
        await db
          .update(MemberTable)
          .set({ role })
          .where(eq(MemberTable.id, memberId as MemberId))

        const updatedRows = await db
          .select()
          .from(MemberTable)
          .where(eq(MemberTable.id, memberId as MemberId))
          .limit(1)
        if (!updatedRows[0]) {
          throw new Error("failed_to_update_member")
        }
        return updatedRows[0]
      },
      ensureDefaultRoles: async (organizationId) => ensureDefaultDynamicRoles(organizationId as OrgId),
      isOwnerRole: roleIncludesOwner,
    },
  })

  if (result.status === "created") {
    await runPostOrganizationMemberChangeHooks({
      organizationId: result.member.organizationId,
      memberId: result.member.id,
      change: "added",
    })
  }

  return result
}

async function acceptInvitation(invitation: InvitationRow, userId: UserId) {
  const availableRoles = await listAssignableRoles(invitation.organizationId)
  const role = normalizeAssignableRole(invitation.role, availableRoles)

  let createdMember = false
  let member = await findActiveMemberForUser({ organizationId: invitation.organizationId, userId })

  if (!member) {
    member = await claimInvitationPlaceholderMember({ invitation, userId, role })
    createdMember = Boolean(member)
  }

  if (!member) {
    member = await insertMemberIfMissing({
      organizationId: invitation.organizationId,
      userId,
      role,
    })
    createdMember = true
  }

  await ensureInvitationTeamMembership({ invitation, memberId: member.id })

  await db
    .update(InvitationTable)
    .set({ status: "accepted" })
    .where(eq(InvitationTable.id, invitation.id))

  return { member, createdMember }
}

export async function acceptInvitationForUser(input: {
  userId: UserId
  email: string
  invitationId: string | null
}) {
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

  if (getInvitationStatus(invitation) !== "pending") {
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
  if (accepted.createdMember) {
    await runPostOrganizationMemberChangeHooks({ organizationId: invitation.organizationId, memberId: accepted.member.id, change: "added" })
  }
  return {
    invitation,
    member: accepted.member,
  }
}

export async function getInvitationPreview(invitationIdRaw: string): Promise<InvitationPreview | null> {
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
    .where(getInvitationLookupWhere(invitationIdRaw))
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
    slug: organizationId,
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

export async function ensureUserOrgAccess(input: {
  userId: UserId
}) {
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
  if (input.allowedDesktopVersions !== undefined || input.requireSso !== undefined) {
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
    .where(eq(MemberTable.userId, userId))
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

  const orgs = await listUserOrgs(input.userId)

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

  activeOrgId ??= orgs[0]?.id ?? null

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

  await ensureDefaultDynamicRoles(organization.id)

  const members = await db
    .select({
      id: MemberTable.id,
      userId: MemberTable.userId,
      role: MemberTable.role,
      createdAt: MemberTable.createdAt,
      user: {
        id: AuthUserTable.id,
        email: AuthUserTable.email,
        name: AuthUserTable.name,
        image: AuthUserTable.image,
      },
    })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(eq(MemberTable.organizationId, organization.id))
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
      userId: input.userId,
      role: currentMember.role,
      createdAt: currentMember.createdAt,
      isOwner: roleIncludesOwner(currentMember.role),
    },
    members: members.map((member) => ({
      id: member.id,
      userId: member.user.id,
      role: member.role,
      createdAt: member.createdAt,
      user: member.user,
      isOwner: roleIncludesOwner(member.role),
    })),
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

export async function removeOrganizationMember(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
  removedByOrgMemberId?: MemberRow["id"]
}) {
  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)

  const member = memberRows[0] ?? null
  if (!member) {
    return null
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(TeamMemberTable)
      .where(eq(TeamMemberTable.orgMembershipId, member.id))

    await tx
      .update(MemberTable)
      .set({ removedAt: new Date(), removedByOrgMember: input.removedByOrgMemberId ?? null, userId: null })
      .where(and(eq(MemberTable.id, member.id), isNull(MemberTable.removedAt)))
  })

  await runPostOrganizationMemberChangeHooks({ organizationId: input.organizationId, memberId: member.id, change: "removed" })

  return member
}
