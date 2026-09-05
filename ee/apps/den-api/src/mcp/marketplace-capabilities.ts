import { and, desc, eq, inArray, isNull, notExists } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  listExternalMcpConnections,
  listUsableExternalMcpConnections,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import {
  declaredPluginMcpAuthType,
  requiredPluginMcpAuthType,
  type PluginMcpAuthType,
} from "../capability-sources/external-mcp-auth-policy.js"
import { EXTERNAL_MCP_PRESETS } from "../capability-sources/external-mcp-presets.js"
import { getConnectedAccount, getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { db } from "../db.js"
import { resolvePluginArchGrantRole } from "../routes/org/plugin-system/access.js"
import { openworkOrganizationConnectionsUrl, openworkYourConnectionsUrl } from "./connection-navigation.js"
import { parseCodemodeScriptPayload, type CodemodeScriptInputIssue } from "./codemode-script-object.js"
import { type BuiltCodemodeTools } from "./codemode-tools.js"
import { executeWorkflow } from "./workflow-service.js"
import { listPluginMcpRequirementBindings, type PluginMcpRequirementBindingRow } from "./plugin-mcp-requirement-bindings.js"
import { scoreText, tokenize } from "./search.js"
import type { McpMemberIdentity } from "./external-capabilities.js"
import type { CapabilityMatch } from "./search.js"

const MARKETPLACE_CAPABILITY_PREFIX = "plugin:"
const PROVENANCE_SUFFIX = "in your organization's library."
const AGENT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type RemoteSkillDescriptor = {
  name: string
  title: string
  description: string
  marketplaceName?: string
  pluginName?: string
  capability: string
  location: string
}

export type AccessibleMarketplaceCapabilityReference = {
  configObjectId: string
  marketplaceId: string | null
  objectType: MarketplaceCapabilityObjectType
  pluginId: string
}

export function normalizeRemoteSkillDescription(input: {
  description: string | null
  name: string
  title: string
}): string {
  const description = input.description?.replace(/\s+/g, " ").trim()
  return (description || input.title.trim() || input.name).slice(0, 1_024)
}

export function standardSkillName(title: string, stableId: string): string {
  const suffix = stableId.replace(/^skill_/, "").slice(-8).toLowerCase()
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
  const bounded = base.slice(0, Math.max(1, 64 - suffix.length - 1)).replace(/-+$/g, "")
  const name = `${bounded || "skill"}-${suffix}`
  return AGENT_SKILL_NAME_PATTERN.test(name) ? name : `skill-${suffix}`
}

type OrganizationId = DenTypeId<"organization">
type PluginId = DenTypeId<"plugin">
type ConfigObjectId = DenTypeId<"configObject">
type ConfigObjectRow = typeof ConfigObjectTable.$inferSelect
type ConfigObjectType = ConfigObjectRow["objectType"]
export type MarketplaceCapabilityObjectType = ConfigObjectType
type ConfigObjectVersionRow = typeof ConfigObjectVersionTable.$inferSelect
type MemberRow = Pick<typeof MemberTable.$inferSelect, "id" | "role">
type UsableExternalMcpConnection = Awaited<ReturnType<typeof listUsableExternalMcpConnections>>[number]
type MarketplaceCapabilityRow = {
  configObject: ConfigObjectRow
  marketplace: typeof MarketplaceTable.$inferSelect | null
  plugin: typeof PluginTable.$inferSelect
}

function canonicalConfigObjectType(objectType: ConfigObjectType): ConfigObjectType {
  return objectType === "script" ? "workflow" : objectType
}

type GrantRow = {
  orgMembershipId: DenTypeId<"member"> | null
  orgWide: boolean
  removedAt: Date | null
  role: "viewer" | "editor" | "manager"
  teamId: DenTypeId<"team"> | null
}
type GrantWithResourceId = GrantRow & { resourceId: string }

export type MarketplaceCapabilityMatch = CapabilityMatch & {
  kind: ConfigObjectType
  plugin: string
  marketplace?: string
  status?: MarketplaceCapabilityStatus
  hint?: string
  action?: MarketplaceMcpRequirementAction
  mcpRequirements?: MarketplaceMcpRequirementStatus[]
}

export type MarketplaceCapabilityStatus = "connection_available" | "content_not_synced" | "executed" | "needs_admin_setup" | "needs_connection" | "needs_install" | "ready" | "reconnect" | "unsupported"

export type MarketplaceMcpRequirementState = "needs_admin_setup" | "needs_connection" | "ready" | "reconnect"

export type MarketplaceMcpRequirementAction = {
  type: "connect" | "none" | "reconnect" | "setup_connection"
  label: string
  surface: "none" | "openwork_organization_connections" | "openwork_your_connections"
  retry: "execute_capability" | "search_capabilities"
  url?: string
}

export type MarketplaceMcpRequirementStatus = {
  configObjectId: string
  pluginId: string
  pluginName: string
  serverName: string
  name: string
  state: MarketplaceMcpRequirementState
  action: MarketplaceMcpRequirementAction
  connectionId?: string
  connectionName?: string
  credentialMode?: "shared" | "per_member"
  connectedForMe?: boolean
}

export type MarketplaceCapabilityExecutePayload = {
  kind: ConfigObjectType
  plugin: string
  marketplace: string | null
  name: string
  description: string | null
  provenance: string
  content?: string
  definition?: string | null
  serverSpec?: Record<string, unknown>
  source?: string | null
  value?: unknown
  logs?: string[]
  toolCalls?: Array<{ name: string }>
  durationMs?: number
  receiptId?: string | null
  canonicalResult?: string
  markdown?: string
  resultDigest?: string
  inputSchemaDigest?: string | null
  outputSchemaDigest?: string | null
  rendererVersion?: "codemode-markdown-v1"
  status?: MarketplaceCapabilityStatus
  hint?: string
  action?: MarketplaceMcpRequirementAction
  mcpRequirements?: MarketplaceMcpRequirementStatus[]
}

export type MarketplaceCapabilityExecuteResult =
  | { ok: true; result: MarketplaceCapabilityExecutePayload }
  | { ok: false; error: "unknown_capability" | "forbidden"; message: string }
  | {
      ok: false
      error: "invalid_capability_arguments"
      message: string
      issues: CodemodeScriptInputIssue[]
      sameArgumentsRetryable: false
      retry: { action: "correct_arguments"; searchRequired: false }
      receiptId?: string | null
    }
  | {
      ok: false
      error: "capability_unavailable"
      message: string
      providerCallAttempted: false
      missing: Array<{ capabilityName: string; scriptPath: string }>
      receiptId?: string | null
    }
  | {
      ok: false
      error: "script_failed"
      message: string
      kind: string
      toolCalls: Array<{ name: string }>
      receiptId?: string | null
    }

export type MarketplaceConfigObjectExecutionMode = "codemode" | "desktop_only" | "instructional" | "mcp"

export type AccessibleWorkflow = {
  pluginId: string
  configObjectId: string
  configObjectVersionId: string
  title: string
  description: string | null
  inputSchema: unknown | null
  outputSchema: unknown | null
  requiredCapabilities: Array<{ capabilityName: string; scriptPath: string }>
}

export type MarketplaceCloudReadinessState = "ready" | "needs_signin" | "needs_admin_setup" | "desktop_only" | "not_synced"

export type MarketplaceCloudReadinessConnection = {
  authType?: "apikey" | "none" | "oauth"
  authTypeMismatch?: boolean
  configObjectId: string
  id: string | null
  name: string
  serverName: string
  url: string
  credentialMode?: "shared" | "per_member"
  connectedForMe?: boolean
  oauthClientConfigured?: boolean
  oauthClientRequired?: boolean
  requiredAuthType?: "apikey" | "none" | "oauth"
}

export type MarketplacePluginCloudReadiness = {
  state: MarketplaceCloudReadinessState
  hasInstructional: boolean
  connections: MarketplaceCloudReadinessConnection[]
}

type MarketplaceReadinessConfigObject = {
  id: ConfigObjectId
  objectType: ConfigObjectType
  pluginId: PluginId
  title: string
}

type MarketplaceMcpDependency = {
  configObjectId: ConfigObjectId
  externalMcpConnectionId: string | null
  name: string
  pluginId: PluginId
  requiredAuthType: PluginMcpAuthType | null
  serverName: string
  url: string
}

type MarketplacePluginMcpRequirement = {
  configObjectId: ConfigObjectId
  externalMcpConnectionId: string | null
  name: string
  pluginId: PluginId
  pluginName: string
  requiredAuthType: PluginMcpAuthType | null
  serverName: string
  url: string
}

export function buildMarketplaceCapabilityName(pluginId: string, configObjectId: string): string {
  return `${MARKETPLACE_CAPABILITY_PREFIX}${pluginId}:${configObjectId}`
}

export function parseMarketplaceCapabilityName(name: string): { configObjectId: string; pluginId: string } | null {
  if (!name.startsWith(MARKETPLACE_CAPABILITY_PREFIX)) return null
  const rest = name.slice(MARKETPLACE_CAPABILITY_PREFIX.length)
  const separatorIndex = rest.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex >= rest.length - 1) return null
  return {
    pluginId: rest.slice(0, separatorIndex),
    configObjectId: rest.slice(separatorIndex + 1),
  }
}

