import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSourceBindingTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
  MarketplaceTable,
  OrganizationTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { isPluginArchOrgAdmin, type PluginArchActorContext, PluginArchAuthorizationError } from "../../../../routes/org/plugin-system/access.js"
import {
  fetchGithubImportFilesWithRevisionGuard,
  getGithubInstallationAccessToken,
  getGithubRepositoryHeadSha,
  getGithubRepositoryTextFile,
  getGithubRepositoryTree,
} from "../github-app.js"
import {
  buildGithubRepoDiscovery,
  type GithubDiscoveredPlugin,
  type GithubDiscoveryClassification,
  type GithubDiscoveryTreeEntry,
  type GithubMarketplaceInfo,
} from "../../../../routes/org/plugin-system/github-discovery.js"
import { db } from "../../../../db.js"
import { resolveOrganizationMemberAuthority } from "../../../../organization-team-roles.js"
import { roleIncludesOwner } from "../../../../orgs.js"
import { PluginArchRouteFailure } from "../../store/route-failure.js"
import {
  buildGithubDiscoveryImportPlans,
  type ConnectorInstanceId,
  type ConnectorInstanceRow,
  type ConnectorMappingId,
  type ConnectorMappingRow,
  type ConnectorSyncEventId,
  type ConnectorSyncEventRow,
  type ConnectorTargetId,
  type ConnectorTargetRow,
  ensureVisibleConnectorInstance,
  getConnectorInstanceRow,
  type GithubDiscoveryImportPlan,
  isRecord,
  normalizeOptionalString,
  type OrganizationId,
  type OrganizationRow,
  pageItems,
  type PluginId,
  serializeConfigObject,
  serializeMarketplace,
  serializePlugin,
} from "../../store/internal.js"
import {
  getConnectorAccountRow,
  getConnectorTargetRow,
  githubConnectorAppConfig,
  serializeConnectorInstance,
  serializeConnectorMapping,
  serializeConnectorTarget,
  wrapGithubConnectorError,
} from "./shared.js"
import { createConnectorMapping, updateConnectorTarget } from "./connectors.js"
import { deriveProjection } from "../../store/projections.js"
// TODO(W0-P03 PR 4): import these from the marketplace store modules once they move out of the old store.
import { attachPluginToMarketplace, createMarketplace, createPlugin, getConfigObjectDetail } from "../../../../routes/org/plugin-system/store.js"

type GithubConnectorDiscoveryStep = {
  id: "read_repository_structure" | "check_marketplace_manifest" | "check_plugin_manifests" | "prepare_discovered_plugins"
  label: string
  status: "completed" | "running" | "warning"
}

type GithubConnectorDiscoveryTreeSummary = {
  scannedEntryCount: number
  strategy: "git-tree-recursive"
  truncated: boolean
}

type GithubDiscoveryCacheEntry = {
  branch: string
  classification: GithubDiscoveryClassification
  discoveredPlugins: GithubDiscoveredPlugin[]
  importPlansByPluginKey: Record<string, GithubDiscoveryImportPlan[]>
  marketplace: GithubMarketplaceInfo | null
  ref: string
  repositoryFullName: string
  sourceRevisionRef: string
  treeSummary: GithubConnectorDiscoveryTreeSummary
  warnings: string[]
}

type GithubConnectorDiscoveryComputation = GithubDiscoveryCacheEntry & {
  connectorInstance: ReturnType<typeof serializeConnectorInstance>
  connectorTarget: ReturnType<typeof serializeConnectorTarget>
  treeEntries: GithubDiscoveryTreeEntry[]
}

type GithubDiscoverySnapshot = GithubDiscoveryCacheEntry & {
  treeEntries: GithubDiscoveryTreeEntry[]
}

function normalizeDiscoveryCursor(value: string | undefined) {
  return value?.trim() || undefined
}

function discoveryStep(status: GithubConnectorDiscoveryStep["status"], id: GithubConnectorDiscoveryStep["id"], label: string): GithubConnectorDiscoveryStep {
  return { id, label, status }
}

function buildGithubConnectorDiscoverySteps(input: {
  classification: GithubDiscoveryClassification
  discoveredPlugins: GithubDiscoveredPlugin[]
}) {
  return [
    discoveryStep("completed", "read_repository_structure", "Read repository structure"),
    discoveryStep(input.classification === "claude_marketplace_repo" ? "completed" : "warning", "check_marketplace_manifest", "Check for Claude marketplace manifest"),
    discoveryStep(
      input.classification === "agent_plugin_repo"
        || input.classification === "claude_single_plugin_repo"
        || input.classification === "claude_multi_plugin_repo"
        ? "completed"
        : "warning",
      "check_plugin_manifests",
      "Check for Agent Plugins or Claude plugin manifests",
    ),
    discoveryStep(input.discoveredPlugins.length > 0 ? "completed" : "warning", "prepare_discovered_plugins", "Prepare discovered plugins"),
  ] satisfies GithubConnectorDiscoveryStep[]
}

function readGithubDiscoveryCache(config: Record<string, unknown> | null) {
  const cache = config && isRecord(config.githubDiscoveryCache) ? config.githubDiscoveryCache : null
  if (!cache) {
    return null
  }

  const repositoryFullName = typeof cache.repositoryFullName === "string" ? cache.repositoryFullName : null
  const branch = typeof cache.branch === "string" ? cache.branch : null
  const ref = typeof cache.ref === "string" ? cache.ref : null
  const sourceRevisionRef = typeof cache.sourceRevisionRef === "string" ? cache.sourceRevisionRef : null
  const discoveredPlugins = Array.isArray(cache.discoveredPlugins) ? cache.discoveredPlugins as GithubDiscoveredPlugin[] : null
  const warnings = Array.isArray(cache.warnings) ? cache.warnings.filter((entry): entry is string => typeof entry === "string") : null
  const treeSummary = isRecord(cache.treeSummary) ? cache.treeSummary as GithubConnectorDiscoveryTreeSummary : null
  const importPlansByPluginKey = isRecord(cache.importPlansByPluginKey)
    ? cache.importPlansByPluginKey as Record<string, GithubDiscoveryImportPlan[]>
    : null
  const classification = typeof cache.classification === "string" ? cache.classification as GithubDiscoveryClassification : null

  if (!repositoryFullName || !branch || !ref || !sourceRevisionRef || !discoveredPlugins || !warnings || !treeSummary || !importPlansByPluginKey || !classification) {
    return null
  }

  return {
    branch,
    classification,
    discoveredPlugins,
    importPlansByPluginKey,
    marketplace: isRecord(cache.marketplace) || cache.marketplace === null ? cache.marketplace as GithubMarketplaceInfo | null : null,
    ref,
    repositoryFullName,
    sourceRevisionRef,
    treeSummary,
    warnings,
  } satisfies GithubDiscoveryCacheEntry
}

