import { and, asc, countDistinct, desc, eq, inArray, isNull, ne, notExists, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ExternalMcpConnectionTable,
  GatewayProviderTable,
  LlmProviderTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import {
  buildDashboardActivity,
  DASHBOARD_ACTIVITY_LIMIT,
  pickSkillParents,
  type DashboardActivityEntry,
} from "./dashboard-activity-rows.js"
import { organizationAllowsManagedModels } from "./inference.js"
import type { OrganizationContext } from "./orgs.js"

type OrganizationId = OrganizationContext["organization"]["id"]
type MemberId = OrganizationContext["currentMember"]["id"]
type PluginId = typeof PluginTable.$inferSelect.id
type MarketplaceId = typeof MarketplaceTable.$inferSelect.id
type ConfigObjectId = typeof ConfigObjectTable.$inferSelect.id

/** Which sources the caller may read, mirroring the admin list endpoints. */
export type DashboardActivityAccess = {
  /** connections.view: GET /v1/mcp-connections?scope=manageable. */
  connections: boolean
  /** llm_providers.view lists every provider; otherwise only the caller's own (scope=manageable). */
  allLlmProviders: boolean
  /** gateway_providers.view on a deployment with Gateway management enabled. */
  gatewayProviders: boolean
  /**
   * Plugin and marketplace visibility. "all" for sharing.manage_all holders;
   * otherwise the explicit ids the caller can view.
   */
  plugins: "all" | readonly PluginId[]
  marketplaces: "all" | readonly MarketplaceId[]
}

const limit = DASHBOARD_ACTIVITY_LIMIT

function activePlugin(organizationId: OrganizationId, visible: DashboardActivityAccess["plugins"]) {
  return and(
    eq(PluginTable.organizationId, organizationId),
    eq(PluginTable.status, "active"),
    isNull(PluginTable.deletedAt),
    visible === "all" ? undefined : inArray(PluginTable.id, [...visible]),
  )
}

function activeSkill(organizationId: OrganizationId) {
  return and(
    eq(ConfigObjectTable.organizationId, organizationId),
    eq(ConfigObjectTable.objectType, "skill"),
    eq(ConfigObjectTable.status, "active"),
    isNull(ConfigObjectTable.deletedAt),
  )
}

/**
 * Newest connections, excluding plugin-owned connections retired with every
 * owning plugin (same rule as listRetiredPluginOwnedExternalMcpConnectionIds),
 * filtered in SQL so the limit applies after visibility.
 */
async function newestConnections(organizationId: OrganizationId) {
  const activeBinding = db
    .select({ id: PluginMcpRequirementBindingTable.externalMcpConnectionId })
    .from(PluginMcpRequirementBindingTable)
    .innerJoin(PluginTable, eq(PluginMcpRequirementBindingTable.pluginId, PluginTable.id))
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
      eq(PluginTable.organizationId, organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
  const ownedBinding = db
    .select({ id: PluginMcpRequirementBindingTable.id })
    .from(PluginMcpRequirementBindingTable)
    .innerJoin(PluginTable, eq(PluginMcpRequirementBindingTable.pluginId, PluginTable.id))
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
      eq(PluginTable.organizationId, organizationId),
      eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, ExternalMcpConnectionTable.id),
      eq(PluginMcpRequirementBindingTable.connectionOwnedByPlugin, true),
    ))
  return db
    .select({
      id: ExternalMcpConnectionTable.id,
      name: ExternalMcpConnectionTable.name,
      url: ExternalMcpConnectionTable.url,
      createdAt: ExternalMcpConnectionTable.createdAt,
    })
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, organizationId),
      or(notExists(ownedBinding), inArray(ExternalMcpConnectionTable.id, activeBinding)),
    ))
    .orderBy(desc(ExternalMcpConnectionTable.createdAt), asc(ExternalMcpConnectionTable.id))
    .limit(limit)
}

async function newestLlmProviders(organizationId: OrganizationId, memberId: MemberId, all: boolean) {
  const managedModelsAllowed = await organizationAllowsManagedModels(organizationId)
  return db
    .select({
      id: LlmProviderTable.id,
      name: LlmProviderTable.name,
      providerId: LlmProviderTable.providerId,
      createdAt: LlmProviderTable.createdAt,
    })
    .from(LlmProviderTable)
    .where(and(
      eq(LlmProviderTable.organizationId, organizationId),
      all ? undefined : eq(LlmProviderTable.createdByOrgMembershipId, memberId),
      managedModelsAllowed ? undefined : sql`${LlmProviderTable.source} <> 'openwork'`,
    ))
    .orderBy(desc(LlmProviderTable.createdAt), asc(LlmProviderTable.id))
    .limit(limit)
}

async function newestGatewayProviders(organizationId: OrganizationId) {
  return db
    .select({
      id: GatewayProviderTable.id,
      name: GatewayProviderTable.name,
      providerId: GatewayProviderTable.provider_id,
      createdAt: GatewayProviderTable.created_at,
    })
    .from(GatewayProviderTable)
    .where(eq(GatewayProviderTable.organization_id, organizationId))
    .orderBy(desc(GatewayProviderTable.created_at), asc(GatewayProviderTable.id))
    .limit(limit)
}

