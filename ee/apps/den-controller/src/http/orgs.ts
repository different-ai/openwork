import express from "express"
import { z } from "zod"
import { and, desc, eq, gt } from "../db/drizzle.js"
import { db } from "../db/index.js"
import {
  AuthUserTable,
  InvitationTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  TempTemplateSharingTable,
} from "../db/schema.js"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { sendDenOrganizationInvitationEmail } from "../email.js"
import { env } from "../env.js"
import {
  acceptInvitationForUser,
  createOrganizationForUser,
  getInvitationPreview,
  getOrganizationContextForUser,
  listAssignableRoles,
  removeOrganizationMember,
  roleIncludesOwner,
  serializePermissionRecord,
  setSessionActiveOrganization,
} from "../orgs.js"
import { asyncRoute } from "./errors.js"
import { getRequestSession } from "./session.js"

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
})

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.string().trim().min(1).max(64),
})

const acceptInvitationSchema = z.object({
  id: z.string().trim().min(1),
})

const updateMemberRoleSchema = z.object({
  role: z.string().trim().min(1).max(64),
})

const permissionSchema = z.record(z.string(), z.array(z.string()))

type InvitationId = typeof InvitationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type OrganizationRoleId = typeof OrganizationRoleTable.$inferSelect.id
type TemplateSharingId = typeof TempTemplateSharingTable.$inferSelect.id

const createRoleSchema = z.object({
  roleName: z.string().trim().min(2).max(64),
  permission: permissionSchema,
})

const updateRoleSchema = z.object({
  roleName: z.string().trim().min(2).max(64).optional(),
  permission: permissionSchema.optional(),
})

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  templateData: z.unknown(),
})

function splitRoles(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function memberHasRole(value: string, role: string) {
  return splitRoles(value).includes(role)
}

function normalizeRoleName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
}

function replaceRoleValue(value: string, previousRole: string, nextRole: string | null) {
  const existing = splitRoles(value)
  const remaining = existing.filter((role) => role !== previousRole)

  if (nextRole && !remaining.includes(nextRole)) {
    remaining.push(nextRole)
  }

  return remaining[0] ? remaining.join(",") : "member"
}

function getInvitationOrigin() {
  return env.betterAuthTrustedOrigins.find((origin) => origin !== "*") ?? env.betterAuthUrl
}

function buildInvitationLink(invitationId: string) {
  return new URL(`/join-org?invite=${encodeURIComponent(invitationId)}`, getInvitationOrigin()).toString()
}

function parseTemplateJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function requireSession(req: express.Request, res: express.Response) {
  const session = await getRequestSession(req)
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }

  const sessionId = typeof session.session?.id === "string"
    ? normalizeDenTypeId("session", session.session.id)
    : null

  return {
    ...session,
    sessionId,
    user: {
      ...session.user,
      id: normalizeDenTypeId("user", session.user.id),
    },
  }
}

async function requireOrganizationContext(req: express.Request, res: express.Response) {
  const session = await requireSession(req, res)
  if (!session) {
    return null
  }

  const organizationSlug = req.params.orgSlug?.trim()
  if (!organizationSlug) {
    res.status(400).json({ error: "organization_slug_required" })
    return null
  }

  const context = await getOrganizationContextForUser({
    userId: session.user.id,
    organizationSlug,
  })

  if (!context) {
    res.status(404).json({ error: "organization_not_found" })
    return null
  }

  if (session.sessionId) {
    await setSessionActiveOrganization(session.sessionId, context.organization.id)
  }

  return {
    session,
    context,
  }
}

function ensureOwner(context: Awaited<ReturnType<typeof requireOrganizationContext>>, res: express.Response) {
  if (!context) {
    return false
  }

  if (!context.context.currentMember.isOwner) {
    res.status(403).json({
      error: "forbidden",
      message: "Only organization owners can manage members and roles.",
    })
    return false
  }

  return true
}

function ensureInviteManager(context: Awaited<ReturnType<typeof requireOrganizationContext>>, res: express.Response) {
  if (!context) {
    return false
  }

  if (context.context.currentMember.isOwner || memberHasRole(context.context.currentMember.role, "admin")) {
    return true
  }

  res.status(403).json({
    error: "forbidden",
    message: "Only organization owners and admins can invite members.",
  })
  return false
}

