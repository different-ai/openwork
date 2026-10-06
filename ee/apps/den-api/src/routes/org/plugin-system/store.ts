import { and, asc, count, desc, eq, inArray, isNull, notExists, or, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorTargetTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
  RemoteMcpAppTable,
  TeamTable,
  TeamMemberTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { hasSkillFrontmatterName, parseSkillMarkdown } from "@openwork-ee/utils"
import { isAuthoredMcpAppVersion } from "@openwork/types/mcp-app"
import type { PluginArchActorContext, PluginArchRole } from "./access.js"
import { isPluginArchOrgAdmin, PluginArchAuthorizationError, requirePluginArchResourceRole, resolvePluginArchGrantRole, resolvePluginArchPluginRoles, resolvePluginArchResourceRole } from "./access.js"
import { memberHasRole } from "../shared.js"
import {
  parseAgentPluginV1McpText,
} from "./agent-plugin-v1.js"
import {
  buildGithubRepoDiscovery,
  type GithubDiscoveredPlugin,
  type GithubDiscoveryClassification,
  type GithubMarketplaceInfo,
  type GithubDiscoveryTreeEntry,
} from "./github-discovery.js"
import {
  DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
  DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
  DEFAULT_OPENWORK_MARKETPLACE_NAME,
  type DefaultMarketplacePluginEntry,
  RETIRED_DEFAULT_OPENWORK_PLUGINS,
  RETIRED_STARTER_MARKETPLACE_DESCRIPTION,
  RETIRED_STARTER_MARKETPLACE_LOGO_URL,
  RETIRED_STARTER_MARKETPLACE_NAME,
  RETIRED_STARTER_PLUGIN_NAMES,
} from "./default-marketplaces.js"
import { db } from "../../../db.js"
import { keysetAfter, keysetPage, type KeysetCursor } from "../../../list-pagination.js"
import { resolveOrganizationMemberAuthority } from "../../../organization-team-roles.js"
import { env } from "../../../env.js"
import { appLogger } from "../../../observability/logger.js"
import { roleIncludesOwner } from "../../../orgs.js"
import { memberFacingMcpConnectionsEnabled } from "../../../capability-sources/external-mcp-rollout.js"
import { comparablePluginMcpRequirementUrl, marketplaceMcpServerEntries, resolveMarketplacePluginCloudReadiness } from "../../../mcp/marketplace-capabilities.js"
import { assertPublicUrl, PrivateUrlError } from "../../../core/net/url-guard.js"
import {
  createExternalMcpConnection,
  deleteExternalMcpConnection,
  deleteExternalMcpConnectionIfUnreferenced,
  getExternalMcpConnection,
  listExternalMcpConnections,
  replaceExternalMcpConnectionAccessForPluginBinding,
} from "../../../capability-sources/external-mcp-connections.js"
import { connectExternalMcp } from "../../../capability-sources/external-mcp-client-runtime.js"
import {
  externalMcpDiagnosticForLog,
  externalMcpDiagnosticForResponse,
  safeExternalMcpEndpointForLog,
} from "../../../capability-sources/external-mcp-diagnostics.js"
import { getOrgOAuthClient, upsertOrgOAuthClient } from "../../../capability-sources/oauth-credentials.js"
import {
  deletePluginMcpRequirementBindingsByIds,
  deletePluginMcpRequirementBindingsForPluginConfigObject,
  deletePluginMcpRequirementBindingsForPlugin,
  listPluginMcpRequirementBindings,
  upsertPluginMcpRequirementBinding,
  type PluginMcpRequirementBindingRow,
} from "../../../mcp/plugin-mcp-requirement-bindings.js"
import { openworkYourConnectionsUrl } from "../../../mcp/connection-navigation.js"
import {
  declaredPluginMcpAuthType,
  requiredPluginMcpAuthType,
  pluginMcpAuthTypeCompatible,
  resolveGithubPluginMcpImportAuthType,
  type PluginMcpAuthType,
} from "../../../capability-sources/external-mcp-auth-policy.js"
import { resolveImportedConnectorTarget } from "../../../capability-sources/claude-connector-aliases.js"
import { NATIVE_OAUTH_PROVIDERS } from "../../../capability-sources/provider-registry.js"
import type { MemberUsableConnectionFacts } from "../mcp-connections.js"
import { PluginArchRouteFailure } from "../../../modules/marketplace/store/route-failure.js"
import {
  INTERNAL_MCP_APP_WRITE,
  rejectAuthoredMcpAppWrite,
} from "../../../modules/marketplace/store/object-types/app.js"
import {
  type AccessGrantWrite,
  buildGithubDiscoveryImportPlans,
  type ConfigObjectId,
  type ConfigObjectInput,
  type ConfigObjectRow,
  type ConfigObjectVersionId,
  type ConfigObjectVersionRow,
  type ConnectorInstanceId,
  type DbTransaction,
  DEFAULT_OPENWORK_EXTENSION_MANIFESTS,
  defaultOpenWorkManifestForPlugin,
  ensureEditableMarketplace,
  ensureEditablePlugin,
  ensureGrantTargetsInOrganization,
  ensureResourceInOrganization,
  ensureVisibleConfigObject,
  ensureVisibleConnectorInstance,
  ensureVisibleMarketplace,
  ensureVisiblePlugin,
  type ExternalMcpConnectionRow,
  getConfigObjectRow,
  getLatestVersions,
  type GrantTarget,
  isRecord,
  type MarketplaceId,
  type MarketplaceMembershipId,
  type MarketplaceMembershipRow,
  type MarketplaceRow,
  type MemberId,
  normalizeOptionalString,
  type OrganizationId,
  pageItems,
  type PluginAccessGrantId,
  type PluginId,
  type PluginMarketplaceSummary,
  type PluginMembershipRow,
  type PluginRow,
  removeGrant,
  type ResourceTarget,
  serializeAccessGrant,
  serializeConfigObject,
  serializeMarketplace,
  serializeMarketplaceMembership,
  serializeMembership,
  serializePlugin,
  serializeVersion,
  type TeamId,
  uniqueIds,
  upsertGrant,
} from "../../../modules/marketplace/store/internal.js"
import { deriveProjection, deriveSkillProjection } from "../../../modules/marketplace/store/projections.js"





export {
  applyGithubConnectorDiscovery,
  completeGithubConnectorInstall,
  consumeGithubInstallState,
  createConnectorAccount,
  createConnectorInstance,
  createConnectorMapping,
  createConnectorTarget,
  createGithubConnectorAccount,
  deleteConnectorMapping,
  deriveGithubImportedObjectProjection,
  disconnectConnectorAccount,
  enqueueGithubWebhookSync,
  executeGithubConnectorSyncEvent,
  getConnectorAccountDetail,
  getConnectorInstanceConfiguration,
  getConnectorInstanceDetail,
  getConnectorSyncEventDetail,
  getConnectorTargetDetail,
  getGithubConnectorDiscovery,
  getGithubConnectorDiscoveryTree,
  githubSetup,
  listConnectorAccounts,
  listConnectorInstances,
  listConnectorMappings,
  listConnectorSyncEvents,
  listConnectorTargets,
  listGithubRepositories,
  queueConnectorTargetResync,
  removeConnectorInstance,
  retryConnectorSyncEvent,
  setConnectorInstanceAutoImport,
  setConnectorInstanceLifecycle,
  startGithubConnectorInstall,
  syncConnectorInstanceNow,
  updateConnectorInstance,
  updateConnectorMapping,
  updateConnectorTarget,
  validateGithubTarget,
} from "../../../modules/marketplace/github-sync/store/index.js"
export { findMarketplaceByExternalKey } from "../../../modules/marketplace/store/internal.js"

export { INTERNAL_MCP_APP_WRITE } from "../../../modules/marketplace/store/object-types/app.js"
export { PluginArchRouteFailure } from "../../../modules/marketplace/store/route-failure.js"

const logger = appLogger.child({ component: "plugin_system_store" })

type PublicGithubPluginTarget = {
  branch: string | null
  repositoryFullName: string
  rootPath: string
}

type PublicGithubTreeSnapshot = {
  branch: string
  fullPathByDiscoveryPath: Map<string, string>
  headSha: string
  repositoryFullName: string
  rootPath: string
  treeEntries: GithubDiscoveryTreeEntry[]
  truncated: boolean
}

type GithubPluginMcpImportAccess = {
  memberIds: MemberId[]
  orgWide: boolean
  teamIds: TeamId[]
}

type PluginMcpRequirementAccess = GithubPluginMcpImportAccess

type PluginMcpRequirementAuthType = "apikey" | "none" | "oauth"

type PluginMcpRequirementCredentialMode = "per_member" | "shared"

type PluginMcpRequirementServer = {
  config: Record<string, unknown>
  name: string
  url: string
}

type PluginMcpConnectionSetup = {
  apiKey?: string
  authType: PluginMcpRequirementAuthType
  credentialMode?: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
}

type GithubPluginMcpImportMapping = {
  displayName: string
  kind: "native" | "preset"
  providerId: string
}

type GithubPluginMcpImportReuse = {
  connectionId: string
  connectionName: string
}

type GithubPluginMcpImportServer = {
  authType: "oauth" | null
  connectionId: string | null
  /** The provider OpenWork already knows for this declared connector (see claude-connector-aliases.ts). */
  mapsTo: GithubPluginMcpImportMapping | null
  name: string
  pluginKey: string
  pluginName: string
  /** The organization's existing connection this server will use instead of a new one. */
  reuse: GithubPluginMcpImportReuse | null
  serverKey: string
  skippedReason: "headers_unsupported" | "invalid_config" | "invalid_url" | "local_unsupported" | "missing_url" | "native_connector" | "unsupported_auth" | null
  sourceSchemaVersion: string | null
  sourcePath: string
  supported: boolean
  url: string | null
}

type GithubPluginMcpImportPlugin = {
  description: string | null
  key: string
  mcpCount: number
  name: string
  skillCount: number
}

type GithubPluginSkillImportSkill = {
  description: string | null
  name: string
  pluginKey: string
  pluginName: string
  rawSourceText?: string
  skillKey: string
  skippedReason: "invalid_skill" | null
  sourceSchemaVersion: string | null
  sourcePath: string
  supported: boolean
}

type GithubPluginMcpImportPlan = {
  branch: string
  classification: GithubDiscoveryClassification
  marketplace: GithubMarketplaceInfo | null
  plugins: GithubPluginMcpImportPlugin[]
  repositoryFullName: string
  rootPath: string
  servers: GithubPluginMcpImportServer[]
  skills: GithubPluginSkillImportSkill[]
  sourceSchemaVersion: string | null
  sourceRevisionRef: string
  /** GitHub cut the repository tree short, so a missing file may still exist. */
  treeTruncated: boolean
  warnings: string[]
}

function normalizeGithubPath(value: string) {
  return value.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

function parsePublicGithubPluginUrl(rawUrl: string): PublicGithubPluginTarget {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "Enter a valid GitHub URL.")
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "Only github.com plugin URLs are supported.")
  }

  const segments = url.pathname.split("/").filter(Boolean)
  const [owner, rawRepo] = segments
  if (!owner || !rawRepo) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub URL must include an owner and repository.")
  }

  const repo = rawRepo.replace(/\.git$/i, "")
  if (!repo) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub URL must include a repository.")
  }

  if (segments.length === 2) {
    return {
      branch: null,
      repositoryFullName: `${owner}/${repo}`,
      rootPath: "",
    }
  }

  if (segments[2] !== "tree") {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "Use a GitHub repository or tree URL, for example /tree/main/sales.")
  }

  const branch = segments[3]
  if (!branch) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub tree URL must include a branch.")
  }

  return {
    branch,
    repositoryFullName: `${owner}/${repo}`,
    rootPath: normalizeGithubPath(segments.slice(4).join("/")),
  }
}

// Overridable so @openwork/testkit specs can serve a fixed repository.
function publicGithubApiBase() {
  return (process.env.DEN_PUBLIC_GITHUB_API_BASE?.trim() || "https://api.github.com").replace(/\/+$/, "")
}

function publicGithubRawBase() {
  return (process.env.DEN_PUBLIC_GITHUB_RAW_BASE?.trim() || "https://raw.githubusercontent.com").replace(/\/+$/, "")
}

// Unauthenticated GitHub API calls share 60 requests an hour per server IP,
// across every organization. The OAuth app's client credentials raise that to
// 5,000 an hour for public data, and grant no access to anyone's account.
function publicGithubAuthorization(): Record<string, string> {
  const { clientId, clientSecret } = env.github
  if (!clientId || !clientSecret) return {}
  return { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` }
}

async function requestPublicGithubJson(input: { path: string; allowStatuses?: number[] }) {
  const response = await fetch(`${publicGithubApiBase()}${input.path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openwork-den-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...publicGithubAuthorization(),
    },
  })
  const text = await response.text()
  const body: unknown = text ? JSON.parse(text) : null
  if (!response.ok && !(input.allowStatuses ?? []).includes(response.status)) {
    const message = isRecord(body) && typeof body.message === "string"
      ? body.message
      : `GitHub request failed with status ${response.status}.`
    throw new PluginArchRouteFailure(response.status === 404 ? 404 : 502, "github_request_failed", message)
  }
  return { body, ok: response.ok, status: response.status }
}

function publicGithubRepoParts(repositoryFullName: string) {
  const [owner, repo, ...rest] = repositoryFullName.split("/")
  if (!owner || !repo || rest.length > 0) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub repository name is invalid.")
  }
  return { owner, repo }
}

async function getPublicGithubDefaultBranch(repositoryFullName: string) {
  const { owner, repo } = publicGithubRepoParts(repositoryFullName)
  const response = await requestPublicGithubJson({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  })
  if (!isRecord(response.body) || typeof response.body.default_branch !== "string" || !response.body.default_branch.trim()) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub repository response was missing the default branch.")
  }
  if (response.body.private === true) {
    throw new PluginArchRouteFailure(400, "private_github_repo", "Private GitHub repositories must be imported through the GitHub connector.")
  }
  return response.body.default_branch.trim()
}

async function getPublicGithubRepositoryTree(target: PublicGithubPluginTarget): Promise<PublicGithubTreeSnapshot> {
  const { owner, repo } = publicGithubRepoParts(target.repositoryFullName)
  const branch = target.branch ?? await getPublicGithubDefaultBranch(target.repositoryFullName)
  const commitResponse = await requestPublicGithubJson({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
  })
  if (!isRecord(commitResponse.body)) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub commit response was invalid.")
  }
  const headSha = typeof commitResponse.body.sha === "string" ? commitResponse.body.sha : ""
  const commit = isRecord(commitResponse.body.commit) ? commitResponse.body.commit : null
  const tree = commit && isRecord(commit.tree) ? commit.tree : null
  const treeSha = tree && typeof tree.sha === "string" ? tree.sha : ""
  if (!headSha || !treeSha) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub commit response was missing the head or tree sha.")
  }

  const treeResponse = await requestPublicGithubJson({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
  })
  if (!isRecord(treeResponse.body) || !Array.isArray(treeResponse.body.tree)) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub tree response was invalid.")
  }

  const rootPath = normalizeGithubPath(target.rootPath)
  const fullPathByDiscoveryPath = new Map<string, string>()
  const treeEntries = treeResponse.body.tree.flatMap((entry): GithubDiscoveryTreeEntry[] => {
    if (!isRecord(entry)) return []
    const fullPath = typeof entry.path === "string" ? normalizeGithubPath(entry.path) : ""
    const kind = entry.type === "blob" || entry.type === "tree" ? entry.type : null
    if (!fullPath || !kind) return []
    if (rootPath && fullPath !== rootPath && !fullPath.startsWith(`${rootPath}/`)) return []
    const discoveryPath = rootPath
      ? (fullPath === rootPath ? "" : fullPath.slice(rootPath.length + 1))
      : fullPath
    if (!discoveryPath) return []
    fullPathByDiscoveryPath.set(discoveryPath, fullPath)
    return [{
      id: entry.sha === null || typeof entry.sha === "string" ? entry.sha ?? discoveryPath : discoveryPath,
      kind,
      path: discoveryPath,
      sha: entry.sha === null || typeof entry.sha === "string" ? entry.sha : null,
      size: typeof entry.size === "number" ? entry.size : null,
    }]
  })

  if (treeEntries.length === 0) {
    throw new PluginArchRouteFailure(404, "github_plugin_root_not_found", "No files were found at that GitHub plugin path.")
  }

  return {
    branch,
    fullPathByDiscoveryPath,
    headSha,
    repositoryFullName: target.repositoryFullName,
    rootPath,
    treeEntries,
    truncated: isRecord(treeResponse.body) && treeResponse.body.truncated === true,
  }
}

const PUBLIC_GITHUB_FETCH_CONCURRENCY = 8

async function mapPublicGithubConcurrently<T, R>(items: T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(PUBLIC_GITHUB_FETCH_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await mapper(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function getPublicGithubTextFile(input: { branch: string; discoveryPath: string; snapshot: PublicGithubTreeSnapshot }) {
  const fullPath = input.snapshot.fullPathByDiscoveryPath.get(input.discoveryPath) ?? input.discoveryPath
  const { owner, repo } = publicGithubRepoParts(input.snapshot.repositoryFullName)
  // Raw downloads at the resolved commit do not count against the API rate
  // limit; a marketplace such as knowledge-work-plugins has 250+ SKILL.md
  // files, so reading them through /contents exhausted it in one preview.
  const ref = input.snapshot.headSha || input.branch
  const response = await fetch(
    `${publicGithubRawBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref.split("/").map(encodeURIComponent).join("/")}/${fullPath.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { "User-Agent": "openwork-den-api" } },
  )
  if (response.status === 404) return null
  if (!response.ok) {
    throw new PluginArchRouteFailure(502, "github_request_failed", `GitHub file download failed with status ${response.status}.`)
  }
  return await response.text()
}

async function getPublicGithubDiscoveryFileTexts(snapshot: PublicGithubTreeSnapshot) {
  const interestingPaths = new Set<string>()
  const knownPaths = new Set(snapshot.treeEntries.map((entry) => entry.path))
  if (knownPaths.has(".claude-plugin/marketplace.json")) {
    interestingPaths.add(".claude-plugin/marketplace.json")
  }
  for (const entry of snapshot.treeEntries) {
    if (entry.path.endsWith(".claude-plugin/plugin.json") || entry.path.endsWith("/plugin.json") || entry.path === "plugin.json") {
      interestingPaths.add(entry.path)
    }
  }

  const paths = [...interestingPaths]
  const texts = await mapPublicGithubConcurrently(paths, (path) => getPublicGithubTextFile({
    branch: snapshot.branch,
    discoveryPath: path,
    snapshot,
  }))
  return Object.fromEntries(paths.map((path, index) => [path, texts[index] ?? null]))
}

export async function listConfigObjects(input: {
  connectorInstanceId?: ConnectorInstanceId
  context: PluginArchActorContext
  cursor?: string
  includeDeleted?: boolean
  limit?: number
  pluginId?: PluginId
  q?: string
  sourceMode?: ConfigObjectRow["sourceMode"]
  status?: ConfigObjectRow["status"]
  type?: ConfigObjectRow["objectType"]
}) {
  const organizationId = input.context.organizationContext.organization.id
  if (input.connectorInstanceId) {
    await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  }
  if (input.pluginId) {
    await ensureVisiblePlugin(input.context, input.pluginId)
  }

  const rows = await db
    .select()
    .from(ConfigObjectTable)
    .where(eq(ConfigObjectTable.organizationId, organizationId))
    .orderBy(desc(ConfigObjectTable.updatedAt), desc(ConfigObjectTable.id))

  const latestVersions = await getLatestVersions(rows.map((row) => row.id))
  const filtered: ReturnType<typeof serializeConfigObject>[] = []

  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object" })
    if (!role) continue
    if (input.type && row.objectType !== input.type) continue
    if (input.status && row.status !== input.status) continue
    if (input.sourceMode && row.sourceMode !== input.sourceMode) continue
    if (!input.includeDeleted && row.status === "deleted") continue
    if (input.connectorInstanceId && row.connectorInstanceId !== input.connectorInstanceId) continue
    if (input.q) {
      const haystack = `${row.title}\n${row.description ?? ""}\n${row.searchText ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    if (input.pluginId) {
      const memberships = await db
        .select({ id: PluginConfigObjectTable.id })
        .from(PluginConfigObjectTable)
        .where(and(
          eq(PluginConfigObjectTable.organizationId, organizationId),
          eq(PluginConfigObjectTable.pluginId, input.pluginId),
          eq(PluginConfigObjectTable.configObjectId, row.id),
          isNull(PluginConfigObjectTable.removedAt),
        ))
        .limit(1)
      if (!memberships[0]) continue
    }
    filtered.push(serializeConfigObject(row, latestVersions.get(row.id) ?? null))
  }

  return pageItems(filtered, input.cursor, input.limit)
}

export async function getConfigObjectDetail(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const row = await ensureVisibleConfigObject(context, configObjectId)
  const latest = await getLatestVersions([row.id])
  return serializeConfigObject(row, latest.get(row.id) ?? null)
}

export async function createConfigObject(input: {
  context: PluginArchActorContext
  objectType: ConfigObjectRow["objectType"]
  pluginIds?: PluginId[]
  /** Where an imported object came from in its source repository; a re-import matches and prunes on it. */
  sourcePath?: string | null
  sourceMode: ConfigObjectRow["sourceMode"]
  value: ConfigObjectInput
}, internal?: typeof INTERNAL_MCP_APP_WRITE) {
  rejectAuthoredMcpAppWrite(input.value, internal)
  if (input.sourceMode === "connector") {
    throw new PluginArchRouteFailure(400, "invalid_request", "Connector-managed config objects must be created through connector sync.")
  }

  for (const pluginId of input.pluginIds ?? []) {
    await ensureEditablePlugin(input.context, pluginId)
  }

  const now = new Date()
  const projection = deriveProjection({ objectType: input.objectType, value: input.value })
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const configObjectId = createDenTypeId("configObject")
  const versionId = createDenTypeId("configObjectVersion")

  await db.transaction(async (tx) => {
    await tx.insert(ConfigObjectTable).values({
      createdAt: now,
      createdByOrgMembershipId,
      currentFileExtension: null,
      currentFileName: null,
      currentRelativePath: input.sourcePath ?? null,
      deletedAt: null,
      description: projection.description,
      id: configObjectId,
      objectType: input.objectType,
      organizationId,
      searchText: projection.searchText,
      sourceMode: input.sourceMode,
      status: "active",
      title: projection.title,
      updatedAt: now,
      connectorInstanceId: null,
    })

      await tx.insert(ConfigObjectVersionTable).values({
        configObjectId,
        connectorSyncEventId: null,
        createdAt: now,
        createdByOrgMembershipId,
        createdVia: input.sourceMode,
        id: versionId,
        isDeletedVersion: false,
        normalizedPayloadJson: input.value.normalizedPayloadJson ?? null,
        organizationId,
        rawSourceText: normalizeOptionalString(input.value.rawSourceText),
      schemaVersion: normalizeOptionalString(input.value.schemaVersion),
      sourceRevisionRef: null,
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

    for (const pluginId of input.pluginIds ?? []) {
      const existing = await tx
        .select({ id: PluginConfigObjectTable.id })
        .from(PluginConfigObjectTable)
        .where(and(eq(PluginConfigObjectTable.pluginId, pluginId), eq(PluginConfigObjectTable.configObjectId, configObjectId)))
        .limit(1)

      if (existing[0]) {
        await tx.update(PluginConfigObjectTable).set({ removedAt: null }).where(eq(PluginConfigObjectTable.id, existing[0].id))
      } else {
        await tx.insert(PluginConfigObjectTable).values({
          configObjectId,
          connectorMappingId: null,
          createdAt: now,
          createdByOrgMembershipId,
          id: createDenTypeId("pluginConfigObject"),
          membershipSource: "manual",
          organizationId,
          pluginId,
        })
      }
    }
  })

  return getConfigObjectDetail(input.context, configObjectId)
}

export async function listConfigObjectVersions(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; cursor?: string; includeDeleted?: boolean; limit?: number }) {
  const configObject = await ensureVisibleConfigObject(input.context, input.configObjectId)
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.configObjectId, configObject.id))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))

  const items = rows
    .filter((row) => input.includeDeleted || !row.isDeletedVersion)
    .map((row) => ({ ...serializeVersion(row), id: row.id }))

  return pageItems(items, input.cursor, input.limit)
}

export async function getConfigObjectVersion(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; versionId: ConfigObjectVersionId }) {
  await ensureVisibleConfigObject(input.context, input.configObjectId)
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(eq(ConfigObjectVersionTable.id, input.versionId), eq(ConfigObjectVersionTable.configObjectId, input.configObjectId)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "config_object_version_not_found", "Config object version not found.")
  }
  return serializeVersion(rows[0])
}