async function newestPluginAttachments(organizationId: OrganizationId, access: DashboardActivityAccess) {
  const rows = await db
    .select({
      id: MarketplacePluginTable.id,
      createdAt: MarketplacePluginTable.createdAt,
      pluginId: PluginTable.id,
      pluginName: PluginTable.name,
      marketplaceId: MarketplaceTable.id,
      marketplaceName: MarketplaceTable.name,
    })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .innerJoin(PluginTable, eq(MarketplacePluginTable.pluginId, PluginTable.id))
    .where(and(
      eq(MarketplacePluginTable.organizationId, organizationId),
      isNull(MarketplacePluginTable.removedAt),
      // The built-in catalog is provisioned by a read, not new workspace work.
      ne(MarketplacePluginTable.membershipSource, "system"),
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
      access.marketplaces === "all" ? undefined : inArray(MarketplaceTable.id, [...access.marketplaces]),
      activePlugin(organizationId, access.plugins),
    ))
    .orderBy(desc(MarketplacePluginTable.createdAt), asc(MarketplacePluginTable.id))
    .limit(limit)
  const pluginIds = [...new Set(rows.map((row) => row.pluginId))]
  const counts = pluginIds.length === 0 ? [] : await db
    .select({ pluginId: PluginConfigObjectTable.pluginId, skills: countDistinct(ConfigObjectTable.id) })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id))
    .where(and(
      inArray(PluginConfigObjectTable.pluginId, pluginIds),
      isNull(PluginConfigObjectTable.removedAt),
      activeSkill(organizationId),
    ))
    .groupBy(PluginConfigObjectTable.pluginId)
  const skillCounts = new Map<string, number>(counts.map((row) => [row.pluginId, Number(row.skills)]))
  return rows.map((row) => ({ ...row, skillCount: skillCounts.get(row.pluginId) ?? 0 }))
}

async function newestSkillVersions(organizationId: OrganizationId, visible: DashboardActivityAccess["plugins"]) {
  const parentedSkills = db
    .select({ id: PluginConfigObjectTable.configObjectId })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginConfigObjectTable.pluginId, PluginTable.id))
    .where(and(isNull(PluginConfigObjectTable.removedAt), activePlugin(organizationId, visible)))
  const versions = await db
    .select({
      id: ConfigObjectVersionTable.id,
      createdAt: ConfigObjectVersionTable.createdAt,
      skillId: ConfigObjectTable.id,
      skillTitle: ConfigObjectTable.title,
    })
    .from(ConfigObjectVersionTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectVersionTable.configObjectId, ConfigObjectTable.id))
    .where(and(
      eq(ConfigObjectVersionTable.isDeletedVersion, false),
      activeSkill(organizationId),
      inArray(ConfigObjectTable.id, parentedSkills),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), asc(ConfigObjectVersionTable.id))
    .limit(limit)
  const skillIds: ConfigObjectId[] = [...new Set(versions.map((row) => row.skillId))]
  if (skillIds.length === 0) return []
  // One parent per skill: the most recently updated visible plugin, matching
  // GET /v1/plugins order (updatedAt desc, id desc).
  const parents = pickSkillParents(await db
    .select({ skillId: PluginConfigObjectTable.configObjectId, pluginId: PluginTable.id, pluginName: PluginTable.name })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginConfigObjectTable.pluginId, PluginTable.id))
    .where(and(
      inArray(PluginConfigObjectTable.configObjectId, skillIds),
      isNull(PluginConfigObjectTable.removedAt),
      activePlugin(organizationId, visible),
    ))
    .orderBy(desc(PluginTable.updatedAt), desc(PluginTable.id)))
  return versions.flatMap((version) => {
    const parent = parents.get(version.skillId)
    return parent ? [{ ...version, pluginId: parent.pluginId, pluginName: parent.pluginName }] : []
  })
}

/** The newest five Activity entries for an organization admin, in a handful of bounded queries. */
export async function readDashboardActivity(input: {
  organizationId: OrganizationId
  memberId: MemberId
  access: DashboardActivityAccess
}): Promise<DashboardActivityEntry[]> {
  const { organizationId, access } = input
  const pluginsVisible = access.plugins === "all" || access.plugins.length > 0
  const marketplacesVisible = access.marketplaces === "all" || access.marketplaces.length > 0
  const [connections, llmProviders, gatewayProviders, pluginAttachments, skillVersions] = await Promise.all([
    access.connections ? newestConnections(organizationId) : [],
    newestLlmProviders(organizationId, input.memberId, access.allLlmProviders),
    access.gatewayProviders ? newestGatewayProviders(organizationId) : [],
    pluginsVisible && marketplacesVisible ? newestPluginAttachments(organizationId, access) : [],
    pluginsVisible ? newestSkillVersions(organizationId, access.plugins) : [],
  ])
  return buildDashboardActivity({ connections, llmProviders, gatewayProviders, pluginAttachments, skillVersions })
}

/** Ids of the organization's active plugins and marketplaces, for callers without sharing.manage_all. */
export async function listActivePluginArchIds(organizationId: OrganizationId) {
  const [plugins, marketplaces] = await Promise.all([
    db.select({ id: PluginTable.id }).from(PluginTable).where(activePlugin(organizationId, "all")),
    db.select({ id: MarketplaceTable.id }).from(MarketplaceTable).where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    )),
  ])
  return { pluginIds: plugins.map((row) => row.id), marketplaceIds: marketplaces.map((row) => row.id) }
}