export function withGithubDiscoveryCache(config: Record<string, unknown>, cache: GithubDiscoveryCacheEntry) {
  return {
    ...config,
    githubDiscoveryCache: cache,
  }
}

async function getGithubDiscoveryContext(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const connectorInstance = await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  if (connectorInstance.connectorType !== "github") {
    throw new PluginArchRouteFailure(409, "github_connector_instance_required", "Connector instance is not a GitHub connector.")
  }

  const connectorAccount = await getConnectorAccountRow(input.context.organizationContext.organization.id, connectorInstance.connectorAccountId)
  if (!connectorAccount || connectorAccount.connectorType !== "github") {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "GitHub connector account not found.")
  }

  const targetRows = await db
    .select()
    .from(ConnectorTargetTable)
    .where(eq(ConnectorTargetTable.connectorInstanceId, connectorInstance.id))
    .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))
    .limit(1)
  const connectorTarget = targetRows[0] ?? null
  if (!connectorTarget) {
    throw new PluginArchRouteFailure(404, "connector_target_not_found", "GitHub connector target not found.")
  }

  const targetConfig = connectorTarget.targetConfigJson && typeof connectorTarget.targetConfigJson === "object"
    ? connectorTarget.targetConfigJson as Record<string, unknown>
    : {}
  const repositoryFullName = typeof targetConfig.repositoryFullName === "string" ? targetConfig.repositoryFullName.trim() : connectorTarget.remoteId.trim()
  const branch = typeof targetConfig.branch === "string" ? targetConfig.branch.trim() : connectorTarget.externalTargetRef?.trim() ?? ""
  const ref = typeof targetConfig.ref === "string" ? targetConfig.ref.trim() : branch ? `refs/heads/${branch}` : ""
  const installationId = typeof connectorInstance.instanceConfigJson === "object" && connectorInstance.instanceConfigJson && typeof (connectorInstance.instanceConfigJson as Record<string, unknown>).installationId === "number"
    ? (connectorInstance.instanceConfigJson as Record<string, unknown>).installationId as number
    : Number(connectorAccount.remoteId)

  if (!repositoryFullName || !branch || !ref || !Number.isFinite(installationId) || installationId <= 0) {
    throw new PluginArchRouteFailure(409, "invalid_github_connector_target", "GitHub connector target is missing repository, branch, or installation metadata.")
  }

  const instanceConfigRecord = typeof connectorInstance.instanceConfigJson === "object" && connectorInstance.instanceConfigJson
    ? connectorInstance.instanceConfigJson as Record<string, unknown>
    : null
  const autoImportSaved = instanceConfigRecord ? instanceConfigRecord.autoImportNewPlugins : undefined
  return {
    autoImportNewPlugins: typeof autoImportSaved === "boolean" ? autoImportSaved : true,
    branch,
    connectorAccount,
    connectorInstance,
    connectorTarget,
    installationId,
    ref,
    repositoryFullName,
  }
}

async function buildConnectorAutomationContext(input: { connectorInstance: ConnectorInstanceRow }) {
  const organizationRows = await db
    .select()
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.connectorInstance.organizationId))
    .limit(1)
  const organization = organizationRows[0] as OrganizationRow | undefined
  if (!organization) {
    throw new PluginArchRouteFailure(404, "organization_not_found", "Organization not found for connector instance.")
  }

  const member = await resolveOrganizationMemberAuthority({
    organizationId: input.connectorInstance.organizationId,
    memberId: input.connectorInstance.createdByOrgMembershipId,
  })
  if (!member) {
    throw new PluginArchRouteFailure(404, "member_not_found", "Connector creator member not found.")
  }

  if (!member.userId) {
    throw new PluginArchRouteFailure(404, "member_not_joined", "Connector creator member has not joined the organization.")
  }

  return {
    automation: true,
    memberTeams: [],
    session: null,
    organizationContext: {
      currentMember: {
        createdAt: member.createdAt,
        id: member.id,
        isOwner: roleIncludesOwner(member.role),
        joinedAt: member.joinedAt,
        role: member.role,
        directRole: member.directRole,
        adminTeams: member.adminTeams,
        userId: member.userId,
      },
      invitations: [],
      members: [],
      organization: {
        allowedEmailDomains: organization.allowedEmailDomains ?? null,
        createdAt: organization.createdAt,
        id: organization.id,
        logo: organization.logo ?? null,
        metadata: organization.metadata ? JSON.stringify(organization.metadata) : null,
        name: organization.name,
        slug: organization.slug,
        updatedAt: organization.updatedAt,
      },
      roles: [],
      teams: [],
    },
  } satisfies PluginArchActorContext
}