export async function getLatestConfigObjectVersion(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId }) {
  await ensureVisibleConfigObject(input.context, input.configObjectId)
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.configObjectId, input.configObjectId))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "config_object_version_not_found", "Config object version not found.")
  }
  return serializeVersion(rows[0])
}

export async function createConfigObjectVersion(input: {
  context: PluginArchActorContext
  configObjectId: ConfigObjectId
  reason?: string
  value: ConfigObjectInput
}) {
  rejectAuthoredMcpAppWrite(input.value)
  const row = await getConfigObjectRow(input.context.organizationContext.organization.id, input.configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  if (row.objectType === "app") {
    const latest = (await getLatestVersions([row.id])).get(row.id)
    if (latest) rejectAuthoredMcpAppWrite(latest)
  }
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object", role: "editor" })

  const now = new Date()
  const projection = deriveProjection({ objectType: row.objectType, value: input.value })
  await db.transaction(async (tx) => {
    await tx.insert(ConfigObjectVersionTable).values({
      configObjectId: row.id,
      connectorSyncEventId: null,
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      createdVia: row.sourceMode === "connector" ? "connector" : row.sourceMode,
      id: createDenTypeId("configObjectVersion"),
      isDeletedVersion: false,
      normalizedPayloadJson: input.value.normalizedPayloadJson ?? null,
      organizationId: row.organizationId,
      rawSourceText: normalizeOptionalString(input.value.rawSourceText),
      schemaVersion: normalizeOptionalString(input.value.schemaVersion),
      sourceRevisionRef: normalizeOptionalString(input.reason),
    })

    await tx.update(ConfigObjectTable).set({
      description: projection.description,
      searchText: projection.searchText,
      title: projection.title,
      updatedAt: now,
    }).where(eq(ConfigObjectTable.id, row.id))
  })
  await deleteStalePluginMcpRequirementBindingsForConfigObject({
    configObject: row,
    spec: parseConfigObjectInputSpec(input.value),
  })

  return getConfigObjectDetail(input.context, row.id)
}

export async function setConfigObjectLifecycle(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; action: "archive" | "delete" | "restore" }) {
  const row = await getConfigObjectRow(input.context.organizationContext.organization.id, input.configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object", role: "manager" })
  const now = new Date()
  const patch = input.action === "archive"
    ? { deletedAt: null, status: "archived" as const, updatedAt: now }
    : input.action === "delete"
      ? { deletedAt: now, status: "deleted" as const, updatedAt: now }
      : { deletedAt: null, status: "active" as const, updatedAt: now }

  await db.update(ConfigObjectTable).set(patch).where(eq(ConfigObjectTable.id, row.id))
  await syncPluginMcpRequirementAccessForResource({
    context: input.context,
    resourceId: row.id,
    resourceKind: "config_object",
  })
  return getConfigObjectDetail(input.context, row.id)
}

export async function listConfigObjectPlugins(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId }) {
  const configObject = await ensureVisibleConfigObject(input.context, input.configObjectId)
  const latest = await getLatestVersions([configObject.id])
  const memberships = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(eq(PluginConfigObjectTable.configObjectId, configObject.id))
    .orderBy(desc(PluginConfigObjectTable.createdAt))

  const serializedConfigObject = serializeConfigObject(configObject, latest.get(configObject.id) ?? null)
  const visible: ReturnType<typeof serializeMembership>[] = []
  for (const membership of memberships) {
    const pluginRole = await resolvePluginArchResourceRole({ context: input.context, resourceId: membership.pluginId, resourceKind: "plugin" })
    if (!pluginRole) continue
    visible.push(serializeMembership(membership, serializedConfigObject))
  }
  return { items: visible, nextCursor: null }
}

export async function attachConfigObjectToPlugin(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; membershipSource?: PluginMembershipRow["membershipSource"]; pluginId: PluginId }) {
  const configObject = await ensureVisibleConfigObject(input.context, input.configObjectId)
  const authoredApp = configObject.objectType === "app"
    && isAuthoredMcpAppVersion((await getLatestVersions([configObject.id])).get(configObject.id) ?? {})
  if (configObject.objectType === "workflow" || configObject.objectType === "script" || authoredApp) {
    // Adding a Workflow or authored App to a Plugin can expand its audience
    // through Plugin and Marketplace grants, so its manager makes that sharing
    // decision. Legacy imported Apps keep their existing membership behavior.
    await requirePluginArchResourceRole({
      context: input.context,
      resourceId: configObject.id,
      resourceKind: "config_object",
      role: "manager",
    })
  }
  await ensureEditablePlugin(input.context, input.pluginId)

  const existing = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, input.configObjectId)))
    .limit(1)

  const now = new Date()
  let membershipId = existing[0]?.id ?? null
  if (existing[0]) {
    await db.update(PluginConfigObjectTable).set({ membershipSource: input.membershipSource ?? existing[0].membershipSource, removedAt: null }).where(eq(PluginConfigObjectTable.id, existing[0].id))
  } else {
    membershipId = createDenTypeId("pluginConfigObject")
    await db.insert(PluginConfigObjectTable).values({
      configObjectId: input.configObjectId,
      connectorMappingId: null,
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: membershipId,
      membershipSource: input.membershipSource ?? "manual",
      organizationId: input.context.organizationContext.organization.id,
      pluginId: input.pluginId,
    })
  }

  const rows = await db.select().from(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.id, membershipId!)).limit(1)
  return serializeMembership(rows[0])
}

export async function removeConfigObjectFromPlugin(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; pluginId: PluginId }) {
  const configObject = await ensureVisibleConfigObject(input.context, input.configObjectId)
  if (configObject.objectType === "workflow" || configObject.objectType === "script") {
    await requirePluginArchResourceRole({
      context: input.context,
      resourceId: configObject.id,
      resourceKind: "config_object",
      role: "manager",
    })
  }
  await ensureEditablePlugin(input.context, input.pluginId)
  const rows = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, input.configObjectId), isNull(PluginConfigObjectTable.removedAt)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "plugin_membership_not_found", "Plugin membership not found.")
  }
  await db.update(PluginConfigObjectTable).set({ removedAt: new Date() }).where(eq(PluginConfigObjectTable.id, rows[0].id))
  await deletePluginMcpRequirementBindingsForPluginConfigObject({
    configObjectId: input.configObjectId,
    organizationId: input.context.organizationContext.organization.id,
    pluginId: input.pluginId,
  })
}

export async function listResourceAccess(input: { context: PluginArchActorContext } & ResourceTarget) {
  await ensureResourceInOrganization(input.context, input)
  await requirePluginArchResourceRole({
    context: input.context,
    resourceId: input.resourceId,
    resourceKind: input.resourceKind,
    role: "manager",
  })

  if (input.resourceKind === "config_object") {
    const rows = await db.select().from(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId)).orderBy(desc(ConfigObjectAccessGrantTable.createdAt))
    return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
  }
  if (input.resourceKind === "marketplace") {
    const rows = await db.select().from(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId)).orderBy(desc(MarketplaceAccessGrantTable.createdAt))
    return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
  }
  if (input.resourceKind === "plugin") {
    const rows = await db.select().from(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.pluginId, input.resourceId)).orderBy(desc(PluginAccessGrantTable.createdAt))
    return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
  }
  const rows = await db.select().from(ConnectorInstanceAccessGrantTable).where(eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId)).orderBy(desc(ConnectorInstanceAccessGrantTable.createdAt))
  return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
}

type TeamPluginAccessEdge = "direct_team" | "via_catalog" | "org_wide"

type TeamPluginAccessCandidate = {
  createdAt: Date
  createdByOrgMembershipId: MemberId
  edge: TeamPluginAccessEdge
  grantId: PluginAccessGrantId | null
  marketplace: { id: MarketplaceId; name: string } | null
  pluginId: PluginId
  pluginName: string
  role: PluginArchRole
}

const teamPluginAccessEdgeOrder: Record<TeamPluginAccessEdge, number> = {
  direct_team: 1,
  via_catalog: 2,
  org_wide: 3,
}

const pluginAccessRolePriority: Record<PluginArchRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
}