export const orgsRouter = express.Router()

orgsRouter.post("/", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) {
    return
  }

  const parsed = createOrganizationSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const organizationId = await createOrganizationForUser({
    userId: session.user.id,
    name: parsed.data.name,
  })

  if (session.sessionId) {
    await setSessionActiveOrganization(session.sessionId, organizationId)
  }

  const context = await getOrganizationContextForUser({
    userId: session.user.id,
    organizationSlug: organizationId,
  })

  res.status(201).json({ organization: context?.organization ?? null })
}))

orgsRouter.get("/invitations/preview", asyncRoute(async (req, res) => {
  const invitationIdRaw = typeof req.query.id === "string" ? req.query.id.trim() : ""
  const invitation = invitationIdRaw ? await getInvitationPreview(invitationIdRaw) : null

  if (!invitation) {
    res.status(404).json({ error: "invitation_not_found" })
    return
  }

  res.json(invitation)
}))

orgsRouter.post("/invitations/accept", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) {
    return
  }

  const parsed = acceptInvitationSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const accepted = await acceptInvitationForUser({
    userId: session.user.id,
    email: session.user.email ?? `${session.user.id}@placeholder.local`,
    invitationId: parsed.data.id,
  })

  if (!accepted) {
    res.status(404).json({ error: "invitation_not_found" })
    return
  }

  if (session.sessionId) {
    await setSessionActiveOrganization(session.sessionId, accepted.member.organizationId)
  }

  const orgRows = await db
    .select({ slug: OrganizationTable.slug })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, accepted.member.organizationId))
    .limit(1)

  res.json({
    accepted: true,
    organizationId: accepted.member.organizationId,
    organizationSlug: orgRows[0]?.slug ?? null,
    invitationId: accepted.invitation.id,
  })
}))

orgsRouter.get("/:orgSlug/context", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload) {
    return
  }

  res.json(payload.context)
}))

orgsRouter.post("/:orgSlug/invitations", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureInviteManager(payload, res)) {
    return
  }

  const parsed = inviteMemberSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const email = parsed.data.email.trim().toLowerCase()
  const availableRoles = await listAssignableRoles(payload.context.organization.id)
  const role = normalizeRoleName(parsed.data.role)
  if (!availableRoles.has(role)) {
    res.status(400).json({
      error: "invalid_role",
      message: "Choose one of the existing organization roles.",
    })
    return
  }

  const existingMembers = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(
      and(
        eq(MemberTable.organizationId, payload.context.organization.id),
        eq(AuthUserTable.email, email),
      ),
    )
    .limit(1)

  if (existingMembers[0]) {
    res.status(409).json({
      error: "member_exists",
      message: "That email address is already a member of this organization.",
    })
    return
  }

  const existingInvitation = await db
    .select()
    .from(InvitationTable)
    .where(
      and(
        eq(InvitationTable.organizationId, payload.context.organization.id),
        eq(InvitationTable.email, email),
        eq(InvitationTable.status, "pending"),
        gt(InvitationTable.expiresAt, new Date()),
      ),
    )
    .limit(1)

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
  const invitationId = existingInvitation[0]?.id ?? createInvitationId()

  if (existingInvitation[0]) {
    await db
      .update(InvitationTable)
      .set({
        role,
        inviterId: payload.session.user.id,
        expiresAt,
      })
      .where(eq(InvitationTable.id, existingInvitation[0].id))
  } else {
    await db.insert(InvitationTable).values({
      id: invitationId,
      organizationId: payload.context.organization.id,
      email,
      role,
      status: "pending",
      inviterId: payload.session.user.id,
      expiresAt,
    })
  }

  await sendDenOrganizationInvitationEmail({
    email,
    inviteLink: buildInvitationLink(invitationId),
    invitedByName: payload.session.user.name ?? payload.session.user.email ?? "OpenWork",
    invitedByEmail: payload.session.user.email ?? "",
    organizationName: payload.context.organization.name,
    role,
  })

  res.status(existingInvitation[0] ? 200 : 201).json({
    invitationId,
    email,
    role,
    expiresAt,
  })
}))

