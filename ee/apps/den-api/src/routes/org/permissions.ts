import { and, asc, count, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  allowedKeys,
  buildPermissionRows,
  latestPermissionRowCreatedAt,
  lockPermissionSet,
  readPermissionSetStates,
  type PermissionDatabase,
} from "@openwork-ee/den-db/permissions"
import {
  AuthUserTable,
  MemberTable,
  PermissionSetPermissionTable,
  PermissionSetTable,
  PermissionSetTeamTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  PERMISSION_AREAS,
  PERMISSION_DEFAULT_SET_KEYS,
  PERMISSION_KEYS,
  getPermissionDefinition,
  isPermissionKey,
  isPermissionLockedOn,
  type PermissionAreaKey,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { appendDomainChanges, finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import {
  permissionSetArchivedEvent,
  permissionSetCreatedEvent,
  permissionSetPermissionsChangedEvent,
  type PermissionSetAuditState,
} from "../../audit/domain/permissions.js"
import { auditChangeCapture } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { requireFeature } from "../../features.js"
import { keysetAfter, keysetCursorQuerySchema, keysetPage, nextCursorSchema, type KeysetCursor } from "../../list-pagination.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, requireOrgPermission } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { roleIncludesOwner } from "../../organization-member-guards.js"
import { isEffectiveOrganizationAdmin } from "../../organization-role-hierarchy.js"
import type { OrganizationContext } from "../../orgs.js"
import { ensureCurrentDefaultPermissionSets } from "../../permissions/default-sets.js"
import type { MemberPermissions } from "../../permissions/effective.js"
import { explainPermissionsForMember } from "../../permissions/resolve.js"
import {
  permissionEditProblemMessage,
  permissionKeyDelta,
  permissionSetKeyStates,
  permissionSourceLabel,
  planPermissionSetCreate,
  planPermissionSetEdit,
  teamPermissionSetName,
  type PermissionEditProblem,
  type PermissionStatus,
} from "../../permissions/set-edits.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, memberPermissionsForRequest, permissionDeniedResponse, permissionFailureHeaders } from "./shared.js"

/**
 * Permissions management endpoints (docs/permissions/overview.md, section 10).
 * Everything except the catalog needs the `permissions` feature, plus
 * permissions.view to read or permissions.manage to write. A member may
 * always read their own effective permissions.
 *
 * Guard order: orgMemberRoute() (marker), requireFeature("permissions"), then
 * requireOrgPermission(key), so a disabled feature answers 404
 * feature_disabled before any 403 or reauth.
 */

type OrganizationId = typeof PermissionSetTable.$inferSelect.organizationId
type PermissionSetId = typeof PermissionSetTable.$inferSelect.id
type PermissionSetRow = typeof PermissionSetTable.$inferSelect
type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type PermissionSetKind = "member_default" | "admin_default" | "team"
type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

const MAX_REQUESTED_CHANGES = 500
const DEFAULT_HISTORY_LIMIT = 50
const MAX_HISTORY_LIMIT = 200

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const permissionStatusSchema = z.enum(["allow", "deny"])
const permissionSetKindSchema = z.enum(["member_default", "admin_default", "team"])
const permissionChangeSourceSchema = z.enum(["user", "seed", "reconcile", "migration"])
const timestampSchema = z.string().datetime()

const requestedPermissionChangeSchema = z.object({
  key: z.string().trim().min(1).max(128).describe("Permission key from GET /v1/permissions/catalog, e.g. llm_provider.delete."),
  status: permissionStatusSchema,
})

const createPermissionSetBodySchema = z.object({
  teamId: denTypeIdSchema("team").describe("The team this set applies to. A team can have one active permission set; it can't be changed later."),
  permissions: z.array(requestedPermissionChangeSchema).max(MAX_REQUESTED_CHANGES)
    .describe("Initial status per key. Keys left out, or set to deny, start denied."),
}).meta({ ref: "CreatePermissionSetBody" })

const updatePermissionSetBodySchema = z.object({
  changes: z.array(requestedPermissionChangeSchema).min(1).max(MAX_REQUESTED_CHANGES)
    .describe("Requested status per key. Each key at most once. Keys already at the requested status are left unchanged."),
}).meta({ ref: "UpdatePermissionSetPermissionsBody" })

const permissionSetParamsSchema = idParamSchema("permissionSetId", "permissionSet")
const memberParamsSchema = idParamSchema("memberId", "member")
const permissionKeyParamsSchema = z.object({ permissionKey: z.string().trim().min(1).max(128) })

const historyQuerySchema = z.object({
  cursor: keysetCursorQuerySchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).optional()
    .meta({ description: `Rows per page, at most ${MAX_HISTORY_LIMIT}. Defaults to ${DEFAULT_HISTORY_LIMIT}.` }),
})

const permissionDefinitionSchema = z.object({
  key: z.string(),
  area: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  sensitive: z.boolean().describe("Using this permission requires a recent sign-in."),
  lockedOn: z.array(z.literal("admin")).describe("Default sets in which this permission can never be turned off."),
  defaultOn: z.array(z.enum(PERMISSION_DEFAULT_SET_KEYS)).describe("Default sets this permission starts on in."),
}).meta({ ref: "PermissionDefinition" })

const permissionCatalogResponseSchema = z.object({
  areas: z.array(z.object({ key: z.string(), label: z.string() })),
  permissions: z.array(permissionDefinitionSchema),
}).meta({ ref: "PermissionCatalog" })

const teamReferenceSchema = z.object({
  id: z.string(),
  name: z.string().nullable().describe("Null when the team no longer exists."),
}).meta({ ref: "PermissionSetTeam" })

const permissionPersonSchema = z.object({
  memberId: z.string(),
  name: z.string(),
  email: z.string(),
}).meta({ ref: "PermissionPerson" })

const permissionChangedBySchema = z.object({
  memberId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
}).meta({ ref: "PermissionChangedBy" })

const adminTeamSummarySchema = z.object({ id: z.string(), name: z.string(), memberCount: z.number().int() })

const appliesToSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone"), memberCount: z.number().int() }),
  z.object({ kind: z.literal("admins"), directAdminCount: z.number().int(), adminTeams: z.array(adminTeamSummarySchema) }),
  z.object({ kind: z.literal("team"), team: teamReferenceSchema.nullable(), memberCount: z.number().int() }),
]).meta({ ref: "PermissionSetAppliesToSummary" })

const appliesToDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone"), memberCount: z.number().int() }),
  z.object({
    kind: z.literal("admins"),
    directAdminCount: z.number().int(),
    directAdmins: z.array(permissionPersonSchema).nullable().describe("Names and emails of members with the admin role. Null unless the caller holds teams.view; directAdminCount is always returned."),
    adminTeams: z.array(adminTeamSummarySchema),
  }),
  z.object({
    kind: z.literal("team"),
    team: teamReferenceSchema.nullable(),
    memberCount: z.number().int(),
    members: z.array(permissionPersonSchema).nullable().describe("Names and emails of the team's members. Null unless the caller holds teams.view; memberCount is always returned."),
  }),
]).meta({ ref: "PermissionSetAppliesTo" })

const permissionSetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: permissionSetKindSchema,
  team: teamReferenceSchema.nullable(),
  allowedCount: z.number().int(),
  createdAt: timestampSchema,
  appliesTo: appliesToSummarySchema,
}).meta({ ref: "PermissionSetSummary" })

const permissionSetListResponseSchema = z.object({
  sets: z.array(permissionSetSummarySchema),
}).meta({ ref: "PermissionSetList" })

const permissionSetKeyStateSchema = z.object({
  key: z.string(),
  status: permissionStatusSchema,
  locked: z.boolean().describe("Always on in this set; it can't be turned off."),
  lastChangedAt: timestampSchema.nullable(),
  lastChangedBy: permissionChangedBySchema.nullable(),
  lastChangeSource: permissionChangeSourceSchema.nullable(),
}).meta({ ref: "PermissionSetKeyState" })

const permissionSetDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: permissionSetKindSchema,
  team: teamReferenceSchema.nullable(),
  allowedCount: z.number().int(),
  createdAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
  permissions: z.array(permissionSetKeyStateSchema),
  appliesTo: appliesToDetailSchema,
}).meta({ ref: "PermissionSetDetail" })

const permissionSetResponseSchema = z.object({
  set: permissionSetDetailSchema,
}).meta({ ref: "PermissionSetResponse" })

const permissionHistoryItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string().nullable().describe("Null when the key is no longer in the catalog."),
  status: permissionStatusSchema,
  source: permissionChangeSourceSchema,
  changedBy: permissionChangedBySchema.nullable(),
  createdAt: timestampSchema,
}).meta({ ref: "PermissionHistoryItem" })

const permissionHistoryResponseSchema = z.object({
  items: z.array(permissionHistoryItemSchema),
  nextCursor: nextCursorSchema,
}).meta({ ref: "PermissionHistoryPage" })

const permissionKeyResponseSchema = z.object({
  permission: permissionDefinitionSchema,
  sets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: permissionSetKindSchema,
    team: teamReferenceSchema.nullable(),
    status: permissionStatusSchema,
    locked: z.boolean(),
  })),
}).meta({ ref: "PermissionKeyStatus" })

const permissionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), label: z.string() }),
  z.object({ kind: z.literal("member_default"), setId: z.string(), setName: z.string(), label: z.string() }),
  z.object({
    kind: z.literal("admin_default"),
    setId: z.string(),
    setName: z.string(),
    via: z.enum(["role", "team"]),
    teamId: z.string().optional(),
    teamName: z.string().optional(),
    label: z.string(),
  }),
  z.object({ kind: z.literal("team"), setId: z.string(), setName: z.string(), teamId: z.string(), teamName: z.string(), label: z.string() }),
  z.object({ kind: z.literal("code_default"), set: z.enum(PERMISSION_DEFAULT_SET_KEYS), label: z.string() }),
]).meta({ ref: "PermissionSource" })

const memberPermissionsResponseSchema = z.object({
  memberId: z.string(),
  featureEnabled: z.boolean(),
  isOwner: z.boolean(),
  isAdmin: z.boolean(),
  permissions: z.array(z.object({
    key: z.string(),
    label: z.string(),
    sources: z.array(permissionSourceSchema),
  })),
}).meta({ ref: "MemberPermissions" })

const permissionsNotFoundSchema = z.object({
  error: z.enum([
    "organization_not_found",
    "feature_disabled",
    "permission_set_not_found",
    "team_not_found",
    "permission_not_found",
    "member_not_found",
  ]),
  feature: z.string().optional(),
  message: z.string().optional(),
}).meta({ ref: "PermissionsNotFoundError" })

const permissionEditErrorSchema = z.object({
  error: z.enum(["unknown_permission", "duplicate_permission", "admin_permissions_require_admin", "permission_locked", "permission_not_held"]),
  message: z.string(),
  keys: z.array(z.string()),
}).meta({ ref: "PermissionEditError" })

const permissionDeniedSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string().optional(),
  requiredPermission: z.string().optional(),
}).passthrough().meta({ ref: "PermissionDeniedError" })

const permissionSetConflictSchema = z.object({
  error: z.enum(["permission_set_archived", "team_permission_set_exists"]),
  message: z.string(),
  permissionSetId: z.string().optional(),
}).meta({ ref: "PermissionSetConflictError" })

const defaultPermissionSetErrorSchema = z.object({
  error: z.literal("default_permission_set"),
  message: z.string(),
}).meta({ ref: "DefaultPermissionSetError" })

