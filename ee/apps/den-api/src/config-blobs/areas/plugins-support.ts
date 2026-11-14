/**
 * Shared by the `plugins.*` config-blob areas (plugins-skills.ts,
 * plugins-plugins.ts, plugins-sources.ts): the plugin-system actor, access
 * grants by role, and the "org-shared vs personal" rule.
 *
 * Org-shared vs personal (what the plugins areas export):
 * every plugin and config object is an org row with a creator; My Library is
 * just what is shared with a member. A row is **personal** while only its
 * creator can reach it (its only active grant is the creator's own person
 * grant, which the store adds on create). It is **org-shared** when:
 * - a plugin: it has any other active grant (a team, another person,
 *   everyone), is in a collection (`marketplace_plugin`), or a source maps
 *   into it (`connector_mapping.plugin_id`);
 * - a config object: it has any other active grant, or it is an active
 *   member of an org-shared plugin.
 * Personal rows are never exported and an import never touches them.
 * Workflows / scripts (Library › Workflows, their own versioned service) and
 * authored MCP Apps (compiled through create_app / update_app) are not part
 * of `plugins.skills` at all, nor are the personal "Workflows" plugins.
 */
import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorMappingTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep, ConfigRef } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import { listTeamsForMember } from "../../member-teams.js"
import type { PluginArchActorContext } from "../../routes/org/plugin-system/access.js"
import { createResourceAccessGrant, deleteResourceAccessGrant } from "../../routes/org/plugin-system/store.js"
import type { ConfigAreaContext, ConfigDb } from "../area.js"
import {
  ConfigApplyError,
  configRouteContext,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  OWN_MANAGER_ACCESS_KEPT,
  personRef,
  resolvedRefIds,
  specRefSchema,
  teamRef,
  type ConfigStepLog,
  type JsonObject,
} from "./route-support.js"

// ---------------------------------------------------------------------------
// Actor

/** The plugin-system actor for the applying member, as the plugin routes build it. */
export async function pluginArchActor(ctx: ConfigAreaContext): Promise<PluginArchActorContext> {
  const { payload, c } = await configRouteContext(ctx)
  return {
    memberTeams: await listTeamsForMember({ organizationId: payload.organization.id, memberId: payload.currentMember.id }),
    organizationContext: payload,
    session: c.get("session"),
  }
}

// ---------------------------------------------------------------------------
// Access grants by role

export const ACCESS_ROLES = ["viewer", "editor", "manager"] as const
export type AccessRole = (typeof ACCESS_ROLES)[number]

const byRoleSchema = z.object({
  viewer: z.array(specRefSchema).max(500).default([]),
  editor: z.array(specRefSchema).max(500).default([]),
  manager: z.array(specRefSchema).max(500).default([]),
}).strict()

/** `orgWide`: the role everyone in the organization has, or null. Teams and people by role. */
export const accessByRoleSchema = z.object({
  orgWide: z.enum(ACCESS_ROLES).nullable().default(null),
  teams: byRoleSchema.default({ viewer: [], editor: [], manager: [] }),
  members: byRoleSchema.default({ viewer: [], editor: [], manager: [] }),
}).strict()

export type AccessByRole = { orgWide: AccessRole | null; teams: Record<AccessRole, ConfigRef[]>; members: Record<AccessRole, ConfigRef[]> }

export type GrantRow = {
  id: string
  resourceId: string
  orgWide: boolean
  teamId: string | null
  orgMembershipId: string | null
  role: AccessRole
}

export type GrantKind = "config_object" | "plugin" | "connector_instance"