orgsRouter.post("/:orgSlug/invitations/:invitationId/cancel", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureInviteManager(payload, res)) {
    return
  }

  let invitationId: InvitationId
  try {
    invitationId = normalizeDenTypeId("invitation", req.params.invitationId)
  } catch {
    res.status(404).json({ error: "invitation_not_found" })
    return
  }

  const invitationRows = await db
    .select({ id: InvitationTable.id, status: InvitationTable.status })
    .from(InvitationTable)
    .where(
      and(
        eq(InvitationTable.id, invitationId),
        eq(InvitationTable.organizationId, payload.context.organization.id),
      ),
    )
    .limit(1)

  if (!invitationRows[0]) {
    res.status(404).json({ error: "invitation_not_found" })
    return
  }

  await db
    .update(InvitationTable)
    .set({ status: "canceled" })
    .where(eq(InvitationTable.id, invitationId))

  res.json({ success: true })
}))

orgsRouter.post("/:orgSlug/members/:memberId/role", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureOwner(payload, res)) {
    return
  }

  const parsed = updateMemberRoleSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  let memberId: MemberId
  try {
    memberId = normalizeDenTypeId("member", req.params.memberId)
  } catch {
    res.status(404).json({ error: "member_not_found" })
    return
  }

  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.id, memberId),
        eq(MemberTable.organizationId, payload.context.organization.id),
      ),
    )
    .limit(1)

  const member = memberRows[0]
  if (!member) {
    res.status(404).json({ error: "member_not_found" })
    return
  }

  if (roleIncludesOwner(member.role)) {
    res.status(400).json({
      error: "owner_role_locked",
      message: "The organization owner role cannot be changed.",
    })
    return
  }

  const role = normalizeRoleName(parsed.data.role)
  const availableRoles = await listAssignableRoles(payload.context.organization.id)
  if (!availableRoles.has(role)) {
    res.status(400).json({ error: "invalid_role", message: "Choose one of the existing organization roles." })
    return
  }

  await db
    .update(MemberTable)
    .set({ role })
    .where(eq(MemberTable.id, member.id))

  res.json({ success: true })
}))

orgsRouter.delete("/:orgSlug/members/:memberId", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureOwner(payload, res)) {
    return
  }

  let memberId: MemberId
  try {
    memberId = normalizeDenTypeId("member", req.params.memberId)
  } catch {
    res.status(404).json({ error: "member_not_found" })
    return
  }

  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.id, memberId),
        eq(MemberTable.organizationId, payload.context.organization.id),
      ),
    )
    .limit(1)

  const member = memberRows[0]
  if (!member) {
    res.status(404).json({ error: "member_not_found" })
    return
  }

  if (roleIncludesOwner(member.role)) {
    res.status(400).json({
      error: "owner_role_locked",
      message: "The organization owner cannot be removed.",
    })
    return
  }

  await removeOrganizationMember({
    organizationId: payload.context.organization.id,
    memberId: member.id,
  })
  res.status(204).end()
}))

orgsRouter.post("/:orgSlug/roles", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureOwner(payload, res)) {
    return
  }

  const parsed = createRoleSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const roleName = normalizeRoleName(parsed.data.roleName)
  if (roleName === "owner") {
    res.status(400).json({ error: "invalid_role", message: "Owner is managed by the system." })
    return
  }

  const existing = await db
    .select({ id: OrganizationRoleTable.id })
    .from(OrganizationRoleTable)
    .where(
      and(
        eq(OrganizationRoleTable.organizationId, payload.context.organization.id),
        eq(OrganizationRoleTable.role, roleName),
      ),
    )
    .limit(1)

  if (existing[0]) {
    res.status(409).json({ error: "role_exists", message: "That role already exists in this organization." })
    return
  }

  await db.insert(OrganizationRoleTable).values({
    id: createRoleId(),
    organizationId: payload.context.organization.id,
    role: roleName,
    permission: serializePermissionRecord(parsed.data.permission),
  })

  res.status(201).json({ success: true })
}))