function normalizeMarketplaceIds(input: { configObjectId: string; pluginId: string }): { configObjectId: ConfigObjectId; pluginId: PluginId } | null {
  try {
    return {
      configObjectId: normalizeDenTypeId("configObject", input.configObjectId),
      pluginId: normalizeDenTypeId("plugin", input.pluginId),
    }
  } catch {
    return null
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function groupGrants<TGrant extends GrantWithResourceId>(rows: TGrant[]): Map<string, TGrant[]> {
  const grouped = new Map<string, TGrant[]>()
  for (const row of rows) {
    const existing = grouped.get(row.resourceId) ?? []
    existing.push(row)
    grouped.set(row.resourceId, existing)
  }
  return grouped
}

function grantRole(member: McpMemberIdentity, grants: GrantRow[]) {
  return resolvePluginArchGrantRole({
    grants,
    memberId: member.orgMembershipId,
    teamIds: member.teamIds,
  })
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || fallback
}

function pluginPath(row: MarketplaceCapabilityRow): string {
  const pluginSlug = slugify(row.plugin.name, row.plugin.id)
  const relativePath = row.configObject.currentRelativePath?.trim()
    || row.configObject.currentFileName?.trim()
    || row.configObject.id
  return `plugin://${pluginSlug}/${relativePath.replace(/^\/+/, "")}`
}

function provenance(pluginName: string): string {
  return `Content from plugin ${pluginName} ${PROVENANCE_SUFFIX}`
}

function objectHint(row: MarketplaceCapabilityRow): string {
  return row.marketplace
    ? `Install marketplace plugin "${row.plugin.name}" from "${row.marketplace.name}" locally to use "${row.configObject.title}".`
    : `Install plugin "${row.plugin.name}" locally to use "${row.configObject.title}".`
}

function contentNotSyncedHint(row: MarketplaceCapabilityRow): string {
  return `Marketplace plugin "${row.plugin.name}" has not synced content for "${row.configObject.title}" yet. Connect or sync the source, then try again.`
}

function unsupportedScriptHint(row: MarketplaceCapabilityRow, message: string): string {
  return `Marketplace plugin "${row.plugin.name}" Workflow "${row.configObject.title}" cannot run: ${message}`
}

function summaryFor(row: MarketplaceCapabilityRow): string {
  const prefix = row.marketplace
    ? `[${row.marketplace.name} / ${row.plugin.name}] ${row.configObject.title}`
    : `[${row.plugin.name}] ${row.configObject.title}`
  const description = row.configObject.description?.trim()
  return description ? `${prefix}: ${description}` : prefix
}

function scoreMarketplaceRow(row: MarketplaceCapabilityRow, queryTokens: string[]): number {
  const score = scoreText(
    tokenize(row.configObject.title),
    tokenize(row.configObject.description ?? ""),
    queryTokens,
    tokenize(row.configObject.searchText ?? ""),
  )
  if (row.configObject.objectType !== "skill") return score
  return queryTokens.some((queryToken) => queryToken === "skill" || queryToken === "skills")
    ? score + 1
    : score
}

function basePayload(row: MarketplaceCapabilityRow): MarketplaceCapabilityExecutePayload {
  return {
    kind: canonicalConfigObjectType(row.configObject.objectType),
    plugin: row.plugin.name,
    marketplace: row.marketplace ? row.marketplace.name : null,
    name: row.configObject.title,
    description: row.configObject.description,
    provenance: provenance(row.plugin.name),
  }
}

async function getActiveMember(organizationId: OrganizationId, member: McpMemberIdentity | null): Promise<MemberRow | null> {
  if (!member) return null
  const rows = await db
    .select({ id: MemberTable.id, role: MemberTable.role })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.id, member.orgMembershipId),
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function listActiveMarketplaceRows(organizationId: OrganizationId): Promise<MarketplaceCapabilityRow[]> {
  const rows = await db
    .select({
      configObject: ConfigObjectTable,
      marketplace: MarketplaceTable,
      plugin: PluginTable,
    })
    .from(ConfigObjectTable)
    .innerJoin(
      PluginConfigObjectTable,
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
    )
    .innerJoin(
      PluginTable,
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
    )
    .innerJoin(
      MarketplacePluginTable,
      eq(MarketplacePluginTable.pluginId, PluginTable.id),
    )
    .innerJoin(
      MarketplaceTable,
      eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId),
    )
    .where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, organizationId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.organizationId, organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(MarketplacePluginTable.organizationId, organizationId),
      isNull(MarketplacePluginTable.removedAt),
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(PluginTable.name, ConfigObjectTable.title, MarketplaceTable.name)
  return rows
}

async function listGrantOnlyRows(organizationId: OrganizationId): Promise<MarketplaceCapabilityRow[]> {
  const rows = await db
    .select({
      configObject: ConfigObjectTable,
      plugin: PluginTable,
    })
    .from(ConfigObjectTable)
    .innerJoin(
      PluginConfigObjectTable,
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
    )
    .innerJoin(
      PluginTable,
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
    )
    .where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, organizationId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.organizationId, organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      notExists(
        db
          .select({ id: MarketplacePluginTable.id })
          .from(MarketplacePluginTable)
          .innerJoin(
            MarketplaceTable,
            eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId),
          )
          .where(and(
            eq(MarketplacePluginTable.pluginId, PluginTable.id),
            eq(MarketplacePluginTable.organizationId, organizationId),
            isNull(MarketplacePluginTable.removedAt),
            eq(MarketplaceTable.organizationId, organizationId),
            eq(MarketplaceTable.status, "active"),
            isNull(MarketplaceTable.deletedAt),
          )),
      ),
    ))
    .orderBy(PluginTable.name, ConfigObjectTable.title)
  return rows.map((row) => ({ ...row, marketplace: null }))
}