/** Active grants of these resources. */
export async function loadGrants(db: ConfigDb, kind: GrantKind, organizationId: string, resourceIds: readonly string[]): Promise<GrantRow[]> {
  const ids = [...new Set(resourceIds)]
  if (ids.length === 0) return []
  const orgId = normalizeDenTypeId("organization", organizationId)
  if (kind === "config_object") {
    const rows = await db.select().from(ConfigObjectAccessGrantTable).where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, orgId),
      inArray(ConfigObjectAccessGrantTable.configObjectId, ids.map((id) => normalizeDenTypeId("configObject", id))),
      isNull(ConfigObjectAccessGrantTable.removedAt),
    ))
    return rows.map((row) => ({ id: row.id, resourceId: row.configObjectId, orgWide: row.orgWide, teamId: row.teamId, orgMembershipId: row.orgMembershipId, role: row.role }))
  }
  if (kind === "plugin") {
    const rows = await db.select().from(PluginAccessGrantTable).where(and(
      eq(PluginAccessGrantTable.organizationId, orgId),
      inArray(PluginAccessGrantTable.pluginId, ids.map((id) => normalizeDenTypeId("plugin", id))),
      isNull(PluginAccessGrantTable.removedAt),
    ))
    return rows.map((row) => ({ id: row.id, resourceId: row.pluginId, orgWide: row.orgWide, teamId: row.teamId, orgMembershipId: row.orgMembershipId, role: row.role }))
  }
  const rows = await db.select().from(ConnectorInstanceAccessGrantTable).where(and(
    eq(ConnectorInstanceAccessGrantTable.organizationId, orgId),
    inArray(ConnectorInstanceAccessGrantTable.connectorInstanceId, ids.map((id) => normalizeDenTypeId("connectorInstance", id))),
    isNull(ConnectorInstanceAccessGrantTable.removedAt),
  ))
  return rows.map((row) => ({ id: row.id, resourceId: row.connectorInstanceId, orgWide: row.orgWide, teamId: row.teamId, orgMembershipId: row.orgMembershipId, role: row.role }))
}

export type AudienceNames = { teamNames: Map<string, string>; memberEmails: Map<string, string> }

export async function loadAudienceNames(db: ConfigDb, organizationId: string, grants: readonly GrantRow[]): Promise<AudienceNames> {
  const [teamNames, memberEmails] = await Promise.all([
    loadTeamNames(db, organizationId, grants.flatMap((grant) => grant.teamId ? [grant.teamId] : [])),
    loadMemberEmails(db, organizationId, grants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : [])),
  ])
  return { teamNames, memberEmails }
}

/** Grants as refs by role, sorted (stable exports). People without an email are left out. */
export function accessSpec(grants: readonly GrantRow[], names: AudienceNames): AccessByRole {
  let orgWide: AccessRole | null = null
  const teams: Record<AccessRole, Array<{ id: string; name: string | undefined }>> = { viewer: [], editor: [], manager: [] }
  const members: Record<AccessRole, string[]> = { viewer: [], editor: [], manager: [] }
  for (const grant of grants) {
    if (grant.orgMembershipId) {
      const email = names.memberEmails.get(grant.orgMembershipId)
      if (email) members[grant.role].push(email)
    } else if (grant.teamId) {
      teams[grant.role].push({ id: grant.teamId, name: names.teamNames.get(grant.teamId) })
    } else if (grant.orgWide) {
      orgWide = grant.role
    }
  }
  const teamRefs = (role: AccessRole) => teams[role].sort((left, right) => left.id.localeCompare(right.id)).map((team) => teamRef(team.id, team.name))
  const memberRefs = (role: AccessRole) => [...new Set(members[role])].sort().map(personRef)
  return {
    orgWide,
    teams: { viewer: teamRefs("viewer"), editor: teamRefs("editor"), manager: teamRefs("manager") },
    members: { viewer: memberRefs("viewer"), editor: memberRefs("editor"), manager: memberRefs("manager") },
  }
}

type DesiredGrant = { key: string; role: AccessRole; label: string; value: { orgWide?: true; teamId?: string; orgMembershipId?: string } }

function grantKey(grant: { orgWide: boolean; teamId: string | null; orgMembershipId: string | null }): string {
  if (grant.orgMembershipId) return `member:${grant.orgMembershipId}`
  if (grant.teamId) return `team:${grant.teamId}`
  return "org"
}

function refLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    if (!isJsonObject(entry)) return "?"
    if (typeof entry.name === "string" && entry.name) return entry.name
    return typeof entry.$ref === "string" ? entry.$ref.replace(/^[^/]+\//, "") : "?"
  })
}