export async function listTeamEffectivePluginAccess(input: { context: PluginArchActorContext; teamId: TeamId }) {
  const organizationId = input.context.organizationContext.organization.id
  const teams = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.id, input.teamId), eq(TeamTable.organizationId, organizationId)))
    .limit(1)

  if (!teams[0]) {
    throw new PluginArchRouteFailure(404, "team_not_found", "Team not found.")
  }
  if (!isPluginArchOrgAdmin(input.context) && !input.context.memberTeams.some((team) => team.id === input.teamId)) {
    throw new PluginArchAuthorizationError(403, "forbidden", "Only organization admins and team members can view this team's plugin access.")
  }

  const [directRows, marketplaceRows, orgWideRows] = await Promise.all([
    db
      .select({
        createdAt: PluginAccessGrantTable.createdAt,
        createdByOrgMembershipId: PluginAccessGrantTable.createdByOrgMembershipId,
        grantId: PluginAccessGrantTable.id,
        pluginId: PluginTable.id,
        pluginName: PluginTable.name,
        role: PluginAccessGrantTable.role,
      })
      .from(PluginAccessGrantTable)
      .innerJoin(PluginTable, eq(PluginAccessGrantTable.pluginId, PluginTable.id))
      .where(and(
        eq(PluginAccessGrantTable.organizationId, organizationId),
        eq(PluginAccessGrantTable.teamId, input.teamId),
        isNull(PluginAccessGrantTable.removedAt),
        eq(PluginTable.organizationId, organizationId),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))
      .orderBy(asc(PluginAccessGrantTable.createdAt), asc(PluginAccessGrantTable.id)),
    db
      .select({
        createdAt: MarketplaceAccessGrantTable.createdAt,
        createdByOrgMembershipId: MarketplaceAccessGrantTable.createdByOrgMembershipId,
        marketplaceId: MarketplaceTable.id,
        marketplaceName: MarketplaceTable.name,
        pluginId: PluginTable.id,
        pluginName: PluginTable.name,
        role: MarketplaceAccessGrantTable.role,
      })
      .from(MarketplaceAccessGrantTable)
      .innerJoin(MarketplaceTable, eq(MarketplaceAccessGrantTable.marketplaceId, MarketplaceTable.id))
      .innerJoin(MarketplacePluginTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
      .innerJoin(PluginTable, eq(MarketplacePluginTable.pluginId, PluginTable.id))
      .where(and(
        eq(MarketplaceAccessGrantTable.organizationId, organizationId),
        eq(MarketplaceAccessGrantTable.teamId, input.teamId),
        isNull(MarketplaceAccessGrantTable.removedAt),
        eq(MarketplaceTable.organizationId, organizationId),
        eq(MarketplaceTable.status, "active"),
        isNull(MarketplaceTable.deletedAt),
        eq(MarketplacePluginTable.organizationId, organizationId),
        isNull(MarketplacePluginTable.removedAt),
        eq(PluginTable.organizationId, organizationId),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))
      .orderBy(asc(MarketplaceAccessGrantTable.createdAt), asc(MarketplaceAccessGrantTable.id), asc(MarketplaceTable.name)),
    db
      .select({
        createdAt: PluginAccessGrantTable.createdAt,
        createdByOrgMembershipId: PluginAccessGrantTable.createdByOrgMembershipId,
        pluginId: PluginTable.id,
        pluginName: PluginTable.name,
        role: PluginAccessGrantTable.role,
      })
      .from(PluginAccessGrantTable)
      .innerJoin(PluginTable, eq(PluginAccessGrantTable.pluginId, PluginTable.id))
      .where(and(
        eq(PluginAccessGrantTable.organizationId, organizationId),
        eq(PluginAccessGrantTable.orgWide, true),
        isNull(PluginAccessGrantTable.removedAt),
        eq(PluginTable.organizationId, organizationId),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))
      .orderBy(asc(PluginAccessGrantTable.createdAt), asc(PluginAccessGrantTable.id)),
  ])

  const candidates: TeamPluginAccessCandidate[] = []
  for (const row of directRows) {
    candidates.push({
      ...row,
      edge: "direct_team",
      marketplace: null,
    })
  }
  for (const row of marketplaceRows) {
    candidates.push({
      createdAt: row.createdAt,
      createdByOrgMembershipId: row.createdByOrgMembershipId,
      edge: "via_catalog",
      grantId: null,
      marketplace: { id: row.marketplaceId, name: row.marketplaceName },
      pluginId: row.pluginId,
      pluginName: row.pluginName,
      role: row.role,
    })
  }
  for (const row of orgWideRows) {
    candidates.push({
      ...row,
      edge: "org_wide",
      grantId: null,
      marketplace: null,
    })
  }

  const effectiveByPluginEdge = new Map<string, TeamPluginAccessCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.pluginId}:${candidate.edge}`
    const current = effectiveByPluginEdge.get(key)
    if (!current || pluginAccessRolePriority[candidate.role] > pluginAccessRolePriority[current.role]) {
      effectiveByPluginEdge.set(key, candidate)
    }
  }

  const effective = [...effectiveByPluginEdge.values()]
  const pluginIds = uniqueIds(effective.map((candidate) => candidate.pluginId))
  const creatorIds = uniqueIds(effective.map((candidate) => candidate.createdByOrgMembershipId))
  const componentCountRows = pluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId, componentCount: count() })
      .from(PluginConfigObjectTable)
      .where(and(
        eq(PluginConfigObjectTable.organizationId, organizationId),
        inArray(PluginConfigObjectTable.pluginId, pluginIds),
        isNull(PluginConfigObjectTable.removedAt),
      ))
      .groupBy(PluginConfigObjectTable.pluginId)
  const creatorRows = creatorIds.length === 0
    ? []
    : await db
      .select({ orgMembershipId: MemberTable.id, name: AuthUserTable.name })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, creatorIds)))

  const componentCounts = new Map(componentCountRows.map((row) => [row.pluginId, row.componentCount]))
  const creatorNames = new Map(creatorRows.flatMap((row) => row.name === null ? [] : [[row.orgMembershipId, row.name]]))

  effective.sort((left, right) => {
    const byName = left.pluginName.localeCompare(right.pluginName)
    if (byName !== 0) return byName
    const byEdge = teamPluginAccessEdgeOrder[left.edge] - teamPluginAccessEdgeOrder[right.edge]
    if (byEdge !== 0) return byEdge
    return left.pluginId.localeCompare(right.pluginId)
  })

  return {
    items: effective.map((candidate) => {
      const creatorName = creatorNames.get(candidate.createdByOrgMembershipId)
      return {
        plugin: {
          id: candidate.pluginId,
          name: candidate.pluginName,
          componentCount: componentCounts.get(candidate.pluginId) ?? 0,
        },
        edge: candidate.edge,
        marketplace: candidate.marketplace,
        role: candidate.role,
        grantedBy: creatorName
          ? { orgMembershipId: candidate.createdByOrgMembershipId, name: creatorName }
          : null,
        grantedAt: candidate.createdAt.toISOString(),
        grantId: candidate.grantId,
      }
    }),
  }
}

export type MePluginAccessEdge =
  | { kind: "mine" }
  | { kind: "person"; sharedBy: { orgMembershipId: MemberId; name: string } | null; grantedAt: string }
  | { kind: "team"; team: { id: TeamId; name: string } }
  | { kind: "org_wide" }
  | { kind: "catalog"; marketplace: { id: MarketplaceId; name: string } }

type MePluginAccessCandidate = {
  edge: MePluginAccessEdge
  edgeKey: string
  role: PluginArchRole
}

const mePluginAccessEdgeOrder: Record<MePluginAccessEdge["kind"], number> = {
  mine: 1,
  person: 2,
  team: 3,
  org_wide: 4,
  catalog: 5,
}

async function listMeEffectivePluginAccessWithComponentKinds(input: { context: PluginArchActorContext }) {
  const organizationId = input.context.organizationContext.organization.id
  const memberId = input.context.organizationContext.currentMember.id
  const teamIds = input.context.memberTeams.map((team) => team.id)
  const activePlugins = await db
    .select()
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))

  if (activePlugins.length === 0) return { items: [] }

  const pluginIds = activePlugins.map((plugin) => plugin.id)
  const applicablePluginGrant = teamIds.length > 0
    ? or(
        eq(PluginAccessGrantTable.orgWide, true),
        eq(PluginAccessGrantTable.orgMembershipId, memberId),
        inArray(PluginAccessGrantTable.teamId, teamIds),
      )
    : or(
        eq(PluginAccessGrantTable.orgWide, true),
        eq(PluginAccessGrantTable.orgMembershipId, memberId),
      )
  const applicableMarketplaceGrant = teamIds.length > 0
    ? or(
        eq(MarketplaceAccessGrantTable.orgWide, true),
        eq(MarketplaceAccessGrantTable.orgMembershipId, memberId),
        inArray(MarketplaceAccessGrantTable.teamId, teamIds),
      )
    : or(
        eq(MarketplaceAccessGrantTable.orgWide, true),
        eq(MarketplaceAccessGrantTable.orgMembershipId, memberId),
      )

  const [pluginGrants, marketplaceMemberships, marketplaceGrants, componentRows] = await Promise.all([
    db
      .select()
      .from(PluginAccessGrantTable)
      .where(and(
        eq(PluginAccessGrantTable.organizationId, organizationId),
        inArray(PluginAccessGrantTable.pluginId, pluginIds),
        isNull(PluginAccessGrantTable.removedAt),
        applicablePluginGrant,
      ))
      .orderBy(asc(PluginAccessGrantTable.createdAt), asc(PluginAccessGrantTable.id)),
    db
      .select({
        marketplaceId: MarketplaceTable.id,
        marketplaceName: MarketplaceTable.name,
        pluginId: MarketplacePluginTable.pluginId,
      })
      .from(MarketplacePluginTable)
      .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
      .where(and(
        eq(MarketplacePluginTable.organizationId, organizationId),
        inArray(MarketplacePluginTable.pluginId, pluginIds),
        isNull(MarketplacePluginTable.removedAt),
        eq(MarketplaceTable.organizationId, organizationId),
        eq(MarketplaceTable.status, "active"),
        isNull(MarketplaceTable.deletedAt),
      )),
    db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.organizationId, organizationId),
        isNull(MarketplaceAccessGrantTable.removedAt),
        applicableMarketplaceGrant,
      )),
    db
      .select({
        pluginId: PluginConfigObjectTable.pluginId,
        objectType: ConfigObjectTable.objectType,
        componentCount: count(),
      })
      .from(PluginConfigObjectTable)
      .innerJoin(ConfigObjectTable, and(
        eq(PluginConfigObjectTable.organizationId, ConfigObjectTable.organizationId),
        eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
      ))
      .where(and(
        eq(PluginConfigObjectTable.organizationId, organizationId),
        inArray(PluginConfigObjectTable.pluginId, pluginIds),
        isNull(PluginConfigObjectTable.removedAt),
      ))
      .groupBy(PluginConfigObjectTable.pluginId, ConfigObjectTable.objectType),
  ])

  const grantCreatorIds = uniqueIds(pluginGrants.flatMap((grant) =>
    grant.orgMembershipId === memberId ? [grant.createdByOrgMembershipId] : []))
  const grantCreatorRows = grantCreatorIds.length === 0
    ? []
    : await db
      .select({ orgMembershipId: MemberTable.id, name: AuthUserTable.name })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, grantCreatorIds)))
  const grantCreatorNames = new Map(grantCreatorRows.map((row) => [row.orgMembershipId, row.name]))
  const pluginsById = new Map(activePlugins.map((plugin) => [plugin.id, plugin]))
  const teamsById = new Map(input.context.memberTeams.map((team) => [team.id, team]))
  const marketplaceGrantsById = new Map<MarketplaceId, typeof marketplaceGrants>()
  const componentsByPlugin = new Map<PluginId, { count: number; kinds: Set<string> }>()
  for (const row of componentRows) {
    const components = componentsByPlugin.get(row.pluginId) ?? { count: 0, kinds: new Set<string>() }
    components.count += row.componentCount
    components.kinds.add(row.objectType)
    componentsByPlugin.set(row.pluginId, components)
  }
  const candidatesByPlugin = new Map<PluginId, Map<string, MePluginAccessCandidate>>()

  const addCandidate = (pluginId: PluginId, candidate: MePluginAccessCandidate) => {
    const existingCandidates = candidatesByPlugin.get(pluginId)
    const candidates = existingCandidates ?? new Map<string, MePluginAccessCandidate>()
    if (!existingCandidates) candidatesByPlugin.set(pluginId, candidates)
    const current = candidates.get(candidate.edgeKey)
    if (!current || pluginAccessRolePriority[candidate.role] > pluginAccessRolePriority[current.role]) {
      candidates.set(candidate.edgeKey, candidate)
    }
  }

  for (const plugin of activePlugins) {
    if (plugin.createdByOrgMembershipId === memberId) {
      addCandidate(plugin.id, { edge: { kind: "mine" }, edgeKey: "mine", role: "manager" })
    }
  }

  for (const grant of pluginGrants) {
    if (!pluginsById.has(grant.pluginId)) continue
    if (grant.orgMembershipId === memberId) {
      const creatorName = grantCreatorNames.get(grant.createdByOrgMembershipId)
      addCandidate(grant.pluginId, {
        edge: {
          kind: "person",
          sharedBy: creatorName ? { orgMembershipId: grant.createdByOrgMembershipId, name: creatorName } : null,
          grantedAt: grant.createdAt.toISOString(),
        },
        edgeKey: "person",
        role: grant.role,
      })
    }
    if (grant.teamId) {
      const team = teamsById.get(grant.teamId)
      if (team) {
        addCandidate(grant.pluginId, {
          edge: { kind: "team", team: { id: team.id, name: team.name } },
          edgeKey: `team:${team.id}`,
          role: grant.role,
        })
      }
    }
    if (grant.orgWide) {
      addCandidate(grant.pluginId, { edge: { kind: "org_wide" }, edgeKey: "org_wide", role: grant.role })
    }
  }

  for (const grant of marketplaceGrants) {
    const existing = marketplaceGrantsById.get(grant.marketplaceId) ?? []
    existing.push(grant)
    marketplaceGrantsById.set(grant.marketplaceId, existing)
  }
  for (const membership of marketplaceMemberships) {
    const role = resolvePluginArchGrantRole({
      grants: marketplaceGrantsById.get(membership.marketplaceId) ?? [],
      memberId,
      teamIds,
    })
    if (!role) continue
    addCandidate(membership.pluginId, {
      edge: {
        kind: "catalog",
        marketplace: { id: membership.marketplaceId, name: membership.marketplaceName },
      },
      edgeKey: `catalog:${membership.marketplaceId}`,
      role: "viewer",
    })
  }

  const items = activePlugins.flatMap((plugin) => {
    const candidates = [...(candidatesByPlugin.get(plugin.id)?.values() ?? [])]
    if (candidates.length === 0) return []
    candidates.sort((left, right) => {
      const byKind = mePluginAccessEdgeOrder[left.edge.kind] - mePluginAccessEdgeOrder[right.edge.kind]
      return byKind !== 0 ? byKind : left.edgeKey.localeCompare(right.edgeKey)
    })
    let role: PluginArchRole = "viewer"
    for (const candidate of candidates) {
      if (pluginAccessRolePriority[candidate.role] > pluginAccessRolePriority[role]) role = candidate.role
    }
    return [{
      plugin: {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        componentCount: componentsByPlugin.get(plugin.id)?.count ?? 0,
        componentKinds: [...(componentsByPlugin.get(plugin.id)?.kinds ?? [])].sort(),
        sourceRepositoryUrl: plugin.sourceRepositoryUrl,
      },
      edges: candidates.map((candidate) => candidate.edge),
      role,
    }]
  })
  items.sort((left, right) => {
    const byName = left.plugin.name.localeCompare(right.plugin.name)
    return byName !== 0 ? byName : left.plugin.id.localeCompare(right.plugin.id)
  })
  return { items }
}

export async function listMeEffectivePluginAccess(input: { context: PluginArchActorContext }) {
  const result = await listMeEffectivePluginAccessWithComponentKinds(input)
  return {
    items: result.items.map((item) => ({
      plugin: {
        id: item.plugin.id,
        name: item.plugin.name,
        description: item.plugin.description,
        componentCount: item.plugin.componentCount,
        sourceRepositoryUrl: item.plugin.sourceRepositoryUrl,
      },
      edges: item.edges,
      role: item.role,
    })),
  }
}

export async function listMeLibraryPluginItems(input: { context: PluginArchActorContext }) {
  const result = await listMeEffectivePluginAccessWithComponentKinds(input)
  return result.items.map((item) => ({
      type: "plugin" as const,
      id: item.plugin.id,
      name: item.plugin.name,
      description: item.plugin.description,
      componentCount: item.plugin.componentCount,
      componentKinds: item.plugin.componentKinds,
      sourceRepositoryUrl: item.plugin.sourceRepositoryUrl,
      edges: item.edges,
      role: item.role,
  }))
}

function memberConnectionState(connection: MemberUsableConnectionFacts) {
  if (
    connection.setupRequired
    || connection.issuerReviewRequired
    || connection.reconnectActionOwner === "organization_admin"
    || connection.authPolicyConfirmed === false
    || connection.authTypeMismatch
    || (connection.oauthClientRequired && !connection.oauthClientConfigured)
    || (connection.credentialMode === "shared" && !connection.connectedForMe)
  ) {
    return "needs_admin_setup"
  }
  if (connection.credentialMode === "per_member" && (!connection.connectedForMe || connection.needsReconnect)) {
    return "needs_signin"
  }
  if (connection.connectedForMe || (connection.credentialMode === "shared" && connection.connected)) {
    return "connected"
  }
  return "available"
}

export async function listMeLibraryConnectionItems(input: {
  connections: MemberUsableConnectionFacts[]
  context: PluginArchActorContext
}) {
  if (input.connections.length === 0) return []

  const organizationId = input.context.organizationContext.organization.id
  const memberId = input.context.organizationContext.currentMember.id
  const teamIds = input.context.memberTeams.map((team) => team.id)
  const connectionIds = new Set(input.connections.map((connection) => connection.id))
  const applicableGrant = teamIds.length > 0
    ? or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, memberId),
        inArray(ExternalMcpConnectionAccessGrantTable.teamId, teamIds),
      )
    : or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, memberId),
      )
  const grants = await db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId),
      applicableGrant,
    ))
    .orderBy(asc(ExternalMcpConnectionAccessGrantTable.createdAt), asc(ExternalMcpConnectionAccessGrantTable.id))
  const creatorIds = uniqueIds(grants
    .filter((grant) => connectionIds.has(grant.externalMcpConnectionId) && grant.orgMembershipId === memberId)
    .map((grant) => grant.createdByOrgMembershipId))
  const creators = creatorIds.length === 0
    ? []
    : await db
      .select({ orgMembershipId: MemberTable.id, name: AuthUserTable.name })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, creatorIds)))
  const creatorNames = new Map(creators.map((creator) => [creator.orgMembershipId, creator.name]))
  const teamsById = new Map(input.context.memberTeams.map((team) => [team.id, team]))
  const edgesByConnection = new Map<string, Map<string, MePluginAccessEdge>>()
  const addEdge = (connectionId: string, key: string, edge: MePluginAccessEdge) => {
    if (!connectionIds.has(connectionId)) return
    const edges = edgesByConnection.get(connectionId) ?? new Map<string, MePluginAccessEdge>()
    if (!edgesByConnection.has(connectionId)) edgesByConnection.set(connectionId, edges)
    if (!edges.has(key)) edges.set(key, edge)
  }

  for (const grant of grants) {
    if (grant.orgWide) addEdge(grant.externalMcpConnectionId, "org_wide", { kind: "org_wide" })
    if (grant.orgMembershipId === memberId) {
      const creatorName = creatorNames.get(grant.createdByOrgMembershipId)
      addEdge(grant.externalMcpConnectionId, "person", {
        kind: "person",
        sharedBy: creatorName ? { orgMembershipId: grant.createdByOrgMembershipId, name: creatorName } : null,
        grantedAt: grant.createdAt.toISOString(),
      })
    }
    if (grant.teamId) {
      const team = teamsById.get(grant.teamId)
      if (team) addEdge(grant.externalMcpConnectionId, `team:${team.id}`, { kind: "team", team: { id: team.id, name: team.name } })
    }
  }

  return input.connections.map((connection) => {
    const edges = [...(edgesByConnection.get(connection.id)?.values() ?? [{ kind: "org_wide" } satisfies MePluginAccessEdge])]
    edges.sort((left, right) => mePluginAccessEdgeOrder[left.kind] - mePluginAccessEdgeOrder[right.kind])
    return {
      type: "connection",
      id: connection.id,
      name: connection.name,
      url: connection.url,
      description: null,
      transport: connection.nativeProviderKey !== null ? "native" : "mcp",
      provider: connection.nativeProviderKey,
      state: memberConnectionState(connection),
      connectedAt: connection.connectedAt,
      edges,
    }
  })
}

export async function createResourceAccessGrant(input: { context: PluginArchActorContext; value: AccessGrantWrite } & ResourceTarget) {
  await ensureResourceInOrganization(input.context, input)
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })
  if (input.value.orgWide === true && !isPluginArchOrgAdmin(input.context)) {
    throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can grant org-wide access.")
  }
  await ensureGrantTargetsInOrganization(input.context, input.value)
  const grant = await upsertGrant(input)
  await syncPluginMcpRequirementAccessForResource(input)
  return grant
}

export async function deleteResourceAccessGrant(input: { context: PluginArchActorContext } & GrantTarget) {
  await ensureResourceInOrganization(input.context, input)
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })
  await removeGrant(input)
  await syncPluginMcpRequirementAccessForResource(input)
}

async function collectPluginMarketplaces(organizationId: PluginRow["organizationId"], pluginIds: PluginId[]): Promise<Map<string, PluginMarketplaceSummary[]>> {
  const byPlugin = new Map<string, PluginMarketplaceSummary[]>()
  if (pluginIds.length === 0) {
    return byPlugin
  }

  const rows = await db
    .select({
      marketplaceId: MarketplaceTable.id,
      marketplaceName: MarketplaceTable.name,
      pluginId: MarketplacePluginTable.pluginId,
    })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      isNull(MarketplacePluginTable.removedAt),
      isNull(MarketplaceTable.deletedAt),
      inArray(MarketplacePluginTable.pluginId, pluginIds),
    ))

  for (const row of rows) {
    const existing = byPlugin.get(row.pluginId) ?? []
    existing.push({ id: row.marketplaceId, name: row.marketplaceName })
    byPlugin.set(row.pluginId, existing)
  }
  return byPlugin
}

async function countPluginMemberships(pluginIds: PluginId[]) {
  const counts = new Map<PluginId, number>()
  if (pluginIds.length === 0) {
    return counts
  }

  const rows = await db
    .select({ pluginId: PluginConfigObjectTable.pluginId, count: count() })
    .from(PluginConfigObjectTable)
    .where(and(inArray(PluginConfigObjectTable.pluginId, pluginIds), isNull(PluginConfigObjectTable.removedAt)))
    .groupBy(PluginConfigObjectTable.pluginId)
  for (const row of rows) counts.set(row.pluginId, row.count)
  return counts
}

async function listActivePluginAccessGrants(organizationId: PluginRow["organizationId"], pluginIds: PluginId[]) {
  const byPlugin = new Map<PluginId, ReturnType<typeof serializeAccessGrant>[]>()
  if (pluginIds.length === 0) {
    return byPlugin
  }

  const rows = await db
    .select()
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, organizationId),
      inArray(PluginAccessGrantTable.pluginId, pluginIds),
      isNull(PluginAccessGrantTable.removedAt),
    ))
    .orderBy(desc(PluginAccessGrantTable.createdAt))
  for (const row of rows) {
    const existing = byPlugin.get(row.pluginId) ?? []
    existing.push(serializeAccessGrant(row))
    byPlugin.set(row.pluginId, existing)
  }
  return byPlugin
}

function pluginAudienceCondition(organizationId: OrganizationId, memberId?: MemberId, teamId?: TeamId | SQL): SQL {
  const grantAudience = (orgWide: typeof PluginAccessGrantTable.orgWide | typeof MarketplaceAccessGrantTable.orgWide, grantMember: typeof PluginAccessGrantTable.orgMembershipId | typeof MarketplaceAccessGrantTable.orgMembershipId, grantTeam: typeof PluginAccessGrantTable.teamId | typeof MarketplaceAccessGrantTable.teamId) => {
    if (memberId) {
      return sql`(${orgWide} = true OR ${grantMember} = ${memberId} OR ${grantTeam} IN (
        SELECT ${TeamMemberTable.teamId} FROM ${TeamMemberTable}
        INNER JOIN ${TeamTable} ON ${TeamTable.id} = ${TeamMemberTable.teamId}
        WHERE ${TeamMemberTable.orgMembershipId} = ${memberId} AND ${TeamTable.organizationId} = ${organizationId}
      ))`
    }
    return sql`(${orgWide} = true OR ${grantTeam} = ${teamId})`
  }
  return sql`(
    ${memberId ? sql`${PluginTable.createdByOrgMembershipId} = ${memberId} OR` : sql``}
    EXISTS (SELECT 1 FROM ${PluginAccessGrantTable}
      WHERE ${PluginAccessGrantTable.pluginId} = ${PluginTable.id}
        AND ${PluginAccessGrantTable.organizationId} = ${organizationId}
        AND ${PluginAccessGrantTable.removedAt} IS NULL
        AND ${grantAudience(PluginAccessGrantTable.orgWide, PluginAccessGrantTable.orgMembershipId, PluginAccessGrantTable.teamId)})
    OR EXISTS (SELECT 1 FROM ${MarketplacePluginTable}
      INNER JOIN ${MarketplaceTable} ON ${MarketplaceTable.id} = ${MarketplacePluginTable.marketplaceId}
      INNER JOIN ${MarketplaceAccessGrantTable} ON ${MarketplaceAccessGrantTable.marketplaceId} = ${MarketplacePluginTable.marketplaceId}
      WHERE ${MarketplacePluginTable.pluginId} = ${PluginTable.id}
        AND ${MarketplacePluginTable.organizationId} = ${organizationId}
        AND ${MarketplacePluginTable.removedAt} IS NULL
        AND ${MarketplaceTable.organizationId} = ${organizationId}
        AND ${MarketplaceAccessGrantTable.organizationId} = ${organizationId}
        AND ${MarketplaceAccessGrantTable.removedAt} IS NULL
        AND ${grantAudience(MarketplaceAccessGrantTable.orgWide, MarketplaceAccessGrantTable.orgMembershipId, MarketplaceAccessGrantTable.teamId)})
  )`
}

export async function listPlugins(input: { context: PluginArchActorContext; cursor?: KeysetCursor; includeAccess?: boolean; includeTotal?: boolean; includeFacets?: boolean; limit?: number; q?: string; name?: string; status?: PluginRow["status"]; teamId?: TeamId; memberId?: MemberId; ownerId?: MemberId }) {
  const organizationId = input.context.organizationContext.organization.id
  const limit = input.limit ?? 50
  const [targetMember] = input.memberId ? await db.select({ role: MemberTable.role, userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt),
  )).limit(1) : []
  const [targetTeam] = input.teamId ? await db.select({ id: TeamTable.id }).from(TeamTable).where(and(
    eq(TeamTable.id, input.teamId), eq(TeamTable.organizationId, organizationId),
  )).limit(1) : []
  if ((input.memberId && !targetMember) || (input.teamId && !targetTeam)) return { items: [], nextCursor: null, ...(input.includeTotal ? { total: 0 } : {}) }
  const effectiveMember = input.memberId && targetMember?.userId && !roleIncludesOwner(targetMember.role) && !memberHasRole(targetMember.role, "admin")
    ? await resolveOrganizationMemberAuthority({ organizationId, memberId: input.memberId })
    : null
  const adminAudience = targetMember && (roleIncludesOwner(targetMember.role) || memberHasRole(targetMember.role, "admin") || (effectiveMember ? memberHasRole(effectiveMember.role, "admin") : false))
  const audience = adminAudience ? undefined : input.memberId || input.teamId
    ? pluginAudienceCondition(organizationId, input.memberId, input.teamId)
    : undefined
  const caller = isPluginArchOrgAdmin(input.context)
    ? undefined
    : pluginAudienceCondition(organizationId, input.context.organizationContext.currentMember.id)
  const baseFilters = and(
    eq(PluginTable.organizationId, organizationId),
    input.status ? eq(PluginTable.status, input.status) : undefined,
    input.q ? sql`(INSTR(LOWER(${PluginTable.name}), LOWER(${input.q})) > 0 OR INSTR(LOWER(COALESCE(${PluginTable.description}, '')), LOWER(${input.q})) > 0)` : undefined,
    input.name ? sql`INSTR(LOWER(${PluginTable.name}), LOWER(${input.name})) > 0` : undefined,
    caller,
  )
  const ownerFilter = input.ownerId ? eq(PluginTable.createdByOrgMembershipId, input.ownerId) : undefined
  const filters = and(baseFilters, audience, ownerFilter)
  const [rows, totalRows, teamCounts, ownerCounts] = await Promise.all([
    db.select().from(PluginTable)
      .where(and(filters, input.cursor ? keysetAfter({ at: PluginTable.updatedAt, id: PluginTable.id }, input.cursor) : undefined))
      .orderBy(desc(PluginTable.updatedAt), desc(PluginTable.id))
      .limit(limit + 1),
    input.includeTotal ? db.select({ total: count() }).from(PluginTable).where(filters) : Promise.resolve([]),
    input.includeFacets ? db.select({ id: TeamTable.id, count: count(PluginTable.id) }).from(TeamTable)
      .leftJoin(PluginTable, and(baseFilters, ownerFilter, pluginAudienceCondition(organizationId, undefined, sql`${TeamTable.id}`)))
      .where(eq(TeamTable.organizationId, organizationId)).groupBy(TeamTable.id) : Promise.resolve([]),
    input.includeFacets ? db.select({ id: PluginTable.createdByOrgMembershipId, count: count() }).from(PluginTable)
      .where(and(baseFilters, audience)).groupBy(PluginTable.createdByOrgMembershipId) : Promise.resolve([]),
  ])
  const page = keysetPage(rows, limit, (row) => ({ at: row.updatedAt, id: row.id }))
  const pageIds = page.items.map((row) => row.id)
  const roles = await resolvePluginArchPluginRoles(input.context, pageIds)
  const managedIds = pageIds.filter((pluginId) => roles.get(pluginId) === "manager")

  const [counts, marketplaceMembers, access] = await Promise.all([
    countPluginMemberships(pageIds),
    collectPluginMarketplaces(organizationId, pageIds),
    input.includeAccess ? listActivePluginAccessGrants(organizationId, managedIds) : null,
  ])

  return {
    items: page.items.map((row) => {
      const plugin = serializePlugin(row, counts.get(row.id) ?? 0, marketplaceMembers.get(row.id) ?? [])
      return access && roles.get(row.id) === "manager" ? { ...plugin, access: access.get(row.id) ?? [] } : plugin
    }),
    nextCursor: page.nextCursor,
    ...(input.includeTotal ? { total: totalRows[0]?.total ?? 0 } : {}),
    ...(input.includeFacets ? { teamCounts, ownerCounts } : {}),
  }
}

export async function getPluginDetail(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await ensureVisiblePlugin(context, pluginId)
  const memberships = await db.select({ id: PluginConfigObjectTable.id }).from(PluginConfigObjectTable).where(and(eq(PluginConfigObjectTable.pluginId, row.id), isNull(PluginConfigObjectTable.removedAt)))
  const marketplaceMembers = await collectPluginMarketplaces(context.organizationContext.organization.id, [row.id])
  return serializePlugin(row, memberships.length, marketplaceMembers.get(row.id) ?? [])
}

export async function createPlugin(input: {
  context: PluginArchActorContext
  description?: string | null
  name: string
  sourceFormat?: string | null
  sourceRepositoryUrl?: string | null
  sourceSchemaVersion?: string | null
}) {
  const now = new Date()
  const name = input.name.trim()
  const existing = await db
    .select({ id: PluginTable.id })
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, input.context.organizationContext.organization.id),
      eq(PluginTable.createdByOrgMembershipId, input.context.organizationContext.currentMember.id),
      eq(PluginTable.name, name),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
    .orderBy(asc(PluginTable.createdAt), asc(PluginTable.id))
    .limit(1)

  if (existing[0]) {
    throw new PluginArchRouteFailure(409, "duplicate_plugin", `You already have an active plugin named "${name}" (${existing[0].id}). Update it instead of creating a duplicate.`)
  }

  const row = {
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    deletedAt: null,
    description: normalizeOptionalString(input.description ?? undefined),
    id: createDenTypeId("plugin"),
    name,
    organizationId: input.context.organizationContext.organization.id,
    sourceFormat: normalizeOptionalString(input.sourceFormat ?? undefined),
    sourceRepositoryUrl: normalizeOptionalString(input.sourceRepositoryUrl ?? undefined),
    sourceSchemaVersion: normalizeOptionalString(input.sourceSchemaVersion ?? undefined),
    status: "active" as const,
    updatedAt: now,
  }

  await db.transaction(async (tx) => {
    await tx.insert(PluginTable).values(row)
    await tx.insert(PluginAccessGrantTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: createDenTypeId("pluginAccessGrant"),
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      pluginId: row.id,
      role: "manager",
      teamId: null,
    })
  })

  return serializePlugin(row, 0)
}

function pluginMcpConnectionSetupInput(setup: PluginMcpConnectionSetup) {
  return {
    apiKey: setup.apiKey,
    authType: setup.authType,
    credentialMode: setup.credentialMode ?? (setup.authType === "oauth" ? "per_member" : "shared"),
    oauthClient: setup.oauthClient,
  }
}

/**
 * A plugin whose inline MCP connection setup failed must not survive as an
 * active plugin with a half-configured server: the creator would see the
 * failure, fix the credentials, and then hit a duplicate-name conflict on
 * retry. Mirror the GitHub import path instead — drop the bindings and the
 * connections this attempt created, then archive the plugin.
 */
async function rollbackPluginMcpConnectionSetup(input: { context: PluginArchActorContext; pluginId: PluginId }) {
  const organizationId = input.context.organizationContext.organization.id
  const bindings = await pluginMcpRequirementBindingsForResource({ organizationId, resourceId: input.pluginId, resourceKind: "plugin" }).catch(() => [])
  await deletePluginMcpRequirementBindingsForPlugin({ organizationId, pluginId: input.pluginId }).catch(() => undefined)
  for (const binding of bindings) {
    if (!binding.connectionOwnedByPlugin) continue
    await deleteExternalMcpConnectionIfUnreferenced({ connectionId: binding.externalMcpConnectionId, organizationId }).catch(() => undefined)
  }
  await setPluginLifecycle({ action: "archive", context: input.context, pluginId: input.pluginId }).catch(() => undefined)
}

export async function createPluginBundle(input: {
  components?: { connection?: PluginMcpConnectionSetup; connectionId?: string; type: ConfigObjectRow["objectType"]; value?: ConfigObjectInput }[]
  context: PluginArchActorContext
  description?: string | null
  marketplaceId?: MarketplaceId
  name: string
  orgWide?: boolean
  sourceRepositoryUrl?: string | null
}) {
  if (input.orgWide === true && !isPluginArchOrgAdmin(input.context)) {
    throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can create org-wide plugins.")
  }

  const components: Array<{
    connection?: PluginMcpConnectionSetup
    connectionBinding?: { connection: ExternalMcpConnectionRow; serverName: string }
    type: ConfigObjectRow["objectType"]
    value: ConfigObjectInput
  }> = []
  for (const component of input.components ?? []) {
    if (component.value) rejectAuthoredMcpAppWrite(component.value)
    if (component.connectionId !== undefined) {
      if (component.type !== "mcp") {
        throw new PluginArchRouteFailure(400, "invalid_request", "connectionId is only allowed on mcp components.")
      }
      if (component.connection) {
        throw new PluginArchRouteFailure(400, "invalid_request", "Provide either connection or connectionId, not both.")
      }
      let connectionId: ExternalMcpConnectionRow["id"]
      try {
        connectionId = normalizeDenTypeId("externalMcpConnection", component.connectionId)
      } catch {
        throw new PluginArchRouteFailure(404, "mcp_connection_not_found", "That connector was not found in this organization.")
      }
      const connection = await getExternalMcpConnection({
        connectionId,
        organizationId: input.context.organizationContext.organization.id,
      })
      if (!connection || connection.kind !== "external_mcp") {
        throw new PluginArchRouteFailure(404, "mcp_connection_not_found", "That connector was not found in this organization.")
      }
      // Members bundle only connectors they added themselves from My Library.
      if (!isPluginArchOrgAdmin(input.context) && connection.createdByOrgMembershipId !== input.context.organizationContext.currentMember.id) {
        throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can bind plugin MCP servers to organization connections.")
      }
      const value: ConfigObjectInput = {
        normalizedPayloadJson: connectionBackedMcpPayload({
          authType: connection.authType,
          connectionId: connection.id,
          ownedByPlugin: false,
          server: { name: connection.name, url: connection.url },
        }),
        metadata: {
          name: component.value?.metadata?.name ?? connection.name,
          description: component.value?.metadata?.description,
        },
      }
      deriveProjection({ objectType: component.type, value })
      components.push({
        connectionBinding: { connection, serverName: slugifyPluginMcpName(connection.name) },
        type: component.type,
        value,
      })
      continue
    }
    if (!component.value) {
      throw new PluginArchRouteFailure(400, "invalid_request", "input is required unless connectionId is provided.")
    }
    deriveProjection({ objectType: component.type, value: component.value })
    if (component.connection) {
      if (!isPluginArchOrgAdmin(input.context)) {
        throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can configure plugin MCP connections.")
      }
      validatePluginMcpRequirementAuth(pluginMcpConnectionSetupInput(component.connection))
    }
    components.push({ connection: component.connection, type: component.type, value: component.value })
  }

  if (input.marketplaceId) {
    // Validate the publish target before creating anything so a bad marketplace cannot leave an orphan plugin.
    await ensureEditableMarketplace(input.context, input.marketplaceId)
  }

  const plugin = await createPlugin({ context: input.context, description: input.description, name: input.name, sourceRepositoryUrl: input.sourceRepositoryUrl })

  const pendingConnections: Array<{ configObjectId: ConfigObjectId; connection: PluginMcpConnectionSetup; serverNames: string[] }> = []
  const pendingConnectionBindings: Array<{ configObjectId: ConfigObjectId; connection: ExternalMcpConnectionRow; serverName: string }> = []
  for (const component of components) {
    const configObject = await createConfigObject({
      context: input.context,
      objectType: component.type,
      pluginIds: [plugin.id],
      sourceMode: "cloud",
      value: component.value,
    })
    if (input.orgWide) {
      await createResourceAccessGrant({
        context: input.context,
        resourceId: configObject.id,
        resourceKind: "config_object",
        value: { orgWide: true, role: "viewer" },
      })
    }
    if (component.connection) {
      pendingConnections.push({
        configObjectId: configObject.id,
        connection: component.connection,
        serverNames: marketplaceMcpServerEntries(parseConfigObjectInputSpec(component.value), configObject.title).map((entry) => entry.name),
      })
    }
    if (component.connectionBinding) {
      pendingConnectionBindings.push({ configObjectId: configObject.id, ...component.connectionBinding })
    }
  }

  if (input.orgWide) {
    await createResourceAccessGrant({
      context: input.context,
      resourceId: plugin.id,
      resourceKind: "plugin",
      value: { orgWide: true, role: "viewer" },
    })
  }

  if (input.marketplaceId) {
    await attachPluginToMarketplace({ context: input.context, marketplaceId: input.marketplaceId, pluginId: plugin.id })
  }

  // Grants and the collection are in place, so the derived connection access
  // is complete the moment each server is configured.
  try {
    for (const pending of pendingConnections) {
      for (const serverName of pending.serverNames) {
        await configureMarketplacePluginMcpRequirement({
          ...pluginMcpConnectionSetupInput(pending.connection),
          configObjectId: pending.configObjectId,
          context: input.context,
          pluginId: plugin.id,
          serverName,
        })
      }
    }
    for (const pending of pendingConnectionBindings) {
      const binding = await upsertPluginMcpRequirementBinding({
        configObjectId: pending.configObjectId,
        createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
        externalMcpConnectionId: pending.connection.id,
        organizationId: input.context.organizationContext.organization.id,
        pluginId: plugin.id,
        serverName: pending.serverName,
        requiredAuthType: pending.connection.authType,
        connectionOwnedByPlugin: false,
      })
      await syncPluginMcpRequirementBindingAccess(binding)
    }
  } catch (error) {
    await rollbackPluginMcpConnectionSetup({ context: input.context, pluginId: plugin.id })
    throw error
  }

  return getPluginDetail(input.context, plugin.id)
}

export async function updatePlugin(input: { context: PluginArchActorContext; description?: string | null; name?: string; pluginId: PluginId }) {
  const row = await ensureEditablePlugin(input.context, input.pluginId)
  const updatedAt = new Date()
  await db.update(PluginTable).set({
    description: input.description === undefined ? row.description : normalizeOptionalString(input.description ?? undefined),
    name: input.name?.trim() || row.name,
    updatedAt,
  }).where(eq(PluginTable.id, row.id))
  return getPluginDetail(input.context, row.id)
}

export async function setPluginLifecycle(input: { action: "archive" | "restore"; context: PluginArchActorContext; pluginId: PluginId }) {
  const row = await ensureVisiblePlugin(input.context, input.pluginId)
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "plugin", role: "manager" })
  const updatedAt = new Date()
  await db.update(PluginTable).set({
    deletedAt: input.action === "archive" ? row.deletedAt : null,
    status: input.action === "archive" ? "archived" : "active",
    updatedAt,
  }).where(eq(PluginTable.id, row.id))
  await syncPluginMcpRequirementAccessForResource({
    context: input.context,
    resourceId: row.id,
    resourceKind: "plugin",
  })
  return getPluginDetail(input.context, row.id)
}

export async function listPluginMemberships(input: { context: PluginArchActorContext; pluginId: PluginId; includeConfigObjects?: boolean; legacyWorkflowObjectType?: boolean; onlyActive?: boolean }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  const memberships = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(input.onlyActive ? and(eq(PluginConfigObjectTable.pluginId, input.pluginId), isNull(PluginConfigObjectTable.removedAt)) : eq(PluginConfigObjectTable.pluginId, input.pluginId))
    .orderBy(desc(PluginConfigObjectTable.createdAt))

  if (!input.includeConfigObjects) {
    return { items: memberships.map((membership) => serializeMembership(membership)), nextCursor: null }
  }

  const configObjects = await db.select().from(ConfigObjectTable).where(inArray(ConfigObjectTable.id, memberships.map((membership) => membership.configObjectId)))
  const resolvedConfigObjects = input.onlyActive
    ? configObjects.filter((row) => row.status === "active" && row.deletedAt === null)
    : configObjects
  const resolvedConfigObjectIds = new Set(resolvedConfigObjects.map((row) => row.id))
  const resolvedMemberships = input.onlyActive
    ? memberships.filter((membership) => resolvedConfigObjectIds.has(membership.configObjectId))
    : memberships
  const latestVersions = await getLatestVersions(resolvedConfigObjects.map((row) => row.id))
  const byId = new Map<string, ReturnType<typeof serializeConfigObject>>(resolvedConfigObjects.map((row) => {
    const serialized = serializeConfigObject(row, latestVersions.get(row.id) ?? null)
    return [row.id, input.legacyWorkflowObjectType && serialized.objectType === "workflow"
      ? { ...serialized, objectType: "script" }
      : serialized]
  }))
  return { items: resolvedMemberships.map((membership) => serializeMembership(membership, byId.get(membership.configObjectId))), nextCursor: null }
}

export async function addPluginMembership(input: { configObjectId: ConfigObjectId; context: PluginArchActorContext; membershipSource?: PluginMembershipRow["membershipSource"]; pluginId: PluginId }) {
  return attachConfigObjectToPlugin({ ...input })
}

export async function removePluginMembership(input: { configObjectId: ConfigObjectId; context: PluginArchActorContext; pluginId: PluginId }) {
  return removeConfigObjectFromPlugin(input)
}

export async function listMarketplaces(input: { context: PluginArchActorContext; cursor?: string; limit?: number; q?: string; status?: MarketplaceRow["status"] }) {
  await ensureDefaultOpenWorkMarketplace(input.context)

  const rows = await db
    .select()
    .from(MarketplaceTable)
    .where(eq(MarketplaceTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(MarketplaceTable.updatedAt), desc(MarketplaceTable.id))

  const marketplaceIds = rows.map((row) => row.id)
  const memberships = marketplaceIds.length === 0
    ? []
    : await db
      .select({ marketplaceId: MarketplacePluginTable.marketplaceId, count: count() })
      .from(MarketplacePluginTable)
      .where(and(
        eq(MarketplacePluginTable.organizationId, input.context.organizationContext.organization.id),
        inArray(MarketplacePluginTable.marketplaceId, marketplaceIds),
        isNull(MarketplacePluginTable.removedAt),
      ))
      .groupBy(MarketplacePluginTable.marketplaceId)

  const counts = new Map<string, number>(memberships.map((row) => [row.marketplaceId, row.count]))

  const visible: ReturnType<typeof serializeMarketplace>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "marketplace" })
    if (!role) continue
    if (input.status && row.status !== input.status) continue
    if (input.q) {
      const haystack = `${row.name}\n${row.description ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    visible.push(serializeMarketplace(row, counts.get(row.id) ?? 0))
  }

  return pageItems(visible, input.cursor, input.limit)
}