async function maybeAutoImportGithubConnectorInstance(input: {
  connectorInstance: ConnectorInstanceRow
  connectorSyncEventId?: ConnectorSyncEventId
  connectorTarget: ConnectorTargetRow
}) {
  const instanceConfig = input.connectorInstance.instanceConfigJson && typeof input.connectorInstance.instanceConfigJson === "object"
    ? input.connectorInstance.instanceConfigJson as Record<string, unknown>
    : {}
  // Treat an unset flag as enabled to match getGithubDiscoveryContext defaults: a repo the
  // user has already configured should re-sync on push unless they explicitly opted out.
  const autoImportNewPlugins = instanceConfig.autoImportNewPlugins !== false
  if (!autoImportNewPlugins) {
    // User explicitly disabled auto-import: do not run discovery or materialize any objects.
    return {
      autoImported: false as const,
      autoImportNewPlugins,
      classification: null,
      createdMarketplace: null,
      createdPluginCount: 0,
      createdPlugins: [],
      discoveredPluginCount: 0,
      materializedConfigObjectCount: 0,
      materializedConfigObjects: [],
      sourceRevisionRef: null,
    }
  }

  const context = await buildConnectorAutomationContext({ connectorInstance: input.connectorInstance })
  // Force a fresh discovery so the latest head revision and file contents are fetched. Without
  // this, the cached discovery snapshot keeps the previous sourceRevisionRef and the version
  // guard in materializeGithubImportedObject would skip creating a new version on push.
  const discovery = await resolveGithubConnectorDiscovery({
    connectorInstanceId: input.connectorInstance.id,
    context,
    forceRefresh: true,
  })
  const selectedKeys = discovery.cache.discoveredPlugins
    .filter((plugin) => plugin.supported)
    .map((plugin) => plugin.key)

  const applied = await applyGithubConnectorDiscovery({
    autoImportNewPlugins,
    connectorInstanceId: input.connectorInstance.id,
    connectorSyncEventId: input.connectorSyncEventId,
    context,
    forceRefresh: true,
    selectedKeys,
  })

  return {
    autoImported: true as const,
    autoImportNewPlugins,
    classification: discovery.cache.classification,
    createdMarketplace: applied.createdMarketplace
      ? { id: applied.createdMarketplace.id, name: applied.createdMarketplace.name }
      : null,
    createdPluginCount: applied.createdPlugins.length,
    createdPlugins: applied.createdPlugins.map((plugin) => ({ id: plugin.id, name: plugin.name })),
    discoveredPluginCount: discovery.cache.discoveredPlugins.length,
    materializedConfigObjectCount: applied.materializedConfigObjects.length,
    materializedConfigObjects: applied.materializedConfigObjects.map((object) => ({
      id: object.id,
      objectType: object.objectType,
      path: object.currentRelativePath,
      title: object.title,
      versionId: object.latestVersion?.id ?? null,
    })),
    sourceRevisionRef: applied.sourceRevisionRef,
  }
}

export async function executeGithubConnectorSyncEvent(input: { connectorSyncEventId: ConnectorSyncEventId }) {
  const eventRows = await db
    .select()
    .from(ConnectorSyncEventTable)
    .where(eq(ConnectorSyncEventTable.id, input.connectorSyncEventId))
    .limit(1)
  const event = eventRows[0]
  if (!event || event.connectorType !== "github") {
    throw new Error("GitHub connector sync event not found.")
  }

  const connectorInstance = await getConnectorInstanceRow(event.organizationId, event.connectorInstanceId)
  if (!connectorInstance || connectorInstance.connectorType !== "github") {
    throw new Error("GitHub connector instance not found for sync event.")
  }
  if (!event.connectorTargetId) {
    throw new Error("GitHub connector target is missing from sync event.")
  }
  const connectorTarget = await getConnectorTargetRow(event.organizationId, event.connectorTargetId)
  if (!connectorTarget || connectorTarget.connectorType !== "github") {
    throw new Error("GitHub connector target not found for sync event.")
  }

  const startedAt = new Date()
  const autoImportSummary = await maybeAutoImportGithubConnectorInstance({
    connectorInstance,
    connectorSyncEventId: event.id,
    connectorTarget,
  })
  const completedAt = new Date()
  const eventStatus: ConnectorSyncEventRow["status"] = !autoImportSummary.autoImported
    ? "ignored"
    : autoImportSummary.materializedConfigObjectCount > 0
      ? "completed"
      : "partial"
  const summaryJson = {
    ...(event.summaryJson ?? {}),
    outcome: eventStatus,
    error: null,
    autoImportApplied: autoImportSummary.autoImported,
    autoImportNewPlugins: autoImportSummary.autoImportNewPlugins,
    classification: autoImportSummary.classification,
    resolvedSourceRevisionRef: autoImportSummary.sourceRevisionRef,
    discoveredPluginCount: autoImportSummary.discoveredPluginCount,
    createdMarketplace: autoImportSummary.createdMarketplace,
    createdPluginCount: autoImportSummary.createdPluginCount,
    createdPlugins: autoImportSummary.createdPlugins,
    materializedConfigObjectCount: autoImportSummary.materializedConfigObjectCount,
    materializedConfigObjects: autoImportSummary.materializedConfigObjects,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  }

  await db.update(ConnectorSyncEventTable).set({
    completedAt,
    nextAttemptAt: null,
    status: eventStatus,
    summaryJson,
  }).where(and(
    eq(ConnectorSyncEventTable.id, event.id),
    eq(ConnectorSyncEventTable.status, "running"),
  ))

  return { status: eventStatus }
}

async function getGithubDiscoveryFileTexts(input: {
  branch: string
  config: ReturnType<typeof githubConnectorAppConfig>
  installationId: number
  repositoryFullName: string
  token?: string
  treeEntries: GithubDiscoveryTreeEntry[]
}) {
  const interestingPaths = new Set<string>()
  const knownPaths = new Set(input.treeEntries.map((entry) => entry.path))

  if (knownPaths.has(".claude-plugin/marketplace.json")) {
    interestingPaths.add(".claude-plugin/marketplace.json")
  }

  for (const entry of input.treeEntries) {
    if (entry.path.endsWith(".claude-plugin/plugin.json") || entry.path.endsWith("/plugin.json") || entry.path === "plugin.json") {
      interestingPaths.add(entry.path)
    }
  }

  const fileTextByPath: Record<string, string | null> = {}
  for (const path of interestingPaths) {
    try {
      fileTextByPath[path] = await getGithubRepositoryTextFile({
        config: input.config,
        installationId: input.installationId,
        path,
        ref: input.branch,
        repositoryFullName: input.repositoryFullName,
        token: input.token,
      })
    } catch (error) {
      wrapGithubConnectorError(error)
    }
  }

  return fileTextByPath
}

function pagedGithubDiscoveryTree(input: { cursor?: string; entries: GithubDiscoveryTreeEntry[]; limit?: number; prefix?: string }) {
  const normalizedPrefix = input.prefix?.trim().replace(/^\/+/, "").replace(/\/+$/, "")
  const filtered = input.entries
    .filter((entry) => !normalizedPrefix || entry.path === normalizedPrefix || entry.path.startsWith(`${normalizedPrefix}/`))
    .sort((left, right) => left.path.localeCompare(right.path))
  return pageItems(filtered, normalizeDiscoveryCursor(input.cursor), input.limit)
}