const forbiddenResponse = (description: string) => jsonResponse(description, z.union([forbiddenSchema, permissionDeniedSchema]))
const editForbiddenResponse = jsonResponse(
  "The caller lacks permissions.manage, needs a recent sign-in, tried to turn on a permission they don't have, or tried to change Admin permissions without being the owner or an admin.",
  z.union([forbiddenSchema, permissionDeniedSchema, permissionEditErrorSchema]),
)
const unauthorizedResponse = jsonResponse("The caller must be signed in.", unauthorizedSchema)
const notFoundResponse = (description: string) => jsonResponse(description, permissionsNotFoundSchema)

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function setKind(defaultKey: PermissionDefaultSetKey | null): PermissionSetKind {
  if (defaultKey === "member") return "member_default"
  if (defaultKey === "admin") return "admin_default"
  return "team"
}

function serializeDefinition(key: PermissionKey) {
  const definition = getPermissionDefinition(key)
  return {
    key,
    area: definition.area,
    label: definition.label,
    description: definition.description ?? null,
    sensitive: definition.sensitive === true,
    lockedOn: [...(definition.lockedOn ?? [])],
    defaultOn: [...definition.defaultOn],
  }
}

function areaEntries() {
  const areas: { key: PermissionAreaKey; label: string }[] = []
  for (const key of Object.keys(PERMISSION_AREAS)) {
    if (isAreaKey(key)) areas.push({ key, label: PERMISSION_AREAS[key].label })
  }
  return areas
}

function isAreaKey(value: string): value is PermissionAreaKey {
  return Object.prototype.hasOwnProperty.call(PERMISSION_AREAS, value)
}

function problemStatus(problem: PermissionEditProblem): 400 | 403 {
  return problem.error === "permission_not_held" || problem.error === "admin_permissions_require_admin" ? 403 : 400
}

function problemBody(problem: PermissionEditProblem) {
  return { error: problem.error, message: permissionEditProblemMessage(problem), keys: problem.keys }
}

function joinKeys(keys: readonly string[]): string | null {
  return keys.length > 0 ? keys.join(",") : null
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function readPermissionSet(database: PermissionDatabase, organizationId: OrganizationId, permissionSetId: PermissionSetId): Promise<PermissionSetRow | null> {
  const [row] = await database.select().from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.id, permissionSetId), eq(PermissionSetTable.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

type TeamLink = { linkId: typeof PermissionSetTeamTable.$inferSelect.id; teamId: TeamId; teamName: string | null; removedAt: Date | null }

/** Team links per set, newest first; the team name is null when the team row is gone. */
async function readTeamLinks(database: PermissionDatabase, organizationId: OrganizationId, setIds: readonly PermissionSetId[]): Promise<Map<PermissionSetId, TeamLink[]>> {
  const links = new Map<PermissionSetId, TeamLink[]>()
  if (setIds.length === 0) return links
  const rows = await database.select({
    linkId: PermissionSetTeamTable.id,
    permissionSetId: PermissionSetTeamTable.permissionSetId,
    teamId: PermissionSetTeamTable.teamId,
    teamName: TeamTable.name,
    removedAt: PermissionSetTeamTable.removedAt,
  })
    .from(PermissionSetTeamTable)
    .leftJoin(TeamTable, and(eq(TeamTable.id, PermissionSetTeamTable.teamId), eq(TeamTable.organizationId, PermissionSetTeamTable.organizationId)))
    .where(and(eq(PermissionSetTeamTable.organizationId, organizationId), inArray(PermissionSetTeamTable.permissionSetId, [...setIds])))
    .orderBy(desc(PermissionSetTeamTable.createdAt), desc(PermissionSetTeamTable.id))
  for (const row of rows) {
    const list = links.get(row.permissionSetId) ?? []
    list.push({ linkId: row.linkId, teamId: row.teamId, teamName: row.teamName, removedAt: row.removedAt })
    links.set(row.permissionSetId, list)
  }
  return links
}

/** The set's current team: the active link, else (archived sets) the most recent one. */
function currentTeam(links: readonly TeamLink[] | undefined): { id: TeamId; name: string | null } | null {
  if (!links || links.length === 0) return null
  const link = links.find((entry) => entry.removedAt === null) ?? links[0]
  return link ? { id: link.teamId, name: link.teamName } : null
}

const activeMemberConditions = (organizationId: OrganizationId) => and(
  eq(MemberTable.organizationId, organizationId),
  isNull(MemberTable.removedAt),
  eq(MemberTable.isSetupAgent, false),
)

type OrganizationPerson = { memberId: MemberId; name: string; email: string; role: string }

async function listActiveMembers(organizationId: OrganizationId): Promise<OrganizationPerson[]> {
  return db.select({ memberId: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email, role: MemberTable.role })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(activeMemberConditions(organizationId))
    .orderBy(asc(AuthUserTable.name), asc(MemberTable.id))
}

function isDirectAdmin(person: { role: string }) {
  return !roleIncludesOwner(person.role) && isEffectiveOrganizationAdmin({ directRole: person.role, adminTeamIds: [] })
}

async function countTeamMembers(organizationId: OrganizationId, teamIds: readonly TeamId[]): Promise<Map<TeamId, number>> {
  const counts = new Map<TeamId, number>()
  if (teamIds.length === 0) return counts
  const rows = await db.select({ teamId: TeamMemberTable.teamId, value: count() })
    .from(TeamMemberTable)
    .innerJoin(MemberTable, eq(MemberTable.id, TeamMemberTable.orgMembershipId))
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(activeMemberConditions(organizationId), inArray(TeamMemberTable.teamId, [...teamIds])))
    .groupBy(TeamMemberTable.teamId)
  for (const row of rows) counts.set(row.teamId, row.value)
  return counts
}

async function listTeamMembers(organizationId: OrganizationId, teamId: TeamId) {
  return db.select({ memberId: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
    .from(TeamMemberTable)
    .innerJoin(MemberTable, eq(MemberTable.id, TeamMemberTable.orgMembershipId))
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(activeMemberConditions(organizationId), eq(TeamMemberTable.teamId, teamId)))
    .orderBy(asc(AuthUserTable.name), asc(MemberTable.id))
}

async function listAdminTeams(organizationId: OrganizationId) {
  const teams = await db.select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.grantsOrganizationAdmin, true)))
    .orderBy(asc(TeamTable.name))
  const counts = await countTeamMembers(organizationId, teams.map((team) => team.id))
  return teams.map((team) => ({ id: team.id, name: team.name, memberCount: counts.get(team.id) ?? 0 }))
}

