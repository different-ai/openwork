/**
 * Config-blob area `members.people`: the organization's people (decision D2):
 * members, pending invitations, their role and the teams they are in.
 *
 * Identity: one item per person, matched by lower-cased email. The item id is
 * the member id (`om_…`), for invited people too (every invitation has a
 * placeholder member row holding its role and teams); an invitation without a
 * placeholder (older rows) uses the invitation id. Never exported: invite
 * tokens, sessions, accounts, passwords, user ids.
 *
 * Spec: `email`, direct `role`, `status` (active | invited), `teams` (refs to
 * `members.teams`) and `managedBy` (scim | sso | manual, informational).
 * Permission sets are NOT a per-person field: a person's permissions follow
 * from their role and teams (`members.roles` carries which teams have which
 * role), so exporting them per person would duplicate derived state.
 *
 * Apply, through the routes' own functions with an in-process route context:
 * - create: someone not in the organization is INVITED
 *   (routes/org/invitations.ts createInvitationAction), whether or not they
 *   already have an account on this instance. Adding an existing account
 *   straight into an organization would skip the explicit-accept / email
 *   verification boundary Den keeps for cross-organization joins
 *   (orgs.ts reconcilePendingInvitationsForUser), so a person with an account
 *   gets a pending invitation too. Invitations are SILENT unless the engine
 *   sets `spec.__sendInviteEmail: true` on the resolved item (from the
 *   request's `decisions.people.sendInviteEmails`). Allowed email domains,
 *   seats and role rules are enforced by the invitation action.
 * - update: role via updateMemberRoleAction (members) or a silent refresh of
 *   the invitation (invited); team membership via the team routes' updateTeam.
 * - delete: removeMemberAction (members) or cancelInvitationAction (invited).
 *   Never the person applying, never the owner (protectedFromDelete), and the
 *   member services keep their own last-owner and role guards.
 * - People managed by the target's SCIM provider are refused with a reason.
 */
import { and, asc, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthAccountTable,
  AuthUserTable,
  InvitationTable,
  MemberTable,
  OrganizationTable,
  ScimProviderTable,
  SsoProviderTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { currentAuditChangeCapture } from "../../audit/request-capture.js"
import { roleIncludesOwner } from "../../organization-member-guards.js"
import { isEmailAllowedForOrganization } from "../../orgs.js"
import { ORGANIZATION_ADMIN_ROLE, normalizeOrganizationRoleName, splitOrganizationRoles } from "../../organization-role-hierarchy.js"
import { cancelInvitationAction, createInvitationAction } from "../../routes/org/invitations.js"
import { removeMemberAction, updateMemberRoleAction } from "../../routes/org/members.js"
import { updateTeam } from "../../routes/org/teams.js"
import { getScimManagedTeamIds } from "../../scim-groups.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem, type ConfigPreflightResult } from "../area.js"
import {
  ConfigApplyError,
  ConfigStepLog,
  applyWithSteps,
  configRouteContext,
  isJsonObject,
  expectRouteOk,
  resolvedRefIds,
  specObject,
  specRefSchema,
  stringField,
  teamRef,
  touches,
  type ConfigRouteContext,
} from "./route-support.js"

const AREA = "members.people"

/** Set by the engine on a resolved create/update item to send invite emails. Absent or false: silent. */
export const SEND_INVITE_EMAIL_FIELD = "__sendInviteEmail"

const personSpecSchema = z.object({
  email: z.string().email().max(255),
  /** The member's direct role (`member`, `admin`, `super-admin`, `owner`). Admin through an Admin team comes from `teams`. */
  role: z.string().min(1).max(255),
  /** Informational (an import only ever invites). Hand-written blobs may leave it out. */
  status: z.enum(["active", "invited"]).default("invited"),
  teams: z.array(specRefSchema).max(500).default([]),
  /** Informational: who owns this person on the source. Hand-written blobs may leave it out. */
  managedBy: z.enum(["manual", "sso", "scim"]).default("manual"),
}).strict()

const personApplyFieldsSchema = z.object({
  email: z.string().email().max(255),
  role: z.string().min(1).max(255),
  status: z.enum(["active", "invited"]),
  managedBy: z.enum(["manual", "sso", "scim"]),
}).passthrough()

type ManagedBy = "manual" | "sso" | "scim"
type MemberId = ReturnType<typeof normalizeDenTypeId<"member">>

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function emailOf(item: ConfigItem): string | null {
  return typeof item.spec.email === "string" ? normalizeEmail(item.spec.email) || null : null
}

function canonicalRole(role: string): string {
  return splitOrganizationRoles(role).map(normalizeOrganizationRoleName).filter(Boolean).sort().join(",")
}

function preferredMemberId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("member", id)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Reads

type PersonRow = {
  memberId: string | null
  invitationId: string | null
  userId: string | null
  email: string
  name: string | null
  role: string
  status: "active" | "invited"
}

/** Provider ids of the organization's SCIM and SSO connections. */
async function identityProviders(ctx: ConfigAreaContext) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const [scim, sso] = await Promise.all([
    ctx.db.select({ providerId: ScimProviderTable.providerId }).from(ScimProviderTable).where(eq(ScimProviderTable.organizationId, organizationId)),
    ctx.db.select({ providerId: SsoProviderTable.providerId }).from(SsoProviderTable).where(eq(SsoProviderTable.organizationId, organizationId)),
  ])
  return { scim: new Set(scim.map((row) => row.providerId)), sso: new Set(sso.map((row) => row.providerId)) }
}