export async function computeGithubDiscoverySnapshot(input: {
  branch: string
  installationId: number
  ref: string
  repositoryFullName: string
  token?: string
}) {
  const token = input.token ?? await getGithubInstallationAccessToken({
    config: githubConnectorAppConfig(),
    installationId: input.installationId,
  })
  let treeSnapshot: Awaited<ReturnType<typeof getGithubRepositoryTree>>
  try {
    treeSnapshot = await getGithubRepositoryTree({
      branch: input.branch,
      config: githubConnectorAppConfig(),
      installationId: input.installationId,
      repositoryFullName: input.repositoryFullName,
      token,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }

  const fileTextByPath = await getGithubDiscoveryFileTexts({
    branch: input.branch,
    config: githubConnectorAppConfig(),
    installationId: input.installationId,
    repositoryFullName: input.repositoryFullName,
    token,
    treeEntries: treeSnapshot.treeEntries,
  })
  const discovery = buildGithubRepoDiscovery({
    entries: treeSnapshot.treeEntries,
    fileTextByPath,
  })

  return {
    branch: input.branch,
    classification: discovery.classification,
    discoveredPlugins: discovery.discoveredPlugins,
    importPlansByPluginKey: buildGithubDiscoveryImportPlans({
      discoveredPlugins: discovery.discoveredPlugins,
      treeEntries: treeSnapshot.treeEntries,
    }),
    marketplace: discovery.marketplace,
    ref: input.ref,
    repositoryFullName: input.repositoryFullName,
    sourceRevisionRef: treeSnapshot.headSha,
    treeEntries: treeSnapshot.treeEntries,
    treeSummary: {
      scannedEntryCount: treeSnapshot.treeEntries.length,
      strategy: "git-tree-recursive",
      truncated: treeSnapshot.truncated,
    } satisfies GithubConnectorDiscoveryTreeSummary,
    warnings: discovery.warnings,
  } satisfies GithubDiscoverySnapshot
}

async function computeGithubConnectorDiscovery(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; token?: string }) {
  const discoveryContext = await getGithubDiscoveryContext(input)
  const snapshot = await computeGithubDiscoverySnapshot({
    branch: discoveryContext.branch,
    installationId: discoveryContext.installationId,
    ref: discoveryContext.ref,
    repositoryFullName: discoveryContext.repositoryFullName,
    token: input.token,
  })

  return {
    ...snapshot,
    connectorInstance: serializeConnectorInstance(discoveryContext.connectorInstance),
    connectorTarget: serializeConnectorTarget(discoveryContext.connectorTarget),
  } satisfies GithubConnectorDiscoveryComputation
}

async function persistGithubConnectorDiscoveryCache(input: {
  cache: GithubDiscoveryCacheEntry
  connectorTargetId: ConnectorTargetId
  context: PluginArchActorContext
}) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) {
    return
  }

  const targetConfig = target.targetConfigJson && typeof target.targetConfigJson === "object"
    ? target.targetConfigJson as Record<string, unknown>
    : {}
  await updateConnectorTarget({
    config: withGithubDiscoveryCache(targetConfig, input.cache),
    connectorTargetId: target.id,
    context: input.context,
    externalTargetRef: target.externalTargetRef,
    remoteId: target.remoteId,
  })
}

async function resolveGithubConnectorDiscovery(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; forceRefresh?: boolean }) {
  const discoveryContext = await getGithubDiscoveryContext(input)
  const targetConfig = discoveryContext.connectorTarget.targetConfigJson && typeof discoveryContext.connectorTarget.targetConfigJson === "object"
    ? discoveryContext.connectorTarget.targetConfigJson as Record<string, unknown>
    : null
  const cached = readGithubDiscoveryCache(targetConfig)
  if (!input.forceRefresh
    && cached
    && cached.branch === discoveryContext.branch
    && cached.ref === discoveryContext.ref
    && cached.repositoryFullName === discoveryContext.repositoryFullName) {
    // A matching branch/ref says nothing about content: compare the cached
    // snapshot's commit SHA against the live head, otherwise the discovery
    // UI stays permanently stuck on the old repository structure after a
    // push (#1871). The probe is a single commits API call; if it fails
    // (rate limit, network), prefer availability and serve the cache.
    const liveHeadSha = await getGithubRepositoryHeadSha({
      branch: discoveryContext.branch,
      config: githubConnectorAppConfig(),
      installationId: discoveryContext.installationId,
      repositoryFullName: discoveryContext.repositoryFullName,
    }).catch(() => null)
    if (liveHeadSha === null || liveHeadSha === cached.sourceRevisionRef) {
      return {
        autoImportNewPlugins: discoveryContext.autoImportNewPlugins,
        cache: cached,
        connectorInstance: serializeConnectorInstance(discoveryContext.connectorInstance),
        connectorTarget: serializeConnectorTarget(discoveryContext.connectorTarget),
      }
    }
  }

  const computed = await computeGithubConnectorDiscovery(input)
  const cache = {
    branch: computed.branch,
    classification: computed.classification,
    discoveredPlugins: computed.discoveredPlugins,
    importPlansByPluginKey: computed.importPlansByPluginKey,
    marketplace: computed.marketplace,
    ref: computed.ref,
    repositoryFullName: computed.repositoryFullName,
    sourceRevisionRef: computed.sourceRevisionRef,
    treeSummary: computed.treeSummary,
    warnings: computed.warnings,
  } satisfies GithubDiscoveryCacheEntry
  await persistGithubConnectorDiscoveryCache({
    cache,
    connectorTargetId: computed.connectorTarget.id,
    context: input.context,
  })
  return {
    autoImportNewPlugins: discoveryContext.autoImportNewPlugins,
    cache,
    connectorInstance: computed.connectorInstance,
    connectorTarget: computed.connectorTarget,
  }
}

function parseMarkdownFrontmatter(rawSourceText: string): { body: string; data: Record<string, string> } {
  const match = rawSourceText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { body: rawSourceText, data: {} }
  }

  const [, yaml, body] = match
  const data: Record<string, string> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colonIndex = trimmed.indexOf(":")
    if (colonIndex === -1) continue
    const key = trimmed.slice(0, colonIndex).trim()
    let value = trimmed.slice(colonIndex + 1).trim()
    if (value.length > 1) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    if (!key || !value) continue
    data[key] = value
  }
  return { body: body ?? "", data }
}