/** Active (non-archived) sets: Member defaults, Admin defaults, then team sets by name. */
async function listActiveSets(organizationId: OrganizationId): Promise<PermissionSetRow[]> {
  const defaults = await ensureCurrentDefaultPermissionSets(organizationId)
  const rows = await db.select().from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.organizationId, organizationId), isNull(PermissionSetTable.archivedAt)))
    .orderBy(asc(PermissionSetTable.name), asc(PermissionSetTable.id))
  const rank = (row: PermissionSetRow) => row.id === defaults.member.id ? 0 : row.id === defaults.admin.id ? 1 : 2
  return rows
    .filter((row) => row.defaultKey === null || row.id === defaults.member.id || row.id === defaults.admin.id)
    .sort((left, right) => rank(left) - rank(right))
}

type ChangedByRow = { changedByOrgMembershipId: MemberId | null; changedByName: string | null; changedByEmail: string | null }

function changedBy(row: ChangedByRow) {
  if (!row.changedByOrgMembershipId) return null
  return { memberId: row.changedByOrgMembershipId, name: row.changedByName, email: row.changedByEmail }
}

const historyColumns = {
  id: PermissionSetPermissionTable.id,
  permissionKey: PermissionSetPermissionTable.permissionKey,
  status: PermissionSetPermissionTable.status,
  source: PermissionSetPermissionTable.source,
  createdAt: PermissionSetPermissionTable.createdAt,
  changedByOrgMembershipId: PermissionSetPermissionTable.changedByOrgMembershipId,
  changedByName: AuthUserTable.name,
  changedByEmail: AuthUserTable.email,
}

function historyQuery(organizationId: OrganizationId, permissionSetId: PermissionSetId, after?: KeysetCursor) {
  return db.select(historyColumns)
    .from(PermissionSetPermissionTable)
    .leftJoin(MemberTable, eq(MemberTable.id, PermissionSetPermissionTable.changedByOrgMembershipId))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(
      eq(PermissionSetPermissionTable.organizationId, organizationId),
      eq(PermissionSetPermissionTable.permissionSetId, permissionSetId),
      after ? keysetAfter({ at: PermissionSetPermissionTable.createdAt, id: PermissionSetPermissionTable.id }, after) : undefined,
    ))
}

/**
 * Who a set applies to includes people's names and emails (team rosters, the
 * members with the admin role). Those are only returned to callers who may
 * see any team's members (teams.view, the one roster view permission);
 * everyone else holding permissions.view gets the counts.
 */
async function mayViewRosters(c: PermissionRouteContext): Promise<boolean> {
  return (await callerPermissions(c))?.has("teams.view") ?? false
}

async function loadPermissionSetDetail(organizationId: OrganizationId, set: PermissionSetRow, includeIdentities: boolean) {
  const [rows, links] = await Promise.all([
    historyQuery(organizationId, set.id),
    readTeamLinks(db, organizationId, [set.id]),
  ])
  const states = permissionSetKeyStates({ defaultKey: set.defaultKey, rows })
  const team = currentTeam(links.get(set.id))

  let appliesTo: z.infer<typeof appliesToDetailSchema>
  if (set.defaultKey === "member") {
    const members = await listActiveMembers(organizationId)
    appliesTo = { kind: "everyone", memberCount: members.length }
  } else if (set.defaultKey === "admin") {
    const [members, adminTeams] = await Promise.all([listActiveMembers(organizationId), listAdminTeams(organizationId)])
    const directAdmins = members.filter(isDirectAdmin).map(({ memberId, name, email }) => ({ memberId, name, email }))
    appliesTo = {
      kind: "admins",
      directAdminCount: directAdmins.length,
      directAdmins: includeIdentities ? directAdmins : null,
      adminTeams,
    }
  } else {
    const active = set.archivedAt === null ? team : null
    if (!active) {
      appliesTo = { kind: "team", team, memberCount: 0, members: includeIdentities ? [] : null }
    } else if (includeIdentities) {
      const members = await listTeamMembers(organizationId, active.id)
      appliesTo = { kind: "team", team, memberCount: members.length, members }
    } else {
      const counts = await countTeamMembers(organizationId, [active.id])
      appliesTo = { kind: "team", team, memberCount: counts.get(active.id) ?? 0, members: null }
    }
  }

  return {
    id: set.id,
    name: set.name,
    kind: setKind(set.defaultKey),
    team,
    allowedCount: states.filter((state) => state.status === "allow").length,
    createdAt: set.createdAt.toISOString(),
    archivedAt: set.archivedAt?.toISOString() ?? null,
    permissions: states.map((state) => ({
      key: state.key,
      status: state.status,
      locked: state.locked,
      lastChangedAt: state.latest?.createdAt.toISOString() ?? null,
      lastChangedBy: state.latest ? changedBy(state.latest) : null,
      lastChangeSource: state.latest?.source ?? null,
    })),
    appliesTo,
  }
}