orgsRouter.patch("/:orgSlug/roles/:roleId", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureOwner(payload, res)) {
    return
  }

  const parsed = updateRoleSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  let roleId: OrganizationRoleId
  try {
    roleId = normalizeDenTypeId("organizationRole", req.params.roleId)
  } catch {
    res.status(404).json({ error: "role_not_found" })
    return
  }

  const roleRows = await db
    .select()
    .from(OrganizationRoleTable)
    .where(
      and(
        eq(OrganizationRoleTable.id, roleId),
        eq(OrganizationRoleTable.organizationId, payload.context.organization.id),
      ),
    )
    .limit(1)

  const roleRow = roleRows[0]
  if (!roleRow) {
    res.status(404).json({ error: "role_not_found" })
    return
  }

  const nextRoleName = parsed.data.roleName ? normalizeRoleName(parsed.data.roleName) : roleRow.role
  if (nextRoleName === "owner") {
    res.status(400).json({ error: "invalid_role", message: "Owner is managed by the system." })
    return
  }

  if (nextRoleName !== roleRow.role) {
    const duplicate = await db
      .select({ id: OrganizationRoleTable.id })
      .from(OrganizationRoleTable)
      .where(
        and(
          eq(OrganizationRoleTable.organizationId, payload.context.organization.id),
          eq(OrganizationRoleTable.role, nextRoleName),
        ),
      )
      .limit(1)

    if (duplicate[0]) {
      res.status(409).json({ error: "role_exists", message: "That role name is already in use." })
      return
    }
  }

  const nextPermission = parsed.data.permission
    ? serializePermissionRecord(parsed.data.permission)
    : roleRow.permission

  await db
    .update(OrganizationRoleTable)
    .set({
      role: nextRoleName,
      permission: nextPermission,
    })
    .where(eq(OrganizationRoleTable.id, roleRow.id))

  if (nextRoleName !== roleRow.role) {
    const members = await db
      .select()
      .from(MemberTable)
      .where(eq(MemberTable.organizationId, payload.context.organization.id))

    for (const member of members) {
      if (!splitRoles(member.role).includes(roleRow.role)) {
        continue
      }

      await db
        .update(MemberTable)
        .set({ role: replaceRoleValue(member.role, roleRow.role, nextRoleName) })
        .where(eq(MemberTable.id, member.id))
    }

    const invitations = await db
      .select()
      .from(InvitationTable)
      .where(eq(InvitationTable.organizationId, payload.context.organization.id))

    for (const invitation of invitations) {
      if (!splitRoles(invitation.role).includes(roleRow.role)) {
        continue
      }

      await db
        .update(InvitationTable)
        .set({ role: replaceRoleValue(invitation.role, roleRow.role, nextRoleName) })
        .where(eq(InvitationTable.id, invitation.id))
    }
  }

  res.json({ success: true })
}))

orgsRouter.delete("/:orgSlug/roles/:roleId", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload || !ensureOwner(payload, res)) {
    return
  }

  let roleId: OrganizationRoleId
  try {
    roleId = normalizeDenTypeId("organizationRole", req.params.roleId)
  } catch {
    res.status(404).json({ error: "role_not_found" })
    return
  }

  const roleRows = await db
    .select()
    .from(OrganizationRoleTable)
    .where(
      and(
        eq(OrganizationRoleTable.id, roleId),
        eq(OrganizationRoleTable.organizationId, payload.context.organization.id),
      ),
    )
    .limit(1)

  const roleRow = roleRows[0]
  if (!roleRow) {
    res.status(404).json({ error: "role_not_found" })
    return
  }

  const membersUsingRole = await db
    .select({ id: MemberTable.id, role: MemberTable.role })
    .from(MemberTable)
    .where(eq(MemberTable.organizationId, payload.context.organization.id))

  if (membersUsingRole.some((member) => splitRoles(member.role).includes(roleRow.role))) {
    res.status(400).json({
      error: "role_in_use",
      message: "Update members using this role before deleting it.",
    })
    return
  }

  const invitationsUsingRole = await db
    .select({ id: InvitationTable.id, role: InvitationTable.role })
    .from(InvitationTable)
    .where(eq(InvitationTable.organizationId, payload.context.organization.id))

  if (invitationsUsingRole.some((invitation) => splitRoles(invitation.role).includes(roleRow.role))) {
    res.status(400).json({
      error: "role_in_use",
      message: "Cancel or update pending invitations using this role before deleting it.",
    })
    return
  }

  await db.delete(OrganizationRoleTable).where(eq(OrganizationRoleTable.id, roleRow.id))
  res.status(204).end()
}))