async function listActiveCapabilityRows(organizationId: OrganizationId): Promise<MarketplaceCapabilityRow[]> {
  const marketplaceRows = await listActiveMarketplaceRows(organizationId)
  const grantOnlyRows = await listGrantOnlyRows(organizationId)
  return [...marketplaceRows, ...grantOnlyRows]
}

async function listActiveMarketplaceRowsForCapability(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<MarketplaceCapabilityRow[]> {
  const rows = await db
    .select({
      configObject: ConfigObjectTable,
      marketplace: MarketplaceTable,
      plugin: PluginTable,
    })
    .from(ConfigObjectTable)
    .innerJoin(
      PluginConfigObjectTable,
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
    )
    .innerJoin(
      PluginTable,
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
    )
    .innerJoin(
      MarketplacePluginTable,
      eq(MarketplacePluginTable.pluginId, PluginTable.id),
    )
    .innerJoin(
      MarketplaceTable,
      eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId),
    )
    .where(and(
      eq(ConfigObjectTable.id, input.configObjectId),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.pluginId, input.pluginId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.id, input.pluginId),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      isNull(MarketplacePluginTable.removedAt),
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(MarketplaceTable.name)
  return rows
}

async function listGrantOnlyRowsForCapability(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<MarketplaceCapabilityRow[]> {
  const rows = await db
    .select({
      configObject: ConfigObjectTable,
      plugin: PluginTable,
    })
    .from(ConfigObjectTable)
    .innerJoin(
      PluginConfigObjectTable,
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
    )
    .innerJoin(
      PluginTable,
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
    )
    .where(and(
      eq(ConfigObjectTable.id, input.configObjectId),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.pluginId, input.pluginId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.id, input.pluginId),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
  return rows.map((row) => ({ ...row, marketplace: null }))
}

async function listActiveRowsForCapability(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<MarketplaceCapabilityRow[]> {
  const marketplaceRows = await listActiveMarketplaceRowsForCapability(input)
  if (marketplaceRows.length > 0) return marketplaceRows
  return listGrantOnlyRowsForCapability(input)
}

async function listConfigObjectGrants(organizationId: OrganizationId, configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) return []
  return db
    .select({
      resourceId: ConfigObjectAccessGrantTable.configObjectId,
      orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
      orgWide: ConfigObjectAccessGrantTable.orgWide,
      removedAt: ConfigObjectAccessGrantTable.removedAt,
      role: ConfigObjectAccessGrantTable.role,
      teamId: ConfigObjectAccessGrantTable.teamId,
    })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
      inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
    ))
}

async function listPluginGrants(organizationId: OrganizationId, pluginIds: PluginId[]) {
  if (pluginIds.length === 0) return []
  return db
    .select({
      resourceId: PluginAccessGrantTable.pluginId,
      orgMembershipId: PluginAccessGrantTable.orgMembershipId,
      orgWide: PluginAccessGrantTable.orgWide,
      removedAt: PluginAccessGrantTable.removedAt,
      role: PluginAccessGrantTable.role,
      teamId: PluginAccessGrantTable.teamId,
    })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, organizationId),
      inArray(PluginAccessGrantTable.pluginId, pluginIds),
    ))
}

async function listMarketplaceGrants(organizationId: OrganizationId, marketplaceIds: DenTypeId<"marketplace">[]) {
  if (marketplaceIds.length === 0) return []
  return db
    .select({
      resourceId: MarketplaceAccessGrantTable.marketplaceId,
      orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
      orgWide: MarketplaceAccessGrantTable.orgWide,
      removedAt: MarketplaceAccessGrantTable.removedAt,
      role: MarketplaceAccessGrantTable.role,
      teamId: MarketplaceAccessGrantTable.teamId,
    })
    .from(MarketplaceAccessGrantTable)
    .where(and(
      eq(MarketplaceAccessGrantTable.organizationId, organizationId),
      inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
    ))
}

async function filterVisibleRows(input: {
  member: McpMemberIdentity
  organizationId: OrganizationId
  rows: MarketplaceCapabilityRow[]
}): Promise<MarketplaceCapabilityRow[]> {
  const configObjectGrantRows = await listConfigObjectGrants(
    input.organizationId,
    unique(input.rows.map((row) => row.configObject.id)),
  )
  const pluginGrantRows = await listPluginGrants(
    input.organizationId,
    unique(input.rows.map((row) => row.plugin.id)),
  )
  const marketplaceGrantRows = await listMarketplaceGrants(
    input.organizationId,
    unique(input.rows.flatMap((row) => row.marketplace ? [row.marketplace.id] : [])),
  )
  const configObjectGrants = groupGrants(configObjectGrantRows)
  const pluginGrants = groupGrants(pluginGrantRows)
  const marketplaceGrants = groupGrants(marketplaceGrantRows)

  return input.rows.filter((row) => {
    // Administrative visibility in Den must not silently publish every
    // capability to that administrator's personal desktop catalog. Desktop
    // discovery follows the same explicit member, team, and org-wide grants
    // for every role so admins can curate what OpenWork exposes to them.
    if (grantRole(input.member, configObjectGrants.get(row.configObject.id) ?? [])) return true
    if (grantRole(input.member, pluginGrants.get(row.plugin.id) ?? [])) return true
    return row.marketplace
      ? Boolean(grantRole(input.member, marketplaceGrants.get(row.marketplace.id) ?? []))
      : false
  })
}

export async function listAccessibleMarketplaceCapabilityReferences(input: {
  enabled?: boolean
  member: McpMemberIdentity | null
  organizationId: string
}): Promise<AccessibleMarketplaceCapabilityReference[]> {
  if (input.enabled === false || !input.member) return []
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!(await getActiveMember(organizationId, input.member))) return []

  const rows = await filterVisibleRows({
    organizationId,
    member: input.member,
    rows: await listActiveCapabilityRows(organizationId),
  })
  const references = new Map<string, AccessibleMarketplaceCapabilityReference>()
  for (const row of rows) {
    const marketplaceId = row.marketplace ? row.marketplace.id : null
    const key = `${marketplaceId ?? "grant-only"}:${row.plugin.id}:${row.configObject.id}`
    references.set(key, {
      configObjectId: row.configObject.id,
      marketplaceId,
      objectType: canonicalConfigObjectType(row.configObject.objectType),
      pluginId: row.plugin.id,
    })
  }
  return [...references.values()].sort((left, right) => {
    const marketplaceOrder = left.marketplaceId === right.marketplaceId
      ? 0
      : left.marketplaceId === null
        ? 1
        : right.marketplaceId === null
          ? -1
          : left.marketplaceId.localeCompare(right.marketplaceId)
    return marketplaceOrder
      || left.pluginId.localeCompare(right.pluginId)
      || left.configObjectId.localeCompare(right.configObjectId)
  })
}