async function managedByUsers(ctx: ConfigAreaContext, userIds: readonly string[]): Promise<Map<string, ManagedBy>> {
  const out = new Map<string, ManagedBy>()
  if (userIds.length === 0) return out
  const providers = await identityProviders(ctx)
  if (providers.scim.size === 0 && providers.sso.size === 0) return out
  const accounts = await ctx.db
    .select({ userId: AuthAccountTable.userId, providerId: AuthAccountTable.providerId })
    .from(AuthAccountTable)
    .where(inArray(AuthAccountTable.userId, userIds.map((id) => normalizeDenTypeId("user", id))))
  for (const account of accounts) {
    if (providers.scim.has(account.providerId)) out.set(account.userId, "scim")
    else if (providers.sso.has(account.providerId) && out.get(account.userId) !== "scim") out.set(account.userId, "sso")
  }
  return out
}

/**
 * Members (people, not setup agents) and pending invitations, one row per person.
 * `ids` reads just those items: member ids with one query; an invitation-only
 * item (`inv_…`, older rows) needs the whole list to tell it apart from a member
 * with the same email, so its presence falls back to the full read, filtered.
 */
async function listPeople(ctx: ConfigAreaContext, ids: readonly string[] | null = null): Promise<PersonRow[]> {
  if (ids) {
    const memberIds = ids.flatMap((id) => preferredMemberId(id) ?? [])
    if (memberIds.length !== ids.length) {
      const wanted = new Set(ids)
      return (await listPeople(ctx)).filter((person) => (person.memberId && wanted.has(person.memberId)) || (person.invitationId && wanted.has(person.invitationId)))
    }
    if (memberIds.length === 0) return []
    return (await listPeopleRows(ctx, memberIds)).people
  }
  const { people, coveredInvitations } = await listPeopleRows(ctx, null)
  return withInvitationOnlyPeople(ctx, people, coveredInvitations)
}

async function listPeopleRows(ctx: ConfigAreaContext, memberIds: readonly MemberId[] | null): Promise<{ people: PersonRow[]; coveredInvitations: Set<string> }> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const members = await ctx.db
    .select({
      memberId: MemberTable.id,
      userId: MemberTable.userId,
      role: MemberTable.role,
      userEmail: AuthUserTable.email,
      userName: AuthUserTable.name,
      invitationId: InvitationTable.id,
      invitationEmail: InvitationTable.email,
      invitationStatus: InvitationTable.status,
    })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(and(
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
      eq(MemberTable.isSetupAgent, false),
      memberIds ? inArray(MemberTable.id, [...memberIds]) : undefined,
    ))
    .orderBy(asc(MemberTable.createdAt), asc(MemberTable.id))
  const people: PersonRow[] = []
  const coveredInvitations = new Set<string>()
  for (const row of members) {
    if (row.invitationId) coveredInvitations.add(row.invitationId)
    if (row.userId && row.userEmail) {
      people.push({ memberId: row.memberId, invitationId: null, userId: row.userId, email: normalizeEmail(row.userEmail), name: row.userName, role: row.role, status: "active" })
    } else if (!row.userId && row.invitationEmail && row.invitationStatus === "pending") {
      people.push({ memberId: row.memberId, invitationId: row.invitationId, userId: null, email: normalizeEmail(row.invitationEmail), name: null, role: row.role, status: "invited" })
    }
  }
  return { people, coveredInvitations }
}