orgsRouter.post("/:orgSlug/templates", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload) {
    return
  }

  const parsed = createTemplateSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const templateId = createDenTypeId("tempTemplateSharing")
  const now = new Date()

  await db.insert(TempTemplateSharingTable).values({
    id: templateId,
    organizationId: payload.context.organization.id,
    creatorMemberId: payload.context.currentMember.id,
    creatorUserId: payload.session.user.id,
    name: parsed.data.name,
    templateJson: JSON.stringify(parsed.data.templateData),
    createdAt: now,
    updatedAt: now,
  })

  res.status(201).json({
    template: {
      id: templateId,
      name: parsed.data.name,
      templateData: parsed.data.templateData,
      createdAt: now,
      updatedAt: now,
      organizationId: payload.context.organization.id,
      creator: {
        memberId: payload.context.currentMember.id,
        userId: payload.session.user.id,
        role: payload.context.currentMember.role,
        name: payload.session.user.name,
        email: payload.session.user.email,
      },
    },
  })
}))

orgsRouter.get("/:orgSlug/templates", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload) {
    return
  }

  const templates = await db
    .select({
      template: {
        id: TempTemplateSharingTable.id,
        organizationId: TempTemplateSharingTable.organizationId,
        name: TempTemplateSharingTable.name,
        templateJson: TempTemplateSharingTable.templateJson,
        createdAt: TempTemplateSharingTable.createdAt,
        updatedAt: TempTemplateSharingTable.updatedAt,
      },
      creatorMember: {
        id: MemberTable.id,
        role: MemberTable.role,
      },
      creatorUser: {
        id: AuthUserTable.id,
        name: AuthUserTable.name,
        email: AuthUserTable.email,
        image: AuthUserTable.image,
      },
    })
    .from(TempTemplateSharingTable)
    .innerJoin(MemberTable, eq(TempTemplateSharingTable.creatorMemberId, MemberTable.id))
    .innerJoin(AuthUserTable, eq(TempTemplateSharingTable.creatorUserId, AuthUserTable.id))
    .where(eq(TempTemplateSharingTable.organizationId, payload.context.organization.id))
    .orderBy(desc(TempTemplateSharingTable.createdAt))

  res.json({
    templates: templates.map((row) => ({
      id: row.template.id,
      organizationId: row.template.organizationId,
      name: row.template.name,
      templateData: parseTemplateJson(row.template.templateJson),
      createdAt: row.template.createdAt,
      updatedAt: row.template.updatedAt,
      creator: {
        memberId: row.creatorMember.id,
        role: row.creatorMember.role,
        userId: row.creatorUser.id,
        name: row.creatorUser.name,
        email: row.creatorUser.email,
        image: row.creatorUser.image,
      },
    })),
  })
}))

orgsRouter.delete("/:orgSlug/templates/:templateId", asyncRoute(async (req, res) => {
  const payload = await requireOrganizationContext(req, res)
  if (!payload) {
    return
  }

  let templateId: TemplateSharingId
  try {
    templateId = normalizeDenTypeId("tempTemplateSharing", req.params.templateId)
  } catch {
    res.status(404).json({ error: "template_not_found" })
    return
  }

  const templateRows = await db
    .select()
    .from(TempTemplateSharingTable)
    .where(
      and(
        eq(TempTemplateSharingTable.id, templateId),
        eq(TempTemplateSharingTable.organizationId, payload.context.organization.id),
      ),
    )
    .limit(1)

  const template = templateRows[0]
  if (!template) {
    res.status(404).json({ error: "template_not_found" })
    return
  }

  const isOwner = payload.context.currentMember.isOwner
  const isCreator = template.creatorMemberId === payload.context.currentMember.id
  if (!isOwner && !isCreator) {
    res.status(403).json({
      error: "forbidden",
      message: "Only the template creator or organization owner can delete templates.",
    })
    return
  }

  await db.delete(TempTemplateSharingTable).where(eq(TempTemplateSharingTable.id, template.id))
  res.status(204).end()
}))

function createInvitationId() {
  return createDenTypeId("invitation")
}

function createRoleId() {
  return createDenTypeId("organizationRole")
}