export async function listAccessibleMarketplaceSkillDescriptors(input: {
  enabled?: boolean
  member: McpMemberIdentity | null
  organizationId: string
}): Promise<RemoteSkillDescriptor[]> {
  if (input.enabled === false || !input.member) return []

  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const memberRow = await getActiveMember(organizationId, input.member)
  if (!memberRow) return []

  const rows = await filterVisibleRows({
    organizationId,
    member: input.member,
    rows: (await listActiveCapabilityRows(organizationId))
      .filter((row) => row.configObject.objectType === "skill"),
  })
  const descriptors = new Map<string, RemoteSkillDescriptor>()
  for (const row of rows) {
    const capability = buildMarketplaceCapabilityName(row.plugin.id, row.configObject.id)
    if (descriptors.has(capability)) continue
    const uniqueSuffix = `${row.plugin.id.slice(-4)}${row.configObject.id.slice(-4)}`
    const name = standardSkillName(row.configObject.title, uniqueSuffix)
    descriptors.set(capability, {
      name,
      title: row.configObject.title,
      description: normalizeRemoteSkillDescription({
        description: row.configObject.description,
        name,
        title: row.configObject.title,
      }),
      ...(row.marketplace ? { marketplaceName: row.marketplace.name } : {}),
      pluginName: row.plugin.name,
      capability,
      location: `skill://${name}/SKILL.md`,
    })
  }

  return [...descriptors.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.capability.localeCompare(b.capability))
}

async function latestVersion(configObjectId: ConfigObjectId, organizationId: OrganizationId) {
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.configObjectId, configObjectId),
      eq(ConfigObjectVersionTable.organizationId, organizationId),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    .limit(1)
  return rows[0] ?? null
}

async function exactVersion(configObjectId: ConfigObjectId, organizationId: OrganizationId, versionId: string) {
  let normalizedVersionId: DenTypeId<"configObjectVersion">
  try {
    normalizedVersionId = normalizeDenTypeId("configObjectVersion", versionId)
  } catch {
    return null
  }
  const rows = await db.select().from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.id, normalizedVersionId),
    eq(ConfigObjectVersionTable.configObjectId, configObjectId),
    eq(ConfigObjectVersionTable.organizationId, organizationId),
  )).limit(1)
  return rows[0] ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null
}

function readExternalMcpConnectionId(input: { config: Record<string, unknown>; spec: Record<string, unknown> }): string | null {
  return readString(input.config.externalMcpConnectionId) ?? readString(input.spec.externalMcpConnectionId)
}

function versionServerSpec(version: ConfigObjectVersionRow): Record<string, unknown> {
  return version.normalizedPayloadJson ?? parseJsonRecord(version.rawSourceText) ?? {}
}

export function marketplaceConfigObjectExecutionMode(objectType: ConfigObjectType): MarketplaceConfigObjectExecutionMode {
  switch (objectType) {
    case "mcp":
      return "mcp"
    case "agent":
    case "command":
    case "context":
    case "custom":
    case "skill":
      return "instructional"
    case "script":
    case "workflow":
      return "codemode"
    case "app":
    case "hook":
    case "tool":
      return "desktop_only"
  }
}

export function marketplaceConfigObjectReadyWhenSynced(objectType: ConfigObjectType): boolean {
  const mode = marketplaceConfigObjectExecutionMode(objectType)
  return mode === "codemode" || mode === "instructional"
}

export function marketplaceMcpServerEntries(spec: Record<string, unknown>, fallbackName: string): { config: Record<string, unknown>; name: string }[] {
  const entries: { config: Record<string, unknown>; name: string }[] = []
  for (const key of ["mcp", "mcpServers"]) {
    const container = spec[key]
    if (!isRecord(container)) continue
    for (const [name, config] of Object.entries(container)) {
      if (isRecord(config)) entries.push({ name, config })
    }
  }
  if (entries.length === 0 && (readString(spec.url) || readString(spec.command))) {
    entries.push({ name: fallbackName, config: spec })
  }
  return entries
}

export function comparableMarketplaceMcpUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export function comparablePluginMcpRequirementUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.hash = ""
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol}//${url.host}${pathname}${url.search}`
  } catch {
    return value.trim().replace(/\/+$/, "")
  }
}

function mcpDependenciesForObject(input: {
  object: MarketplaceReadinessConfigObject
  version: ConfigObjectVersionRow
}): MarketplaceMcpDependency[] {
  const spec = versionServerSpec(input.version)
  const dependencies = marketplaceMcpServerEntries(spec, input.object.title).map((entry) => {
    const url = readString(entry.config.url) ?? ""
    return {
      configObjectId: input.object.id,
      externalMcpConnectionId: readExternalMcpConnectionId({ config: entry.config, spec }),
      name: entry.name,
      pluginId: input.object.pluginId,
      requiredAuthType: requiredPluginMcpAuthType({ declaredAuthType: declaredPluginMcpAuthType(entry.config), url }),
      serverName: entry.name,
      url,
    }
  })
  return dependencies.length > 0
    ? dependencies
    : [{ configObjectId: input.object.id, externalMcpConnectionId: null, name: input.object.title, pluginId: input.object.pluginId, requiredAuthType: null, serverName: input.object.title, url: "" }]
}

export function isSharedConnectionReady(connection: ExternalMcpConnectionRow): boolean {
  return Boolean(connection.accessToken || connection.apiKey || (connection.authType === "none" && connection.connectedAt))
}

export async function connectedForMember(input: {
  connection: ExternalMcpConnectionRow
  member: McpMemberIdentity
}): Promise<boolean> {
  if (input.connection.credentialMode === "shared") return isSharedConnectionReady(input.connection)
  const account = await getConnectedAccount({
    organizationId: input.connection.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    providerId: input.connection.id,
  })
  return Boolean(account?.accessToken)
}

function bindingByRequirement(rows: PluginMcpRequirementBindingRow[]): Map<string, PluginMcpRequirementBindingRow> {
  const bindings = new Map<string, PluginMcpRequirementBindingRow>()
  for (const row of rows) {
    bindings.set(requirementKey({ configObjectId: row.configObjectId, pluginId: row.pluginId, serverName: row.serverName }), row)
  }
  return bindings
}

function requirementKey(input: { configObjectId: string; pluginId: string; serverName: string }) {
  return `${input.pluginId}\n${input.configObjectId}\n${input.serverName}`
}