/** Adds pending invitations that have no placeholder member (older rows). */
async function withInvitationOnlyPeople(ctx: ConfigAreaContext, people: PersonRow[], coveredInvitations: Set<string>): Promise<PersonRow[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const invitations = await ctx.db
    .select({ id: InvitationTable.id, email: InvitationTable.email, role: InvitationTable.role })
    .from(InvitationTable)
    .where(and(eq(InvitationTable.organizationId, organizationId), eq(InvitationTable.status, "pending")))
    .orderBy(asc(InvitationTable.createdAt), asc(InvitationTable.id))
  const seen = new Set(people.map((person) => person.email))
  for (const invitation of invitations) {
    const email = normalizeEmail(invitation.email)
    if (coveredInvitations.has(invitation.id) || seen.has(email)) continue
    seen.add(email)
    people.push({ memberId: null, invitationId: invitation.id, userId: null, email, name: null, role: invitation.role, status: "invited" })
  }
  return people
}

async function teamIdsByMember(ctx: ConfigAreaContext, memberIds: readonly string[]) {
  const out = new Map<string, Array<{ id: string; name: string }>>()
  if (memberIds.length === 0) return out
  const rows = await ctx.db
    .select({ memberId: TeamMemberTable.orgMembershipId, teamId: TeamTable.id, teamName: TeamTable.name })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, and(eq(TeamTable.id, TeamMemberTable.teamId), eq(TeamTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId))))
    .where(inArray(TeamMemberTable.orgMembershipId, memberIds.map((id) => normalizeDenTypeId("member", id))))
  for (const row of rows) {
    if (!row.memberId) continue
    const list = out.get(row.memberId) ?? []
    list.push({ id: row.teamId, name: row.teamName })
    out.set(row.memberId, list)
  }
  return out
}

/** The target row behind an item id: a member (placeholder members included) or an invitation without one. */
async function readTarget(ctx: ConfigAreaContext, targetId: string): Promise<PersonRow | null> {
  const id = targetId.trim()
  return (await listPeople(ctx, [id])).find((person) => person.memberId === id || person.invitationId === id) ?? null
}

async function memberIdForInvitation(ctx: ConfigAreaContext, invitationId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
      eq(MemberTable.inviteId, normalizeDenTypeId("invitation", invitationId)),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return row?.id ?? null
}

async function activeMemberByEmail(ctx: ConfigAreaContext, email: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(
      eq(MemberTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
      isNull(MemberTable.removedAt),
      sql`lower(${AuthUserTable.email}) = ${email}`,
    ))
    .limit(1)
  return row?.id ?? null
}

// ---------------------------------------------------------------------------
// Writes

async function actorUser(ctx: ConfigAreaContext) {
  const [user] = await ctx.db
    .select({ id: AuthUserTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, normalizeDenTypeId("user", ctx.actor.userId)))
    .limit(1)
  if (!user) throw new ConfigApplyError("actor_not_found", "The person applying this change no longer has an account.", 403)
  return user
}

/** Invites (or silently refreshes the invitation of) `email` with `role`. Returns the placeholder member id. */
async function invite(ctx: ConfigAreaContext, rc: ConfigRouteContext, input: { email: string; role: string; sendEmail: boolean; memberId?: string }) {
  const response = await createInvitationAction(rc.c, rc.payload, await actorUser(ctx), { email: input.email, role: input.role }, currentAuditChangeCapture(ctx.organizationId), {
    sendEmail: input.sendEmail,
    memberId: preferredMemberId(input.memberId),
  })
  const body = await expectRouteOk(response, `Invite ${input.email}`)
  const invitationId = stringField(body, "invitationId")
  return { invitationId, memberId: await memberIdForInvitation(ctx, invitationId) }
}

/**
 * Puts the member in exactly `wanted` teams through the team route's
 * updateTeam (Admin-team and grant rules included). Only teams whose
 * membership changes are written, one step each; updateTeam writes only this
 * person's membership row. Teams managed by SCIM are left alone with a
 * warning: the identity provider owns their members.
 */