/** The grants the resolved spec asks for. Higher roles win when a team or person is listed twice. */
function desiredGrants(access: unknown): DesiredGrant[] {
  const spec = isJsonObject(access) ? access : {}
  const teams = isJsonObject(spec.teams) ? spec.teams : {}
  const members = isJsonObject(spec.members) ? spec.members : {}
  const out = new Map<string, DesiredGrant>()
  const orgWide = spec.orgWide
  if (orgWide === "viewer" || orgWide === "editor" || orgWide === "manager") {
    out.set("org", { key: "org", role: orgWide, label: "everyone", value: { orgWide: true } })
  }
  for (const role of ACCESS_ROLES) {
    const teamLabels = refLabels(teams[role])
    resolvedRefIds(teams[role], `access.teams.${role}`).forEach((id, index) => {
      const teamId = normalizeDenTypeId("team", id)
      out.set(`team:${teamId}`, { key: `team:${teamId}`, role, label: teamLabels[index] ?? teamId, value: { teamId } })
    })
    const memberLabels = refLabels(members[role])
    resolvedRefIds(members[role], `access.members.${role}`).forEach((id, index) => {
      const orgMembershipId = normalizeDenTypeId("member", id)
      out.set(`member:${orgMembershipId}`, { key: `member:${orgMembershipId}`, role, label: memberLabels[index] ?? orgMembershipId, value: { orgMembershipId } })
    })
  }
  return [...out.values()]
}

function grantTargetField(key: string): string {
  if (key === "org") return "access.orgWide"
  return key.startsWith("team:") ? "access.teams" : "access.members"
}

/**
 * Make the active grants of one resource exactly the spec's, through the same
 * store calls as the access routes (role checks, org-wide permission, plugin
 * MCP access re-sync). Only grants that differ are written. The applying
 * member's own manager grant is kept, as in the dashboard.
 */