function marketplaceRequirementAction(input: {
  connectionId?: string
  connectionName?: string
  pluginName: string
  state: MarketplaceMcpRequirementState
}): MarketplaceMcpRequirementAction {
  if (input.state === "ready") {
    return {
      type: "none",
      label: "Ready",
      surface: "none",
      retry: "execute_capability",
    }
  }

  if ((input.state === "needs_connection" || input.state === "reconnect") && input.connectionId) {
    const connectionName = input.connectionName ?? "this connection"
    return {
      type: input.state === "reconnect" ? "reconnect" : "connect",
      label: `${input.state === "reconnect" ? "Reconnect" : "Connect"} ${connectionName}`,
      surface: "openwork_your_connections",
      retry: "search_capabilities",
      url: openworkYourConnectionsUrl(input.connectionId),
    }
  }

  return {
    type: "setup_connection",
    label: `Ask an org admin to configure Connections for ${input.pluginName}`,
    surface: "openwork_organization_connections",
    retry: "search_capabilities",
    url: openworkOrganizationConnectionsUrl(),
  }
}

function requirementSort(left: MarketplaceMcpRequirementStatus, right: MarketplaceMcpRequirementStatus) {
  return left.pluginName.localeCompare(right.pluginName)
    || left.configObjectId.localeCompare(right.configObjectId)
    || left.serverName.localeCompare(right.serverName)
    || left.name.localeCompare(right.name)
}

function firstBlockingRequirement(requirements: MarketplaceMcpRequirementStatus[]) {
  return requirements.find((requirement) => requirement.state === "needs_admin_setup")
    ?? requirements.find((requirement) => requirement.state === "needs_connection" || requirement.state === "reconnect")
    ?? null
}

function aggregateRequirementStatus(requirements: MarketplaceMcpRequirementStatus[]): MarketplaceCapabilityStatus | undefined {
  if (requirements.length === 0) return undefined
  const blocking = firstBlockingRequirement(requirements)
  return blocking?.state ?? "ready"
}

function requirementHint(input: {
  capabilityName: string
  requirement: MarketplaceMcpRequirementStatus
}) {
  if (input.requirement.state === "needs_connection" || input.requirement.state === "reconnect") {
    return `${input.capabilityName} belongs to marketplace plugin "${input.requirement.pluginName}", which requires "${input.requirement.name}". ${input.requirement.action.label} from Your Connections, then try again.`
  }
  return `${input.capabilityName} belongs to marketplace plugin "${input.requirement.pluginName}", which needs an org admin to configure its required MCP connection before it can run in OpenWork Cloud.`
}

function connectionById(connections: ExternalMcpConnectionRow[]) {
  const map = new Map<string, ExternalMcpConnectionRow>()
  for (const connection of connections) map.set(connection.id, connection)
  return map
}

function connectionIsUsable(input: {
  connectionId: string
  usableConnections: ExternalMcpConnectionRow[]
}) {
  return input.usableConnections.some((connection) => connection.id === input.connectionId)
}

function matchingConnectionForRequirement(input: {
  allConnections: ExternalMcpConnectionRow[]
  requirement: MarketplacePluginMcpRequirement
  usableConnections: ExternalMcpConnectionRow[]
}) {
  const allById = connectionById(input.allConnections)
  if (input.requirement.externalMcpConnectionId) {
    const connection = allById.get(input.requirement.externalMcpConnectionId) ?? null
    if (!connection) return null
    return comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(input.requirement.url)
      ? connection
      : null
  }
  return input.usableConnections.find((connection) => comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(input.requirement.url)) ?? null
}

async function statusForRequirement(input: {
  allConnections: ExternalMcpConnectionRow[]
  member: McpMemberIdentity
  requirement: MarketplacePluginMcpRequirement
  usableConnections: ExternalMcpConnectionRow[]
}): Promise<MarketplaceMcpRequirementStatus> {
  const connection = matchingConnectionForRequirement(input)
  const authTypeMismatch = Boolean(connection && input.requirement.requiredAuthType && connection.authType !== input.requirement.requiredAuthType)
  const usable = connection && !authTypeMismatch
    ? connectionIsUsable({ connectionId: connection.id, usableConnections: input.usableConnections })
    : false
  const base = {
    configObjectId: input.requirement.configObjectId,
    pluginId: input.requirement.pluginId,
    pluginName: input.requirement.pluginName,
    serverName: input.requirement.serverName,
    name: input.requirement.name,
    ...(connection && usable ? { connectionId: connection.id, connectionName: connection.name, credentialMode: connection.credentialMode } : {}),
  }

  if (!connection || !usable) {
    const state = "needs_admin_setup"
    return {
      ...base,
      state,
      action: marketplaceRequirementAction({ pluginName: input.requirement.pluginName, state }),
    }
  }

  const connected = await connectedForMember({ connection, member: input.member })
  if (connected) {
    const state = "ready"
    return {
      ...base,
      state,
      connectedForMe: true,
      action: marketplaceRequirementAction({
        connectionId: connection.id,
        connectionName: connection.name,
        pluginName: input.requirement.pluginName,
        state,
      }),
    }
  }

  const state: MarketplaceMcpRequirementState = connection.credentialMode === "per_member" ? "needs_connection" : "needs_admin_setup"
  return {
    ...base,
    state,
    connectedForMe: false,
    action: marketplaceRequirementAction({
      connectionId: connection.id,
      connectionName: connection.name,
      pluginName: input.requirement.pluginName,
      state,
    }),
  }
}

function requirementsForMcpObject(input: {
  bindings: Map<string, PluginMcpRequirementBindingRow>
  configObjectId: ConfigObjectId
  pluginId: PluginId
  pluginName: string
  title: string
  version: ConfigObjectVersionRow
}): MarketplacePluginMcpRequirement[] {
  const spec = versionServerSpec(input.version)
  return marketplaceMcpServerEntries(spec, input.title)
    .flatMap((entry) => {
      const url = readString(entry.config.url)
      if (!url) return []
      const binding = input.bindings.get(requirementKey({ configObjectId: input.configObjectId, pluginId: input.pluginId, serverName: entry.name }))
      return [{
        configObjectId: input.configObjectId,
        externalMcpConnectionId: binding?.externalMcpConnectionId ?? readExternalMcpConnectionId({ config: entry.config, spec }),
        name: entry.name,
        pluginId: input.pluginId,
        pluginName: input.pluginName,
        requiredAuthType: requiredPluginMcpAuthType({ declaredAuthType: declaredPluginMcpAuthType(entry.config), url }),
        serverName: entry.name,
        url,
      }]
    })
}