async function ensureDefaultOpenWorkMarketplace(context: PluginArchActorContext) {
  const organizationId = context.organizationContext.organization.id
  if (await defaultOpenWorkMarketplaceSeedComplete(organizationId)) {
    return
  }

  await db.transaction(async (tx) => {
    const organization = (await tx
      .select({ id: OrganizationTable.id })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
      .for("update"))[0]
    if (!organization) throw new Error("Organization not found while provisioning default marketplaces.")

    const now = new Date()
    await retireStarterPlaceholders({ database: tx, organizationId, retiredAt: now })
    await retireDefaultOpenWorkPlugins({ database: tx, organizationId, retiredAt: now })

    const marketplace = await ensureDefaultMarketplace({
      context,
      createdAt: now,
      database: tx,
      description: DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
      logoUrl: DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
      name: DEFAULT_OPENWORK_MARKETPLACE_NAME,
    })
    await ensureDefaultMarketplacePlugins({
      context,
      createdAt: now,
      database: tx,
      entries: DEFAULT_OPENWORK_EXTENSION_MANIFESTS.map((manifest) => ({ description: manifest.description, name: manifest.name })),
      marketplaceId: marketplace.id,
    })
  })
}

async function defaultOpenWorkMarketplaceSeedComplete(organizationId: OrganizationId) {
  const retirable = await findRetirableStarterPlaceholders(db, organizationId)
  if (retirable.memberships.length > 0 || retirable.emptyMarketplaceIds.length > 0) {
    return false
  }
  if ((await findRetirableDefaultOpenWorkPluginIds(db, organizationId)).length > 0) {
    return false
  }

  const defaultMarketplaces = await db
    .select({ id: MarketplaceTable.id, logoUrl: MarketplaceTable.logoUrl, name: MarketplaceTable.name })
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.name, DEFAULT_OPENWORK_MARKETPLACE_NAME),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
  const openWorkMarketplaceId = defaultMarketplaces.find((marketplace) => marketplace.logoUrl === DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL)?.id
  if (!openWorkMarketplaceId) {
    return false
  }

  const marketplaceIds = [openWorkMarketplaceId]
  const marketplaceGrantRows = await db
    .select({ marketplaceId: MarketplaceAccessGrantTable.marketplaceId, role: MarketplaceAccessGrantTable.role })
    .from(MarketplaceAccessGrantTable)
    .where(and(
      eq(MarketplaceAccessGrantTable.organizationId, organizationId),
      inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
      eq(MarketplaceAccessGrantTable.orgWide, true),
      eq(MarketplaceAccessGrantTable.role, "viewer"),
      isNull(MarketplaceAccessGrantTable.removedAt),
    ))
  const marketplaceGrants = new Set(marketplaceGrantRows.map((grant) => grant.marketplaceId))
  if (!marketplaceIds.every((marketplaceId) => marketplaceGrants.has(marketplaceId))) {
    return false
  }

  const defaultPluginEntries = DEFAULT_OPENWORK_EXTENSION_MANIFESTS.map((manifest) => ({ description: manifest.description, name: manifest.name }))
  const defaultPluginRows = await db
    .select({ id: PluginTable.id, name: PluginTable.name, description: PluginTable.description })
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, organizationId),
      inArray(PluginTable.name, defaultPluginEntries.map((entry) => entry.name)),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))

  const pluginIdByEntry = new Map<string, PluginId>()
  for (const entry of defaultPluginEntries) {
    const plugin = defaultPluginRows.find((row) => row.name === entry.name && row.description === entry.description)
    if (!plugin) {
      return false
    }
    pluginIdByEntry.set(defaultMarketplacePluginEntryKey(entry), plugin.id)
  }

  const pluginIds = Array.from(pluginIdByEntry.values())
  const pluginGrantRows = await db
    .select({ pluginId: PluginAccessGrantTable.pluginId })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, organizationId),
      inArray(PluginAccessGrantTable.pluginId, pluginIds),
      eq(PluginAccessGrantTable.orgWide, true),
      eq(PluginAccessGrantTable.role, "viewer"),
      isNull(PluginAccessGrantTable.removedAt),
    ))
  const pluginGrants = new Set(pluginGrantRows.map((grant) => grant.pluginId))
  if (!pluginIds.every((pluginId) => pluginGrants.has(pluginId))) {
    return false
  }

  const expectedMemberships = new Set<string>()
  for (const entry of defaultPluginEntries) {
    const pluginId = pluginIdByEntry.get(defaultMarketplacePluginEntryKey(entry))
    if (pluginId) expectedMemberships.add(defaultMarketplacePluginMembershipKey(openWorkMarketplaceId, pluginId))
  }

  const membershipRows = await db
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId, pluginId: MarketplacePluginTable.pluginId })
    .from(MarketplacePluginTable)
    .where(and(
      eq(MarketplacePluginTable.organizationId, organizationId),
      inArray(MarketplacePluginTable.marketplaceId, marketplaceIds),
      inArray(MarketplacePluginTable.pluginId, pluginIds),
      isNull(MarketplacePluginTable.removedAt),
    ))
  const memberships = new Set(membershipRows.map((membership) => defaultMarketplacePluginMembershipKey(membership.marketplaceId, membership.pluginId)))
  return Array.from(expectedMemberships).every((membership) => memberships.has(membership))
}

/**
 * Starter placeholders are plugins the system put into the retired starter
 * marketplace that never gained a source or any contents. Anything imported,
 * filled in, or added by a person stays.
 */
