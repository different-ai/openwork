import { and, asc, eq } from "./db/drizzle.js"
import { db } from "./db/index.js"
import {
  AuthSessionTable,
  AuthUserTable,
  InvitationTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  TeamMemberTable,
  TeamTable,
} from "./db/schema.js"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { denDefaultDynamicOrganizationRoles, denOrganizationStaticRoles } from "./organization-access.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type SessionId = typeof AuthSessionTable.$inferSelect.id
type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberRow = typeof MemberTable.$inferSelect
type InvitationRow = typeof InvitationTable.$inferSelect

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
  }
}

export type UserOrgSummary = {
  id: OrgId
  name: string
  slug: string
  logo: string | null
  metadata: string | null
  role: string
  membershipId: string
  createdAt: Date
  updatedAt: Date
}

export type OrganizationContext = {
  organization: {
    id: OrgId
    name: string
    slug: string
    logo: string | null
    metadata: string | null
    createdAt: Date
    updatedAt: Date
  }
  currentMember: {
    id: string
    userId: UserId
    role: string
    createdAt: Date
    isOwner: boolean
  }
  members: Array<{
    id: string
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

function buildPersonalOrgName(email: string) {
  const localPart = email.split("@")[0] ?? "Personal"
  const normalized = titleCase(localPart.replace(/[._-]+/g, " ").trim()) || "Personal"
  const suffix = normalized.endsWith("s") ? "' Org" : "'s Org"
  return `${normalized}${suffix}`
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

async function getInvitationById(invitationIdRaw: string) {
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
  const existingRows = await db
    .select({ role: OrganizationRoleTable.role })
    .from(OrganizationRoleTable)
    .where(eq(OrganizationRoleTable.organizationId, orgId))

  const existing = new Set(existingRows.map((row) => row.role))

  for (const [role, permission] of Object.entries(denDefaultDynamicOrganizationRoles)) {
    if (existing.has(role)) {
      continue
    }

    await db.insert(OrganizationRoleTable).values({
      id: createDenTypeId("organizationRole"),
      organizationId: orgId,
      role,
      permission: serializePermissionRecord(permission),
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
    .where(
      and(
        eq(MemberTable.organizationId, input.organizationId),
        eq(MemberTable.userId, input.userId),
      ),
    )
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
    .where(
      and(
        eq(MemberTable.organizationId, input.organizationId),
        eq(MemberTable.userId, input.userId),
      ),
    )
    .limit(1)

  if (!created[0]) {
    throw new Error("failed_to_create_member")
  }

  return created[0]
}

async function acceptInvitation(invitation: InvitationRow, userId: UserId) {
  const availableRoles = await listAssignableRoles(invitation.organizationId)
  const role = normalizeAssignableRole(invitation.role, availableRoles)

  const member = await insertMemberIfMissing({
    organizationId: invitation.organizationId,
    userId,
    role,
  })

  if (invitation.teamId) {
    const teams = await db
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(eq(TeamTable.id, invitation.teamId))
      .limit(1)

    if (teams[0]) {
      const existingTeamMember = await db
        .select({ id: TeamMemberTable.id })
        .from(TeamMemberTable)
        .where(
          and(
            eq(TeamMemberTable.teamId, invitation.teamId),
            eq(TeamMemberTable.userId, userId),
          ),
        )
        .limit(1)

      if (!existingTeamMember[0]) {
        await db.insert(TeamMemberTable).values({
          id: createDenTypeId("teamMember"),
          teamId: invitation.teamId,
          userId,
        })
      }
    }
  }

  await db
    .update(InvitationTable)
    .set({ status: "accepted" })
    .where(eq(InvitationTable.id, invitation.id))

  return member
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

  const member = await acceptInvitation(invitation, input.userId)
  return {
    invitation,
    member,
  }
}

export async function getInvitationPreview(invitationIdRaw: string): Promise<InvitationPreview | null> {
  let invitationId
  try {
    invitationId = normalizeDenTypeId("invitation", invitationIdRaw)
  } catch {
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
      },
    })
    .from(InvitationTable)
    .innerJoin(OrganizationTable, eq(InvitationTable.organizationId, OrganizationTable.id))
    .where(eq(InvitationTable.id, invitationId))
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
    organization: row.organization,
  }
}

async function createOrganizationRecord(input: {
  userId: UserId
  name: string
  logo?: string | null
  metadata?: string | null
}) {
  const organizationId = createDenTypeId("organization")

  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: input.name,
    slug: organizationId,
    logo: input.logo ?? null,
    metadata: input.metadata ?? null,
  })

  await db.insert(MemberTable).values({
    id: createDenTypeId("member"),
    organizationId,
    userId: input.userId,
    role: "owner",
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

export async function createOrganizationForUser(input: {
  userId: UserId
  name: string
}) {
  return createOrganizationRecord({
    userId: input.userId,
    name: input.name.trim(),
  })
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
        metadata: OrganizationTable.metadata,
        createdAt: OrganizationTable.createdAt,
        updatedAt: OrganizationTable.updatedAt,
      },
    })
    .from(MemberTable)
    .innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
    .where(eq(MemberTable.userId, userId))
    .orderBy(asc(MemberTable.createdAt))

  return memberships.map((row) => ({
    id: row.organization.id,
    name: row.organization.name,
    slug: row.organization.slug,
    logo: row.organization.logo,
    metadata: row.organization.metadata,
    role: row.role,
    membershipId: row.membershipId,
    createdAt: row.organization.createdAt,
    updatedAt: row.organization.updatedAt,
  })) satisfies UserOrgSummary[]
}

export async function resolveUserOrganizationsForSession(input: {
  sessionId: SessionId | null
  activeOrganizationId?: string | null
  userId: UserId
  email: string
  name?: string | null
}) {
  await ensureUserOrgAccess({
    userId: input.userId,
  })

  let orgs = await listUserOrgs(input.userId)
  if (orgs.length === 0) {
    await createOrganizationRecord({
      userId: input.userId,
      name: buildPersonalOrgName(input.email),
    })

    orgs = await listUserOrgs(input.userId)
  }

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

  if (input.sessionId && activeOrgId && activeOrgId !== input.activeOrganizationId) {
    await setSessionActiveOrganization(input.sessionId, activeOrgId)
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
  organizationSlug: string
}) {
  const organizationRows = await db
    .select()
    .from(OrganizationTable)
    .where(eq(OrganizationTable.slug, input.organizationSlug))
    .limit(1)

  const organization = organizationRows[0]
  if (!organization) {
    return null
  }

  const currentMemberRows = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.organizationId, organization.id),
        eq(MemberTable.userId, input.userId),
      ),
    )
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

  const builtInDynamicRoleNames = new Set(Object.keys(denDefaultDynamicOrganizationRoles))

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      metadata: organization.metadata,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    },
    currentMember: {
      id: currentMember.id,
      userId: currentMember.userId,
      role: currentMember.role,
      createdAt: currentMember.createdAt,
      isOwner: roleIncludesOwner(currentMember.role),
    },
    members: members.map((member) => ({
      ...member,
      isOwner: roleIncludesOwner(member.role),
    })),
    invitations,
    roles: [
      {
        id: "builtin-owner",
        role: "owner",
        permission: denOrganizationStaticRoles.owner.statements,
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
  } satisfies OrganizationContext
}

export async function removeOrganizationMember(input: {
  organizationId: OrgId
  memberId: MemberRow["id"]
}) {
  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.id, input.memberId),
        eq(MemberTable.organizationId, input.organizationId),
      ),
    )
    .limit(1)

  const member = memberRows[0] ?? null
  if (!member) {
    return null
  }

  const teams = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(eq(TeamTable.organizationId, input.organizationId))

  await db.transaction(async (tx) => {
    for (const team of teams) {
      await tx
        .delete(TeamMemberTable)
        .where(
          and(
            eq(TeamMemberTable.teamId, team.id),
            eq(TeamMemberTable.userId, member.userId),
          ),
        )
    }

    await tx.delete(MemberTable).where(eq(MemberTable.id, member.id))
  })

  return member
}