function importedObjectMetadata(input: { objectType: ConnectorMappingRow["objectType"]; path: string; rawSourceText: string }) {
  const pathSegments = input.path.split("/")
  const fileName = pathSegments[pathSegments.length - 1] ?? input.path
  const parentName = pathSegments[pathSegments.length - 2] ?? pathSegments[pathSegments.length - 1] ?? "Imported"
  const nameFromFile = fileName.replace(/\.[^.]+$/, "")
  const preferredName = input.objectType === "skill" || input.objectType === "agent"
    ? (fileName.toUpperCase() === "SKILL.MD" || fileName.toUpperCase() === "AGENT.MD" ? parentName : nameFromFile)
    : nameFromFile

  const isMarkdown = fileName.toLowerCase().endsWith(".md") || fileName.toLowerCase().endsWith(".mdx")
  const frontmatter = isMarkdown ? parseMarkdownFrontmatter(input.rawSourceText) : null
  const frontmatterName = frontmatter?.data.name ?? frontmatter?.data.title
  const frontmatterDescription = frontmatter?.data.description ?? frontmatter?.data.summary

  const isJson = fileName.toLowerCase().endsWith(".json")
  const normalizedPayloadJson = isJson ? parseJsonObject(input.rawSourceText) : undefined

  const metadata: Record<string, unknown> = {
    name: frontmatterName?.trim() || preferredName,
    relativePath: input.path,
  }
  if (frontmatterDescription?.trim()) {
    metadata.description = frontmatterDescription.trim()
  }
  if (frontmatter && Object.keys(frontmatter.data).length > 0) {
    metadata.frontmatter = frontmatter.data
  }

  if (input.objectType === "mcp" && normalizedPayloadJson) {
    const serverNames = importedMcpServerNames(normalizedPayloadJson)
    metadata.name = importedMcpObjectName({
      nameFromFile,
      pathSegments,
      payload: normalizedPayloadJson,
      serverNames,
    })
    if (!readPayloadString(normalizedPayloadJson, "description")) {
      metadata.description = serverNames.length > 1
        ? `${serverNames.length} MCP servers imported from ${input.path}.`
        : `MCP server imported from ${input.path}.`
    }
  } else if (isJson && !readPayloadString(normalizedPayloadJson, "description")) {
    // Without this the projection falls back to the file's second line, which
    // for JSON is a fragment such as `"hooks": {`.
    metadata.description = `Imported from ${input.path}.`
  }

  return {
    metadata,
    normalizedPayloadJson,
  }
}