async function findRetirableStarterPlaceholders(database: typeof db | DbTransaction, organizationId: OrganizationId) {
  const starterMarketplaces = await database
    .select({ description: MarketplaceTable.description, id: MarketplaceTable.id, logoUrl: MarketplaceTable.logoUrl })
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.name, RETIRED_STARTER_MARKETPLACE_NAME),
      isNull(MarketplaceTable.deletedAt),
    ))
  if (starterMarketplaces.length === 0) {
    return { emptyMarketplaceIds: [], memberships: [] }
  }
  const starterMarketplaceIds = starterMarketplaces.map((marketplace) => marketplace.id)

  const memberships = await database
    .select({ id: MarketplacePluginTable.id, pluginId: PluginTable.id })
    .from(MarketplacePluginTable)
    .innerJoin(PluginTable, eq(PluginTable.id, MarketplacePluginTable.pluginId))
    .where(and(
      eq(MarketplacePluginTable.organizationId, organizationId),
      inArray(MarketplacePluginTable.marketplaceId, starterMarketplaceIds),
      eq(MarketplacePluginTable.membershipSource, "system"),
      isNull(MarketplacePluginTable.removedAt),
      eq(PluginTable.organizationId, organizationId),
      inArray(PluginTable.name, [...RETIRED_STARTER_PLUGIN_NAMES]),
      isNull(PluginTable.sourceFormat),
      isNull(PluginTable.sourceRepositoryUrl),
      isNull(PluginTable.deletedAt),
      notExists(database
        .select({ id: PluginConfigObjectTable.id })
        .from(PluginConfigObjectTable)
        .where(and(
          eq(PluginConfigObjectTable.pluginId, PluginTable.id),
          isNull(PluginConfigObjectTable.removedAt),
        ))),
    ))

  // Only the untouched starter marketplace goes, and only once nothing else is in it.
  const untouchedMarketplaceIds = starterMarketplaces
    .filter((marketplace) => marketplace.logoUrl === RETIRED_STARTER_MARKETPLACE_LOGO_URL && marketplace.description === RETIRED_STARTER_MARKETPLACE_DESCRIPTION)
    .map((marketplace) => marketplace.id)
  if (untouchedMarketplaceIds.length === 0) {
    return { emptyMarketplaceIds: [], memberships }
  }
  const activeMemberships = await database
    .select({ id: MarketplacePluginTable.id, marketplaceId: MarketplacePluginTable.marketplaceId })
    .from(MarketplacePluginTable)
    .where(and(
      eq(MarketplacePluginTable.organizationId, organizationId),
      inArray(MarketplacePluginTable.marketplaceId, untouchedMarketplaceIds),
      isNull(MarketplacePluginTable.removedAt),
    ))
  const retiringMembershipIds = new Set(memberships.map((membership) => membership.id))
  const keptMarketplaceIds = new Set(activeMemberships
    .filter((membership) => !retiringMembershipIds.has(membership.id))
    .map((membership) => membership.marketplaceId))
  const emptyMarketplaceIds = untouchedMarketplaceIds.filter((marketplaceId) => !keptMarketplaceIds.has(marketplaceId))

  return { emptyMarketplaceIds, memberships }
}

async function retireStarterPlaceholders(input: { database: DbTransaction; organizationId: OrganizationId; retiredAt: Date }) {
  const { emptyMarketplaceIds, memberships } = await findRetirableStarterPlaceholders(input.database, input.organizationId)
  if (memberships.length > 0) {
    await input.database.update(MarketplacePluginTable)
      .set({ removedAt: input.retiredAt })
      .where(inArray(MarketplacePluginTable.id, memberships.map((membership) => membership.id)))
    await input.database.update(PluginTable)
      .set({ deletedAt: input.retiredAt, status: "deleted", updatedAt: input.retiredAt })
      .where(inArray(PluginTable.id, uniqueIds(memberships.map((membership) => membership.pluginId))))
  }
  if (emptyMarketplaceIds.length > 0) {
    await input.database.update(MarketplaceTable)
      .set({ deletedAt: input.retiredAt, status: "deleted", updatedAt: input.retiredAt })
      .where(inArray(MarketplaceTable.id, emptyMarketplaceIds))
  }
}

/**
 * Retired built-in plugins are retired only while they are still the untouched
 * system seed: no source, no contents. Anything imported or filled in stays.
 */
async function findRetirableDefaultOpenWorkPluginIds(database: typeof db | DbTransaction, organizationId: OrganizationId) {
  if (RETIRED_DEFAULT_OPENWORK_PLUGINS.length === 0) return []
  const rows = await database
    .select({ description: PluginTable.description, id: PluginTable.id, name: PluginTable.name })
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, organizationId),
      inArray(PluginTable.name, RETIRED_DEFAULT_OPENWORK_PLUGINS.map((entry) => entry.name)),
      isNull(PluginTable.sourceFormat),
      isNull(PluginTable.sourceRepositoryUrl),
      isNull(PluginTable.deletedAt),
      notExists(database
        .select({ id: PluginConfigObjectTable.id })
        .from(PluginConfigObjectTable)
        .where(and(
          eq(PluginConfigObjectTable.pluginId, PluginTable.id),
          isNull(PluginConfigObjectTable.removedAt),
        ))),
    ))
  return rows
    .filter((row) => RETIRED_DEFAULT_OPENWORK_PLUGINS.some((entry) => entry.name === row.name && entry.description === row.description))
    .map((row) => row.id)
}

async function retireDefaultOpenWorkPlugins(input: { database: DbTransaction; organizationId: OrganizationId; retiredAt: Date }) {
  const pluginIds = await findRetirableDefaultOpenWorkPluginIds(input.database, input.organizationId)
  if (pluginIds.length === 0) return
  await input.database.update(MarketplacePluginTable)
    .set({ removedAt: input.retiredAt })
    .where(and(
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      inArray(MarketplacePluginTable.pluginId, pluginIds),
      isNull(MarketplacePluginTable.removedAt),
    ))
  await input.database.update(PluginTable)
    .set({ deletedAt: input.retiredAt, status: "deleted", updatedAt: input.retiredAt })
    .where(inArray(PluginTable.id, pluginIds))
}

function defaultMarketplacePluginEntryKey(entry: DefaultMarketplacePluginEntry) {
  return `${entry.name}\n${entry.description}`
}

function defaultMarketplacePluginMembershipKey(marketplaceId: MarketplaceId, pluginId: PluginId) {
  return `${marketplaceId}:${pluginId}`
}

async function ensureDefaultMarketplacePlugins(input: {
  context: PluginArchActorContext
  createdAt: Date
  database: DbTransaction
  entries: DefaultMarketplacePluginEntry[]
  marketplaceId: MarketplaceId
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id

  for (const entry of input.entries) {
    let plugin = (await input.database
      .select()
      .from(PluginTable)
      .where(and(
        eq(PluginTable.organizationId, organizationId),
        eq(PluginTable.name, entry.name),
        eq(PluginTable.description, entry.description),
        isNull(PluginTable.deletedAt),
      ))
      .limit(1))[0]

    if (!plugin) {
      const pluginRow = {
        createdAt: input.createdAt,
        createdByOrgMembershipId,
        deletedAt: null,
        description: entry.description,
        id: createDenTypeId("plugin"),
        name: entry.name,
        organizationId,
        sourceFormat: null,
        sourceRepositoryUrl: null,
        sourceSchemaVersion: null,
        status: "active" as const,
        updatedAt: input.createdAt,
      }
      await input.database.insert(PluginTable).values(pluginRow)
      plugin = pluginRow
    }

    await ensureOrgWidePluginAccess({ context: input.context, database: input.database, pluginId: plugin.id, role: "viewer" })

    const existingMembership = (await input.database
      .select()
      .from(MarketplacePluginTable)
      .where(and(
        eq(MarketplacePluginTable.marketplaceId, input.marketplaceId),
        eq(MarketplacePluginTable.pluginId, plugin.id),
      ))
      .limit(1))[0]

    if (existingMembership) {
      if (existingMembership.removedAt) {
        await input.database.update(MarketplacePluginTable).set({ membershipSource: "system", removedAt: null }).where(eq(MarketplacePluginTable.id, existingMembership.id))
      }
      continue
    }

    await input.database.insert(MarketplacePluginTable).values({
      createdAt: input.createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("marketplacePlugin"),
      marketplaceId: input.marketplaceId,
      membershipSource: "system",
      organizationId,
      pluginId: plugin.id,
      removedAt: null,
    })
  }
}

async function ensureDefaultMarketplace(input: {
  context: PluginArchActorContext
  createdAt: Date
  database: DbTransaction
  description: string
  logoUrl: string
  name: string
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id

  let marketplace = (await input.database
    .select()
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.name, input.name),
      isNull(MarketplaceTable.deletedAt),
    ))
    .limit(1))[0]

  if (!marketplace) {
    const marketplaceRow = {
      externalKey: null,
      createdAt: input.createdAt,
      createdByOrgMembershipId,
      deletedAt: null,
      description: input.description,
      id: createDenTypeId("marketplace"),
      logoUrl: input.logoUrl,
      name: input.name,
      organizationId,
      status: "active" as const,
      updatedAt: input.createdAt,
    }
    await input.database.insert(MarketplaceTable).values(marketplaceRow)
    marketplace = marketplaceRow
  } else if (!marketplace.logoUrl) {
    await input.database.update(MarketplaceTable).set({ logoUrl: input.logoUrl }).where(eq(MarketplaceTable.id, marketplace.id))
    marketplace = { ...marketplace, logoUrl: input.logoUrl }
  }

  await ensureOrgWideMarketplaceAccess({ context: input.context, database: input.database, marketplaceId: marketplace.id, role: "viewer" })
  return marketplace
}

async function ensureOrgWideMarketplaceAccess(input: {
  context: PluginArchActorContext
  database: DbTransaction
  marketplaceId: MarketplaceId
  role: PluginArchRole
}) {
  const createdAt = new Date()
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id

  const existing = (await input.database
    .select()
    .from(MarketplaceAccessGrantTable)
    .where(and(eq(MarketplaceAccessGrantTable.marketplaceId, input.marketplaceId), eq(MarketplaceAccessGrantTable.orgWide, true)))
    .limit(1))[0]
  if (existing) {
    if (existing.removedAt || existing.role !== input.role) {
      await input.database.update(MarketplaceAccessGrantTable).set({ createdByOrgMembershipId, removedAt: null, role: input.role }).where(eq(MarketplaceAccessGrantTable.id, existing.id))
    }
    return
  }
  await input.database.insert(MarketplaceAccessGrantTable).values({
    createdAt,
    createdByOrgMembershipId,
    id: createDenTypeId("marketplaceAccessGrant"),
    marketplaceId: input.marketplaceId,
    organizationId,
    orgMembershipId: null,
    orgWide: true,
    role: input.role,
    teamId: null,
  })
}

async function ensureOrgWidePluginAccess(input: {
  context: PluginArchActorContext
  database: DbTransaction
  pluginId: PluginId
  role: PluginArchRole
}) {
  const createdAt = new Date()
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id

  const existing = (await input.database
    .select()
    .from(PluginAccessGrantTable)
    .where(and(eq(PluginAccessGrantTable.pluginId, input.pluginId), eq(PluginAccessGrantTable.orgWide, true)))
    .limit(1))[0]
  if (existing) {
    if (existing.removedAt || existing.role !== input.role) {
      await input.database.update(PluginAccessGrantTable).set({ createdByOrgMembershipId, removedAt: null, role: input.role }).where(eq(PluginAccessGrantTable.id, existing.id))
    }
    return
  }
  await input.database.insert(PluginAccessGrantTable).values({
    createdAt,
    createdByOrgMembershipId,
    id: createDenTypeId("pluginAccessGrant"),
    organizationId,
    orgMembershipId: null,
    orgWide: true,
    pluginId: input.pluginId,
    role: input.role,
    teamId: null,
  })
}

export async function getMarketplaceDetail(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await ensureVisibleMarketplace(context, marketplaceId)
  const memberships = await db
    .select({ id: MarketplacePluginTable.id })
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, row.id), isNull(MarketplacePluginTable.removedAt)))
  return serializeMarketplace(row, memberships.length)
}

export async function createMarketplace(input: { context: PluginArchActorContext; description?: string | null; logoUrl?: string | null; name: string; externalKey?: string }) {
  const now = new Date()
  const row = {
    externalKey: input.externalKey ?? null,
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    deletedAt: null,
    description: normalizeOptionalString(input.description ?? undefined),
    id: createDenTypeId("marketplace"),
    logoUrl: normalizeOptionalString(input.logoUrl ?? undefined),
    name: input.name.trim(),
    organizationId: input.context.organizationContext.organization.id,
    status: "active" as const,
    updatedAt: now,
  }

  await db.transaction(async (tx) => {
    await tx.insert(MarketplaceTable).values(row)
    await tx.insert(MarketplaceAccessGrantTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: createDenTypeId("marketplaceAccessGrant"),
      marketplaceId: row.id,
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      role: "manager",
      teamId: null,
    })
  })

  return serializeMarketplace(row, 0)
}

export async function updateMarketplace(input: { context: PluginArchActorContext; description?: string | null; logoUrl?: string | null; marketplaceId: MarketplaceId; name?: string }) {
  const row = await ensureEditableMarketplace(input.context, input.marketplaceId)
  const updatedAt = new Date()
  await db.update(MarketplaceTable).set({
    description: input.description === undefined ? row.description : normalizeOptionalString(input.description ?? undefined),
    logoUrl: input.logoUrl === undefined ? row.logoUrl : normalizeOptionalString(input.logoUrl ?? undefined),
    name: input.name?.trim() || row.name,
    updatedAt,
  }).where(eq(MarketplaceTable.id, row.id))
  return getMarketplaceDetail(input.context, row.id)
}

export async function setMarketplaceLifecycle(input: { action: "archive" | "delete" | "restore"; context: PluginArchActorContext; marketplaceId: MarketplaceId }) {
  const row = await ensureVisibleMarketplace(input.context, input.marketplaceId)
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "marketplace", role: "manager" })
  const updatedAt = new Date()
  if (input.action === "delete") {
    const memberships = await db
      .select()
      .from(MarketplacePluginTable)
      .where(eq(MarketplacePluginTable.marketplaceId, row.id))
    if (memberships.some((membership) => membership.removedAt === null && (membership.membershipSource === "system" || membership.membershipSource === "connector"))) {
      throw new PluginArchRouteFailure(409, "managed_marketplace_cannot_be_deleted", "Built-in and connected marketplaces cannot be deleted here.")
    }
    await db.transaction(async (tx) => {
      await tx.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.marketplaceId, row.id))
      await tx.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.marketplaceId, row.id))
      await tx.delete(MarketplaceTable).where(eq(MarketplaceTable.id, row.id))
    })
    for (const pluginId of new Set(memberships.map((membership) => membership.pluginId))) {
      await syncPluginMcpRequirementAccessForResource({ context: input.context, resourceId: pluginId, resourceKind: "plugin" })
    }
    return serializeMarketplace({ ...row, deletedAt: updatedAt, status: "deleted", updatedAt }, memberships.filter((membership) => membership.removedAt === null).length)
  }
  await db.transaction(async (tx) => {
    await tx.update(MarketplaceTable).set({
      deletedAt: input.action === "restore" ? null : row.deletedAt,
      status: input.action === "archive" ? "archived" : "active",
      updatedAt,
    }).where(eq(MarketplaceTable.id, row.id))
  })
  await syncPluginMcpRequirementAccessForResource({
    context: input.context,
    resourceId: row.id,
    resourceKind: "marketplace",
  })
  return getMarketplaceDetail(input.context, row.id)
}

export async function listMarketplaceMemberships(input: { context: PluginArchActorContext; includePlugins?: boolean; marketplaceId: MarketplaceId; onlyActive?: boolean }) {
  await ensureVisibleMarketplace(input.context, input.marketplaceId)
  const memberships = await db
    .select()
    .from(MarketplacePluginTable)
    .where(input.onlyActive ? and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), isNull(MarketplacePluginTable.removedAt)) : eq(MarketplacePluginTable.marketplaceId, input.marketplaceId))
    .orderBy(desc(MarketplacePluginTable.createdAt))

  if (!input.includePlugins) {
    return { items: memberships.map((membership) => serializeMarketplaceMembership(membership)), nextCursor: null }
  }

  const plugins = memberships.length === 0
    ? []
    : await db.select().from(PluginTable).where(inArray(PluginTable.id, memberships.map((membership) => membership.pluginId)))
  const byId = new Map<string, ReturnType<typeof serializePlugin>>(plugins.map((row) => [row.id, serializePlugin(row)]))
  return { items: memberships.map((membership) => serializeMarketplaceMembership(membership, byId.get(membership.pluginId))), nextCursor: null }
}

export type MarketplaceResolvedSource = {
  connectorAccountId: string
  connectorInstanceId: string
  accountLogin: string | null
  repositoryFullName: string
  branch: string | null
} | null

export async function getMarketplaceResolved(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId }) {
  const marketplaceRow = await ensureVisibleMarketplace(input.context, input.marketplaceId)
  const organizationId = input.context.organizationContext.organization.id

  const memberships = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, marketplaceRow.id), isNull(MarketplacePluginTable.removedAt)))
    .orderBy(desc(MarketplacePluginTable.createdAt))

  const pluginIds = memberships.map((membership) => membership.pluginId)
  const pluginRows = pluginIds.length === 0
    ? []
    : await db.select().from(PluginTable).where(inArray(PluginTable.id, pluginIds))

  const activePluginMemberships = pluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId, configObjectId: PluginConfigObjectTable.configObjectId })
      .from(PluginConfigObjectTable)
      .where(and(inArray(PluginConfigObjectTable.pluginId, pluginIds), isNull(PluginConfigObjectTable.removedAt)))
  const memberCounts = new Map<string, number>()
  for (const entry of activePluginMemberships) {
    memberCounts.set(entry.pluginId, (memberCounts.get(entry.pluginId) ?? 0) + 1)
  }

  const configObjectIds = [...new Set(activePluginMemberships.map((entry) => entry.configObjectId))]
  const configObjectTypeById = new Map<string, string>()
  if (configObjectIds.length > 0) {
    const rows = await db
      .select({ id: ConfigObjectTable.id, objectType: ConfigObjectTable.objectType })
      .from(ConfigObjectTable)
      .where(inArray(ConfigObjectTable.id, configObjectIds))
    for (const row of rows) {
      configObjectTypeById.set(row.id, row.objectType)
    }
  }

  const componentCountsByPlugin = new Map<string, Map<string, number>>()
  for (const entry of activePluginMemberships) {
    const objectType = configObjectTypeById.get(entry.configObjectId)
    if (!objectType) continue
    let counts = componentCountsByPlugin.get(entry.pluginId)
    if (!counts) {
      counts = new Map<string, number>()
      componentCountsByPlugin.set(entry.pluginId, counts)
    }
    counts.set(objectType, (counts.get(objectType) ?? 0) + 1)
  }

  const cloudReadinessByPlugin = memberFacingMcpConnectionsEnabled(input.context.organizationContext.organization.metadata)
    ? await resolveMarketplacePluginCloudReadiness({
        organizationId,
        member: {
          orgMembershipId: input.context.organizationContext.currentMember.id,
          teamIds: input.context.memberTeams.map((team) => team.id),
        },
        pluginIds,
        desktopManifestPluginIds: pluginRows.flatMap((row) => defaultOpenWorkManifestForPlugin(row) ? [row.id] : []),
      })
    : new Map<string, never>()

  const plugins = pluginRows.map((row) => {
    const componentCounts = Object.fromEntries(componentCountsByPlugin.get(row.id) ?? new Map())
    const cloudReadiness = cloudReadinessByPlugin.get(row.id)
    return {
      ...serializePlugin(row, memberCounts.get(row.id) ?? 0, [], componentCounts),
      componentCounts,
      ...(cloudReadiness ? { cloudReadiness } : {}),
    }
  })

  let source: MarketplaceResolvedSource = null
  if (pluginIds.length > 0) {
    const mappingRows = await db
      .selectDistinct({ connectorInstanceId: ConnectorMappingTable.connectorInstanceId })
      .from(ConnectorMappingTable)
      .where(and(
        eq(ConnectorMappingTable.organizationId, organizationId),
        inArray(ConnectorMappingTable.pluginId, pluginIds),
      ))
    const connectorInstanceIds = mappingRows.map((entry) => entry.connectorInstanceId)
    if (connectorInstanceIds.length === 1) {
      const [instance] = await db
        .select()
        .from(ConnectorInstanceTable)
        .where(eq(ConnectorInstanceTable.id, connectorInstanceIds[0]))
        .limit(1)
      if (instance) {
        const [account] = await db
          .select()
          .from(ConnectorAccountTable)
          .where(eq(ConnectorAccountTable.id, instance.connectorAccountId))
          .limit(1)
        const [target] = await db
          .select()
          .from(ConnectorTargetTable)
          .where(eq(ConnectorTargetTable.connectorInstanceId, instance.id))
          .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))
          .limit(1)
        const targetConfig = target?.targetConfigJson && typeof target.targetConfigJson === "object"
          ? target.targetConfigJson as Record<string, unknown>
          : {}
        const repositoryFullName = typeof targetConfig.repositoryFullName === "string"
          ? targetConfig.repositoryFullName
          : instance.remoteId ?? ""
        source = {
          connectorAccountId: instance.connectorAccountId,
          connectorInstanceId: instance.id,
          accountLogin: account?.externalAccountRef ?? (account?.metadataJson && typeof account.metadataJson === "object" ? (account.metadataJson as Record<string, unknown>).accountLogin as string ?? null : null),
          repositoryFullName,
          branch: typeof targetConfig.branch === "string" ? targetConfig.branch : target?.externalTargetRef ?? null,
        }
      }
    }
  }

  return {
    marketplace: {
      ...serializeMarketplace(marketplaceRow, plugins.length),
      canDelete: memberships.every((membership) => membership.membershipSource === "manual"),
    },
    plugins,
    source,
  }
}

export async function attachPluginToMarketplace(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId; membershipSource?: MarketplaceMembershipRow["membershipSource"]; pluginId: PluginId }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  if (input.marketplaceId) {
    await ensureEditableMarketplace(input.context, input.marketplaceId)
  }

  const existing = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), eq(MarketplacePluginTable.pluginId, input.pluginId)))
    .limit(1)

  const now = new Date()
  let membershipId: MarketplaceMembershipId | null = existing[0]?.id ?? null
  if (existing[0]) {
    await db.update(MarketplacePluginTable).set({ membershipSource: input.membershipSource ?? existing[0].membershipSource, removedAt: null }).where(eq(MarketplacePluginTable.id, existing[0].id))
  } else {
    membershipId = createDenTypeId("marketplacePlugin")
    await db.insert(MarketplacePluginTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: membershipId,
      marketplaceId: input.marketplaceId,
      membershipSource: input.membershipSource ?? "manual",
      organizationId: input.context.organizationContext.organization.id,
      pluginId: input.pluginId,
    })
  }

  const rows = await db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.id, membershipId!)).limit(1)
  await syncPluginMcpRequirementAccessForResource({ context: input.context, resourceId: input.pluginId, resourceKind: "plugin" })
  return serializeMarketplaceMembership(rows[0])
}