export async function applyAccess(input: {
  ctx: ConfigAreaContext
  actor: PluginArchActorContext
  kind: GrantKind
  resourceId: string
  access: unknown
  log: ConfigStepLog
  warnings: string[]
}): Promise<void> {
  const desired = desiredGrants(input.access)
  const current = await loadGrants(input.ctx.db, input.kind, input.ctx.organizationId, [input.resourceId])
  const currentByKey = new Map(current.map((grant) => [grantKey(grant), grant]))
  const write = async (step: ConfigApplyStep, value: DesiredGrant["value"], role: AccessRole) => {
    const grant = {
      role,
      ...(value.orgWide ? { orgWide: true } : {}),
      ...(value.teamId ? { teamId: normalizeDenTypeId("team", value.teamId) } : {}),
      ...(value.orgMembershipId ? { orgMembershipId: normalizeDenTypeId("member", value.orgMembershipId) } : {}),
    }
    await input.log.run(step, async () => {
      if (input.kind === "config_object") {
        await createResourceAccessGrant({ context: input.actor, resourceKind: "config_object", resourceId: normalizeDenTypeId("configObject", input.resourceId), value: grant })
      } else if (input.kind === "plugin") {
        await createResourceAccessGrant({ context: input.actor, resourceKind: "plugin", resourceId: normalizeDenTypeId("plugin", input.resourceId), value: grant })
      } else {
        await createResourceAccessGrant({ context: input.actor, resourceKind: "connector_instance", resourceId: normalizeDenTypeId("connectorInstance", input.resourceId), value: grant })
      }
    })
  }
  for (const grant of desired) {
    const existing = currentByKey.get(grant.key)
    if (existing?.role === grant.role) continue
    const action = existing ? "set" : "add"
    await write({ action, target: grantTargetField(grant.key), detail: `${grant.label} (${grant.role})` }, grant.value, grant.role)
  }
  const desiredKeys = new Set(desired.map((grant) => grant.key))
  const self = input.actor.organizationContext.currentMember.id
  for (const grant of current) {
    const key = grantKey(grant)
    if (desiredKeys.has(key)) continue
    if (grant.orgMembershipId === self && grant.role === "manager") {
      input.warnings.push(OWN_MANAGER_ACCESS_KEPT)
      continue
    }
    const detail = grant.orgWide ? "everyone" : grant.teamId ?? grant.orgMembershipId ?? grant.id
    await input.log.run({ action: "remove", target: grantTargetField(key), detail: `${detail} (${grant.role})` }, async () => {
      if (input.kind === "config_object") {
        await deleteResourceAccessGrant({ context: input.actor, resourceKind: "config_object", resourceId: normalizeDenTypeId("configObject", input.resourceId), grantId: normalizeDenTypeId("configObjectAccessGrant", grant.id) })
      } else if (input.kind === "plugin") {
        await deleteResourceAccessGrant({ context: input.actor, resourceKind: "plugin", resourceId: normalizeDenTypeId("plugin", input.resourceId), grantId: normalizeDenTypeId("pluginAccessGrant", grant.id) })
      } else {
        await deleteResourceAccessGrant({ context: input.actor, resourceKind: "connector_instance", resourceId: normalizeDenTypeId("connectorInstance", input.resourceId), grantId: normalizeDenTypeId("connectorInstanceAccessGrant", grant.id) })
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Org-shared vs personal

/** Whether a grant is the creator's own person grant (the one the store adds on create). */
function isCreatorGrant(grant: GrantRow, creatorId: string): boolean {
  return !grant.orgWide && !grant.teamId && grant.orgMembershipId === creatorId
}

export type SharedPlugins = {
  /** Org-shared plugin ids. */
  ids: Set<string>
  /** Plugins a source maps into (their contents come from that source). */
  sourceMapped: Set<string>
  /** Plugins the OpenWork Marketplace seeds into every organization. */
  builtIn: Set<string>
}

/** Every live plugin of the organization, and which of them are org-shared. */
export async function loadSharedPlugins(db: ConfigDb, organizationId: string): Promise<{ rows: Array<typeof PluginTable.$inferSelect>; shared: SharedPlugins }> {
  const orgId = normalizeDenTypeId("organization", organizationId)
  const rows = await db.select().from(PluginTable).where(and(eq(PluginTable.organizationId, orgId), isNull(PluginTable.deletedAt), inArray(PluginTable.status, ["active", "inactive", "archived"])))
  const shared: SharedPlugins = { ids: new Set(), sourceMapped: new Set(), builtIn: new Set() }
  if (rows.length === 0) return { rows, shared }
  const ids = rows.map((row) => row.id)
  const [grants, memberships, mappings] = await Promise.all([
    loadGrants(db, "plugin", organizationId, ids),
    db.select({ pluginId: MarketplacePluginTable.pluginId, membershipSource: MarketplacePluginTable.membershipSource })
      .from(MarketplacePluginTable)
      .innerJoin(MarketplaceTable, eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId))
      .where(and(eq(MarketplacePluginTable.organizationId, orgId), isNull(MarketplacePluginTable.removedAt), isNull(MarketplaceTable.deletedAt), inArray(MarketplacePluginTable.pluginId, ids))),
    db.select({ pluginId: ConnectorMappingTable.pluginId })
      .from(ConnectorMappingTable)
      .where(and(eq(ConnectorMappingTable.organizationId, orgId), isNotNull(ConnectorMappingTable.pluginId))),
  ])
  const creators = new Map<string, string>(rows.map((row) => [row.id, row.createdByOrgMembershipId]))
  for (const grant of grants) {
    if (!isCreatorGrant(grant, creators.get(grant.resourceId) ?? "")) shared.ids.add(grant.resourceId)
  }
  for (const membership of memberships) {
    shared.ids.add(membership.pluginId)
    if (membership.membershipSource === "system") shared.builtIn.add(membership.pluginId)
  }
  for (const mapping of mappings) {
    if (!mapping.pluginId) continue
    shared.ids.add(mapping.pluginId)
    shared.sourceMapped.add(mapping.pluginId)
  }
  return { rows, shared }
}

/** Object types `plugins.skills` carries. Workflows and scripts belong to Library › Workflows. */
export const EXPORTED_OBJECT_TYPES = ["skill", "agent", "command", "tool", "mcp", "hook", "context", "custom", "app"] as const

/** Org-shared config object ids among `objectIds` (creator ids alongside). */
export async function sharedConfigObjectIds(input: {
  db: ConfigDb
  organizationId: string
  objects: ReadonlyArray<{ id: string; createdByOrgMembershipId: string }>
  sharedPluginIds: ReadonlySet<string>
}): Promise<Set<string>> {
  const out = new Set<string>()
  if (input.objects.length === 0) return out
  const ids = input.objects.map((object) => object.id)
  const creators = new Map(input.objects.map((object) => [object.id, object.createdByOrgMembershipId]))
  const orgId = normalizeDenTypeId("organization", input.organizationId)
  const [grants, memberships] = await Promise.all([
    loadGrants(input.db, "config_object", input.organizationId, ids),
    input.db.select({ pluginId: PluginConfigObjectTable.pluginId, configObjectId: PluginConfigObjectTable.configObjectId })
      .from(PluginConfigObjectTable)
      .where(and(eq(PluginConfigObjectTable.organizationId, orgId), isNull(PluginConfigObjectTable.removedAt), inArray(PluginConfigObjectTable.configObjectId, ids.map((id) => normalizeDenTypeId("configObject", id))))),
  ])
  for (const grant of grants) {
    if (!isCreatorGrant(grant, creators.get(grant.resourceId) ?? "")) out.add(grant.resourceId)
  }
  for (const membership of memberships) {
    if (input.sharedPluginIds.has(membership.pluginId)) out.add(membership.configObjectId)
  }
  return out
}

/** Live config objects (not deleted) of the exported types. */
export async function loadConfigObjects(db: ConfigDb, organizationId: string, ids: readonly string[] | null) {
  const orgId = normalizeDenTypeId("organization", organizationId)
  if (ids && ids.length === 0) return []
  return db.select().from(ConfigObjectTable).where(and(
    eq(ConfigObjectTable.organizationId, orgId),
    isNull(ConfigObjectTable.deletedAt),
    inArray(ConfigObjectTable.status, ["active", "inactive", "archived", "ingestion_error"]),
    inArray(ConfigObjectTable.objectType, [...EXPORTED_OBJECT_TYPES]),
    ids ? inArray(ConfigObjectTable.id, ids.map((id) => normalizeDenTypeId("configObject", id))) : undefined,
  ))
}

// ---------------------------------------------------------------------------
// Small helpers

/** The local id of a resolved single ref, or null when the ref is null/absent. */
export function resolvedRefId(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  const [id] = resolvedRefIds([value], label)
  return id ?? null
}

/** The target ids referenced by an exported (unresolved) ref list: "<area>/<id>" → id. */
export function exportedRefIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isJsonObject(entry) && typeof entry.$ref === "string" ? [entry.$ref.slice(entry.$ref.indexOf("/") + 1)] : [])
}

export function parseSpec<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((entry) => `${entry.path.join(".")}: ${entry.message}`).join("; "), 400, issue ? issue.path.join(".") : undefined)
  }
  return parsed.data
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isJsonObject(value)) return value
  const out: JsonObject = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