async function marketplacePluginMcpRequirements(input: {
  organizationId: OrganizationId
  pluginIds: PluginId[]
}): Promise<MarketplacePluginMcpRequirement[]> {
  const pluginIds = unique(input.pluginIds)
  if (pluginIds.length === 0) return []
  const rows = await db
    .select({
      configObjectId: ConfigObjectTable.id,
      pluginId: PluginTable.id,
      pluginName: PluginTable.name,
      title: ConfigObjectTable.title,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
    .innerJoin(PluginTable, eq(PluginTable.id, PluginConfigObjectTable.pluginId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      inArray(PluginConfigObjectTable.pluginId, pluginIds),
      isNull(PluginConfigObjectTable.removedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.objectType, "mcp"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
  const configObjectIds = unique(rows.map((row) => row.configObjectId))
  const versions = await latestVersionsForReadiness(input.organizationId, configObjectIds)
  const bindings = bindingByRequirement(await listPluginMcpRequirementBindings({
    configObjectIds,
    organizationId: input.organizationId,
  }))

  return rows
    .flatMap((row) => {
      const version = versions.get(row.configObjectId)
      return version
        ? requirementsForMcpObject({
          bindings,
          configObjectId: row.configObjectId,
          pluginId: row.pluginId,
          pluginName: row.pluginName,
          title: row.title,
          version,
        })
        : []
    })
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName)
      || left.configObjectId.localeCompare(right.configObjectId)
      || left.serverName.localeCompare(right.serverName)
      || left.name.localeCompare(right.name))
}

async function marketplacePluginMcpRequirementStatuses(input: {
  member: McpMemberIdentity
  organizationId: OrganizationId
  pluginIds: PluginId[]
}): Promise<Map<string, MarketplaceMcpRequirementStatus[]>> {
  const requirements = await marketplacePluginMcpRequirements({ organizationId: input.organizationId, pluginIds: input.pluginIds })
  const byPlugin = new Map<string, MarketplaceMcpRequirementStatus[]>()
  if (requirements.length === 0) return byPlugin

  const allConnections = (await listExternalMcpConnections(input.organizationId))
    .filter((connection) => connection.kind === "external_mcp")
  const usableConnections = await listUsableExternalMcpConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  for (const requirement of requirements) {
    const status = await statusForRequirement({
      allConnections,
      member: input.member,
      requirement,
      usableConnections,
    })
    const existing = byPlugin.get(requirement.pluginId) ?? []
    existing.push(status)
    existing.sort(requirementSort)
    byPlugin.set(requirement.pluginId, existing)
  }
  return byPlugin
}

async function resolveMcpReadinessConnections(input: {
  allConnections: ExternalMcpConnectionRow[]
  connections: UsableExternalMcpConnection[]
  dependencies: MarketplaceMcpDependency[]
  member: McpMemberIdentity
  organizationId: OrganizationId
}): Promise<MarketplaceCloudReadinessConnection[]> {
  const connectedCache = new Map<string, boolean>()
  const oauthClientConfiguredCache = new Map<string, boolean>()
  const output: MarketplaceCloudReadinessConnection[] = []
  const bindings = bindingByRequirement(await listPluginMcpRequirementBindings({
    organizationId: input.organizationId,
    configObjectIds: unique(input.dependencies.map((dependency) => dependency.configObjectId)),
  }))

  for (const dependency of input.dependencies) {
    const binding = bindings.get(requirementKey(dependency))
    const explicitConnectionId = binding?.externalMcpConnectionId ?? dependency.externalMcpConnectionId
    const matched = explicitConnectionId
      ? input.allConnections.find((connection) => connection.id === explicitConnectionId && comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(dependency.url))
      : dependency.url
        ? input.connections.find((connection) => comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(dependency.url))
        : null
    if (!matched) {
      output.push({ configObjectId: dependency.configObjectId, id: null, name: dependency.name, serverName: dependency.serverName, url: dependency.url })
      continue
    }

    let connectedForMe = connectedCache.get(matched.id)
    if (connectedForMe === undefined) {
      connectedForMe = await connectedForMember({ connection: matched, member: input.member })
      connectedCache.set(matched.id, connectedForMe)
    }
    let oauthClientConfigured: boolean | undefined
    const preset = EXTERNAL_MCP_PRESETS.find((candidate) => comparablePluginMcpRequirementUrl(candidate.url) === comparablePluginMcpRequirementUrl(matched.url))
    const authTypeMismatch = Boolean(dependency.requiredAuthType && matched.authType !== dependency.requiredAuthType)
    const oauthClientRequired = dependency.requiredAuthType === "oauth" && preset?.requiresOAuthClient === true
    if (dependency.requiredAuthType === "oauth" || matched.authType === "oauth") {
      oauthClientConfigured = oauthClientConfiguredCache.get(matched.id)
      if (oauthClientConfigured === undefined) {
        oauthClientConfigured = Boolean(await getOrgOAuthClient(input.organizationId, matched.id))
        oauthClientConfiguredCache.set(matched.id, oauthClientConfigured)
      }
    }
    output.push({
      authType: matched.authType,
      authTypeMismatch,
      configObjectId: dependency.configObjectId,
      id: matched.id,
      name: matched.name,
      serverName: dependency.serverName,
      url: matched.url,
      credentialMode: matched.credentialMode,
      connectedForMe,
      ...(oauthClientConfigured === undefined ? {} : { oauthClientConfigured }),
      ...(dependency.requiredAuthType ? { requiredAuthType: dependency.requiredAuthType } : {}),
      ...(dependency.requiredAuthType === "oauth" || matched.authType === "oauth" ? { oauthClientRequired } : {}),
    })
  }

  return output
}

function groupReadinessObjects(rows: MarketplaceReadinessConfigObject[]) {
  const grouped = new Map<string, MarketplaceReadinessConfigObject[]>()
  for (const row of rows) {
    const existing = grouped.get(row.pluginId) ?? []
    existing.push(row)
    grouped.set(row.pluginId, existing)
  }
  return grouped
}

async function latestVersionsForReadiness(organizationId: OrganizationId, configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) return new Map<string, ConfigObjectVersionRow>()
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.organizationId, organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, configObjectIds),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const versions = new Map<string, ConfigObjectVersionRow>()
  for (const row of rows) {
    if (!versions.has(row.configObjectId)) versions.set(row.configObjectId, row)
  }
  return versions
}

export async function resolveMarketplacePluginCloudReadiness(input: {
  desktopManifestPluginIds?: PluginId[]
  member: McpMemberIdentity
  organizationId: OrganizationId
  pluginIds: PluginId[]
}): Promise<Map<string, MarketplacePluginCloudReadiness>> {
  const pluginIds = unique(input.pluginIds)
  const readiness = new Map<string, MarketplacePluginCloudReadiness>()
  if (pluginIds.length === 0) return readiness

  const rows = await db
    .select({
      id: ConfigObjectTable.id,
      objectType: ConfigObjectTable.objectType,
      pluginId: PluginConfigObjectTable.pluginId,
      title: ConfigObjectTable.title,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      inArray(PluginConfigObjectTable.pluginId, pluginIds),
      isNull(PluginConfigObjectTable.removedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))

  const objectsByPluginId = groupReadinessObjects(rows)
  const latestVersions = await latestVersionsForReadiness(input.organizationId, rows.map((row) => row.id))
  const usableConnections = await listUsableExternalMcpConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const allConnections = (await listExternalMcpConnections(input.organizationId))
    .filter((connection) => connection.kind === "external_mcp")
  const desktopManifestPluginIds = new Set(input.desktopManifestPluginIds ?? [])

  for (const pluginId of pluginIds) {
    const objects = objectsByPluginId.get(pluginId) ?? []
    if (objects.length === 0) {
      readiness.set(pluginId, {
        state: desktopManifestPluginIds.has(pluginId) ? "desktop_only" : "not_synced",
        hasInstructional: false,
        connections: [],
      })
      continue
    }

    const hasInstructional = objects.some((object) => latestVersions.has(object.id) && marketplaceConfigObjectReadyWhenSynced(object.objectType))
    if (objects.some((object) => !latestVersions.has(object.id))) {
      readiness.set(pluginId, { state: "not_synced", hasInstructional, connections: [] })
      continue
    }

    const mcpObjects = objects.filter((object) => marketplaceConfigObjectExecutionMode(object.objectType) === "mcp")
    if (mcpObjects.length === 0) {
      readiness.set(pluginId, {
        state: hasInstructional ? "ready" : "desktop_only",
        hasInstructional,
        connections: [],
      })
      continue
    }

    const dependencies = mcpObjects.flatMap((object) => {
      const version = latestVersions.get(object.id)
      return version ? mcpDependenciesForObject({ object, version }) : []
    })
    const connections = await resolveMcpReadinessConnections({ allConnections, connections: usableConnections, dependencies, member: input.member, organizationId: input.organizationId })
    const state = connections.some((connection) => connection.id === null
      || connection.authTypeMismatch === true
      || (connection.oauthClientRequired === true && connection.oauthClientConfigured === false)
      || (connection.credentialMode === "shared" && connection.connectedForMe === false))
      ? "needs_admin_setup"
      : connections.some((connection) => connection.credentialMode === "per_member" && connection.connectedForMe === false)
        ? "needs_signin"
        : "ready"
    readiness.set(pluginId, { state, hasInstructional, connections })
  }

  return readiness
}

async function mcpHint(input: {
  member: McpMemberIdentity
  organizationId: OrganizationId
  row: MarketplaceCapabilityRow
  serverSpec: Record<string, unknown>
}): Promise<{ hint: string; status: "connection_available" | "needs_connection" }> {
  const entries = marketplaceMcpServerEntries(input.serverSpec, input.row.configObject.title)
  if (entries.length > 0) {
    const visibleConnections = await listUsableExternalMcpConnections({
      organizationId: input.organizationId,
      orgMembershipId: input.member.orgMembershipId,
      teamIds: input.member.teamIds,
    })

    const bindings = bindingByRequirement(await listPluginMcpRequirementBindings({
      organizationId: input.organizationId,
      configObjectIds: [input.row.configObject.id],
    }))
    for (const entry of entries) {
      const binding = bindings.get(requirementKey({ configObjectId: input.row.configObject.id, pluginId: input.row.plugin.id, serverName: entry.name }))
      const explicitConnectionId = binding?.externalMcpConnectionId ?? readExternalMcpConnectionId({ config: entry.config, spec: input.serverSpec })
      const declaredUrl = readString(entry.config.url)
      const matching = explicitConnectionId
        ? visibleConnections.find((connection) => connection.id === explicitConnectionId && declaredUrl && comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(declaredUrl))
        : null
      if (matching) {
        return {
          status: "connection_available",
          hint: `An External MCP Connection named "${matching.name}" already points at this server. Search capabilities for "${matching.name}" to use its tools.`,
        }
      }
    }

    const urls = unique(entries.flatMap((entry) => {
      const hasExplicitConnection = Boolean(
        bindings.get(requirementKey({ configObjectId: input.row.configObject.id, pluginId: input.row.plugin.id, serverName: entry.name }))?.externalMcpConnectionId
        ?? readExternalMcpConnectionId({ config: entry.config, spec: input.serverSpec }),
      )
      const url = readString(entry.config.url)
      return !hasExplicitConnection && url ? [comparableMarketplaceMcpUrl(url)] : []
    }))
    const matching = visibleConnections.find((connection) => urls.includes(comparableMarketplaceMcpUrl(connection.url)))
    if (matching) {
      return {
        status: "connection_available",
        hint: `An External MCP Connection named "${matching.name}" already points at this server. Search capabilities for "${matching.name}" to use its tools.`,
      }
    }
  }

  return {
    status: "needs_connection",
    hint: `This plugin declares an MCP server but OpenWork will not auto-provision it. Ask an org admin to add it in OpenWork Cloud -> Connectors, or install "${input.row.plugin.name}" locally.`,
  }
}

function commandArguments(body: unknown): string {
  if (!isRecord(body)) return ""
  return typeof body.arguments === "string" ? body.arguments : ""
}

export async function searchMarketplaceCapabilities(input: {
  enabled?: boolean
  limit?: number
  member: McpMemberIdentity | null
  objectTypes?: MarketplaceCapabilityObjectType[]
  organizationId: string
  query: string
}): Promise<MarketplaceCapabilityMatch[]> {
  if (input.enabled === false || !input.member) return []
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []

  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const memberRow = await getActiveMember(organizationId, input.member)
  if (!memberRow) return []

  const rows = await filterVisibleRows({
    organizationId,
    member: input.member,
    rows: await listActiveCapabilityRows(organizationId),
  })
  const requirementStatusesByPluginId = await marketplacePluginMcpRequirementStatuses({
    organizationId,
    member: input.member,
    pluginIds: unique(rows.map((row) => row.plugin.id)),
  })
  const matchesByName = new Map<string, MarketplaceCapabilityMatch>()

  for (const row of rows) {
    const objectType = canonicalConfigObjectType(row.configObject.objectType)
    if (input.objectTypes && !input.objectTypes.includes(objectType)) continue
    const score = scoreMarketplaceRow(row, queryTokens)
    if (score <= 0) continue
    const name = buildMarketplaceCapabilityName(row.plugin.id, row.configObject.id)
    if (matchesByName.has(name)) continue
    const match: MarketplaceCapabilityMatch = {
      name,
      method: "PLUGIN",
      path: pluginPath(row),
      score,
      summary: summaryFor(row),
      pathParams: [],
      queryParams: [],
      hasBody: objectType === "command" || objectType === "workflow",
      kind: objectType,
      plugin: row.plugin.name,
      ...(row.marketplace ? { marketplace: row.marketplace.name } : {}),
    }
    if (objectType === "tool") {
      match.status = "needs_install"
      match.hint = objectHint(row)
    }
    if (marketplaceConfigObjectExecutionMode(objectType) === "instructional") {
      const requirements = requirementStatusesByPluginId.get(row.plugin.id) ?? []
      const requirementStatus = aggregateRequirementStatus(requirements)
      const blockingRequirement = firstBlockingRequirement(requirements)
      if (requirementStatus) {
        match.status = requirementStatus
        match.mcpRequirements = requirements
      }
      if (blockingRequirement) {
        match.action = blockingRequirement.action
        match.hint = requirementHint({ capabilityName: row.configObject.title, requirement: blockingRequirement })
      }
    }
    matchesByName.set(name, match)
  }

  return [...matchesByName.values()]
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .slice(0, input.limit ?? 5)
}

export async function listAccessibleWorkflows(input: {
  member: McpMemberIdentity
  organizationId: string
}): Promise<AccessibleWorkflow[]> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!await getActiveMember(organizationId, input.member)) return []
  const rows = await filterVisibleRows({
    organizationId,
    member: input.member,
    rows: await listActiveCapabilityRows(organizationId),
  })
  const workflows: AccessibleWorkflow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (canonicalConfigObjectType(row.configObject.objectType) !== "workflow" || seen.has(row.configObject.id)) continue
    const version = await latestVersion(row.configObject.id, organizationId)
    if (!version) continue
    const parsed = parseCodemodeScriptPayload(version.normalizedPayloadJson)
    if (!parsed.ok) continue
    seen.add(row.configObject.id)
    workflows.push({
      pluginId: row.plugin.id,
      configObjectId: row.configObject.id,
      configObjectVersionId: version.id,
      title: row.configObject.title,
      description: row.configObject.description,
      inputSchema: parsed.payload.inputSchema ?? null,
      outputSchema: parsed.payload.outputSchema ?? null,
      requiredCapabilities: parsed.payload.requiredCapabilities,
    })
  }
  return workflows.sort((left, right) => left.title.localeCompare(right.title))
}