export async function removePluginFromMarketplace(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId; pluginId: PluginId }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  await ensureEditableMarketplace(input.context, input.marketplaceId)
  const rows = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), eq(MarketplacePluginTable.pluginId, input.pluginId), isNull(MarketplacePluginTable.removedAt)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "marketplace_membership_not_found", "Marketplace membership not found.")
  }
  await db.update(MarketplacePluginTable).set({ removedAt: new Date() }).where(eq(MarketplacePluginTable.id, rows[0].id))
  await syncPluginMcpRequirementAccessForResource({ context: input.context, resourceId: input.pluginId, resourceKind: "plugin" })
}

function slugifyPluginMcpName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mcp"
}

function externalMcpConnectionName(input: { pluginName: string; serverName: string }) {
  const serverName = input.serverName.trim()
  const pluginName = input.pluginName.trim()
  if (!pluginName) return serverName || "Imported MCP"
  if (!serverName) return pluginName
  return `${pluginName} / ${serverName}`
}

function githubPluginMcpServerKey(input: { name: string; pluginKey: string; sourcePath: string; url: string | null }) {
  return [input.pluginKey, input.sourcePath, input.name, input.url ?? ""].map(encodeURIComponent).join(":")
}

function githubPluginMcpImportServer(input: Omit<GithubPluginMcpImportServer, "mapsTo" | "reuse" | "serverKey">): GithubPluginMcpImportServer {
  return {
    ...input,
    mapsTo: null,
    reuse: null,
    serverKey: githubPluginMcpServerKey(input),
  }
}

/**
 * Claude/Cowork connectors that point at Anthropic-only endpoints (or leave
 * the URL to Claude) map to the provider OpenWork already knows. Presets use
 * their own URL; native providers are never imported as MCP servers.
 */
function withImportedConnectorTarget(server: GithubPluginMcpImportServer): GithubPluginMcpImportServer {
  const target = resolveImportedConnectorTarget({ name: server.name, url: server.url })
  if (!target) return server
  const mapsTo = { displayName: target.displayName, kind: target.kind, providerId: target.providerId }
  if (target.kind === "preset") {
    return { ...server, mapsTo, url: server.supported ? target.url : server.url }
  }
  if (target.whenMissing === "skip" && (server.supported || server.skippedReason === "missing_url")) {
    return { ...server, mapsTo, skippedReason: "native_connector", supported: false }
  }
  return { ...server, mapsTo }
}

function isLoopbackMcpHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost"
    || normalized === "::1"
    || normalized.startsWith("127.")
}

export function mcpServerEntriesFromPayload(input: {
  plugin: GithubDiscoveredPlugin
  rawSourceText: string
  sourcePath: string
}): GithubPluginMcpImportServer[] {
  const isAgentPlugin = input.plugin.sourceKind === "agent_plugin_manifest"
  const sourceSchemaVersion = isAgentPlugin ? input.plugin.sourceSchemaVersion : null
  let invalidAgentEntries: GithubPluginMcpImportServer[] = []
  let fallbackEntries: Array<[string, unknown]>
  if (isAgentPlugin) {
    const parsed = parseAgentPluginV1McpText(input.rawSourceText, input.plugin.sourceSchemaVersion)
    if (!parsed.ok) {
      return [githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name: input.sourcePath,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_config",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })]
    }
    invalidAgentEntries = parsed.entries.filter((entry) => !entry.valid).map((entry) => githubPluginMcpImportServer({
      authType: null,
      connectionId: null,
      name: entry.name || input.plugin.displayName,
      pluginKey: input.plugin.key,
      pluginName: input.plugin.displayName,
      skippedReason: "invalid_config",
      sourceSchemaVersion,
      sourcePath: input.sourcePath,
      supported: false,
      url: typeof entry.config.url === "string" ? entry.config.url : null,
    }))
    const validEntries = parsed.entries.filter((entry) => entry.valid).map((entry) => [entry.name, entry.config] satisfies [string, unknown])
    if (validEntries.length === 0) return invalidAgentEntries
    fallbackEntries = validEntries
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(input.rawSourceText)
    } catch {
      return [githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name: input.sourcePath,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })]
    }

    const root = isRecord(parsed) ? parsed : {}
    const containers = [
      isRecord(root.mcpServers) ? root.mcpServers : null,
      isRecord(root.mcp) ? root.mcp : null,
    ].filter((entry): entry is Record<string, unknown> => Boolean(entry))
    const entries = containers.flatMap((container) => Object.entries(container))
    fallbackEntries = entries.length > 0 ? entries : [[input.plugin.displayName, root]]
  }

  return [...invalidAgentEntries, ...fallbackEntries.map(([rawName, rawConfig]) => {
    const server = mcpServerEntryFromConfig(rawName, rawConfig)
    // Agent Plugins declare what they require; only Claude/Cowork suggestions are mapped.
    return isAgentPlugin ? server : withImportedConnectorTarget(server)
  })]

  function mcpServerEntryFromConfig(rawName: string, rawConfig: unknown): GithubPluginMcpImportServer {
    const config = isRecord(rawConfig) ? rawConfig : {}
    const name = rawName.trim() || input.plugin.displayName
    const url = typeof config.url === "string" ? config.url.trim() : ""
    const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : ""
    const command = typeof config.command === "string"
      ? config.command.trim()
      : Array.isArray(config.command) && config.command.some((part) => typeof part === "string" && part.trim())
        ? "local command"
        : ""

    if (isAgentPlugin && isRecord(config.headers) && Object.keys(config.headers).length > 0) {
      return githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "headers_unsupported",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url: typeof config.url === "string" ? config.url : null,
      })
    }

    if (!url) {
      return githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: command ? "local_unsupported" : "missing_url",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url,
      })
    }

    if (
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
      || (isAgentPlugin && parsedUrl.protocol === "http:" && !isLoopbackMcpHostname(parsedUrl.hostname))
      || (isAgentPlugin && Boolean(parsedUrl.username || parsedUrl.password))
      || (isAgentPlugin && Boolean(parsedUrl.hash))
    ) {
      return githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url,
      })
    }

    if (type && type !== "http" && type !== "remote" && type !== "streamable-http" && type !== "sse") {
      return githubPluginMcpImportServer({
        authType: null,
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "local_unsupported",
        sourceSchemaVersion,
        sourcePath: input.sourcePath,
        supported: false,
        url,
      })
    }

    return githubPluginMcpImportServer({
      authType: declaredPluginMcpAuthType(config),
      connectionId: null,
      name,
      pluginKey: input.plugin.key,
      pluginName: input.plugin.displayName,
      skippedReason: null,
      sourceSchemaVersion,
      sourcePath: input.sourcePath,
      supported: true,
      url,
    })
  }
}

function githubPluginSkillKey(input: { pluginKey: string; sourcePath: string }) {
  return [input.pluginKey, input.sourcePath].map(encodeURIComponent).join(":")
}

function skillMetadataFromText(skillText: string) {
  const parsed = parseSkillMarkdown(skillText)
  if (parsed.hasFrontmatter) {
    const title = parsed.name.trim() || "Untitled skill"
    const description = parsed.description.trim() || null
    return {
      description: description ? description.slice(0, 65535) : null,
      title: title.slice(0, 255),
    }
  }

  const lines = skillText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)

  const cleanup = (value: string) => value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim()

  const title = cleanup(lines[0] ?? "") || "Untitled skill"
  const description = lines.slice(1).map(cleanup).find(Boolean) ?? null

  return {
    description: description ? description.slice(0, 65535) : null,
    title: title.slice(0, 255),
  }
}

export function skillEntryFromSource(input: {
  includeRawSourceText: boolean
  plugin: GithubDiscoveredPlugin
  rawSourceText: string
  sourcePath: string
}): GithubPluginSkillImportSkill {
  const metadata = skillMetadataFromText(input.rawSourceText)
  const base = {
    description: metadata.description,
    name: metadata.title,
    pluginKey: input.plugin.key,
    pluginName: input.plugin.displayName,
    skillKey: githubPluginSkillKey({ pluginKey: input.plugin.key, sourcePath: input.sourcePath }),
    sourceSchemaVersion: input.plugin.sourceKind === "agent_plugin_manifest" ? input.plugin.sourceSchemaVersion : null,
    sourcePath: input.sourcePath,
  }
  if (input.plugin.sourceKind === "agent_plugin_manifest") {
    try {
      const projection = deriveSkillProjection({ rawSourceText: input.rawSourceText })
      const pathSegments = input.sourcePath.split("/").filter(Boolean)
      const skillDirectoryName = pathSegments.at(-2) ?? ""
      if (projection.title !== skillDirectoryName) {
        throw new Error("Agent Skill name must match its parent directory.")
      }
      return {
        ...base,
        description: projection.description,
        name: projection.title,
        rawSourceText: input.includeRawSourceText ? input.rawSourceText : undefined,
        skippedReason: null,
        supported: true,
      }
    } catch {
      return {
        ...base,
        skippedReason: "invalid_skill",
        supported: false,
      }
    }
  }
  if (!input.rawSourceText.trim() || !hasSkillFrontmatterName(input.rawSourceText)) {
    return {
      ...base,
      skippedReason: "invalid_skill",
      supported: false,
    }
  }
  return {
    ...base,
    rawSourceText: input.includeRawSourceText ? input.rawSourceText : undefined,
    skippedReason: null,
    supported: true,
  }
}

/**
 * Fills in which existing organization connection each server will use: the
 * External MCP connection for its (canonical) URL, or the native Google
 * Workspace / Microsoft 365 connection a Claude connector maps to.
 */
async function withExistingConnectionReuse(input: { organizationId: OrganizationId; servers: GithubPluginMcpImportServer[] }) {
  const connections = await listExternalMcpConnections(input.organizationId)
  const nativeByProvider = new Map<string, GithubPluginMcpImportReuse | null>()
  const nativeConnection = async (providerId: string) => {
    if (nativeByProvider.has(providerId)) return nativeByProvider.get(providerId) ?? null
    const row = connections.find((connection) => connection.kind === "native_provider" && connection.nativeProviderKey === providerId)
    // Legacy native setups keep the OAuth client under the provider key, with no connection row.
    const legacy = row ? null : await getOrgOAuthClient(input.organizationId, providerId)
    const reuse = row
      ? { connectionId: row.id, connectionName: row.name }
      : legacy
        ? { connectionId: providerId, connectionName: NATIVE_OAUTH_PROVIDERS[providerId]?.displayName ?? providerId }
        : null
    nativeByProvider.set(providerId, reuse)
    return reuse
  }
  const result: GithubPluginMcpImportServer[] = []
  for (const server of input.servers) {
    if (server.mapsTo?.kind === "native") {
      const reuse = await nativeConnection(server.mapsTo.providerId)
      // A vendor-hosted server kept only for orgs without the native connection.
      result.push(reuse && server.supported
        ? { ...server, reuse, skippedReason: "native_connector", supported: false }
        : { ...server, reuse })
      continue
    }
    const serverUrl = server.url
    const existing = server.supported && serverUrl
      ? connections.find((connection) => connection.kind === "external_mcp" && comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(serverUrl))
      : undefined
    result.push(existing ? { ...server, reuse: { connectionId: existing.id, connectionName: existing.name } } : server)
  }
  return result
}

async function computeGithubPluginMcpImportPlan(input: { githubUrl: string; includeSkillText?: boolean; organizationId?: OrganizationId }): Promise<GithubPluginMcpImportPlan> {
  const target = parsePublicGithubPluginUrl(input.githubUrl)
  const snapshot = await getPublicGithubRepositoryTree(target)
  const fileTextByPath = await getPublicGithubDiscoveryFileTexts(snapshot)
  const discovery = buildGithubRepoDiscovery({
    entries: snapshot.treeEntries,
    fileTextByPath,
  })
  const importPlansByPluginKey = buildGithubDiscoveryImportPlans({
    discoveredPlugins: discovery.discoveredPlugins,
    treeEntries: snapshot.treeEntries,
  })

  // Read every component file up front, a few at a time; a marketplace like
  // knowledge-work-plugins has 250+ files and reading them one by one took
  // over 30 seconds. Results are then assembled in discovery order.
  const jobs = discovery.discoveredPlugins
    .filter((entry) => entry.supported)
    .flatMap((plugin) => (importPlansByPluginKey[plugin.key] ?? [])
      .filter((plan) => plan.objectType === "mcp" || plan.objectType === "skill")
      .flatMap((plan) => plan.paths.map((path) => ({ kind: plan.objectType === "mcp" ? "mcp" as const : "skill" as const, path, plugin }))))
  const texts = await mapPublicGithubConcurrently(jobs, (job) => getPublicGithubTextFile({
    branch: snapshot.branch,
    discoveryPath: job.path,
    snapshot,
  }))

  const servers: GithubPluginMcpImportServer[] = []
  const skills: GithubPluginSkillImportSkill[] = []
  for (const kind of ["mcp", "skill"] as const) {
    for (const [index, job] of jobs.entries()) {
      const rawSourceText = texts[index]
      if (job.kind !== kind || !rawSourceText) continue
      if (kind === "mcp") {
        servers.push(...mcpServerEntriesFromPayload({ plugin: job.plugin, rawSourceText, sourcePath: job.path }))
      } else {
        skills.push(skillEntryFromSource({
          includeRawSourceText: input.includeSkillText === true,
          plugin: job.plugin,
          rawSourceText,
          sourcePath: job.path,
        }))
      }
    }
  }

  // Import connects each server through hosted egress, which only accepts
  // public HTTPS URLs. Apply the same rule here so the preview never promises
  // a server the import then refuses (it used to fail the whole import with a
  // 500 after the preview said "supported").
  const egressByUrl = new Map<string, Promise<boolean>>()
  const egressAllowed = (url: string) => {
    let pending = egressByUrl.get(url)
    if (!pending) {
      pending = assertPublicUrl(url).then(() => true, (error: unknown) => {
        if (error instanceof PrivateUrlError) return false
        throw error
      })
      egressByUrl.set(url, pending)
    }
    return pending
  }
  for (const [index, server] of servers.entries()) {
    if (env.allowPrivateMcpUrls || !server.supported || !server.url || await egressAllowed(server.url)) continue
    servers[index] = { ...server, skippedReason: "invalid_url", supported: false }
  }
  if (input.organizationId) {
    servers.splice(0, servers.length, ...await withExistingConnectionReuse({ organizationId: input.organizationId, servers }))
  }

  const plugins = discovery.discoveredPlugins
    .filter((plugin) => plugin.supported)
    .map((plugin) => ({
      description: plugin.description,
      key: plugin.key,
      mcpCount: servers.filter((server) => server.pluginKey === plugin.key && server.supported).length,
      name: plugin.displayName,
      skillCount: skills.filter((skill) => skill.pluginKey === plugin.key && skill.supported).length,
    } satisfies GithubPluginMcpImportPlugin))
    .filter((plugin) => plugin.mcpCount > 0 || plugin.skillCount > 0)
  const sourceSchemaVersions = new Set(discovery.discoveredPlugins
    .filter((plugin) => plugin.supported && plugin.sourceKind === "agent_plugin_manifest")
    .flatMap((plugin) => plugin.sourceSchemaVersion ? [plugin.sourceSchemaVersion] : []))

  return {
    branch: snapshot.branch,
    classification: discovery.classification,
    marketplace: discovery.marketplace,
    plugins,
    repositoryFullName: snapshot.repositoryFullName,
    rootPath: snapshot.rootPath,
    servers,
    skills,
    sourceSchemaVersion: sourceSchemaVersions.size === 1 ? [...sourceSchemaVersions][0] ?? null : null,
    sourceRevisionRef: snapshot.headSha,
    treeTruncated: snapshot.truncated,
    warnings: [
      ...discovery.warnings,
      ...(snapshot.truncated ? ["GitHub truncated the repository tree; some MCP files may be missing."] : []),
    ],
  }
}

function serializePluginMcpRequirementBinding(row: PluginMcpRequirementBindingRow) {
  return {
    configObjectId: row.configObjectId,
    externalMcpConnectionId: row.externalMcpConnectionId,
    id: row.id,
    pluginId: row.pluginId,
    serverName: row.serverName,
  }
}

function isExternalMcpConnectionReady(row: ExternalMcpConnectionRow) {
  if (row.credentialMode === "per_member") return true
  return Boolean(row.accessToken || row.apiKey || (row.authType === "none" && row.connectedAt))
}

function serializePluginMcpRequirementConnection(row: ExternalMcpConnectionRow) {
  return {
    authType: row.authType,
    connected: isExternalMcpConnectionReady(row),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    credentialMode: row.credentialMode,
    id: row.id,
    name: row.name,
    url: row.url,
  }
}

function parseConfigObjectVersionSpec(row: ConfigObjectVersionRow): Record<string, unknown> {
  if (row.normalizedPayloadJson) return row.normalizedPayloadJson
  if (!row.rawSourceText) return {}
  try {
    const parsed: unknown = JSON.parse(row.rawSourceText)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value.trim() : ""
}

function parseConfigObjectInputSpec(input: ConfigObjectInput): Record<string, unknown> {
  if (input.normalizedPayloadJson) return input.normalizedPayloadJson
  if (!input.rawSourceText) return {}
  try {
    const parsed: unknown = JSON.parse(input.rawSourceText)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function deleteStalePluginMcpRequirementBindingsForConfigObject(input: {
  configObject: ConfigObjectRow
  spec: Record<string, unknown>
}) {
  if (input.configObject.objectType !== "mcp") return
  const entries = new Map(marketplaceMcpServerEntries(input.spec, input.configObject.title).flatMap((entry) => {
    const url = readRecordString(entry.config, "url")
    return url ? [[entry.name, url]] : []
  }))
  const bindings = await db
    .select({ binding: PluginMcpRequirementBindingTable, connection: ExternalMcpConnectionTable })
    .from(PluginMcpRequirementBindingTable)
    .innerJoin(ExternalMcpConnectionTable, eq(ExternalMcpConnectionTable.id, PluginMcpRequirementBindingTable.externalMcpConnectionId))
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.configObject.organizationId),
      eq(PluginMcpRequirementBindingTable.configObjectId, input.configObject.id),
    ))
  const staleBindingIds = bindings.flatMap((row) => {
    const declaredUrl = entries.get(row.binding.serverName)
    if (!declaredUrl) return [row.binding.id]
    return comparablePluginMcpRequirementUrl(row.connection.url) === comparablePluginMcpRequirementUrl(declaredUrl)
      ? []
      : [row.binding.id]
  })
  await deletePluginMcpRequirementBindingsByIds({ bindingIds: staleBindingIds })
}

function mcpRequirementServerFromVersion(input: {
  configObject: ConfigObjectRow
  serverName: string
  version: ConfigObjectVersionRow
}): PluginMcpRequirementServer {
  const spec = parseConfigObjectVersionSpec(input.version)
  const serverName = input.serverName.trim()
  const entry = marketplaceMcpServerEntries(spec, input.configObject.title).find((candidate) => candidate.name === serverName)
  if (!entry) {
    throw new PluginArchRouteFailure(404, "mcp_server_not_found", "MCP server declaration not found on this config object.")
  }

  const url = readRecordString(entry.config, "url")
  if (!url) {
    throw new PluginArchRouteFailure(400, "mcp_server_not_remote", "Only declared remote MCP servers with a URL can be configured.")
  }

  return { config: entry.config, name: entry.name, url }
}

function configVersionOwnsImportedExternalMcpConnection(version: ConfigObjectVersionRow, connectionId: string) {
  const spec = parseConfigObjectVersionSpec(version)
  const metadata = isRecord(spec.metadata) ? spec.metadata : null
  const recordedConnectionId = readRecordString(spec, "externalMcpConnectionId")
    || (metadata ? readRecordString(metadata, "externalMcpConnectionId") : null)
  const owned = spec.externalMcpConnectionOwnedByPlugin === true
    || metadata?.externalMcpConnectionOwnedByPlugin === true
  return owned && recordedConnectionId === connectionId
}

async function assertRemotePluginMcpUrl(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PluginArchRouteFailure(400, "invalid_mcp_url", "MCP server URL is invalid.")
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PluginArchRouteFailure(400, "invalid_mcp_url", "MCP URLs must use HTTP or HTTPS.")
  }
  if (parsed.protocol === "http:" && !env.allowPrivateMcpUrls) {
    throw new PluginArchRouteFailure(400, "invalid_mcp_url", "Hosted MCP connections must use HTTPS.")
  }
  if (parsed.hash) {
    throw new PluginArchRouteFailure(400, "invalid_mcp_url", "MCP URLs must not contain a fragment.")
  }
  if (parsed.username || parsed.password) {
    throw new PluginArchRouteFailure(400, "invalid_mcp_url", "MCP URLs must not contain embedded credentials.")
  }

  const sensitiveParameters = new Set(["access_token", "api_key", "client_secret", "token", "refresh_token", "id_token", "code_verifier"])
  for (const parameter of parsed.searchParams.keys()) {
    if (sensitiveParameters.has(parameter.toLowerCase())) {
      throw new PluginArchRouteFailure(400, "invalid_mcp_url", `MCP URL query parameter "${parameter}" must not contain credentials.`)
    }
  }

  if (!env.allowPrivateMcpUrls) {
    try {
      await assertPublicUrl(url)
    } catch (error) {
      throw new PluginArchRouteFailure(400, "invalid_mcp_url", error instanceof Error ? error.message : "URL not allowed.")
    }
  }
}