async function syncTeams(ctx: ConfigAreaContext, rc: ConfigRouteContext, log: ConfigStepLog, memberId: string, wanted: readonly string[], label: string, teamNames: Map<string, string>): Promise<string[]> {
  const warnings: string[] = []
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const currentTeams = (await teamIdsByMember(ctx, [memberId])).get(memberId) ?? []
  for (const team of currentTeams) teamNames.set(team.id, team.name)
  const current = new Set(currentTeams.map((team) => team.id))
  const next = new Set(wanted)
  const changed = [...new Set([...current, ...next])].filter((teamId) => current.has(teamId) !== next.has(teamId))
  if (changed.length === 0) return warnings
  const scimTeams = await getScimManagedTeamIds(organizationId, ctx.db)
  for (const teamId of changed) {
    const team = normalizeDenTypeId("team", teamId)
    if (scimTeams.has(team)) {
      warnings.push(`${label}: team membership of a SCIM-managed team was left to the identity provider.`)
      continue
    }
    const adding = next.has(teamId)
    await log.run({ action: adding ? "add" : "remove", target: "teams", detail: teamNames.get(teamId) ?? teamId }, async () => {
      const members = (await ctx.db.select({ id: TeamMemberTable.orgMembershipId }).from(TeamMemberTable).where(eq(TeamMemberTable.teamId, team)))
        .flatMap((row) => row.id ? [row.id] : [])
      const member = normalizeDenTypeId("member", memberId)
      const memberIds = adding ? [...new Set([...members, member])] : members.filter((id) => id !== member)
      await expectRouteOk(await updateTeam(rc.c, rc.payload, team, { memberIds }), `${adding ? "Add" : "Remove"} ${label} ${adding ? "to" : "from"} a team`)
    })
  }
  return warnings
}

/** Team names from the resolved refs' name hints, for step details. */
function refTeamNames(refs: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(refs)) return out
  for (const ref of refs) {
    if (isJsonObject(ref) && typeof ref.id === "string" && typeof ref.name === "string") out.set(ref.id, ref.name)
  }
  return out
}

async function refuseScimManaged(ctx: ConfigAreaContext, person: PersonRow) {
  if (!person.userId) return
  if ((await managedByUsers(ctx, [person.userId])).get(person.userId) === "scim") {
    throw new ConfigApplyError("scim_managed_member", `${person.email} is managed by your identity provider (SCIM); change them there.`, 409)
  }
}

function sendsInviteEmail(spec: { [key: string]: unknown }): boolean {
  return spec[SEND_INVITE_EMAIL_FIELD] === true
}

// ---------------------------------------------------------------------------
// Preflight

type InviteRules = { allowedEmailDomains: string[]; scim: boolean }

/** One read per plan: preflight runs once per person with the same context. */
const inviteRules = new WeakMap<ConfigAreaContext, Promise<InviteRules>>()

function readInviteRules(ctx: ConfigAreaContext): Promise<InviteRules> {
  const cached = inviteRules.get(ctx)
  if (cached) return cached
  const loading = (async () => {
    const [row] = await ctx.db.select({ allowedEmailDomains: OrganizationTable.allowedEmailDomains }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId))).limit(1)
    const domains = Array.isArray(row?.allowedEmailDomains) ? row.allowedEmailDomains.filter((entry): entry is string => typeof entry === "string") : []
    return { allowedEmailDomains: domains, scim: (await identityProviders(ctx)).scim.size > 0 }
  })()
  inviteRules.set(ctx, loading)
  return loading
}

/** The invitation action's own rules, before apply: allowed email domains and SCIM-provisioned people. */
async function peoplePreflight(ctx: ConfigAreaContext, op: ConfigApplyOp): Promise<ConfigPreflightResult | null> {
  if (op.kind !== "create" || typeof op.item.spec.email !== "string") return null
  const email = normalizeEmail(op.item.spec.email)
  const rules = await readInviteRules(ctx)
  if (op.item.spec.managedBy === "scim" && rules.scim) {
    return { skip: `${email} is provisioned by the identity provider (SCIM) on the source: this organization's SCIM provisions them` }
  }
  if (!isEmailAllowedForOrganization(rules.allowedEmailDomains, email)) {
    return { block: `${email} can't be invited: this organization only allows ${rules.allowedEmailDomains.join(", ")} email addresses (Settings › General). Allow the domain first, or skip this person.` }
  }
  const role = typeof op.item.spec.role === "string" ? op.item.spec.role : ""
  return roleIncludesOwner(role) ? { warnings: [`${email} is the owner on the source; they are invited as an admin (an import never moves ownership).`] } : null
}