async function auditStateFor(database: PermissionDatabase, set: PermissionSetRow, teamId: TeamId | null): Promise<PermissionSetAuditState> {
  const states = await readPermissionSetStates(database, [set.id], { lock: "share" })
  return { set, teamId, allowedKeys: [...allowedKeys(states.get(set.id))] }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type PermissionRouteContext = Parameters<typeof memberPermissionsForRequest>[0] & {
  get(key: "memberPermissions"): MemberPermissions | undefined
}

/** The caller's effective permissions (set by requireOrgPermission; resolved once per request otherwise). */
async function callerPermissions(c: PermissionRouteContext): Promise<MemberPermissions | null> {
  return c.get("memberPermissions") ?? await memberPermissionsForRequest(c)
}

function organizationContext(c: { get(key: "organizationContext"): OrganizationContext | undefined }): OrganizationContext | null {
  return c.get("organizationContext") ?? null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerOrgPermissionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/permissions/catalog",
    describeRoute({
      tags: ["Permissions"],
      summary: "List the permission catalog",
      description: "Lists every permission area and permission key with its label, description and flags: sensitive (needs a recent sign-in), lockedOn (can never be turned off in those default sets) and defaultOn (default sets it starts on in). Available to every member, whether or not Permissions is turned on.",
      responses: {
        200: jsonResponse("Permission catalog returned successfully.", permissionCatalogResponseSchema),
        401: unauthorizedResponse,
        404: notFoundResponse("The organization was not found."),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      return c.json({
        areas: areaEntries(),
        permissions: PERMISSION_KEYS.map(serializeDefinition),
      })
    },
  )

  app.get(
    "/v1/permissions/sets",
    describeRoute({
      tags: ["Permissions"],
      summary: "List permission sets",
      description: "Lists Member permissions, Admin permissions and every active team permission set, with the linked team, how many permissions each allows and who it applies to. Creates the Member and Admin sets if they don't exist yet. Requires permissions.view and the Permissions feature.",
      responses: {
        200: jsonResponse("Permission sets returned successfully.", permissionSetListResponseSchema),
        401: unauthorizedResponse,
        403: forbiddenResponse("The caller lacks permissions.view."),
        404: notFoundResponse("The organization was not found, or Permissions is turned off."),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.view"),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const sets = await listActiveSets(organizationId)
      const setIds = sets.map((set) => set.id)
      const [states, links, members, adminTeams] = await Promise.all([
        readPermissionSetStates(db, setIds),
        readTeamLinks(db, organizationId, setIds),
        listActiveMembers(organizationId),
        listAdminTeams(organizationId),
      ])
      const teamIds = sets.flatMap((set) => {
        const team = currentTeam(links.get(set.id))
        return set.defaultKey === null && team ? [team.id] : []
      })
      const teamCounts = await countTeamMembers(organizationId, teamIds)

      return c.json({
        sets: sets.map((set) => {
          const team = currentTeam(links.get(set.id))
          const appliesTo: z.infer<typeof appliesToSummarySchema> = set.defaultKey === "member"
            ? { kind: "everyone", memberCount: members.length }
            : set.defaultKey === "admin"
              ? { kind: "admins", directAdminCount: members.filter(isDirectAdmin).length, adminTeams }
              : { kind: "team", team, memberCount: team ? teamCounts.get(team.id) ?? 0 : 0 }
          return {
            id: set.id,
            name: set.name,
            kind: setKind(set.defaultKey),
            team,
            allowedCount: allowedKeys(states.get(set.id)).size,
            createdAt: set.createdAt.toISOString(),
            appliesTo,
          }
        }),
      })
    },
  )

  app.post(
    "/v1/permissions/sets",
    describeNonMcpRoute({
      tags: ["Permissions"],
      "x-mcp": false,
      summary: "Create team permissions",
      description: "Creates the permission set for one team, named \"<team name> Permissions\" (fixed from then on), links it to the team and stores its initial permissions. A team can have one active set, and the team can't be changed later. You can only turn on permissions you have yourself. Requires permissions.manage (only the owner has it by default), a recent sign-in, and the Permissions feature.",
      responses: {
        201: jsonResponse("Team permission set created.", permissionSetResponseSchema),
        400: jsonResponse("The body was invalid or named an unknown or repeated permission.", z.union([invalidRequestSchema, permissionEditErrorSchema])),
        401: unauthorizedResponse,
        403: editForbiddenResponse,
        404: notFoundResponse("The organization or team was not found, or Permissions is turned off."),
        409: jsonResponse("The team already has an active permission set.", permissionSetConflictSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.manage"),
    jsonValidator(createPermissionSetBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const editor = await callerPermissions(c)
      if (!editor) return c.json({ error: "organization_not_found" as const }, 404)

      const body = c.req.valid("json")
      const plan = planPermissionSetCreate({ permissions: body.permissions, editor })
      if (!plan.ok) return c.json(problemBody(plan.problem), problemStatus(plan.problem))

      const teamId = normalizeDenTypeId("team", body.teamId)
      const capture = auditChangeCapture(c)
      const actorMemberId = payload.currentMember.id
      const allowed = plan.changes.map((change) => change.key)

      const result = await db.transaction(async (tx) => {
        // The team row serializes concurrent creates for the same team. The
        // set is new, so its rows need no notBefore.
        const [team] = await tx.select({ id: TeamTable.id, name: TeamTable.name }).from(TeamTable)
          .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, organizationId)))
          .limit(1)
          .for("update")
        if (!team) return { ok: false as const, error: "team_not_found" as const }

        const [existing] = await tx.select({ id: PermissionSetTable.id }).from(PermissionSetTeamTable)
          .innerJoin(PermissionSetTable, eq(PermissionSetTable.id, PermissionSetTeamTable.permissionSetId))
          .where(and(
            eq(PermissionSetTeamTable.organizationId, organizationId),
            eq(PermissionSetTeamTable.teamId, team.id),
            isNull(PermissionSetTeamTable.removedAt),
            isNull(PermissionSetTable.archivedAt),
          ))
          .limit(1)
        if (existing) return { ok: false as const, error: "team_permission_set_exists" as const, permissionSetId: existing.id }

        const now = new Date()
        const set: PermissionSetRow = {
          id: createDenTypeId("permissionSet"),
          organizationId,
          defaultKey: null,
          name: teamPermissionSetName(team.name),
          createdByOrgMembershipId: actorMemberId,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          archivedByOrgMembershipId: null,
        }
        await tx.insert(PermissionSetTable).values({
          id: set.id,
          organizationId,
          defaultKey: null,
          name: set.name,
          createdByOrgMembershipId: actorMemberId,
          createdAt: now,
        })

        // A brand-new set has no earlier link to this team to re-activate.
        await tx.insert(PermissionSetTeamTable).values({
          id: createDenTypeId("permissionSetTeam"),
          organizationId,
          permissionSetId: set.id,
          teamId: team.id,
          createdByOrgMembershipId: actorMemberId,
          createdAt: now,
        })

        const rows = buildPermissionRows({
          organizationId,
          permissionSetId: set.id,
          changes: plan.changes,
          source: "user",
          changedByOrgMembershipId: actorMemberId,
          now,
        })
        if (rows.length > 0) await tx.insert(PermissionSetPermissionTable).values(rows)

        const auditEventIds = await appendDomainChanges(tx, capture, [
          permissionSetCreatedEvent(organizationId, { set, teamId: team.id, allowedKeys: allowed }),
        ])
        return { ok: true as const, set, teamId: team.id, auditEventIds }
      })

      if (!result.ok) {
        if (result.error === "team_not_found") return c.json({ error: "team_not_found" as const, message: "This team doesn't exist in your organization." }, 404)
        return c.json({
          error: "team_permission_set_exists" as const,
          message: "This team already has permissions. Edit them instead.",
          permissionSetId: result.permissionSetId,
        }, 409)
      }

      await finishLegacyAuditAction(capture, {
        organizationId,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.permissionSetCreated,
        payload: {
          permissionSetId: result.set.id,
          permissionSetName: result.set.name,
          teamId: result.teamId,
          allowedCount: allowed.length,
          allowedKeys: joinKeys(allowed),
        },
      }, result.auditEventIds)

      return c.json({ set: await loadPermissionSetDetail(organizationId, result.set, await mayViewRosters(c)) }, 201)
    },
  )

  app.get(
    "/v1/permissions/sets/:permissionSetId",
    describeRoute({
      tags: ["Permissions"],
      summary: "Get a permission set",
      description: "Returns one permission set with the status of every catalog permission (allow or deny, whether it is locked on, and who last changed it) and who it applies to: everyone (Member permissions), members with the admin role and Admin teams (Admin permissions), or the linked team and its members. The names and emails of those people are only included when the caller also holds teams.view; otherwise only the counts are. Archived team sets are still readable. Requires permissions.view and the Permissions feature.",
      responses: {
        200: jsonResponse("Permission set returned successfully.", permissionSetResponseSchema),
        400: jsonResponse("The permission set id was invalid.", invalidRequestSchema),
        401: unauthorizedResponse,
        403: forbiddenResponse("The caller lacks permissions.view."),
        404: notFoundResponse("The permission set or organization was not found, or Permissions is turned off."),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.view"),
    paramValidator(permissionSetParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const permissionSetId = normalizeDenTypeId("permissionSet", c.req.valid("param").permissionSetId)
      const existing = await readPermissionSet(db, organizationId, permissionSetId)
      if (!existing) return c.json({ error: "permission_set_not_found" as const }, 404)
      if (existing.defaultKey !== null) await ensureCurrentDefaultPermissionSets(organizationId)
      return c.json({ set: await loadPermissionSetDetail(organizationId, existing, await mayViewRosters(c)) })
    },
  )

  app.put(
    "/v1/permissions/sets/:permissionSetId/permissions",
    describeNonMcpRoute({
      tags: ["Permissions"],
      "x-mcp": false,
      summary: "Change permissions in a set",
      description: "Turns permissions on (allow) or off (deny) in one set. Only keys whose status actually changes are recorded; every change is kept in the set's history. Only the owner and admins can change Admin permissions. Permissions locked on for admins can't be turned off in Admin permissions, you can only turn on permissions you have yourself (except turning a permission back on in Member or Admin permissions where it is on by default), and archived sets can't be changed. The linked team can't be changed. Returns the set's new state. Requires permissions.manage (only the owner has it by default), a recent sign-in, and the Permissions feature.",
      responses: {
        200: jsonResponse("Permissions updated; the set's current state is returned.", permissionSetResponseSchema),
        400: jsonResponse("The body was invalid, named an unknown or repeated permission, or tried to turn off a locked permission.", z.union([invalidRequestSchema, permissionEditErrorSchema])),
        401: unauthorizedResponse,
        403: editForbiddenResponse,
        404: notFoundResponse("The permission set or organization was not found, or Permissions is turned off."),
        409: jsonResponse("The permission set is archived.", permissionSetConflictSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.manage"),
    paramValidator(permissionSetParamsSchema),
    jsonValidator(updatePermissionSetBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const editor = await callerPermissions(c)
      if (!editor) return c.json({ error: "organization_not_found" as const }, 404)

      const permissionSetId = normalizeDenTypeId("permissionSet", c.req.valid("param").permissionSetId)
      const existing = await readPermissionSet(db, organizationId, permissionSetId)
      if (!existing) return c.json({ error: "permission_set_not_found" as const }, 404)
      // A default set must hold a row for every default key before it is
      // diffed, or reconciliation could later override an explicit deny.
      if (existing.defaultKey !== null) await ensureCurrentDefaultPermissionSets(organizationId)

      const requested = c.req.valid("json").changes
      const capture = auditChangeCapture(c)
      const actorMemberId = payload.currentMember.id

      const result = await db.transaction(async (tx) => {
        if (!(await lockPermissionSet(tx, organizationId, permissionSetId))) return { ok: false as const, error: "permission_set_not_found" as const }
        const set = await readPermissionSet(tx, organizationId, permissionSetId)
        if (!set) return { ok: false as const, error: "permission_set_not_found" as const }
        if (set.archivedAt) return { ok: false as const, error: "permission_set_archived" as const }

        const current = (await readPermissionSetStates(tx, [set.id], { lock: "share" })).get(set.id) ?? new Map<string, PermissionStatus>()
        const plan = planPermissionSetEdit({ defaultKey: set.defaultKey, current, changes: requested, editor })
        if (!plan.ok) return { ok: false as const, error: "invalid_edit" as const, problem: plan.problem }
        if (plan.changes.length === 0) return { ok: true as const, set, changes: [], granted: [], revoked: [], auditEventIds: [] }

        await tx.insert(PermissionSetPermissionTable).values(buildPermissionRows({
          organizationId,
          permissionSetId: set.id,
          changes: plan.changes,
          source: "user",
          changedByOrgMembershipId: actorMemberId,
          notBefore: await latestPermissionRowCreatedAt(tx, set.id),
        }))

        const before = allowedKeys(current)
        const after = new Set(before)
        for (const change of plan.changes) {
          if (change.status === "allow") after.add(change.key)
          else after.delete(change.key)
        }
        const delta = permissionKeyDelta(before, after)
        const links = await readTeamLinks(tx, organizationId, [set.id])
        const teamId = currentTeam(links.get(set.id))?.id ?? null
        const auditEventIds = await appendDomainChanges(tx, capture, [
          permissionSetPermissionsChangedEvent(
            organizationId,
            { set, teamId, allowedKeys: [...before] },
            { set, teamId, allowedKeys: [...after] },
            delta,
          ),
        ])
        return { ok: true as const, set, changes: plan.changes, granted: delta.granted, revoked: delta.revoked, auditEventIds }
      })

      if (!result.ok) {
        if (result.error === "permission_set_not_found") return c.json({ error: "permission_set_not_found" as const }, 404)
        if (result.error === "permission_set_archived") {
          return c.json({ error: "permission_set_archived" as const, message: "This permission set was deleted and can't be changed." }, 409)
        }
        return c.json(problemBody(result.problem), problemStatus(result.problem))
      }

      if (result.changes.length > 0) {
        await finishLegacyAuditAction(capture, {
          organizationId,
          actorUserId: payload.currentMember.userId,
          action: ORGANIZATION_AUDIT_ACTIONS.permissionSetPermissionsChanged,
          payload: {
            permissionSetId: result.set.id,
            permissionSetName: result.set.name,
            permissionSetKind: setKind(result.set.defaultKey),
            changedCount: result.changes.length,
            grantedKeys: joinKeys(result.granted),
            revokedKeys: joinKeys(result.revoked),
          },
        }, result.auditEventIds)
      }

      return c.json({ set: await loadPermissionSetDetail(organizationId, result.set, await mayViewRosters(c)) })
    },
  )

  app.get(
    "/v1/permissions/sets/:permissionSetId/history",
    describeRoute({
      tags: ["Permissions"],
      summary: "List permission set history",
      description: "Lists every recorded change to a set's permissions, newest first: the permission, the status it was set to, where the change came from (user, seed, reconcile, migration) and who made it. Paginated with cursor and limit. Requires permissions.view and the Permissions feature.",
      responses: {
        200: jsonResponse("History page returned successfully.", permissionHistoryResponseSchema),
        400: jsonResponse("The permission set id, cursor or limit was invalid.", invalidRequestSchema),
        401: unauthorizedResponse,
        403: forbiddenResponse("The caller lacks permissions.view."),
        404: notFoundResponse("The permission set or organization was not found, or Permissions is turned off."),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.view"),
    paramValidator(permissionSetParamsSchema),
    queryValidator(historyQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const permissionSetId = normalizeDenTypeId("permissionSet", c.req.valid("param").permissionSetId)
      const existing = await readPermissionSet(db, organizationId, permissionSetId)
      if (!existing) return c.json({ error: "permission_set_not_found" as const }, 404)

      const { cursor, limit = DEFAULT_HISTORY_LIMIT } = c.req.valid("query")
      const rows = await historyQuery(organizationId, permissionSetId, cursor)
        .orderBy(desc(PermissionSetPermissionTable.createdAt), desc(PermissionSetPermissionTable.id))
        .limit(limit + 1)
      const page = keysetPage(rows, limit, (row) => ({ at: row.createdAt, id: row.id }))

      return c.json({
        items: page.items.map((row) => ({
          id: row.id,
          key: row.permissionKey,
          label: isPermissionKey(row.permissionKey) ? getPermissionDefinition(row.permissionKey).label : null,
          status: row.status,
          source: row.source,
          changedBy: changedBy(row),
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      })
    },
  )

  app.delete(
    "/v1/permissions/sets/:permissionSetId",
    describeNonMcpRoute({
      tags: ["Permissions"],
      "x-mcp": false,
      summary: "Delete team permissions",
      description: "Archives a team permission set and unlinks it from its team, so its permissions stop applying to the team's members. The set and its history are kept. Member and Admin permissions can't be deleted. Requires permissions.manage (only the owner has it by default), a recent sign-in, and the Permissions feature.",
      responses: {
        204: emptyResponse("The team permission set was archived."),
        400: jsonResponse("The id was invalid, or the set is Member or Admin permissions.", z.union([invalidRequestSchema, defaultPermissionSetErrorSchema])),
        401: unauthorizedResponse,
        403: forbiddenResponse("The caller lacks permissions.manage or needs a recent sign-in."),
        404: notFoundResponse("The permission set or organization was not found, or Permissions is turned off."),
        409: jsonResponse("The permission set is already archived.", permissionSetConflictSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.manage"),
    paramValidator(permissionSetParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const permissionSetId = normalizeDenTypeId("permissionSet", c.req.valid("param").permissionSetId)
      const capture = auditChangeCapture(c)
      const actorMemberId = payload.currentMember.id

      const result = await db.transaction(async (tx) => {
        if (!(await lockPermissionSet(tx, organizationId, permissionSetId))) return { ok: false as const, error: "permission_set_not_found" as const }
        const set = await readPermissionSet(tx, organizationId, permissionSetId)
        if (!set) return { ok: false as const, error: "permission_set_not_found" as const }
        if (set.defaultKey !== null) return { ok: false as const, error: "default_permission_set" as const }
        if (set.archivedAt) return { ok: false as const, error: "permission_set_archived" as const }

        const now = new Date()
        const links = (await readTeamLinks(tx, organizationId, [set.id])).get(set.id) ?? []
        const activeLinks = links.filter((link) => link.removedAt === null)
        const teamId = currentTeam(links)?.id ?? null
        const before = await auditStateFor(tx, set, teamId)

        if (activeLinks.length > 0) {
          await tx.update(PermissionSetTeamTable)
            .set({ removedAt: now, removedByOrgMembershipId: actorMemberId })
            .where(inArray(PermissionSetTeamTable.id, activeLinks.map((link) => link.linkId)))
        }
        await tx.update(PermissionSetTable)
          .set({ archivedAt: now, archivedByOrgMembershipId: actorMemberId })
          .where(eq(PermissionSetTable.id, set.id))

        const archived: PermissionSetRow = { ...set, archivedAt: now, archivedByOrgMembershipId: actorMemberId }
        const auditEventIds = await appendDomainChanges(tx, capture, [
          permissionSetArchivedEvent(organizationId, before, { ...before, set: archived }),
        ])
        return { ok: true as const, set, teamId, auditEventIds }
      })

      if (!result.ok) {
        if (result.error === "permission_set_not_found") return c.json({ error: "permission_set_not_found" as const }, 404)
        if (result.error === "default_permission_set") {
          return c.json({ error: "default_permission_set" as const, message: "Member and Admin permissions can't be deleted. Turn permissions off instead." }, 400)
        }
        return c.json({ error: "permission_set_archived" as const, message: "This permission set was already deleted." }, 409)
      }

      await finishLegacyAuditAction(capture, {
        organizationId,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.permissionSetArchived,
        payload: {
          permissionSetId: result.set.id,
          permissionSetName: result.set.name,
          teamId: result.teamId,
        },
      }, result.auditEventIds)

      return c.body(null, 204)
    },
  )

  app.get(
    "/v1/permissions/keys/:permissionKey",
    describeRoute({
      tags: ["Permissions"],
      summary: "Get one permission across sets",
      description: "Returns one catalog permission and its current status in every active set: Member permissions, Admin permissions and each team set. Requires permissions.view and the Permissions feature.",
      responses: {
        200: jsonResponse("Permission status returned successfully.", permissionKeyResponseSchema),
        400: jsonResponse("The permission key was invalid.", invalidRequestSchema),
        401: unauthorizedResponse,
        403: forbiddenResponse("The caller lacks permissions.view."),
        404: notFoundResponse("The permission or organization was not found, or Permissions is turned off."),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireOrgPermission("permissions.view"),
    paramValidator(permissionKeyParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const key = c.req.valid("param").permissionKey
      if (!isPermissionKey(key)) {
        return c.json({ error: "permission_not_found" as const, message: "This permission doesn't exist." }, 404)
      }

      const sets = await listActiveSets(organizationId)
      const setIds = sets.map((set) => set.id)
      const [states, links] = await Promise.all([
        readPermissionSetStates(db, setIds),
        readTeamLinks(db, organizationId, setIds),
      ])
      return c.json({
        permission: serializeDefinition(key),
        sets: sets.map((set) => {
          const defaultKey = set.defaultKey
          const status: PermissionStatus = allowedKeys(states.get(set.id), [key]).has(key) ? "allow" : "deny"
          return {
            id: set.id,
            name: set.name,
            kind: setKind(defaultKey),
            team: currentTeam(links.get(set.id)),
            status,
            locked: defaultKey !== null && isPermissionLockedOn(key, defaultKey),
          }
        }),
      })
    },
  )

  app.get(
    "/v1/members/:memberId/permissions",
    describeRoute({
      tags: ["Permissions"],
      summary: "Get a member's effective permissions",
      description: "Lists the permissions one member has and, for each, every source that grants it, e.g. \"Admin permissions (admin role)\" or \"Support Permissions (via Support team)\". Members can always read their own; reading someone else's requires permissions.view. Requires the Permissions feature.",
      responses: {
        200: jsonResponse("Effective permissions returned successfully.", memberPermissionsResponseSchema),
        400: jsonResponse("The member id was invalid.", invalidRequestSchema),
        401: unauthorizedResponse,
        403: forbiddenResponse("The caller is reading another member's permissions without permissions.view."),
        404: notFoundResponse("The member or organization was not found, or Permissions is turned off."),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    paramValidator(memberParamsSchema),
    async (c) => {
      const payload = organizationContext(c)
      if (!payload) return c.json({ error: "organization_not_found" as const }, 404)
      const memberId = normalizeDenTypeId("member", c.req.valid("param").memberId)
      if (memberId !== payload.currentMember.id && !(await hasPermission(c, "permissions.view"))) {
        const denied = permissionDeniedResponse("permissions.view")
        return c.json(denied, 403, permissionFailureHeaders(denied))
      }

      const explanation = await explainPermissionsForMember({ organizationId: payload.organization.id, memberId })
      if (!explanation) return c.json({ error: "member_not_found" as const }, 404)
      return c.json({
        memberId,
        featureEnabled: explanation.featureEnabled,
        isOwner: explanation.isOwner,
        isAdmin: explanation.isAdmin,
        permissions: explanation.permissions.map((entry) => ({
          key: entry.key,
          label: getPermissionDefinition(entry.key).label,
          sources: entry.sources.map((source) => ({ ...source, label: permissionSourceLabel(source) })),
        })),
      })
    },
  )
}