async function activeMarketplaceIdsForPlugin(input: { organizationId: OrganizationId; pluginId: PluginId }) {
  const rows = await db
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .where(and(
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      eq(MarketplacePluginTable.pluginId, input.pluginId),
      isNull(MarketplacePluginTable.removedAt),
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
  return rows.map((row) => row.marketplaceId)
}

async function derivePluginMcpRequirementAccess(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<PluginMcpRequirementAccess> {
  const activeRows = await db
    .select({ id: PluginConfigObjectTable.id, objectType: ConfigObjectTable.objectType })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginConfigObjectTable.pluginId, PluginTable.id))
    .innerJoin(ConfigObjectTable, eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.pluginId, input.pluginId),
      eq(PluginConfigObjectTable.configObjectId, input.configObjectId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    .limit(1)
  if (!activeRows[0]) {
    return { memberIds: [], orgWide: false, teamIds: [] }
  }
  if (activeRows[0].objectType === "app") {
    const activeApp = await db.select({ configObjectId: RemoteMcpAppTable.configObjectId })
      .from(RemoteMcpAppTable)
      .where(and(
        eq(RemoteMcpAppTable.organizationId, input.organizationId),
        eq(RemoteMcpAppTable.configObjectId, input.configObjectId),
        eq(RemoteMcpAppTable.status, "active"),
      ))
      .limit(1)
    if (!activeApp[0]) return { memberIds: [], orgWide: false, teamIds: [] }
  }

  const marketplaceIds = await activeMarketplaceIdsForPlugin({ organizationId: input.organizationId, pluginId: input.pluginId })
  const configObjectGrants = await db
    .select({ orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId, orgWide: ConfigObjectAccessGrantTable.orgWide, teamId: ConfigObjectAccessGrantTable.teamId })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, input.organizationId),
      eq(ConfigObjectAccessGrantTable.configObjectId, input.configObjectId),
      isNull(ConfigObjectAccessGrantTable.removedAt),
    ))
  const pluginGrants = await db
    .select({ orgMembershipId: PluginAccessGrantTable.orgMembershipId, orgWide: PluginAccessGrantTable.orgWide, teamId: PluginAccessGrantTable.teamId })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, input.organizationId),
      eq(PluginAccessGrantTable.pluginId, input.pluginId),
      isNull(PluginAccessGrantTable.removedAt),
    ))
  const marketplaceGrants = marketplaceIds.length > 0
    ? await db
      .select({ orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId, orgWide: MarketplaceAccessGrantTable.orgWide, teamId: MarketplaceAccessGrantTable.teamId })
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.organizationId, input.organizationId),
        inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
        isNull(MarketplaceAccessGrantTable.removedAt),
      ))
    : []
  const grants = [...configObjectGrants, ...pluginGrants, ...marketplaceGrants]
  return {
    orgWide: grants.some((grant) => grant.orgWide),
    memberIds: sortedUnique(grants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : [])),
    teamIds: sortedUnique(grants.flatMap((grant) => grant.teamId ? [grant.teamId] : [])),
  }
}

async function syncPluginMcpRequirementBindingAccess(row: PluginMcpRequirementBindingRow) {
  const access = await derivePluginMcpRequirementAccess({
    configObjectId: row.configObjectId,
    organizationId: row.organizationId,
    pluginId: row.pluginId,
  })
  await replaceExternalMcpConnectionAccessForPluginBinding({
    access,
    bindingId: row.id,
    connectionId: row.externalMcpConnectionId,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    organizationId: row.organizationId,
  })
}

async function syncPluginMcpRequirementBindings(rows: PluginMcpRequirementBindingRow[]) {
  for (const row of rows) await syncPluginMcpRequirementBindingAccess(row)
}

async function pluginMcpRequirementBindingsForResource(input: ResourceTarget & { organizationId: OrganizationId }) {
  if (input.resourceKind === "config_object") {
    return db
      .select()
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(PluginMcpRequirementBindingTable.configObjectId, input.resourceId),
      ))
  }
  if (input.resourceKind === "plugin") {
    return db
      .select()
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(PluginMcpRequirementBindingTable.pluginId, input.resourceId),
      ))
  }
  if (input.resourceKind === "marketplace") {
    return db
      .select({ binding: PluginMcpRequirementBindingTable })
      .from(PluginMcpRequirementBindingTable)
      .innerJoin(MarketplacePluginTable, eq(MarketplacePluginTable.pluginId, PluginMcpRequirementBindingTable.pluginId))
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(MarketplacePluginTable.organizationId, input.organizationId),
        eq(MarketplacePluginTable.marketplaceId, input.resourceId),
        isNull(MarketplacePluginTable.removedAt),
      ))
      .then((rows) => rows.map((row) => row.binding))
  }
  return []
}

export async function syncPluginMcpRequirementAccessForResource(input: ResourceTarget & { context: PluginArchActorContext }) {
  const organizationId = input.context.organizationContext.organization.id
  const rows = input.resourceKind === "config_object"
    ? await pluginMcpRequirementBindingsForResource({ organizationId, resourceId: input.resourceId, resourceKind: "config_object" })
    : input.resourceKind === "plugin"
      ? await pluginMcpRequirementBindingsForResource({ organizationId, resourceId: input.resourceId, resourceKind: "plugin" })
      : input.resourceKind === "marketplace"
        ? await pluginMcpRequirementBindingsForResource({ organizationId, resourceId: input.resourceId, resourceKind: "marketplace" })
        : []
  await syncPluginMcpRequirementBindings(rows)
}

async function activePluginMcpRequirement(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}) {
  const rows = await db
    .select({ configObject: ConfigObjectTable, plugin: PluginTable })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginConfigObjectTable.pluginId, PluginTable.id))
    .innerJoin(ConfigObjectTable, eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.pluginId, input.pluginId),
      eq(PluginConfigObjectTable.configObjectId, input.configObjectId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.objectType, "mcp"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    .limit(1)

  const row = rows[0]
  if (!row) {
    throw new PluginArchRouteFailure(404, "mcp_requirement_not_found", "Active plugin MCP requirement not found.")
  }
  return row
}

function expectedMcpRequirementCredentialMode(input: { authType: PluginMcpRequirementAuthType; credentialMode: PluginMcpRequirementCredentialMode }) {
  if (input.authType === "apikey" || input.authType === "none") return "shared"
  return input.credentialMode
}

function normalizedPluginMcpApiKey(apiKey?: string) {
  const trimmed = apiKey?.trim()
  return trimmed ? trimmed : null
}

function validatePluginMcpRequirementAuth(input: {
  apiKey?: string
  authType: PluginMcpRequirementAuthType
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
}) {
  const apiKey = normalizedPluginMcpApiKey(input.apiKey)
  if (input.oauthClient && input.authType !== "oauth") {
    throw new PluginArchRouteFailure(400, "invalid_mcp_auth", "oauthClient is only allowed when authType is oauth.")
  }
  if (apiKey && input.authType !== "apikey") {
    throw new PluginArchRouteFailure(400, "invalid_mcp_auth", "apiKey is only allowed when authType is apikey.")
  }
  if (input.authType === "apikey" && input.credentialMode !== "shared") {
    throw new PluginArchRouteFailure(400, "invalid_mcp_auth", "authType apikey requires credentialMode shared.")
  }
  if (input.authType === "apikey" && !apiKey) {
    throw new PluginArchRouteFailure(400, "invalid_mcp_auth", "authType apikey requires apiKey.")
  }
  if (input.credentialMode === "per_member" && input.authType !== "oauth") {
    throw new PluginArchRouteFailure(400, "invalid_mcp_auth", "credentialMode per_member requires authType oauth.")
  }
}

async function connectionCompatibleWithRequirement(input: {
  apiKey?: string | null
  authType: PluginMcpRequirementAuthType
  connection: ExternalMcpConnectionRow
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  organizationId: OrganizationId
  url: string
}) {
  if (input.connection.kind !== "external_mcp") return false
  const baseCompatible = comparablePluginMcpRequirementUrl(input.connection.url) === comparablePluginMcpRequirementUrl(input.url)
    && input.connection.authType === input.authType
    && input.connection.credentialMode === input.credentialMode
  if (!baseCompatible) return false
  if (input.authType === "apikey") {
    const apiKey = normalizedPluginMcpApiKey(input.apiKey ?? undefined)
    return Boolean(apiKey) && input.connection.apiKey === apiKey
  }
  if (!input.oauthClient || input.authType !== "oauth") return true
  const existingClient = await getOrgOAuthClient(input.organizationId, input.connection.id)
  return existingClient?.clientId === input.oauthClient.clientId
}

async function createOrReusePluginMcpRequirementConnection(input: {
  access: PluginMcpRequirementAccess
  apiKey?: string | null
  authType: PluginMcpRequirementAuthType
  context: PluginArchActorContext
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  plugin: PluginRow
  server: PluginMcpRequirementServer
}): Promise<{ connection: ExternalMcpConnectionRow; created: boolean }> {
  const organizationId = input.context.organizationContext.organization.id
  const connections = await listExternalMcpConnections(organizationId)
  let compatible: ExternalMcpConnectionRow | null = null
  for (const connection of connections) {
    if (await connectionCompatibleWithRequirement({
      apiKey: input.apiKey,
      authType: input.authType,
      connection,
      credentialMode: input.credentialMode,
      oauthClient: input.oauthClient,
      organizationId,
      url: input.server.url,
    })) {
      compatible = connection
      break
    }
  }

  if (compatible) {
    return { connection: compatible, created: false }
  }

  const created = await createExternalMcpConnection({
    access: { memberIds: [], orgWide: false, teamIds: [] },
    apiKey: input.authType === "apikey" ? input.apiKey : null,
    authType: input.authType,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    credentialMode: input.credentialMode,
    name: externalMcpConnectionName({ pluginName: input.plugin.name, serverName: input.server.name }),
    organizationId,
    url: input.server.url,
  })
  return { connection: created, created: true }
}

function pluginMcpValidationRedirectUri(connectionId: string) {
  const baseUrl = env.apiPublicUrl ?? env.betterAuthUrl
  return new URL(`/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`, baseUrl).toString()
}