export async function executeMarketplaceCapability(input: {
  buildTools?: () => Promise<BuiltCodemodeTools>
  body?: unknown
  configObjectId: string
  configObjectVersionId?: string
  automationRunId?: DenTypeId<"automationRun">
  enabled?: boolean
  member: McpMemberIdentity | null
  organizationId: string
  pluginId: string
  redirectUriBase?: string
  validateScriptOutput?: boolean
}): Promise<MarketplaceCapabilityExecuteResult> {
  if (input.enabled === false) {
    return { ok: false, error: "unknown_capability", message: "No such capability." }
  }
  if (!input.member) {
    return { ok: false, error: "forbidden", message: "No active org membership for this token." }
  }

  const normalizedIds = normalizeMarketplaceIds({ pluginId: input.pluginId, configObjectId: input.configObjectId })
  if (!normalizedIds) {
    return { ok: false, error: "unknown_capability", message: "No such capability." }
  }

  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const rows = await listActiveRowsForCapability({
    organizationId,
    pluginId: normalizedIds.pluginId,
    configObjectId: normalizedIds.configObjectId,
  })
  if (rows.length === 0) {
    return { ok: false, error: "unknown_capability", message: "No such capability." }
  }
  const memberRow = await getActiveMember(organizationId, input.member)
  if (!memberRow) {
    return { ok: false, error: "forbidden", message: "No active org membership for this token." }
  }
  const visibleRows = await filterVisibleRows({ organizationId, member: input.member, rows })
  const row = visibleRows[0]
  if (!row) {
    return { ok: false, error: "forbidden", message: "You have not been granted access to this plugin capability." }
  }

  const version = input.configObjectVersionId
    ? await exactVersion(row.configObject.id, organizationId, input.configObjectVersionId)
    : await latestVersion(row.configObject.id, organizationId)
  if (!version) {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        status: "content_not_synced",
        hint: contentNotSyncedHint(row),
      },
    }
  }

  if (canonicalConfigObjectType(row.configObject.objectType) === "workflow") {
    const execution = await executeWorkflow({
      database: db,
      organizationId,
      orgMembershipId: input.member.orgMembershipId,
      pluginId: row.plugin.id,
      configObjectId: row.configObject.id,
      configObjectVersionId: version.id,
      automationRunId: input.automationRunId,
      normalizedPayloadJson: version.normalizedPayloadJson,
      code: version.rawSourceText ?? "",
      scriptInput: input.body,
      validateOutput: input.validateScriptOutput === true,
      buildTools: input.buildTools ?? (async () => ({ tools: {}, manifest: [] })),
    })
    if (!execution.ok && execution.error === "unsupported") {
      return {
        ok: true,
        result: {
          ...basePayload(row),
          status: "unsupported",
          hint: unsupportedScriptHint(row, execution.message),
        },
      }
    }
    if (!execution.ok && (execution.error === "invalid_arguments" || execution.error === "invalid_result")) {
      return {
        ok: false,
        error: "invalid_capability_arguments",
        message: execution.message,
        issues: execution.issues,
        sameArgumentsRetryable: false,
        retry: { action: "correct_arguments", searchRequired: false },
        receiptId: execution.receiptId ?? null,
      }
    }
    if (!execution.ok && execution.error === "capability_unavailable") return execution
    if (!execution.ok && execution.error === "script_failed") {
      return {
        ok: false,
        error: "script_failed",
        message: execution.message,
        kind: execution.kind,
        toolCalls: execution.toolCalls,
        receiptId: execution.receiptId ?? null,
      }
    }
    if (!execution.ok) return { ok: false, error: "script_failed", message: execution.message, kind: "InvalidDataValue", toolCalls: [] }
    return {
      ok: true,
      result: {
        ...basePayload(row),
        status: "executed",
        value: execution.value,
        logs: execution.logs,
        toolCalls: execution.toolCalls,
        durationMs: execution.durationMs,
        receiptId: execution.receiptId,
        canonicalResult: execution.canonicalResult,
        markdown: execution.markdown,
        resultDigest: execution.resultDigest,
        inputSchemaDigest: execution.inputSchemaDigest,
        outputSchemaDigest: execution.outputSchemaDigest,
        rendererVersion: execution.rendererVersion,
      },
    }
  }

  if (marketplaceConfigObjectExecutionMode(row.configObject.objectType) === "instructional") {
    const requirementStatuses = await marketplacePluginMcpRequirementStatuses({
      organizationId,
      member: input.member,
      pluginIds: [row.plugin.id],
    })
    const requirements = requirementStatuses.get(row.plugin.id) ?? []
    const blockingRequirement = firstBlockingRequirement(requirements)
    if (blockingRequirement) {
      return {
        ok: true,
        result: {
          ...basePayload(row),
          status: blockingRequirement.state,
          hint: requirementHint({ capabilityName: row.configObject.title, requirement: blockingRequirement }),
          action: blockingRequirement.action,
          mcpRequirements: requirements,
        },
      }
    }
  }

  if (row.configObject.objectType === "command") {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        content: (version.rawSourceText ?? "").replaceAll("$ARGUMENTS", commandArguments(input.body)),
      },
    }
  }

  if (
    row.configObject.objectType === "skill"
    || row.configObject.objectType === "context"
    || row.configObject.objectType === "custom"
    || row.configObject.objectType === "agent"
  ) {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        content: version.rawSourceText ?? "",
      },
    }
  }

  if (row.configObject.objectType === "mcp") {
    const serverSpec = versionServerSpec(version)
    const guidance = await mcpHint({ organizationId, member: input.member, row, serverSpec })
    return {
      ok: true,
      result: {
        ...basePayload(row),
        serverSpec,
        status: guidance.status,
        hint: guidance.hint,
      },
    }
  }

  if (row.configObject.objectType === "tool") {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        source: version.rawSourceText,
        status: "needs_install",
        hint: objectHint(row),
      },
    }
  }

  return {
    ok: true,
    result: {
      ...basePayload(row),
      definition: version.rawSourceText,
      status: "unsupported",
      hint: "Marketplace plugin hooks are not supported on the OpenWork capability rail yet.",
    },
  }
}