// ---------------------------------------------------------------------------

export const membersPeopleArea = defineConfigArea({
  key: AREA,
  label: "People",
  path: ["Members", "People"],
  // Item ids are member ids (`om_…`); an invitation-only row's `inv_…` id is never reused.
  idPrefix: denTypeIdPrefixes.member,
  specVersion: 1,
  specSchema: personSpecSchema,
  dependsOn: ["members.teams"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "teams.view",
  managePermission: "invitations.manage",
  tables: ["member", "team_member", "invitation"],
  naturalKeys: [{ label: "email", get: emailOf }],
  uniqueFields: [{ label: "email", get: (item) => typeof item.spec.email === "string" ? normalizeEmail(item.spec.email) || null : null }],
  secretFields: [],
  // An import invites; it never makes someone join, and a person's name is
  // their account's. Both are exported for readers but are not changes.
  informationalFields: ["status"],
  informationalName: true,
  // Invitation, member and team actions open their own transactions on the global db, and may send email.
  transactional: false,
  externalEffects: true,
  protectedFromDelete: (item, ctx) => {
    if (item.id === ctx.actor.memberId) return "You can't remove yourself."
    if (typeof item.spec.role === "string" && roleIncludesOwner(item.spec.role)) return "The owner can't be removed. Transfer ownership first."
    if (item.spec.managedBy === "scim") return "Managed by your identity provider (SCIM)."
    return null
  },

  preflight: (ctx, op) => peoplePreflight(ctx, op),

  irreversible: (op) => {
    const email = op.kind === "delete" ? emailOf(op.previous) ?? op.previous.name : typeof op.item.spec.email === "string" ? normalizeEmail(op.item.spec.email) : op.item.name
    if (op.kind === "delete") {
      if (op.previous.spec.status === "invited") return [`The invitation of ${email} is cancelled; a restore sends them a new one.`]
      return [
        `${email} is removed from the organization: a restore can only invite them again, and they must accept to rejoin.`,
        `${email}'s sign-ins to connectors and AI providers, their own keys and their API keys are revoked or deleted.`,
      ]
    }
    if (!sendsInviteEmail(op.item.spec)) return []
    if (op.kind === "create") return [`An invitation email is sent to ${email}.`]
    return op.previous.spec.status === "invited" && touches(op.changes, "role") ? [`A new invitation email is sent to ${email}.`] : []
  },

  async exportItems(ctx) {
    return peopleItems(ctx, await listPeople(ctx))
  },

  async readItems(ctx, ids) {
    return peopleItems(ctx, await listPeople(ctx, ids))
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const rc = await configRouteContext(ctx)
      const capture = currentAuditChangeCapture(ctx.organizationId)

      if (op.kind === "delete") {
        if (op.targetId === ctx.actor.memberId) throw new ConfigApplyError("cannot_remove_self", "You can't remove yourself.", 400)
        const person = await readTarget(ctx, op.targetId)
        if (!person) return { localId: op.targetId, warnings: [`${op.previous.name} is no longer in the organization.`] }
        if (roleIncludesOwner(person.role)) throw new ConfigApplyError("owner_protected", "The owner can't be removed. Transfer ownership first.", 400)
        await refuseScimManaged(ctx, person)
        if (person.status === "active" && person.memberId) {
          const memberId = person.memberId
          await log.run({ action: "delete", target: "member", detail: person.email }, async () => {
            await expectRouteOk(await removeMemberAction(rc.c, rc.payload, memberId, capture), `Remove ${person.email}`)
          })
        } else if (person.invitationId) {
          const invitationId = person.invitationId
          await log.run({ action: "delete", target: "invitation", detail: person.email }, async () => {
            await expectRouteOk(await cancelInvitationAction(rc.c, rc.payload, invitationId, capture), `Cancel the invitation of ${person.email}`)
          })
        }
        return { localId: op.targetId }
      }

      const raw = specObject(op.item.spec)
      const spec = personApplyFieldsSchema.parse(raw)
      const email = normalizeEmail(spec.email)
      const role = canonicalRole(spec.role)
      const teamIds = [...new Set(resolvedRefIds(raw.teams, `${email} teams`))]
      const teamNames = refTeamNames(raw.teams)
      const sendEmail = sendsInviteEmail(raw)
      const warnings: string[] = []

      const target = op.kind === "update"
        ? await readTarget(ctx, op.targetId)
        : await (async () => {
          const existing = await activeMemberByEmail(ctx, email)
          return existing ? readTarget(ctx, existing) : null
        })()

      if (!target) {
        if (op.kind === "update") throw new ConfigApplyError("member_not_found", `${op.previous.name} is no longer in the organization.`, 404)
        if (spec.managedBy === "scim" && (await identityProviders(ctx)).scim.size > 0) {
          throw new ConfigApplyError("scim_managed_member", `${email} is provisioned by an identity provider (SCIM) on the source; provision them through this organization's SCIM instead.`, 409)
        }
        let inviteRole = role
        if (roleIncludesOwner(role)) {
          inviteRole = ORGANIZATION_ADMIN_ROLE
          warnings.push(`${email} is the owner on the source; invited as an admin here (ownership is never moved by import).`)
        }
        if (spec.status === "active") warnings.push(`${email} was invited; they join when they accept.`)
        const invited = await log.run(
          { action: "create", target: "invitation", detail: `${email} (${inviteRole}${sendEmail ? ", email sent" : ", no email"})` },
          () => invite(ctx, rc, { email, role: inviteRole, sendEmail, memberId: op.preferredId }),
          "email",
        )
        const memberId = invited.memberId
        if (!memberId) {
          if (teamIds.length > 0) warnings.push(`${email}: teams are set when they accept.`)
          return { localId: invited.invitationId, warnings }
        }
        warnings.push(...await syncTeams(ctx, rc, log, memberId, teamIds, email, teamNames))
        return { localId: memberId, warnings }
      }

      // Update (or a create that found the person already here: every field is compared then).
      const inScope = (path: string) => op.kind === "create" || touches(op.changes, path)
      await refuseScimManaged(ctx, target)
      if (inScope("email") && target.email !== email) warnings.push(`${target.email} keeps their email; it is not changed by import.`)
      if (spec.status === "active" && target.status === "invited") warnings.push(`${target.email} has not accepted their invitation yet.`)

      if (inScope("role") && canonicalRole(target.role) !== role) {
        if (roleIncludesOwner(role) !== roleIncludesOwner(target.role)) {
          warnings.push(`${target.email}: ownership is only moved by transferring it; role left as ${target.role}.`)
        } else if (target.status === "active" && target.memberId) {
          const memberId = target.memberId
          await log.run({ action: "set", target: "role", detail: role }, async () => {
            await expectRouteOk(await updateMemberRoleAction(rc.c, rc.payload, memberId, role, capture), `Change the role of ${target.email}`)
          })
        } else {
          await log.run({ action: "set", target: "role", detail: `${role} (invitation refreshed${sendEmail ? ", email sent" : ""})` }, () => invite(ctx, rc, { email: target.email, role, sendEmail }))
        }
      }

      const memberId = target.memberId
      if (inScope("teams")) {
        if (memberId) warnings.push(...await syncTeams(ctx, rc, log, memberId, teamIds, target.email, teamNames))
        else if (teamIds.length > 0) warnings.push(`${target.email}: teams are set when they accept.`)
      }
      return { localId: memberId ?? target.invitationId ?? op.item.sourceId ?? email, warnings }
    })
  },
})

async function peopleItems(ctx: ConfigAreaContext, people: PersonRow[]): Promise<ConfigItem[]> {
  const memberIds = people.flatMap((person) => person.memberId ? [person.memberId] : [])
  const [teams, managedBy] = await Promise.all([
    teamIdsByMember(ctx, memberIds),
    managedByUsers(ctx, people.flatMap((person) => person.userId ? [person.userId] : [])),
  ])
  return people
    .sort((left, right) => left.email.localeCompare(right.email))
    .map((person): ConfigItem => ({
      id: person.memberId ?? person.invitationId ?? person.email,
      name: person.name?.trim() || person.email,
      spec: {
        email: person.email,
        role: canonicalRole(person.role),
        status: person.status,
        teams: [...(person.memberId ? teams.get(person.memberId) ?? [] : [])]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((team) => teamRef(team.id, team.name)),
        managedBy: (person.userId ? managedBy.get(person.userId) : undefined) ?? "manual",
      },
    }))
}