async function validateConfiguredPluginMcpConnection(input: {
  authType: PluginMcpRequirementAuthType
  connection: ExternalMcpConnectionRow
}) {
  if (input.connection.kind !== "external_mcp") {
    throw new PluginArchRouteFailure(400, "invalid_mcp_connection", "Native provider connectors cannot satisfy plugin MCP requirements.")
  }
  if (input.authType === "oauth") return
  try {
    await connectExternalMcp(
      input.connection,
      pluginMcpValidationRedirectUri(input.connection.id),
      undefined,
      undefined,
      input.connection.id,
    )
  } catch (error) {
    const diagnostic = externalMcpDiagnosticForResponse(error, input.connection.id, "MCP_INITIALIZE")
    console.error("plugin_mcp_connection_validation_failed", {
      connectionId: input.connection.id,
      organizationId: input.connection.organizationId,
      connectionEndpoint: safeExternalMcpEndpointForLog(input.connection.url),
      ...externalMcpDiagnosticForLog(error, input.connection.id, "MCP_INITIALIZE"),
    })
    throw new PluginArchRouteFailure(
      502,
      "connection_validation_failed",
      `Could not validate "${input.connection.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
    )
  }

  if (input.authType === "none") {
    await markImportedExternalMcpConnectionConnected(input.connection.id)
  }
}

function sortedUnique<TValue extends string>(values: TValue[]): TValue[] {
  return [...new Set(values)].sort()
}

async function requireExistingExternalMcpConnectionMatchesImport(input: {
  authType: PluginMcpAuthType
  credentialMode: "per_member" | "shared"
  existingAuthType: "apikey" | "none" | "oauth"
  existingCredentialMode: "per_member" | "shared"
}) {
  const expectedCredentialMode = input.authType === "oauth" ? input.credentialMode : "shared"
  if (input.existingAuthType !== input.authType || input.existingCredentialMode !== expectedCredentialMode) {
    throw new PluginArchRouteFailure(
      409,
      "external_mcp_connection_config_mismatch",
      "An External MCP Connection already exists for this URL with different authentication or credential mode. Edit the existing connection or import with matching settings.",
    )
  }
}

async function ensureImportedExternalMcpConnection(input: {
  access: GithubPluginMcpImportAccess
  authType: PluginMcpAuthType
  context: PluginArchActorContext
  credentialMode: "per_member" | "shared"
  server: GithubPluginMcpImportServer
}): Promise<{ connection: Awaited<ReturnType<typeof createExternalMcpConnection>>; ownedByImportedPlugin: boolean }> {
  if (!input.server.url) {
    throw new PluginArchRouteFailure(400, "invalid_mcp_import", "MCP server URL is required.")
  }
  const serverUrl = input.server.url

  // Same rule as every other MCP connection: self-hosted Dens that allow
  // private MCP URLs (DEN_ALLOW_PRIVATE_MCP_URLS, dev mode) skip the guard.
  if (!env.allowPrivateMcpUrls) {
    try {
      await assertPublicUrl(serverUrl)
    } catch (error) {
      if (!(error instanceof PrivateUrlError)) throw error
      throw new PluginArchRouteFailure(400, "invalid_mcp_import", `MCP server "${input.server.name}" cannot be imported: ${error.message}`)
    }
  }
  const organizationId = input.context.organizationContext.organization.id
  const existing = (await listExternalMcpConnections(organizationId))
    .find((connection) => connection.kind === "external_mcp" && comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(serverUrl))

  // A Claude connector mapped to a preset (Slack, Notion, ...) uses the
  // organization's connection for it as the admin set it up, rather than
  // failing the import over a different credential mode.
  if (existing && input.server.mapsTo?.kind === "preset") {
    return { connection: existing, ownedByImportedPlugin: false }
  }

  if (existing) {
    const authType = resolveGithubPluginMcpImportAuthType({
      declaredAuthType: input.server.authType,
      // Legacy none always used shared mode, regardless of the import's OAuth
      // mode default. A shared PAT must not replace per-member OAuth.
      existingAuthType: existing.authType === "none" || existing.credentialMode === input.credentialMode ? existing.authType : undefined,
      requestedAuthType: input.authType,
      url: serverUrl,
    })
    await requireExistingExternalMcpConnectionMatchesImport({
      authType,
      credentialMode: input.credentialMode,
      existingAuthType: existing.authType,
      existingCredentialMode: existing.credentialMode,
    })
    if (authType === "none") {
      try {
        await validateConfiguredPluginMcpConnection({ authType, connection: existing })
      } catch (error) {
        await db.update(ExternalMcpConnectionTable).set({ connectedAt: null }).where(and(
          eq(ExternalMcpConnectionTable.organizationId, organizationId),
          eq(ExternalMcpConnectionTable.id, existing.id),
        ))
        throw error
      }
    }
    return { connection: existing, ownedByImportedPlugin: false }
  }

  const created = await createExternalMcpConnection({
    access: { memberIds: [], orgWide: false, teamIds: [] },
    authType: input.authType,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    credentialMode: input.authType === "oauth" ? input.credentialMode : "shared",
    name: externalMcpConnectionName({ pluginName: input.server.pluginName, serverName: input.server.name }),
    organizationId,
    url: serverUrl,
  })
  if (input.authType === "none") {
    try {
      await validateConfiguredPluginMcpConnection({ authType: input.authType, connection: created })
    } catch (error) {
      await deleteExternalMcpConnection({ connectionId: created.id, organizationId })
      throw error
    }
  }
  return { connection: created, ownedByImportedPlugin: true }
}

async function markImportedExternalMcpConnectionConnected(connectionId: typeof ExternalMcpConnectionTable.$inferSelect.id) {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ connectedAt: new Date() })
    .where(eq(ExternalMcpConnectionTable.id, connectionId))
}

function connectionBackedMcpPayload(input: {
  authType: PluginMcpAuthType
  connectionId: string
  optional?: boolean
  ownedByPlugin: boolean
  server: { name: string; url: string | null }
}) {
  const serverName = slugifyPluginMcpName(input.server.name)
  return {
    mcpServers: {
      [serverName]: {
        type: "remote",
        url: input.server.url,
        openworkManaged: "den_external_mcp",
        externalMcpConnectionId: input.connectionId,
        externalMcpConnectionOwnedByPlugin: input.ownedByPlugin,
        requiredAuthType: input.authType,
        ...(input.authType === "oauth" ? { oauth: true } : {}),
        ...(input.optional ? { optional: true } : {}),
      },
    },
    openworkManaged: "den_external_mcp",
    externalMcpConnectionId: input.connectionId,
    externalMcpConnectionOwnedByPlugin: input.ownedByPlugin,
    requiredAuthType: input.authType,
  }
}

function importedConnectionBackedMcpPayload(input: {
  authType: PluginMcpAuthType
  connectionId: string
  optional: boolean
  ownedByImportedPlugin: boolean
  server: GithubPluginMcpImportServer
}) {
  return connectionBackedMcpPayload({
    authType: input.authType,
    connectionId: input.connectionId,
    optional: input.optional,
    ownedByPlugin: input.ownedByImportedPlugin,
    server: input.server,
  })
}

function importedPluginName(plan: GithubPluginMcpImportPlan) {
  if (plan.plugins.length === 1) return plan.plugins[0].name
  return plan.marketplace?.name?.trim() || plan.rootPath.split("/").filter(Boolean).at(-1) || plan.repositoryFullName.split("/").at(-1) || "GitHub MCP Plugin"
}

export async function previewGithubPluginMcpImport(input: { context: PluginArchActorContext; githubUrl: string }) {
  // Only admins import, and only they see which organization connections an import would use.
  return computeGithubPluginMcpImportPlan({
    githubUrl: input.githubUrl,
    organizationId: isPluginArchOrgAdmin(input.context) ? input.context.organizationContext.organization.id : undefined,
  })
}

export async function configureMarketplacePluginMcpRequirement(input: {
  apiKey?: string
  authType: PluginMcpRequirementAuthType
  configObjectId: ConfigObjectId
  context: PluginArchActorContext
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  pluginId: PluginId
  serverName: string
}) {
  validatePluginMcpRequirementAuth(input)
  const organizationId = input.context.organizationContext.organization.id
  const requirement = await activePluginMcpRequirement({
    configObjectId: input.configObjectId,
    organizationId,
    pluginId: input.pluginId,
  })
  const versions = await getLatestVersions([requirement.configObject.id])
  const version = versions.get(requirement.configObject.id)
  if (!version) {
    throw new PluginArchRouteFailure(409, "mcp_requirement_not_synced", "MCP config object has no active version to configure.")
  }

  const server = mcpRequirementServerFromVersion({
    configObject: requirement.configObject,
    serverName: input.serverName,
    version,
  })
  const declaredRequiredAuthType = requiredPluginMcpAuthType({
    declaredAuthType: declaredPluginMcpAuthType(server.config),
    url: server.url,
  })
  if (!pluginMcpAuthTypeCompatible({ authType: input.authType, requiredAuthType: declaredRequiredAuthType, url: server.url })) {
    throw new PluginArchRouteFailure(
      409,
      "mcp_auth_type_mismatch",
      declaredRequiredAuthType
        ? `This MCP requirement must use ${declaredRequiredAuthType} authentication.`
        : "This authentication type is not supported by the MCP server.",
    )
  }
  const requiredAuthType = declaredRequiredAuthType ?? input.authType
  await assertRemotePluginMcpUrl(server.url)
  const credentialMode = expectedMcpRequirementCredentialMode(input)
  const apiKey = normalizedPluginMcpApiKey(input.apiKey)
  const access = await derivePluginMcpRequirementAccess({
    configObjectId: requirement.configObject.id,
    organizationId,
    pluginId: requirement.plugin.id,
  })
  const previousBinding = (await listPluginMcpRequirementBindings({
    configObjectIds: [requirement.configObject.id],
    organizationId,
  })).find((candidate) => candidate.pluginId === requirement.plugin.id && candidate.serverName === server.name)
  const connectionResult = await createOrReusePluginMcpRequirementConnection({
    access,
    apiKey,
    authType: input.authType,
    context: input.context,
    credentialMode,
    oauthClient: input.oauthClient,
    plugin: requirement.plugin,
    server,
  })
  const connection = connectionResult.connection

  try {
    await validateConfiguredPluginMcpConnection({ authType: input.authType, connection })
  } catch (error) {
    if (connectionResult.created) {
      await deleteExternalMcpConnection({ connectionId: connection.id, organizationId })
    }
    throw error
  }

  if (input.oauthClient) {
    const existingClient = await getOrgOAuthClient(organizationId, connection.id)
    if (!existingClient) {
      await upsertOrgOAuthClient({
        organizationId,
        providerId: connection.id,
        clientId: input.oauthClient.clientId,
        clientSecret: input.oauthClient.clientSecret ?? null,
        createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      })
    }
  }

  const binding = await upsertPluginMcpRequirementBinding({
    configObjectId: requirement.configObject.id,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    externalMcpConnectionId: connection.id,
    organizationId,
    pluginId: requirement.plugin.id,
    serverName: server.name,
    requiredAuthType,
    connectionOwnedByPlugin: connectionResult.created || Boolean(
      previousBinding?.externalMcpConnectionId === connection.id && previousBinding.connectionOwnedByPlugin
    ),
  })
  await syncPluginMcpRequirementBindingAccess(binding)
  const replacedOwnedConnectionId = previousBinding
    && previousBinding.externalMcpConnectionId !== connection.id
    && (previousBinding.connectionOwnedByPlugin
      || configVersionOwnsImportedExternalMcpConnection(version, previousBinding.externalMcpConnectionId))
    ? previousBinding.externalMcpConnectionId
    : null
  if (replacedOwnedConnectionId) {
    await deleteExternalMcpConnectionIfUnreferenced({ connectionId: replacedOwnedConnectionId, organizationId })
  }
  const refreshedConnection = await getExternalMcpConnection({ connectionId: connection.id, organizationId })

  return {
    binding: serializePluginMcpRequirementBinding(binding),
    connection: serializePluginMcpRequirementConnection(refreshedConnection ?? connection),
    links: {
      yourConnections: openworkYourConnectionsUrl(connection.id),
    },
  }
}

async function grantImportAccessToPluginArchResource(input: {
  access: GithubPluginMcpImportAccess
  context: PluginArchActorContext
} & (
  | { resourceId: ConfigObjectId; resourceKind: "config_object" }
  | { resourceId: PluginId; resourceKind: "plugin" }
)) {
  const grant = async (value: AccessGrantWrite) => {
    if (input.resourceKind === "plugin") {
      await createResourceAccessGrant({
        context: input.context,
        resourceId: input.resourceId,
        resourceKind: "plugin",
        value,
      })
      return
    }
    await createResourceAccessGrant({
      context: input.context,
      resourceId: input.resourceId,
      resourceKind: "config_object",
      value,
    })
  }

  if (input.access.orgWide) {
    await grant({ orgWide: true, role: "viewer" })
    return
  }

  for (const memberId of input.access.memberIds) {
    await grant({ orgMembershipId: memberId, role: "viewer" })
  }
  for (const teamId of input.access.teamIds) {
    await grant({ role: "viewer", teamId })
  }
}

type ImportedGithubObject = {
  id: ConfigObjectId
  mcpUrlKeys: string[]
  objectType: "mcp" | "skill"
  rawSourceText: string | null
  /** The repository path a GitHub import read it from; null for objects added by hand or imported before provenance was kept. */
  sourcePath: string | null
  title: string
}

// Keys that survive a re-import when an object has no recorded source path:
// a skill's name (its SKILL.md frontmatter name, stored as the title) and an
// MCP server's URL.
function importedSkillKey(name: string) {
  return `skill:${name.trim().toLowerCase()}`
}

function importedMcpKey(url: string) {
  return `mcp:${comparablePluginMcpRequirementUrl(url)}`
}

/**
 * Where a GitHub-imported object came from, as a repository path: the skill's
 * SKILL.md, or the `.mcp.json` plus `#<server name>`. Stored as the config
 * object's current relative path (the column GitHub connector sync uses for
 * the same thing). Null when it does not fit the column.
 */
function githubImportSourcePath(plan: Pick<GithubPluginMcpImportPlan, "rootPath">, sourcePath: string, serverName?: string) {
  const path = `${plan.rootPath ? `${plan.rootPath}/` : ""}${sourcePath}${serverName === undefined ? "" : `#${serverName}`}`
  return path.length <= 255 ? path : null
}

function isWithinGithubImportRoot(plan: Pick<GithubPluginMcpImportPlan, "rootPath">, path: string) {
  return !plan.rootPath || path.startsWith(`${plan.rootPath}/`)
}

async function findPreviouslyImportedGithubPlugin(input: { context: PluginArchActorContext; name: string; sourceRepositoryUrl: string }) {
  const rows = await db
    .select({ id: PluginTable.id })
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, input.context.organizationContext.organization.id),
      eq(PluginTable.createdByOrgMembershipId, input.context.organizationContext.currentMember.id),
      eq(PluginTable.name, input.name.trim()),
      eq(PluginTable.sourceRepositoryUrl, input.sourceRepositoryUrl),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
    .orderBy(asc(PluginTable.createdAt), asc(PluginTable.id))
    .limit(1)
  return rows[0] ?? null
}

/** The skills and MCP servers already in a plugin, with what a re-import matches on. */
async function importedGithubObjects(context: PluginArchActorContext, pluginId: PluginId): Promise<ImportedGithubObject[]> {
  const organizationId = context.organizationContext.organization.id
  const objects = await db
    .select({
      currentRelativePath: ConfigObjectTable.currentRelativePath,
      id: ConfigObjectTable.id,
      objectType: ConfigObjectTable.objectType,
      sourceMode: ConfigObjectTable.sourceMode,
      title: ConfigObjectTable.title,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, organizationId),
      eq(PluginConfigObjectTable.pluginId, pluginId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
  const versions = await getLatestVersions(objects.map((object) => object.id))
  const result: ImportedGithubObject[] = []
  for (const object of objects) {
    if (object.objectType !== "skill" && object.objectType !== "mcp") continue
    const version = versions.get(object.id)
    const payload = version && isRecord(version.normalizedPayloadJson) ? version.normalizedPayloadJson : null
    const servers = payload && isRecord(payload.mcpServers) ? Object.values(payload.mcpServers).filter(isRecord) : []
    result.push({
      id: object.id,
      mcpUrlKeys: object.objectType === "mcp"
        ? servers.flatMap((server) => typeof server.url === "string" ? [importedMcpKey(server.url)] : [])
        : [],
      objectType: object.objectType,
      rawSourceText: object.objectType === "skill" ? version?.rawSourceText ?? null : null,
      // Only a GitHub import's own objects carry a source path it may prune by.
      sourcePath: object.sourceMode === "import" ? object.currentRelativePath?.trim() || null : null,
      title: object.title,
    })
  }
  return result
}

async function recordGithubImportSourcePath(object: ImportedGithubObject, sourcePath: string | null) {
  if (!sourcePath || object.sourcePath) return
  await db.update(ConfigObjectTable).set({ currentRelativePath: sourcePath }).where(and(
    eq(ConfigObjectTable.id, object.id),
    eq(ConfigObjectTable.sourceMode, "import"),
  ))
}

/**
 * Takes a component deleted upstream out of a re-imported plugin: its
 * membership is marked removed and, unless another plugin still uses it, the
 * object is archived. Both can be undone. An MCP server's requirement binding
 * goes with it; a connection created for this plugin is deleted only when
 * nothing else references it.
 */
async function removeGithubImportedObject(input: { context: PluginArchActorContext; object: ImportedGithubObject; pluginId: PluginId }) {
  const organizationId = input.context.organizationContext.organization.id
  const ownedBindings = await db
    .select({ connectionId: PluginMcpRequirementBindingTable.externalMcpConnectionId })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
      eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
      eq(PluginMcpRequirementBindingTable.configObjectId, input.object.id),
      eq(PluginMcpRequirementBindingTable.connectionOwnedByPlugin, true),
    ))
  await removeConfigObjectFromPlugin({ configObjectId: input.object.id, context: input.context, pluginId: input.pluginId })
  const otherMemberships = await db
    .select({ id: PluginConfigObjectTable.id })
    .from(PluginConfigObjectTable)
    .where(and(
      eq(PluginConfigObjectTable.organizationId, organizationId),
      eq(PluginConfigObjectTable.configObjectId, input.object.id),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .limit(1)
  if (!otherMemberships[0]) {
    await setConfigObjectLifecycle({ action: "archive", configObjectId: input.object.id, context: input.context })
  }
  for (const connectionId of new Set(ownedBindings.map((binding) => binding.connectionId))) {
    await deleteExternalMcpConnectionIfUnreferenced({ connectionId, organizationId }).catch(() => undefined)
  }
}

export async function importGithubPluginMcps(input: {
  access?: GithubPluginMcpImportAccess
  authType: "none" | "oauth"
  context: PluginArchActorContext
  credentialMode: "per_member" | "shared"
  description?: string | null
  githubUrl: string
  marketplaceId?: MarketplaceId
  name?: string
  selectedSkillKeys?: string[]
  selectedServerKeys?: string[]
  selectedServerNames?: string[]
}) {
  if (!isPluginArchOrgAdmin(input.context)) {
    throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can import plugins from GitHub.")
  }

  if (input.marketplaceId) {
    await ensureEditableMarketplace(input.context, input.marketplaceId)
  }
  const plan = await computeGithubPluginMcpImportPlan({
    githubUrl: input.githubUrl,
    includeSkillText: true,
    organizationId: input.context.organizationContext.organization.id,
  })
  const selectedSkillKeys = new Set(input.selectedSkillKeys?.map((key) => key.trim()).filter(Boolean) ?? [])
  const selectedServerKeys = new Set(input.selectedServerKeys?.map((key) => key.trim()).filter(Boolean) ?? [])
  const selectedServerNames = new Set(input.selectedServerNames?.map((name) => name.trim()).filter(Boolean) ?? [])
  const consideredServers = selectedServerKeys.size > 0
    ? plan.servers.filter((server) => selectedServerKeys.has(server.serverKey))
    : selectedServerNames.size > 0
    ? plan.servers.filter((server) => selectedServerNames.has(server.name))
    : plan.servers
  // Omitted means every skill, like servers; an explicit [] imports none.
  const consideredSkills = input.selectedSkillKeys === undefined
    ? plan.skills
    : plan.skills.filter((skill) => selectedSkillKeys.has(skill.skillKey))
  const supportedServers = consideredServers.filter((server) => server.supported && server.url)
  const supportedSkills = consideredSkills.filter((skill) => skill.supported && skill.rawSourceText)
  if (supportedServers.length === 0 && supportedSkills.length === 0) {
    throw new PluginArchRouteFailure(400, "no_supported_plugin_components", "No supported remote MCP servers or skills were selected from that plugin.")
  }

  const access = input.access ?? {
    memberIds: [],
    orgWide: true,
    teamIds: [],
  }
  if (!access.orgWide && access.memberIds.length === 0 && access.teamIds.length === 0) {
    throw new PluginArchRouteFailure(400, "missing_import_access", "Choose who can use the imported plugin.")
  }
  const pluginName = input.name ?? importedPluginName(plan)
  const sourceRepositoryUrl = `https://github.com/${plan.repositoryFullName}`
  // Re-running an import (a migration agent retrying, or picking up upstream
  // changes) updates the plugin imported earlier from the same repository
  // instead of failing as a duplicate.
  const previous = await findPreviouslyImportedGithubPlugin({ context: input.context, name: pluginName, sourceRepositoryUrl })
  const plugin = previous ?? await createPlugin({
    context: input.context,
    description: input.description === undefined
      ? `Plugin components imported from ${plan.repositoryFullName}${plan.rootPath ? `/${plan.rootPath}` : ""}.`
      : input.description,
    name: pluginName,
    sourceFormat: plan.classification === "agent_plugin_repo" ? "agent-plugin" : "claude-plugin",
    sourceRepositoryUrl,
    sourceSchemaVersion: plan.classification === "agent_plugin_repo" ? plan.sourceSchemaVersion : null,
  })
  // Match what is already in the plugin by its recorded source path first,
  // then by the keys older imports can still be matched on.
  const existingObjects = previous ? await importedGithubObjects(input.context, previous.id) : []
  const existingBySourcePath = new Map<string, ImportedGithubObject>()
  const existingByKey = new Map<string, ImportedGithubObject>()
  for (const object of existingObjects) {
    if (object.sourcePath) existingBySourcePath.set(object.sourcePath, object)
    if (object.objectType === "skill") existingByKey.set(importedSkillKey(object.title), object)
    for (const key of object.mcpUrlKeys) existingByKey.set(key, object)
  }
  const matchedObjectIds = new Set<ConfigObjectId>()

  const importedOwnedConnectionIds = new Set<ExternalMcpConnectionRow["id"]>()
  try {
    if (!previous) {
      await grantImportAccessToPluginArchResource({
        access,
        context: input.context,
        resourceId: plugin.id,
        resourceKind: "plugin",
      })
    }

  const imported: Array<{ connectionId: string; connectionName: string; existingConnection: boolean; name: string; url: string }> = []
  const importedSkills: Array<{ configObjectId: ConfigObjectId; name: string; sourcePath: string }> = []
  const updatedSkills: Array<{ configObjectId: ConfigObjectId; name: string; sourcePath: string }> = []
  const unchanged: Array<{ name: string; objectType: "mcp" | "skill" }> = []
  const removed: Array<{ configObjectId: ConfigObjectId; name: string; objectType: "mcp" | "skill"; sourcePath: string }> = []
  for (const server of supportedServers) {
    const sourcePath = githubImportSourcePath(plan, server.sourcePath, server.name)
    // A server is the same server while its URL is: a changed URL is a new
    // connection, and the old object is pruned below as gone upstream.
    const existingServer = server.url ? existingByKey.get(importedMcpKey(server.url)) : undefined
    if (existingServer?.objectType === "mcp") {
      matchedObjectIds.add(existingServer.id)
      await recordGithubImportSourcePath(existingServer, sourcePath)
      unchanged.push({ name: server.name, objectType: "mcp" })
      continue
    }
    const defaultAuthType = resolveGithubPluginMcpImportAuthType({
      declaredAuthType: server.authType,
      requestedAuthType: input.authType,
      url: server.url ?? "",
    })
    const importedConnection = await ensureImportedExternalMcpConnection({
      access,
      authType: defaultAuthType,
      context: input.context,
      credentialMode: input.credentialMode,
      server,
    })
    const connection = importedConnection.connection
    const authType = connection.authType
    if (importedConnection.ownedByImportedPlugin) importedOwnedConnectionIds.add(connection.id)
    const payload = importedConnectionBackedMcpPayload({
      authType,
      connectionId: connection.id,
      // Claude/Cowork plugins list connectors as suggestions ("connect one
      // of these"); their skills work without them. Agent Plugins declare
      // what they need, so those stay required.
      optional: plan.classification !== "agent_plugin_repo",
      ownedByImportedPlugin: importedConnection.ownedByImportedPlugin,
      server,
    })
    const configObject = await createConfigObject({
      context: input.context,
      objectType: "mcp",
      pluginIds: [plugin.id],
      sourceMode: "import",
      sourcePath,
      value: {
        metadata: {
          description: `Den-hosted MCP connection imported from ${server.sourcePath}.`,
          externalMcpConnectionId: connection.id,
          externalMcpConnectionOwnedByPlugin: importedConnection.ownedByImportedPlugin,
          requiredAuthType: authType,
          githubUrl: input.githubUrl,
          name: externalMcpConnectionName({ pluginName: server.pluginName, serverName: server.name }),
          openworkManaged: "den_external_mcp",
          repositoryFullName: plan.repositoryFullName,
          sourceFormat: plan.classification === "agent_plugin_repo" ? "agent-plugin" : "claude-plugin",
          sourceSchemaVersion: server.sourceSchemaVersion,
          sourcePath: server.sourcePath,
        },
        normalizedPayloadJson: payload,
        schemaVersion: "openwork.den_external_mcp.v1",
      },
    })
    await upsertPluginMcpRequirementBinding({
      configObjectId: configObject.id,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      externalMcpConnectionId: connection.id,
      organizationId: input.context.organizationContext.organization.id,
      pluginId: plugin.id,
      serverName: slugifyPluginMcpName(server.name),
      requiredAuthType: authType,
      connectionOwnedByPlugin: importedConnection.ownedByImportedPlugin,
    })
    await grantImportAccessToPluginArchResource({
      access,
      context: input.context,
      resourceId: configObject.id,
      resourceKind: "config_object",
    })
    imported.push({
      connectionId: connection.id,
      connectionName: connection.name,
      existingConnection: !importedConnection.ownedByImportedPlugin,
      name: server.name,
      url: server.url ?? "",
    })
  }

  for (const skill of supportedSkills) {
    const skillText = skill.rawSourceText
    if (!skillText) {
      throw new PluginArchRouteFailure(400, "invalid_skill_import", "Selected skill content was unavailable.")
    }
    const metadata = skillMetadataFromText(skillText)
    const sourcePath = githubImportSourcePath(plan, skill.sourcePath)
    const byPath = sourcePath ? existingBySourcePath.get(sourcePath) : undefined
    const byName = existingByKey.get(importedSkillKey(metadata.title))
    const existingSkill = byPath?.objectType === "skill" ? byPath : byName?.objectType === "skill" ? byName : undefined
    if (existingSkill) {
      matchedObjectIds.add(existingSkill.id)
      await recordGithubImportSourcePath(existingSkill, sourcePath)
      // Stored text is trimmed on write; compare the same way.
      if (existingSkill.rawSourceText?.trim() === skillText.trim()) {
        unchanged.push({ name: metadata.title, objectType: "skill" })
        continue
      }
      await createConfigObjectVersion({
        context: input.context,
        configObjectId: existingSkill.id,
        reason: `Re-imported from ${input.githubUrl}`,
        value: { rawSourceText: skillText },
      })
      updatedSkills.push({ configObjectId: existingSkill.id, name: metadata.title, sourcePath: skill.sourcePath })
      continue
    }
    const configObject = await createConfigObject({
      context: input.context,
      objectType: "skill",
      pluginIds: [plugin.id],
      sourceMode: "import",
      sourcePath,
      value: {
        metadata: {
          description: metadata.description ?? `Skill imported from ${skill.sourcePath}.`,
          githubUrl: input.githubUrl,
          name: metadata.title,
          repositoryFullName: plan.repositoryFullName,
          sourceFormat: plan.classification === "agent_plugin_repo" ? "agent-plugin" : "claude-plugin",
          sourceSchemaVersion: skill.sourceSchemaVersion,
          sourcePath: skill.sourcePath,
        },
        rawSourceText: skillText,
      },
    })
    await grantImportAccessToPluginArchResource({
      access,
      context: input.context,
      resourceId: configObject.id,
      resourceKind: "config_object",
    })
    importedSkills.push({ configObjectId: configObject.id, name: metadata.title, sourcePath: skill.sourcePath })
  }

  // Prune what was deleted upstream. Presence is judged against everything the
  // repository still has, not only what this call selected, so leaving a skill
  // unselected never removes it. Objects without a recorded source path (added
  // by hand) and paths outside this import's folder are never touched, and a
  // truncated GitHub tree is not trusted to say a file is gone.
  if (previous && !plan.treeTruncated) {
    const upstreamSkillPaths = new Set(plan.skills.flatMap((skill) => githubImportSourcePath(plan, skill.sourcePath) ?? []))
    const upstreamSkillKeys = new Set(plan.skills.map((skill) => importedSkillKey(skill.name)))
    const upstreamMcpKeys = new Set(plan.servers.flatMap((server) => server.url ? [importedMcpKey(server.url)] : []))
    for (const object of existingObjects) {
      if (!object.sourcePath || matchedObjectIds.has(object.id) || !isWithinGithubImportRoot(plan, object.sourcePath)) continue
      const stillUpstream = object.objectType === "skill"
        ? upstreamSkillPaths.has(object.sourcePath) || upstreamSkillKeys.has(importedSkillKey(object.title))
        : object.mcpUrlKeys.some((key) => upstreamMcpKeys.has(key))
      if (stillUpstream) continue
      await removeGithubImportedObject({ context: input.context, object, pluginId: plugin.id })
      // An MCP object's title is its connection name; report the server name it was imported as.
      const name = object.objectType === "mcp" ? object.sourcePath.split("#").slice(1).join("#") || object.title : object.title
      removed.push({ configObjectId: object.id, name, objectType: object.objectType, sourcePath: object.sourcePath })
    }
  }

  if (input.marketplaceId && !previous) {
    await attachPluginToMarketplace({
      context: input.context,
      marketplaceId: input.marketplaceId,
      membershipSource: "api",
      pluginId: plugin.id,
    })
  }

  const skipped = consideredServers.flatMap((server) =>
    server.supported || !server.skippedReason ? [] : [{ mapsTo: server.mapsTo, name: server.name, reason: server.skippedReason, reuse: server.reuse }])
  const skippedSkills = consideredSkills.flatMap((skill) =>
    skill.supported || !skill.skippedReason ? [] : [{ name: skill.name, reason: skill.skippedReason, sourcePath: skill.sourcePath }])

  return {
    imported,
    importedSkills,
    marketplaceId: input.marketplaceId ?? null,
    mode: previous ? "updated" as const : "created" as const,
    plugin: await getPluginDetail(input.context, plugin.id),
    removed,
    skipped,
    skippedSkills,
    unchanged,
    updatedSkills,
  }
  } catch (error) {
    // Never tear down a plugin that existed before this import.
    if (previous) throw error
    await deletePluginMcpRequirementBindingsForPlugin({
      organizationId: input.context.organizationContext.organization.id,
      pluginId: plugin.id,
    }).catch(() => undefined)
    for (const connectionId of importedOwnedConnectionIds) {
      await deleteExternalMcpConnectionIfUnreferenced({
        organizationId: input.context.organizationContext.organization.id,
        connectionId,
      }).catch(() => undefined)
    }
    await setPluginLifecycle({ action: "archive", context: input.context, pluginId: plugin.id }).catch(() => undefined)
    throw error
  }
}