// ---------------------------------------------------------------------------
// Similarity (names are not unique in the plugins areas)

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function tokens(value: string): Set<string> {
  return new Set(normalizeText(value).split(" ").filter(Boolean))
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const entry of left) if (right.has(entry)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** 1 for equal names (case, spaces, punctuation ignored), else token overlap. */
export function nameSimilarity(left: string, right: string): number {
  if (normalizeText(left) === normalizeText(right)) return 1
  return jaccard(tokens(left), tokens(right))
}

/** The text without a leading `---` frontmatter block (SKILL.md, agents, commands): names and descriptions are compared apart. */
function withoutFrontmatter(text: string): string {
  const match = /^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return match ? text.slice(match[0].length) : text
}

/** Share of equal non-empty lines between two texts (order ignored, frontmatter left out). */
export function textOverlap(left: string | null, right: string | null): number {
  if (left === null || right === null) return 0
  if (left === right) return 1
  const lines = (text: string) => new Set(withoutFrontmatter(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  return jaccard(lines(left), lines(right))
}

/** Leaf paths → JSON values of a plain object. */
function leaves(value: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) leaves(entry, prefix ? `${prefix}.${key}` : key, out)
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => leaves(entry, `${prefix}[${index}]`, out))
  } else {
    out.set(prefix, JSON.stringify(value))
  }
  return out
}

/** Share of equal leaf fields between two JSON values. */
export function jsonOverlap(left: unknown, right: unknown): number {
  if (left === null || left === undefined || right === null || right === undefined) return 0
  const a = leaves(left)
  const b = leaves(right)
  if (a.size === 0 && b.size === 0) return 1
  let equal = 0
  for (const [path, value] of a) if (b.get(path) === value) equal += 1
  return equal / Math.max(a.size, b.size)
}