function parseJsonObject(rawSourceText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(rawSourceText)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readPayloadString(payload: Record<string, unknown> | undefined, key: string) {
  const value = payload?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function importedMcpServerNames(payload: Record<string, unknown>) {
  return [payload.mcpServers, payload.mcp].flatMap((container) => (
    isRecord(container)
      ? Object.entries(container).filter(([name, config]) => name.trim() && isRecord(config)).map(([name]) => name.trim())
      : []
  ))
}

/**
 * A `.mcp.json` file names its servers by key, so the file name (".mcp") is
 * never a useful title. Prefer the single server's key, then the file's own
 * name, then the folder that holds it (normally the plugin directory).
 */
function importedMcpObjectName(input: {
  nameFromFile: string
  pathSegments: string[]
  payload: Record<string, unknown>
  serverNames: string[]
}) {
  if (input.serverNames.length === 1) return input.serverNames[0]
  const declaredName = readPayloadString(input.payload, "name") ?? readPayloadString(input.payload, "title")
  if (declaredName) return declaredName
  const parentName = input.pathSegments.length > 1 ? input.pathSegments[input.pathSegments.length - 2]?.trim() : ""
  if (parentName && parentName !== ".claude-plugin") return parentName
  return input.nameFromFile.replace(/^\.+/, "") || "mcp"
}

export function deriveGithubImportedObjectProjection(input: { objectType: ConnectorMappingRow["objectType"]; path: string; rawSourceText: string }) {
  const metadata = importedObjectMetadata({ objectType: input.objectType, path: input.path, rawSourceText: input.rawSourceText })
  const frontmatterRecord = metadata.metadata && typeof metadata.metadata.frontmatter === "object"
    ? metadata.metadata.frontmatter as Record<string, unknown>
    : null
  const hasFrontmatter = frontmatterRecord && Object.keys(frontmatterRecord).length > 0
  // Skill projections need the full SKILL.md: deriveSkillProjection parses and
  // validates the frontmatter itself, so stripping it here made every GitHub
  // connector skill import fail with invalid_skill_frontmatter.
  const projectionRawSource = input.objectType !== "skill" && hasFrontmatter
    ? parseMarkdownFrontmatter(input.rawSourceText).body
    : input.rawSourceText
  return {
    metadata,
    projection: deriveProjection({
      objectType: input.objectType,
      value: {
        metadata: metadata.metadata,
        normalizedPayloadJson: metadata.normalizedPayloadJson,
        rawSourceText: projectionRawSource,
      },
    }),
  }
}

async function findActiveConnectorSourceBinding(input: {
  connectorMappingId: ConnectorMappingId
  externalLocator: string
  organizationId: OrganizationId
}) {
  const rows = await db
    .select()
    .from(ConnectorSourceBindingTable)
    .where(and(
      eq(ConnectorSourceBindingTable.organizationId, input.organizationId),
      eq(ConnectorSourceBindingTable.connectorMappingId, input.connectorMappingId),
      eq(ConnectorSourceBindingTable.externalLocator, input.externalLocator),
      isNull(ConnectorSourceBindingTable.deletedAt),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function materializeGithubImportedObject(input: {
  connectorInstance: ReturnType<typeof serializeConnectorInstance>
  connectorMapping: ReturnType<typeof serializeConnectorMapping>
  connectorSyncEventId?: ConnectorSyncEventId
  connectorTarget: ReturnType<typeof serializeConnectorTarget>
  context: PluginArchActorContext
  externalLocator: string
  rawSourceText: string
  sourceFileRevisionRef?: string | null
  sourceRevisionRef: string
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const now = new Date()
  const { metadata, projection } = deriveGithubImportedObjectProjection({
    objectType: input.connectorMapping.objectType,
    path: input.externalLocator,
    rawSourceText: input.rawSourceText,
  })
  const fileName = input.externalLocator.split("/").filter(Boolean).at(-1) ?? input.externalLocator
  const fileExtension = fileName.includes(".") ? fileName.split(".").at(-1) ?? null : null

  // Prefer the per-file blob sha when the tree snapshot provides one so an unchanged file can be
  // skipped even when the head commit moved; fall back to the head revision otherwise.
  const bindingRevisionRef = input.sourceFileRevisionRef ?? input.sourceRevisionRef
  const existingBinding = await findActiveConnectorSourceBinding({
    connectorMappingId: input.connectorMapping.id,
    externalLocator: input.externalLocator,
    organizationId,
  })

  if (!existingBinding) {
    const configObjectId = createDenTypeId("configObject")
    const versionId = createDenTypeId("configObjectVersion")
    await db.transaction(async (tx) => {
      await tx.insert(ConfigObjectTable).values({
        connectorInstanceId: input.connectorInstance.id,
        createdAt: now,
        createdByOrgMembershipId,
        currentFileExtension: normalizeOptionalString(fileExtension ?? undefined),
        currentFileName: fileName,
        currentRelativePath: input.externalLocator,
        deletedAt: null,
        description: projection.description,
        id: configObjectId,
        objectType: input.connectorMapping.objectType,
        organizationId,
        searchText: projection.searchText,
        sourceMode: "connector",
        status: "active",
        title: projection.title,
        updatedAt: now,
      })

      await tx.insert(ConfigObjectVersionTable).values({
        configObjectId,
        connectorSyncEventId: input.connectorSyncEventId ?? null,
        createdAt: now,
        createdByOrgMembershipId,
        createdVia: "connector",
        id: versionId,
        isDeletedVersion: false,
        normalizedPayloadJson: metadata.normalizedPayloadJson ?? null,
        organizationId,
        rawSourceText: normalizeOptionalString(input.rawSourceText),
        schemaVersion: null,
        sourceRevisionRef: input.sourceRevisionRef,
      })

      await tx.insert(ConfigObjectAccessGrantTable).values({
        configObjectId,
        createdAt: now,
        createdByOrgMembershipId,
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        orgMembershipId: createdByOrgMembershipId,
        orgWide: false,
        role: "manager",
        teamId: null,
      })

      if (input.connectorMapping.pluginId) {
        await tx.insert(PluginConfigObjectTable).values({
          configObjectId,
          connectorMappingId: input.connectorMapping.id,
          createdAt: now,
          createdByOrgMembershipId,
          id: createDenTypeId("pluginConfigObject"),
          membershipSource: "connector",
          organizationId,
          pluginId: input.connectorMapping.pluginId,
          removedAt: null,
        })
      }

      await tx.insert(ConnectorSourceBindingTable).values({
        configObjectId,
        connectorInstanceId: input.connectorInstance.id,
        connectorMappingId: input.connectorMapping.id,
        connectorTargetId: input.connectorTarget.id,
        connectorType: input.connectorTarget.connectorType,
        createdAt: now,
        deletedAt: null,
        externalLocator: input.externalLocator,
        externalStableRef: input.externalLocator,
        id: createDenTypeId("connectorSourceBinding"),
        lastSeenSourceRevisionRef: bindingRevisionRef,
        organizationId,
        remoteId: input.connectorTarget.remoteId,
        status: "active",
        updatedAt: now,
      })
    })

    return getConfigObjectDetail(input.context, configObjectId)
  }

  const binding = existingBinding
  if (binding.lastSeenSourceRevisionRef !== bindingRevisionRef && binding.lastSeenSourceRevisionRef !== input.sourceRevisionRef) {
    const versionId = createDenTypeId("configObjectVersion")
    await db.transaction(async (tx) => {
      await tx.update(ConfigObjectTable).set({
        currentFileExtension: normalizeOptionalString(fileExtension ?? undefined),
        currentFileName: fileName,
        currentRelativePath: input.externalLocator,
        description: projection.description,
        searchText: projection.searchText,
        status: "active",
        title: projection.title,
        updatedAt: now,
      }).where(eq(ConfigObjectTable.id, binding.configObjectId))

      await tx.insert(ConfigObjectVersionTable).values({
        configObjectId: binding.configObjectId,
        connectorSyncEventId: input.connectorSyncEventId ?? null,
        createdAt: now,
        createdByOrgMembershipId,
        createdVia: "connector",
        id: versionId,
        isDeletedVersion: false,
        normalizedPayloadJson: metadata.normalizedPayloadJson ?? null,
        organizationId,
        rawSourceText: normalizeOptionalString(input.rawSourceText),
        schemaVersion: null,
        sourceRevisionRef: input.sourceRevisionRef,
      })

      if (input.connectorMapping.pluginId) {
        const membership = await tx
          .select({ id: PluginConfigObjectTable.id })
          .from(PluginConfigObjectTable)
          .where(and(
            eq(PluginConfigObjectTable.pluginId, input.connectorMapping.pluginId),
            eq(PluginConfigObjectTable.configObjectId, binding.configObjectId),
          ))
          .limit(1)
        if (membership[0]) {
          await tx.update(PluginConfigObjectTable).set({
            connectorMappingId: input.connectorMapping.id,
            membershipSource: "connector",
            removedAt: null,
          }).where(eq(PluginConfigObjectTable.id, membership[0].id))
        } else {
          await tx.insert(PluginConfigObjectTable).values({
            configObjectId: binding.configObjectId,
            connectorMappingId: input.connectorMapping.id,
            createdAt: now,
            createdByOrgMembershipId,
            id: createDenTypeId("pluginConfigObject"),
            membershipSource: "connector",
            organizationId,
            pluginId: input.connectorMapping.pluginId,
            removedAt: null,
          })
        }
      }

      await tx.update(ConnectorSourceBindingTable).set({
        deletedAt: null,
        lastSeenSourceRevisionRef: bindingRevisionRef,
        status: "active",
        updatedAt: now,
      }).where(eq(ConnectorSourceBindingTable.id, binding.id))
    })
  }

  return getConfigObjectDetail(input.context, binding.configObjectId)
}

async function materializeGithubImportPlans(input: {
  connectorInstance: ReturnType<typeof serializeConnectorInstance>
  connectorSyncEventId?: ConnectorSyncEventId
  connectorTarget: ReturnType<typeof serializeConnectorTarget>
  context: PluginArchActorContext
  importPlans: Array<{ fileShaByPath?: Record<string, string>; mapping: ReturnType<typeof serializeConnectorMapping>; paths: string[] }>
  sourceRevisionRef: string
}) {
  const config = githubConnectorAppConfig()
  const targetConfig = input.connectorTarget.targetConfigJson && typeof input.connectorTarget.targetConfigJson === "object"
    ? input.connectorTarget.targetConfigJson as Record<string, unknown>
    : {}
  const branch = typeof targetConfig.branch === "string" ? targetConfig.branch : input.connectorTarget.externalTargetRef ?? ""
  const installationId = typeof input.connectorInstance.instanceConfigJson === "object" && input.connectorInstance.instanceConfigJson && typeof (input.connectorInstance.instanceConfigJson as Record<string, unknown>).installationId === "number"
    ? (input.connectorInstance.instanceConfigJson as Record<string, unknown>).installationId as number
    : null
  const repositoryFullName = typeof targetConfig.repositoryFullName === "string" ? targetConfig.repositoryFullName : input.connectorTarget.remoteId
  if (!installationId || !branch || !repositoryFullName) {
    throw new PluginArchRouteFailure(409, "invalid_github_materialization_context", "GitHub connector target is missing required materialization context.")
  }

  const token = await getGithubInstallationAccessToken({
    config,
    installationId,
  })
  const organizationId = input.context.organizationContext.organization.id
  const plannedFiles = input.importPlans.flatMap((plan) => plan.paths.map((path) => ({
    mapping: plan.mapping,
    path,
    sourceFileRevisionRef: plan.fileShaByPath?.[path] ?? null,
  })))
  const existingBindings = await Promise.all(plannedFiles.map((file) => findActiveConnectorSourceBinding({
    connectorMappingId: file.mapping.id,
    externalLocator: file.path,
    organizationId,
  })))
  const fetchResults = await fetchGithubImportFilesWithRevisionGuard({
    fetchFile: (path) => getGithubRepositoryTextFile({
      config,
      installationId,
      path,
      ref: branch,
      repositoryFullName,
      token,
    }),
    files: plannedFiles.map((file, index) => ({
      lastSeenSourceRevisionRef: existingBindings[index]?.lastSeenSourceRevisionRef ?? null,
      path: file.path,
      sourceFileRevisionRef: file.sourceFileRevisionRef,
      sourceRevisionRef: input.sourceRevisionRef,
    })),
  })

  const materializedConfigObjects: ReturnType<typeof serializeConfigObject>[] = []
  let firstFetchFailure: { error: unknown } | null = null
  for (const [index, file] of plannedFiles.entries()) {
    const result = fetchResults[index]
    if (result.status === "failed") {
      firstFetchFailure = firstFetchFailure ?? { error: result.error }
      continue
    }
    if (result.status === "skipped_unchanged") {
      // The file content is already materialized at this revision: no fetch, no new version.
      const binding = existingBindings[index]
      if (binding) {
        materializedConfigObjects.push(await getConfigObjectDetail(input.context, binding.configObjectId))
      }
      continue
    }
    if (!result.rawSourceText) {
      continue
    }
    materializedConfigObjects.push(await materializeGithubImportedObject({
      connectorInstance: input.connectorInstance,
      connectorMapping: file.mapping,
      connectorSyncEventId: input.connectorSyncEventId,
      connectorTarget: input.connectorTarget,
      context: input.context,
      externalLocator: file.path,
      rawSourceText: result.rawSourceText,
      sourceFileRevisionRef: file.sourceFileRevisionRef,
      sourceRevisionRef: input.sourceRevisionRef,
    }))
  }

  if (firstFetchFailure) {
    wrapGithubConnectorError(firstFetchFailure.error)
  }

  return materializedConfigObjects
}

async function ensureDiscoveryPlugin(input: {
  context: PluginArchActorContext
  description: string | null
  name: string
  sourceFormat: "agent-plugin" | "claude-plugin"
  sourceRepositoryUrl: string
  sourceSchemaVersion: string | null
}) {
  const existing = await db
    .select()
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, input.context.organizationContext.organization.id),
      eq(PluginTable.name, input.name.trim()),
      isNull(PluginTable.deletedAt),
    ))
    .orderBy(asc(PluginTable.createdAt), asc(PluginTable.id))
    .limit(1)

  if (existing[0]) {
    if (
      existing[0].sourceFormat !== input.sourceFormat
      || existing[0].sourceRepositoryUrl !== input.sourceRepositoryUrl
      || existing[0].sourceSchemaVersion !== input.sourceSchemaVersion
    ) {
      await db.update(PluginTable).set({
        sourceFormat: input.sourceFormat,
        sourceRepositoryUrl: input.sourceRepositoryUrl,
        sourceSchemaVersion: input.sourceSchemaVersion,
      }).where(eq(PluginTable.id, existing[0].id))
    }
    return serializePlugin({
      ...existing[0],
      sourceFormat: input.sourceFormat,
      sourceRepositoryUrl: input.sourceRepositoryUrl,
      sourceSchemaVersion: input.sourceSchemaVersion,
    }, 0)
  }

  return createPlugin({
    context: input.context,
    description: input.description,
    name: input.name,
    sourceFormat: input.sourceFormat,
    sourceRepositoryUrl: input.sourceRepositoryUrl,
    sourceSchemaVersion: input.sourceSchemaVersion,
  })
}

async function ensureDiscoveryMarketplace(input: { context: PluginArchActorContext; description: string | null; name: string }) {
  const existing = await db
    .select()
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, input.context.organizationContext.organization.id),
      eq(MarketplaceTable.name, input.name.trim()),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(asc(MarketplaceTable.createdAt), asc(MarketplaceTable.id))
    .limit(1)

  if (existing[0]) {
    return serializeMarketplace(existing[0], 0)
  }

  return createMarketplace({
    context: input.context,
    description: input.description,
    name: input.name,
  })
}

async function ensureDiscoveryMapping(input: {
  connectorTargetId: ConnectorTargetId
  context: PluginArchActorContext
  objectType: ConnectorMappingRow["objectType"]
  pluginId: PluginId
  selector: string
}) {
  const existing = await db
    .select()
    .from(ConnectorMappingTable)
    .where(and(
      eq(ConnectorMappingTable.connectorTargetId, input.connectorTargetId),
      eq(ConnectorMappingTable.mappingKind, "path"),
      eq(ConnectorMappingTable.objectType, input.objectType),
      eq(ConnectorMappingTable.pluginId, input.pluginId),
      eq(ConnectorMappingTable.selector, input.selector),
    ))
    .limit(1)

  if (existing[0]) {
    return serializeConnectorMapping(existing[0])
  }

  return createConnectorMapping({
    autoAddToPlugin: true,
    config: {
      discoverySourceKind: input.objectType,
    },
    connectorTargetId: input.connectorTargetId,
    context: input.context,
    mappingKind: "path",
    objectType: input.objectType,
    pluginId: input.pluginId,
    selector: input.selector,
  })
}

export async function getGithubConnectorDiscovery(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const discovery = await resolveGithubConnectorDiscovery(input)
  return {
    autoImportNewPlugins: discovery.autoImportNewPlugins,
    classification: discovery.cache.classification,
    connectorInstance: discovery.connectorInstance,
    connectorTarget: discovery.connectorTarget,
    discoveredPlugins: discovery.cache.discoveredPlugins,
    repositoryFullName: discovery.cache.repositoryFullName,
    sourceRevisionRef: discovery.cache.sourceRevisionRef,
    steps: buildGithubConnectorDiscoverySteps({
      classification: discovery.cache.classification,
      discoveredPlugins: discovery.cache.discoveredPlugins,
    }),
    treeSummary: discovery.cache.treeSummary,
    warnings: discovery.cache.warnings,
  }
}

export async function getGithubConnectorDiscoveryTree(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; cursor?: string; limit?: number; prefix?: string }) {
  const discovery = await computeGithubConnectorDiscovery({ connectorInstanceId: input.connectorInstanceId, context: input.context })
  return pagedGithubDiscoveryTree({
    cursor: input.cursor,
    entries: discovery.treeEntries,
    limit: input.limit,
    prefix: input.prefix,
  })
}

export async function applyGithubConnectorDiscovery(input: { autoImportNewPlugins: boolean; connectorInstanceId: ConnectorInstanceId; connectorSyncEventId?: ConnectorSyncEventId; context: PluginArchActorContext; forceRefresh?: boolean; selectedKeys: string[] }) {
  if (!isPluginArchOrgAdmin(input.context)) {
    throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can apply connector discovery.")
  }

  const discovery = await resolveGithubConnectorDiscovery({ connectorInstanceId: input.connectorInstanceId, context: input.context, forceRefresh: input.forceRefresh })
  const selectedKeySet = new Set(input.selectedKeys.map((key) => key.trim()).filter(Boolean))
  const selectedPlugins = discovery.cache.discoveredPlugins.filter((plugin) => plugin.supported && selectedKeySet.has(plugin.key))
  await db.update(ConnectorInstanceTable).set({
    instanceConfigJson: {
      ...((discovery.connectorInstance.instanceConfigJson && typeof discovery.connectorInstance.instanceConfigJson === "object")
        ? discovery.connectorInstance.instanceConfigJson as Record<string, unknown>
        : {}),
      autoImportNewPlugins: input.autoImportNewPlugins,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorInstanceTable.id, discovery.connectorInstance.id))

  const marketplaceInfo = discovery.cache.marketplace
  const marketplaceName = marketplaceInfo?.name?.trim() || discovery.cache.repositoryFullName
  const marketplaceDescription = marketplaceInfo?.description?.trim()
    ?? `Imported from GitHub marketplace repository ${discovery.cache.repositoryFullName}.`
  const createdMarketplace = discovery.cache.classification === "claude_marketplace_repo"
    ? await ensureDiscoveryMarketplace({
        context: input.context,
        description: marketplaceDescription,
        name: marketplaceName,
      })
    : null

  const plugins = [] as Array<ReturnType<typeof serializePlugin>>
  const mappings = [] as Array<ReturnType<typeof serializeConnectorMapping>>
  const importPlans = [] as Array<{ fileShaByPath?: Record<string, string>; mapping: ReturnType<typeof serializeConnectorMapping>; paths: string[] }>
  for (const discoveredPlugin of selectedPlugins) {
    const plugin = await ensureDiscoveryPlugin({
      context: input.context,
      description: discoveredPlugin.description,
      name: discoveredPlugin.displayName,
      sourceFormat: discoveredPlugin.sourceKind === "agent_plugin_manifest" ? "agent-plugin" : "claude-plugin",
      sourceRepositoryUrl: `https://github.com/${discovery.cache.repositoryFullName}`,
      sourceSchemaVersion: discoveredPlugin.sourceSchemaVersion,
    })
    plugins.push(plugin)

    if (createdMarketplace) {
      await attachPluginToMarketplace({
        context: input.context,
        marketplaceId: createdMarketplace.id,
        membershipSource: "connector",
        pluginId: plugin.id,
      })
    }

    for (const plan of discovery.cache.importPlansByPluginKey[discoveredPlugin.key] ?? []) {
      const mapping = await ensureDiscoveryMapping({
        connectorTargetId: discovery.connectorTarget.id,
        context: input.context,
        objectType: plan.objectType,
        pluginId: plugin.id,
        selector: plan.selector,
      })
      mappings.push(mapping)
      importPlans.push({ fileShaByPath: plan.fileShaByPath, mapping, paths: plan.paths })
    }
  }

  const materializedConfigObjects = await materializeGithubImportPlans({
    connectorInstance: discovery.connectorInstance,
    connectorSyncEventId: input.connectorSyncEventId,
    connectorTarget: discovery.connectorTarget,
    context: input.context,
    importPlans,
    sourceRevisionRef: discovery.cache.sourceRevisionRef,
  })

  return {
    autoImportNewPlugins: input.autoImportNewPlugins,
    createdMarketplace,
    connectorInstance: discovery.connectorInstance,
    connectorTarget: discovery.connectorTarget,
    createdPlugins: plugins,
    createdMappings: mappings,
    materializedConfigObjects,
    sourceRevisionRef: discovery.cache.sourceRevisionRef,
  }
}
