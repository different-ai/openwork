import { createHash } from "node:crypto"
import { and, asc, count, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectedAccountTable,
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSourceBindingTable,
  ConnectorSourceTombstoneTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  ExternalMcpOAuthTransactionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  OrgOAuthClientTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
  SkillHubMemberTable,
  SkillHubSkillTable,
  SkillHubTable,
  SkillTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { hasSkillFrontmatterName, parseSkillMarkdown } from "@openwork-ee/utils"
import type { PluginArchActorContext, PluginArchResourceKind, PluginArchRole } from "./access.js"
import { requirePluginArchResourceRole, resolvePluginArchResourceRole } from "./access.js"
import {
  buildGithubAppInstallUrl,
  createGithubInstallStateToken,
  fetchGithubImportFilesWithRevisionGuard,
  GithubConnectorConfigError,
  GithubConnectorRequestError,
  getGithubAppSummary,
  getGithubConnectorAppConfig,
  getGithubInstallationAccessToken,
  getGithubRepositoryHeadSha,
  getGithubRepositoryTextFile,
  getGithubRepositoryTree,
  getGithubInstallationSummary,
  listGithubInstallationRepositories,
  validateGithubInstallationTarget,
  verifyGithubInstallStateToken,
} from "./github-app.js"
import {
  buildGithubRepoDiscovery,
  type GithubDiscoveredPlugin,
  type GithubDiscoveryClassification,
  type GithubMarketplaceInfo,
  type GithubDiscoveryTreeEntry,
} from "./github-discovery.js"
import { planConnectorImportedResourceCleanup, uniqueIds } from "./connector-cleanup.js"
import {
  DEFAULT_ANTHROPIC_MARKETPLACE_DESCRIPTION,
  DEFAULT_ANTHROPIC_MARKETPLACE_LOGO_URL,
  DEFAULT_ANTHROPIC_MARKETPLACE_NAME,
  DEFAULT_ANTHROPIC_STARTER_PLUGINS,
  DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
  DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
  DEFAULT_OPENWORK_MARKETPLACE_NAME,
  type DefaultMarketplacePluginEntry,
} from "./default-marketplaces.js"
import { db } from "../../../db.js"
import { env } from "../../../env.js"
import { appLogger } from "../../../observability/logger.js"
import { appendPublicApiPath } from "../../../request-url.js"
import { roleIncludesOwner } from "../../../orgs.js"
import { memberFacingMcpConnectionsEnabled } from "../../../capability-sources/external-mcp-rollout.js"
import {
  discoverExternalMcpConfiguration,
  inferExternalMcpManifestConfiguration,
  type ExternalMcpConfigurationDiscovery,
} from "../../../capability-sources/external-mcp-discovery.js"
import { isSensitiveExternalMcpCredentialKey } from "../../../capability-sources/external-mcp-input-safety.js"
import { comparablePluginMcpRequirementUrl, marketplaceMcpServerEntries, resolveMarketplacePluginCloudReadiness } from "../../../mcp/marketplace-capabilities.js"
import { assertPublicUrl } from "../../../capability-sources/url-guard.js"
import {
  compareAndSetExternalMcpOAuthClient,
  createExternalMcpConnection,
  deleteExternalMcpConnection,
  deleteExternalMcpConnectionIfUnused,
  getExternalMcpConnection,
  listExternalMcpConnections,
  normalizeExternalMcpRequestedOAuthScopes,
  replaceExternalMcpConnectionAccessForPluginBinding,
  type ExternalMcpOAuthClientRevision,
  type ExternalMcpOAuthClientValue,
} from "../../../capability-sources/external-mcp-connections.js"
import { connectExternalMcp } from "../../../capability-sources/external-mcp-client-runtime.js"
import { createExternalMcpLifecycleDeadline, externalMcpPreRegisteredClientExtra } from "../../../capability-sources/external-mcp-client.js"
import {
  externalMcpDiagnosticForLog,
  externalMcpDiagnosticForResponse,
  safeExternalMcpEndpointForLog,
} from "../../../capability-sources/external-mcp-diagnostics.js"
import { getOrgOAuthClient } from "../../../capability-sources/oauth-credentials.js"
import {
  deletePluginMcpRequirementBindingsByIds,
  deletePluginMcpRequirementBindingsForPluginConfigObject,
  PluginMcpRequirementConnectionMissingError,
  upsertPluginMcpRequirementBinding,
  type PluginMcpRequirementBindingRow,
} from "../../../mcp/plugin-mcp-requirement-bindings.js"
import { openworkYourConnectionsUrl } from "../../../mcp/connection-navigation.js"
import {
  assertPublicGithubTreeWithinLimits,
  createPublicGithubRequestBudget,
  decodePublicGithubBase64File,
  PUBLIC_GITHUB_IMPORT_LIMITS,
  PublicGithubRequestError,
  requestPublicGithubJson as requestBoundedPublicGithubJson,
  resolvePublicGithubRefAndPath,
  type PublicGithubRequestBudget,
} from "./public-github.js"

type OrganizationId = PluginArchActorContext["organizationContext"]["organization"]["id"]
const logger = appLogger.child({ component: "plugin_system_store" })
type MemberId = PluginArchActorContext["organizationContext"]["currentMember"]["id"]
type TeamId = PluginArchActorContext["memberTeams"][number]["id"]
type ConfigObjectRow = typeof ConfigObjectTable.$inferSelect
type ConfigObjectVersionRow = typeof ConfigObjectVersionTable.$inferSelect
type MarketplaceRow = typeof MarketplaceTable.$inferSelect
type MarketplaceMembershipRow = typeof MarketplacePluginTable.$inferSelect
type PluginRow = typeof PluginTable.$inferSelect
type PluginMembershipRow = typeof PluginConfigObjectTable.$inferSelect
type ConfigObjectId = ConfigObjectRow["id"]
type ConfigObjectVersionId = ConfigObjectVersionRow["id"]
type MarketplaceId = MarketplaceRow["id"]
type MarketplaceMembershipId = MarketplaceMembershipRow["id"]
type PluginId = PluginRow["id"]
type PluginMembershipId = PluginMembershipRow["id"]
type SkillId = typeof SkillTable.$inferSelect.id
type AccessGrantRow =
  | typeof ConfigObjectAccessGrantTable.$inferSelect
  | typeof MarketplaceAccessGrantTable.$inferSelect
  | typeof PluginAccessGrantTable.$inferSelect
  | typeof ConnectorInstanceAccessGrantTable.$inferSelect
type ConfigObjectAccessGrantId = typeof ConfigObjectAccessGrantTable.$inferSelect.id
type MarketplaceAccessGrantId = typeof MarketplaceAccessGrantTable.$inferSelect.id
type PluginAccessGrantId = typeof PluginAccessGrantTable.$inferSelect.id
type ConnectorInstanceAccessGrantId = typeof ConnectorInstanceAccessGrantTable.$inferSelect.id
type ConnectorAccountRow = typeof ConnectorAccountTable.$inferSelect
type ConnectorInstanceRow = typeof ConnectorInstanceTable.$inferSelect
type ConnectorTargetRow = typeof ConnectorTargetTable.$inferSelect
type ConnectorMappingRow = typeof ConnectorMappingTable.$inferSelect
type ConnectorSyncEventRow = typeof ConnectorSyncEventTable.$inferSelect
type ConnectorAccountId = ConnectorAccountRow["id"]
type ConnectorInstanceId = ConnectorInstanceRow["id"]
type ConnectorTargetId = ConnectorTargetRow["id"]
type ConnectorMappingId = ConnectorMappingRow["id"]
type ConnectorSyncEventId = ConnectorSyncEventRow["id"]
type MemberRow = typeof MemberTable.$inferSelect
type OrganizationRow = typeof OrganizationTable.$inferSelect
type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
type PluginMcpRequirementBindingId = PluginMcpRequirementBindingRow["id"]
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type CursorPage<TItem extends { id: string }> = {
  items: TItem[]
  nextCursor: string | null
}

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

type GithubDiscoveryImportPlan = {
  fileShaByPath?: Record<string, string>
  objectType: ConnectorMappingRow["objectType"]
  paths: string[]
  selector: string
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

type PublicGithubPluginTarget = {
  canonicalUrl: string
  refAndPathSegments: string[] | null
  repositoryFullName: string
}

type PublicGithubTreeSnapshot = {
  branch: string
  budget: PublicGithubRequestBudget
  fullPathByDiscoveryPath: Map<string, string>
  headSha: string
  repositoryFullName: string
  rootPath: string
  textByDiscoveryPath: Map<string, string | null>
  treeEntries: GithubDiscoveryTreeEntry[]
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

type GithubPluginMcpImportServer = {
  authType: "apikey" | "none" | "oauth" | "unknown"
  connectionId: string | null
  discovery: ExternalMcpConfigurationDiscovery | null
  name: string
  pluginKey: string
  pluginName: string
  serverKey: string
  skippedReason: "missing_url" | "local_unsupported" | "invalid_url" | "unsupported_auth" | "unsupported_configuration" | null
  sourcePath: string
  supported: boolean
  url: string | null
}

type GithubPluginMcpImportServerConfiguration = {
  apiKey?: string
  authType: PluginMcpRequirementAuthType
  credentialMode?: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  serverKey: string
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
  sourceRevisionRef: string
  warnings: string[]
}

type ConfigObjectInput = {
  metadata?: Record<string, unknown>
  normalizedPayloadJson?: Record<string, unknown>
  parserMode?: string
  rawSourceText?: string
  schemaVersion?: string
  sourceRevisionRef?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

type AccessGrantWrite = {
  orgMembershipId?: MemberId
  orgWide?: boolean
  role: PluginArchRole
  teamId?: TeamId
}

type RepositorySummary = {
  defaultBranch: string | null
  fullName: string
  hasPluginManifest?: boolean
  id: number
  manifestKind?: "marketplace" | "plugin" | null
  marketplacePluginCount?: number | null
  private: boolean
}

type ConfigObjectResourceTarget = {
  resourceId: ConfigObjectId
  resourceKind: "config_object"
}

type PluginResourceTarget = {
  resourceId: PluginId
  resourceKind: "plugin"
}

type MarketplaceResourceTarget = {
  resourceId: MarketplaceId
  resourceKind: "marketplace"
}

type ConnectorInstanceResourceTarget = {
  resourceId: ConnectorInstanceId
  resourceKind: "connector_instance"
}

type ResourceTarget =
  | ConfigObjectResourceTarget
  | MarketplaceResourceTarget
  | PluginResourceTarget
  | ConnectorInstanceResourceTarget

type ConfigObjectGrantTarget = ConfigObjectResourceTarget & { grantId: ConfigObjectAccessGrantId }
type MarketplaceGrantTarget = MarketplaceResourceTarget & { grantId: MarketplaceAccessGrantId }
type PluginGrantTarget = PluginResourceTarget & { grantId: PluginAccessGrantId }
type ConnectorInstanceGrantTarget = ConnectorInstanceResourceTarget & { grantId: ConnectorInstanceAccessGrantId }
type GrantTarget = ConfigObjectGrantTarget | MarketplaceGrantTarget | PluginGrantTarget | ConnectorInstanceGrantTarget

export class PluginArchRouteFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly error: string,
    message: string,
  ) {
    super(message)
    this.name = "PluginArchRouteFailure"
  }
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function firstTextLine(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? ""
}

function stripLineDecorators(value: string) {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim()
}

const MAX_PUBLIC_GITHUB_SOURCE_PATH_LENGTH = 2_048
const MAX_PUBLISHER_NAME_LENGTH = 255
const MAX_IMPORTED_MCP_URL_LENGTH = 2_048

function normalizeGithubPath(value: string) {
  return value.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

function safePublicGithubPath(value: string): string | null {
  const normalized = normalizeGithubPath(value)
  if (!normalized || normalized.length > MAX_PUBLIC_GITHUB_SOURCE_PATH_LENGTH) return null
  const segments = normalized.split("/")
  if (segments.some((segment) => !segment
    || segment === "."
    || segment === ".."
    || segment.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(segment))) return null
  return normalized
}

function decodeSafeGithubUrlSegment(value: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return null
  }
  if (!decoded
    || decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(decoded)) return null
  return decoded
}

function boundedPublisherName(value: string | null | undefined, fallback: string) {
  const bounded = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PUBLISHER_NAME_LENGTH)
  return bounded || fallback.slice(0, MAX_PUBLISHER_NAME_LENGTH)
}

export function parsePublicGithubPluginUrl(rawUrl: string): PublicGithubPluginTarget {
  const normalizedRawUrl = rawUrl.trim()
  let url: URL
  try {
    url = new URL(normalizedRawUrl)
  } catch {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "Enter a valid GitHub URL.")
  }

  const authority = normalizedRawUrl.match(/^https:\/\/([^/?#]*)/i)?.[1]?.toLowerCase()
  if (url.protocol !== "https:" || (authority !== "github.com" && authority !== "www.github.com")) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "Use an HTTPS github.com URL without a port or embedded credentials.")
  }
  if (url.search || url.hash || normalizedRawUrl.includes("?") || normalizedRawUrl.includes("#")) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub plugin URLs must not contain query parameters or fragments.")
  }

  const encodedSegments = url.pathname.split("/").filter(Boolean)
  const segments = encodedSegments.map(decodeSafeGithubUrlSegment)
  if (segments.some((segment) => segment === null)) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub plugin URLs contain an unsupported path segment.")
  }
  const [rawOwner, rawRepoWithSuffix] = segments as string[]
  const owner = rawOwner?.toLowerCase()
  const rawRepo = rawRepoWithSuffix?.toLowerCase()
  if (!owner || !rawRepo) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub URL must include an owner and repository.")
  }

  const repo = rawRepo.replace(/\.git$/i, "")
  if (!repo
    || owner.length > 39
    || repo.length > 100
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(owner)
    || !/^[a-z0-9._-]+$/.test(repo)) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub URL must include a repository.")
  }

  if (segments.length === 2) {
    return {
      canonicalUrl: `https://github.com/${owner}/${repo}`,
      refAndPathSegments: null,
      repositoryFullName: `${owner}/${repo}`,
    }
  }

  if (segments[2] !== "tree") {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "Use a GitHub repository or tree URL, for example /tree/main/sales.")
  }

  const refAndPathSegments = (segments as string[]).slice(3)
  if (refAndPathSegments.length === 0) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub tree URL must include a branch.")
  }
  const canonicalSuffix = refAndPathSegments.map(encodeURIComponent).join("/")

  return {
    canonicalUrl: `https://github.com/${owner}/${repo}/tree/${canonicalSuffix}`,
    refAndPathSegments,
    repositoryFullName: `${owner}/${repo}`,
  }
}

async function requestPublicGithubJson(input: {
  allowStatuses?: number[]
  budget: PublicGithubRequestBudget
  maxResponseBytes?: number
  path: string
}) {
  try {
    return await requestBoundedPublicGithubJson(input)
  } catch (error) {
    if (error instanceof PublicGithubRequestError) {
      throw new PluginArchRouteFailure(error.status, error.code, error.message)
    }
    throw error
  }
}

function publicGithubRepoParts(repositoryFullName: string) {
  const [owner, repo, ...rest] = repositoryFullName.split("/")
  if (!owner || !repo || rest.length > 0) {
    throw new PluginArchRouteFailure(400, "invalid_github_url", "GitHub repository name is invalid.")
  }
  return { owner, repo }
}

async function getPublicGithubRepositoryInfo(repositoryFullName: string, budget: PublicGithubRequestBudget) {
  const { owner, repo } = publicGithubRepoParts(repositoryFullName)
  const response = await requestPublicGithubJson({
    budget,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  })
  if (!isRecord(response.body) || typeof response.body.default_branch !== "string" || !response.body.default_branch.trim()) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub repository response was missing the default branch.")
  }
  if (response.body.private === true) {
    throw new PluginArchRouteFailure(400, "private_github_repo", "Private GitHub repositories must be imported through the GitHub connector.")
  }
  return { defaultBranch: response.body.default_branch.trim() }
}

type ResolvedPublicGithubTreeTarget = {
  branch: string
  commitBody: Record<string, unknown>
  rootPath: string
}

async function resolvePublicGithubTreeTarget(input: {
  budget: PublicGithubRequestBudget
  defaultBranch: string
  owner: string
  refAndPathSegments: string[] | null
  repo: string
}): Promise<ResolvedPublicGithubTreeTarget> {
  try {
    const resolved = await resolvePublicGithubRefAndPath({
      defaultRef: input.defaultBranch,
      refAndPathSegments: input.refAndPathSegments,
      resolveRef: async (branch) => {
        const response = await requestPublicGithubJson({
          allowStatuses: [404, 422],
          budget: input.budget,
          path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(branch)}`,
        })
        if (!response.ok) return null
        if (!isRecord(response.body)) {
          throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub commit response was invalid.")
        }
        return response.body
      },
    })
    return {
      branch: resolved.ref,
      commitBody: resolved.resolved,
      rootPath: normalizeGithubPath(resolved.rootPath),
    }
  } catch (error) {
    if (error instanceof PublicGithubRequestError) {
      throw new PluginArchRouteFailure(error.status, error.code, error.message)
    }
    throw error
  }
}

async function resolvePublicGithubSubtreeSha(input: {
  budget: PublicGithubRequestBudget
  owner: string
  repo: string
  rootPath: string
  treeSha: string
}) {
  let currentTreeSha = input.treeSha
  for (const segment of input.rootPath.split("/").filter(Boolean)) {
    const response = await requestPublicGithubJson({
      budget: input.budget,
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(currentTreeSha)}`,
    })
    if (!isRecord(response.body) || !Array.isArray(response.body.tree)) {
      throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub subtree response was invalid.")
    }
    const entry = response.body.tree.find((candidate) => isRecord(candidate)
      && candidate.type === "tree"
      && candidate.path === segment
      && typeof candidate.sha === "string")
    if (!isRecord(entry) || typeof entry.sha !== "string") {
      throw new PluginArchRouteFailure(404, "github_plugin_root_not_found", "No directory was found at that GitHub plugin path.")
    }
    currentTreeSha = entry.sha
  }
  return currentTreeSha
}

async function getPublicGithubRepositoryTree(
  target: PublicGithubPluginTarget,
  operationDeadlineAt?: number,
): Promise<PublicGithubTreeSnapshot> {
  const { owner, repo } = publicGithubRepoParts(target.repositoryFullName)
  const operationTimeoutMs = operationDeadlineAt === undefined
    ? undefined
    : githubMcpRemainingTimeoutMs(operationDeadlineAt, PUBLIC_GITHUB_IMPORT_LIMITS.operationTimeoutMs)
  const budget = createPublicGithubRequestBudget(
    operationTimeoutMs === undefined ? undefined : { operationTimeoutMs },
  )
  const repository = await getPublicGithubRepositoryInfo(target.repositoryFullName, budget)
  const resolvedTarget = await resolvePublicGithubTreeTarget({
    budget,
    defaultBranch: repository.defaultBranch,
    owner,
    refAndPathSegments: target.refAndPathSegments,
    repo,
  })
  const { branch, commitBody, rootPath } = resolvedTarget
  const headSha = typeof commitBody.sha === "string" ? commitBody.sha : ""
  const commit = isRecord(commitBody.commit) ? commitBody.commit : null
  const tree = commit && isRecord(commit.tree) ? commit.tree : null
  const treeSha = tree && typeof tree.sha === "string" ? tree.sha : ""
  if (!headSha || !treeSha) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub commit response was missing the head or tree sha.")
  }

  const discoveryTreeSha = rootPath
    ? await resolvePublicGithubSubtreeSha({ budget, owner, repo, rootPath, treeSha })
    : treeSha
  const treeResponse = await requestPublicGithubJson({
    budget,
    maxResponseBytes: PUBLIC_GITHUB_IMPORT_LIMITS.treeResponseBytes,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(discoveryTreeSha)}?recursive=1`,
  })
  if (!isRecord(treeResponse.body) || !Array.isArray(treeResponse.body.tree)) {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub tree response was invalid.")
  }
  try {
    assertPublicGithubTreeWithinLimits({
      entryCount: treeResponse.body.tree.length,
      truncated: treeResponse.body.truncated === true,
    })
  } catch (error) {
    if (error instanceof PublicGithubRequestError) {
      throw new PluginArchRouteFailure(error.status, error.code, error.message)
    }
    throw error
  }

  const fullPathByDiscoveryPath = new Map<string, string>()
  const treeEntries = treeResponse.body.tree.flatMap((entry): GithubDiscoveryTreeEntry[] => {
    if (!isRecord(entry)) return []
    const relativePath = typeof entry.path === "string" ? safePublicGithubPath(entry.path) : null
    const kind = entry.type === "blob" || entry.type === "tree" ? entry.type : null
    if (!relativePath || !kind) return []
    const discoveryPath = relativePath
    const fullPath = rootPath ? `${rootPath}/${relativePath}` : relativePath
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
    budget,
    fullPathByDiscoveryPath,
    headSha,
    repositoryFullName: target.repositoryFullName,
    rootPath,
    textByDiscoveryPath: new Map(),
    treeEntries,
  }
}

async function getPublicGithubTextFile(input: { discoveryPath: string; snapshot: PublicGithubTreeSnapshot }) {
  const cached = input.snapshot.textByDiscoveryPath.get(input.discoveryPath)
  if (cached !== undefined || input.snapshot.textByDiscoveryPath.has(input.discoveryPath)) return cached ?? null
  const fullPath = input.snapshot.fullPathByDiscoveryPath.get(input.discoveryPath) ?? input.discoveryPath
  const declaredSize = input.snapshot.treeEntries.find((entry) => entry.path === input.discoveryPath)?.size
  if (declaredSize !== null && declaredSize !== undefined && declaredSize > PUBLIC_GITHUB_IMPORT_LIMITS.fileBytes) {
    throw new PluginArchRouteFailure(
      400,
      "github_import_limit_exceeded",
      `GitHub file "${input.discoveryPath}" is larger than ${PUBLIC_GITHUB_IMPORT_LIMITS.fileBytes} bytes.`,
    )
  }
  const { owner, repo } = publicGithubRepoParts(input.snapshot.repositoryFullName)
  const response = await requestPublicGithubJson({
    allowStatuses: [404],
    budget: input.snapshot.budget,
    // Always read from the immutable commit captured with the tree. Reading
    // from the branch here would allow it to move between the revision check
    // and file fetch, producing a mixed or attacker-swapped import.
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${fullPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.snapshot.headSha)}`,
  })
  if (!response.ok) {
    input.snapshot.textByDiscoveryPath.set(input.discoveryPath, null)
    return null
  }
  if (!isRecord(response.body) || response.body.encoding !== "base64" || typeof response.body.content !== "string") {
    throw new PluginArchRouteFailure(502, "github_response_incomplete", "GitHub file response was incomplete.")
  }
  try {
    const text = decodePublicGithubBase64File({
      base64: response.body.content,
      budget: input.snapshot.budget,
      path: input.discoveryPath,
    })
    input.snapshot.textByDiscoveryPath.set(input.discoveryPath, text)
    return text
  } catch (error) {
    if (error instanceof PublicGithubRequestError) {
      throw new PluginArchRouteFailure(error.status, error.code, error.message)
    }
    throw error
  }
}

async function getPublicGithubDiscoveryFileTexts(snapshot: PublicGithubTreeSnapshot) {
  const interestingPaths = new Set<string>()
  const knownPaths = new Set(snapshot.treeEntries.map((entry) => entry.path))
  if (knownPaths.has(".claude-plugin/marketplace.json")) {
    interestingPaths.add(".claude-plugin/marketplace.json")
  }
  if (knownPaths.has("server.json")) {
    interestingPaths.add("server.json")
  }
  for (const entry of snapshot.treeEntries) {
    if (entry.path.endsWith(".claude-plugin/plugin.json") || entry.path.endsWith("/plugin.json") || entry.path === "plugin.json") {
      interestingPaths.add(entry.path)
    }
  }

  if (interestingPaths.size > PUBLIC_GITHUB_IMPORT_LIMITS.files) {
    throw new PluginArchRouteFailure(
      400,
      "github_import_limit_exceeded",
      `GitHub plugin discovery is limited to ${PUBLIC_GITHUB_IMPORT_LIMITS.files} manifest and component files. Narrow the GitHub URL to a plugin subdirectory.`,
    )
  }

  const fileTextByPath: Record<string, string | null> = {}
  for (const path of interestingPaths) {
    fileTextByPath[path] = await getPublicGithubTextFile({
      discoveryPath: path,
      snapshot,
    })
  }
  return fileTextByPath
}

function deriveProjection(input: { objectType: ConfigObjectRow["objectType"]; value: ConfigObjectInput }) {
  const metadata = input.value.metadata ?? {}
  const payload = input.value.normalizedPayloadJson ?? {}
  const rawSourceText = normalizeOptionalString(input.value.rawSourceText)
  const titleCandidate = [
    typeof metadata.title === "string" ? metadata.title : null,
    typeof metadata.name === "string" ? metadata.name : null,
    typeof payload.title === "string" ? payload.title : null,
    typeof payload.name === "string" ? payload.name : null,
    rawSourceText ? stripLineDecorators(firstTextLine(rawSourceText)) : null,
  ].find((value) => Boolean(normalizeOptionalString(value ?? undefined)))

  const descriptionCandidate = [
    typeof metadata.description === "string" ? metadata.description : null,
    typeof payload.description === "string" ? payload.description : null,
    rawSourceText
      ? rawSourceText
        .split(/\r?\n/g)
        .map((line) => stripLineDecorators(line.trim()))
        .filter(Boolean)
        .slice(1)
        .find(Boolean) ?? null
      : null,
  ].find((value) => Boolean(normalizeOptionalString(value ?? undefined)))

  const title = normalizeOptionalString(titleCandidate ?? undefined)
    ?? `${input.objectType.charAt(0).toUpperCase()}${input.objectType.slice(1)} ${new Date().toISOString()}`

  const description = normalizeOptionalString(descriptionCandidate ?? undefined)
  const searchText = [title, description, rawSourceText].filter(Boolean).join("\n") || null

  return {
    description,
    searchText,
    title,
  }
}

function pageItems<TItem extends { id: string }>(items: TItem[], cursor: string | undefined, limit: number | undefined): CursorPage<TItem> {
  const ordered = [...items]
  const pageSize = limit ?? 50
  const startIndex = cursor ? Math.max(ordered.findIndex((item) => item.id === cursor) + 1, 0) : 0
  const sliced = ordered.slice(startIndex, startIndex + pageSize)
  const nextCursor = ordered.length > startIndex + pageSize ? sliced[sliced.length - 1]?.id ?? null : null
  return { items: sliced, nextCursor }
}

async function getLatestVersions(configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) {
    return new Map<string, ConfigObjectVersionRow>()
  }

  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))

  const latestByObjectId = new Map<string, ConfigObjectVersionRow>()
  for (const row of rows) {
    if (!latestByObjectId.has(row.configObjectId)) {
      latestByObjectId.set(row.configObjectId, row)
    }
  }

  return latestByObjectId
}

function serializeVersion(row: ConfigObjectVersionRow) {
  return {
    configObjectId: row.configObjectId,
    connectorSyncEventId: row.connectorSyncEventId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdVia: row.createdVia,
    id: row.id,
    isDeletedVersion: row.isDeletedVersion,
    normalizedPayloadJson: row.normalizedPayloadJson,
    rawSourceText: row.rawSourceText,
    schemaVersion: row.schemaVersion,
    sourceRevisionRef: row.sourceRevisionRef,
  }
}

function serializeConfigObject(row: ConfigObjectRow, latestVersion: ConfigObjectVersionRow | null) {
  return {
    connectorInstanceId: row.connectorInstanceId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    currentFileExtension: row.currentFileExtension,
    currentFileName: row.currentFileName,
    currentRelativePath: row.currentRelativePath,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    latestVersion: latestVersion ? serializeVersion(latestVersion) : null,
    objectType: row.objectType,
    organizationId: row.organizationId,
    searchText: row.searchText,
    sourceMode: row.sourceMode,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  }
}

type PluginMarketplaceSummary = {
  id: string
  name: string
}

const DEFAULT_OPENWORK_EXTENSION_MANIFESTS = [
  {
    schemaVersion: 1,
    id: "openwork-browser",
    name: "OpenWork Browser",
    description: "Automate the built-in browser panel that stays visible inside OpenWork.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/openwork-mark.svg" },
    composer: { prompt: "Use the OpenWork Browser extension to " },
    setup: { instructions: "OpenWork Browser is ready by default in desktop workspaces." },
    resources: [{ type: "opencode-plugin", id: "opencode-chrome-devtools", packageName: "opencode-chrome-devtools", required: true }],
    contributions: [
      { type: "settings-panel", ref: "openwork.browser.settings", location: "settings-detail" },
      { type: "session-side-panel", ref: "openwork.browser.panel", location: "session-right-pane" },
      { type: "composer-prompt", prompt: "Use the OpenWork Browser extension to ", location: "composer" },
    ],
    enablement: [{ type: "toggle-enabled", ref: "openwork-browser", label: "Enabled" }],
    lifecycle: { reload: ["plugins", "agents"], detection: ["plugin:opencode-chrome-devtools"] },
    defaultEnabled: true,
  },
  {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Mac only: control Mac apps through semantic accessibility refs, screenshots, background-safe clicks, keyboard input, and strict mode.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/openwork-mark.svg" },
    composer: { prompt: "Use Computer Use to " },
    setup: { instructions: "Computer Use is Mac only. Grant Accessibility and Screen Recording permissions, then connect the local MCP server in this workspace." },
    resources: [
      { type: "mcp", id: "computer-use-mcp", label: "Computer Use MCP", mcpServerName: "computer-use", command: ["npx", "-y", "@openwork/handsfree", "mcp"], localCommandRef: "openwork.computerUseMcp", required: true },
      { type: "native-binary", id: "computer-use-native", label: "macOS accessibility runtime", packageName: "@openwork/handsfree", required: true },
    ],
    contributions: [
      { type: "setup-instructions", ref: "openwork.computerUse.setup", location: "settings-detail" },
      { type: "composer-prompt", prompt: "Use Computer Use to ", location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "computer-use", label: "MCP server connected" },
      { type: "permission-granted", ref: "accessibility", label: "Accessibility permission" },
      { type: "permission-granted", ref: "screenRecording", label: "Screen Recording permission" },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:computer-use"] },
    platform: ["darwin"],
  },
  {
    schemaVersion: 1,
    id: "openai-image-gen",
    name: "OpenAI Image Gen",
    description: "Generate image artifacts with gpt-image-2.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-openai.svg" },
    composer: { prompt: "Use the OpenAI Image Gen extension to " },
    setup: { instructions: "Add an OpenAI API key, then agents can generate image artifacts through OpenWork extension actions." },
    resources: [
      { type: "secret", id: "openai-api-key", envKey: "OPENAI_API_KEY", required: true },
      { type: "local-service", id: "openai-image-generation-service", label: "OpenAI image generation", required: true },
      { type: "tool", id: "openai-image-generate", label: "Image generation", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "openwork.imageGen.settings", location: "settings-detail" },
      { type: "composer-prompt", prompt: "Use the OpenAI Image Gen extension to ", location: "composer" },
    ],
    enablement: [{ type: "env-set", ref: "OPENAI_API_KEY", label: "OpenAI API key" }],
    lifecycle: { reload: ["config"], detection: ["env:OPENAI_API_KEY"] },
  },
  {
    schemaVersion: 1,
    id: "google-workspace",
    name: "Google Workspace",
    description: "Let OpenWork help with meetings, selected Drive files, and Gmail drafts.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    icon: { simpleIconSlug: "google" },
    composer: { prompt: "Use Google Workspace to " },
    setup: { instructions: "Connect your Google account to use Calendar, Drive, and Gmail drafts in OpenWork." },
    resources: [
      { type: "provider", id: "google-oauth", label: "Google account", providerId: "google-workspace", required: true },
      { type: "local-service", id: "google-workspace-connector", label: "Secure local connection", required: true },
      { type: "tool", id: "google-calendar-read", label: "Calendar", required: true },
      { type: "tool", id: "google-gmail-drafts", label: "Gmail drafts", required: true },
      { type: "tool", id: "google-drive-selected-files", label: "Selected Drive files", required: true },
      { type: "tool", id: "google-gmail-read", label: "Gmail read (opt-in)", required: false },
      { type: "tool", id: "google-drive-full", label: "Full Drive access (opt-in)", required: false },
      { type: "tool", id: "google-calendar-events", label: "Calendar events (opt-in)", required: false },
      { type: "tool", id: "google-chat", label: "Google Chat (opt-in)", required: false },
    ],
    contributions: [
      { type: "settings-panel", ref: "openwork.googleWorkspace.settings", location: "settings-detail" },
      { type: "composer-prompt", prompt: "Use Google Workspace to ", location: "composer" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:google-workspace"] },
  },
  {
    schemaVersion: 1,
    id: "ollama",
    name: "Ollama",
    description: "Local model provider at http://localhost:11434.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-ollama.svg" },
    composer: { prompt: "Use the Ollama extension to " },
    setup: { instructions: "Run Ollama locally, choose or pull a model, then add it as an OpenCode provider." },
    resources: [
      { type: "local-service", id: "ollama-api", label: "Ollama API", description: "http://localhost:11434", required: true },
      { type: "provider", id: "ollama", providerId: "ollama", packageName: "@ai-sdk/openai-compatible", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "openwork.ollama.settings", location: "settings-detail" },
      { type: "composer-prompt", prompt: "Use the Ollama extension to ", location: "composer" },
    ],
    enablement: [{ type: "provider-connected", ref: "ollama", label: "Ollama provider" }],
    lifecycle: { reload: ["config"], detection: ["provider:ollama"] },
  },
] as const

function defaultOpenWorkManifestForPlugin(row: PluginRow) {
  return DEFAULT_OPENWORK_EXTENSION_MANIFESTS.find((manifest) => manifest.name === row.name && manifest.description === row.description) ?? null
}

function extensionResourceTypeForConfigObject(objectType: string) {
  switch (objectType) {
    case "skill":
    case "agent":
    case "command":
    case "tool":
    case "mcp":
    case "hook":
    case "context":
      return objectType
    default:
      return "file"
  }
}

function serializePluginExtension(row: PluginRow, componentCounts: Record<string, number>) {
  const builtInManifest = defaultOpenWorkManifestForPlugin(row)
  if (builtInManifest) {
    return {
      description: builtInManifest.description,
      id: builtInManifest.id,
      manifest: builtInManifest,
      name: builtInManifest.name,
      sourceFormat: "openwork-builtin",
    }
  }

  const sourceFormat = "claude-plugin"
  const description = row.description?.trim() || `${row.name} extension`
  const resources = Object.entries(componentCounts).flatMap(([objectType, count]) => {
    if (count <= 0) return []
    const resourceType = extensionResourceTypeForConfigObject(objectType)
    return [{
      type: resourceType,
      id: `${row.id}:${objectType}`,
      label: `${count} ${objectType}${count === 1 ? "" : "s"}`,
      required: true,
    }]
  })
  return {
    description: row.description,
    id: row.id,
    manifest: {
      schemaVersion: 1,
      id: row.id,
      name: row.name,
      description,
      source: {
        format: sourceFormat,
        origin: "den" as const,
        reference: row.id,
        trusted: false,
      },
      resources,
      contributions: [{
        type: "setup-instructions",
        ref: "den.claudePlugin.setup",
        label: "Claude-compatible plugin import",
        location: "settings-detail",
      }],
      setup: {
        instructions: "Imported from a Claude-compatible plugin. OpenWork installs its resources into this workspace as extension components.",
      },
      lifecycle: {
        detection: Object.keys(componentCounts).map((objectType) => `${objectType}:${row.id}`),
      },
    },
    name: row.name,
    sourceFormat,
  }
}

function serializePlugin(row: PluginRow, memberCount?: number, marketplaces: PluginMarketplaceSummary[] = [], componentCounts: Record<string, number> = {}) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    extension: serializePluginExtension(row, componentCounts),
    marketplaces,
    memberCount,
    name: row.name,
    organizationId: row.organizationId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeMarketplace(row: MarketplaceRow, pluginCount?: number) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    logoUrl: row.logoUrl,
    name: row.name,
    organizationId: row.organizationId,
    pluginCount,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeMembership(row: PluginMembershipRow, configObject?: ReturnType<typeof serializeConfigObject>) {
  return {
    configObject,
    configObjectId: row.configObjectId,
    connectorMappingId: row.connectorMappingId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    membershipSource: row.membershipSource,
    pluginId: row.pluginId,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  }
}

function serializeMarketplaceMembership(row: MarketplaceMembershipRow, plugin?: ReturnType<typeof serializePlugin>) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    marketplaceId: row.marketplaceId,
    membershipSource: row.membershipSource,
    plugin,
    pluginId: row.pluginId,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  }
}

function serializeAccessGrant(row: AccessGrantRow) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    orgMembershipId: row.orgMembershipId,
    orgWide: row.orgWide,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
    role: row.role,
    teamId: row.teamId,
  }
}

function serializeConnectorAccount(row: ConnectorAccountRow, creatorName: string | null = null) {
  return {
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    createdByName: creatorName,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    displayName: row.displayName,
    externalAccountRef: row.externalAccountRef,
    id: row.id,
    metadata: row.metadataJson ?? undefined,
    organizationId: row.organizationId,
    remoteId: row.remoteId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function resolveCreatorName(context: PluginArchActorContext, memberId: string) {
  const member = context.organizationContext.members.find((entry) => entry.id === memberId)
  if (!member) return null
  return member.user.name?.trim() || member.user.email || null
}

function serializeConnectorInstance(row: ConnectorInstanceRow) {
  return {
    connectorAccountId: row.connectorAccountId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    instanceConfigJson: row.instanceConfigJson,
    lastSyncCursor: row.lastSyncCursor,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    name: row.name,
    organizationId: row.organizationId,
    remoteId: row.remoteId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeConnectorTarget(row: ConnectorTargetRow) {
  return {
    connectorInstanceId: row.connectorInstanceId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    externalTargetRef: row.externalTargetRef,
    id: row.id,
    remoteId: row.remoteId,
    targetConfigJson: row.targetConfigJson,
    targetKind: row.targetKind,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeConnectorMapping(row: ConnectorMappingRow) {
  return {
    autoAddToPlugin: row.autoAddToPlugin,
    connectorInstanceId: row.connectorInstanceId,
    connectorTargetId: row.connectorTargetId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    mappingConfigJson: row.mappingConfigJson,
    mappingKind: row.mappingKind,
    objectType: row.objectType,
    pluginId: row.pluginId,
    remoteId: row.remoteId,
    selector: row.selector,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeConnectorSyncEvent(row: ConnectorSyncEventRow) {
  return {
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    connectorInstanceId: row.connectorInstanceId,
    connectorTargetId: row.connectorTargetId,
    connectorType: row.connectorType,
    eventType: row.eventType,
    externalEventRef: row.externalEventRef,
    id: row.id,
    remoteId: row.remoteId,
    sourceRevisionRef: row.sourceRevisionRef,
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    summaryJson: row.summaryJson,
  }
}

async function getConfigObjectRow(organizationId: OrganizationId, configObjectId: ConfigObjectId) {
  const rows = await db
    .select()
    .from(ConfigObjectTable)
    .where(and(eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.id, configObjectId)))
    .limit(1)

  return rows[0] ?? null
}

async function getPluginRow(organizationId: OrganizationId, pluginId: PluginId) {
  const rows = await db
    .select()
    .from(PluginTable)
    .where(and(eq(PluginTable.organizationId, organizationId), eq(PluginTable.id, pluginId)))
    .limit(1)

  return rows[0] ?? null
}

async function getMarketplaceRow(organizationId: OrganizationId, marketplaceId: MarketplaceId) {
  const rows = await db
    .select()
    .from(MarketplaceTable)
    .where(and(eq(MarketplaceTable.organizationId, organizationId), eq(MarketplaceTable.id, marketplaceId)))
    .limit(1)

  return rows[0] ?? null
}

async function getConnectorAccountRow(organizationId: OrganizationId, connectorAccountId: ConnectorAccountId) {
  const rows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(eq(ConnectorAccountTable.organizationId, organizationId), eq(ConnectorAccountTable.id, connectorAccountId)))
    .limit(1)

  return rows[0] ?? null
}

async function getConnectorInstanceRow(organizationId: OrganizationId, connectorInstanceId: ConnectorInstanceId) {
  const rows = await db
    .select()
    .from(ConnectorInstanceTable)
    .where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.id, connectorInstanceId)))
    .limit(1)

  return rows[0] ?? null
}

async function getConnectorTargetRow(organizationId: OrganizationId, connectorTargetId: ConnectorTargetId) {
  const rows = await db
    .select({ target: ConnectorTargetTable, instance: ConnectorInstanceTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorTargetTable.id, connectorTargetId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.target ?? null
}

async function getConnectorMappingRow(organizationId: OrganizationId, connectorMappingId: ConnectorMappingId) {
  const rows = await db
    .select({ mapping: ConnectorMappingTable, instance: ConnectorInstanceTable })
    .from(ConnectorMappingTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorMappingTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorMappingTable.id, connectorMappingId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.mapping ?? null
}

async function getConnectorSyncEventRow(organizationId: OrganizationId, connectorSyncEventId: ConnectorSyncEventId) {
  const rows = await db
    .select({ event: ConnectorSyncEventTable, instance: ConnectorInstanceTable })
    .from(ConnectorSyncEventTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorSyncEventTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorSyncEventTable.id, connectorSyncEventId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.event ?? null
}

// Verifies the target resource exists AND belongs to the caller's active
// organization, returning 404 otherwise. This must run before any role check on
// access-grant endpoints: resolvePluginArchResourceRole short-circuits to
// "manager" for org admins without binding the resource to the org, so without
// this guard an admin in org A could read/add/revoke grants on org B resources
// by supplying a foreign resourceId.
async function ensureResourceInOrganization(context: PluginArchActorContext, target: ResourceTarget) {
  const organizationId = context.organizationContext.organization.id
  if (target.resourceKind === "config_object") {
    if (!(await getConfigObjectRow(organizationId, target.resourceId))) {
      throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
    }
    return
  }
  if (target.resourceKind === "plugin") {
    if (!(await getPluginRow(organizationId, target.resourceId))) {
      throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
    }
    return
  }
  if (target.resourceKind === "marketplace") {
    if (!(await getMarketplaceRow(organizationId, target.resourceId))) {
      throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
    }
    return
  }
  if (!(await getConnectorInstanceRow(organizationId, target.resourceId))) {
    throw new PluginArchRouteFailure(404, "connector_instance_not_found", "Connector instance not found.")
  }
}

// Validates that a grant's target member/team belong to the caller's active
// organization, so a manager cannot grant access to a foreign org's member or
// team id by smuggling it through the request body.
async function ensureGrantTargetsInOrganization(context: PluginArchActorContext, value: AccessGrantWrite) {
  const organizationId = context.organizationContext.organization.id

  if (value.orgMembershipId) {
    const member = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.id, value.orgMembershipId)))
      .limit(1)
    if (!member[0]) {
      throw new PluginArchRouteFailure(404, "member_not_found", "Member not found.")
    }
  }

  if (value.teamId) {
    const team = await db
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.id, value.teamId)))
      .limit(1)
    if (!team[0]) {
      throw new PluginArchRouteFailure(404, "team_not_found", "Team not found.")
    }
  }
}

async function ensureVisibleConfigObject(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const row = await getConfigObjectRow(context.organizationContext.organization.id, configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "config_object", role: "viewer" })
  return row
}

async function ensureEditablePlugin(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await getPluginRow(context.organizationContext.organization.id, pluginId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "plugin", role: "editor" })
  return row
}

async function ensureEditableMarketplace(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await getMarketplaceRow(context.organizationContext.organization.id, marketplaceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "marketplace", role: "editor" })
  return row
}

async function ensureVisibleMarketplace(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await getMarketplaceRow(context.organizationContext.organization.id, marketplaceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "marketplace", role: "viewer" })
  return row
}

async function ensureVisiblePlugin(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await getPluginRow(context.organizationContext.organization.id, pluginId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "plugin", role: "viewer" })
  return row
}

async function ensureVisibleConnectorInstance(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await getConnectorInstanceRow(context.organizationContext.organization.id, connectorInstanceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_instance_not_found", "Connector instance not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "connector_instance", role: "viewer" })
  return row
}

async function ensureEditableConnectorInstance(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await getConnectorInstanceRow(context.organizationContext.organization.id, connectorInstanceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_instance_not_found", "Connector instance not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "connector_instance", role: "editor" })
  return row
}

async function upsertGrant(input: ResourceTarget & {
  context: PluginArchActorContext
  value: AccessGrantWrite
}) {
  const createdAt = new Date()
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id

  if (input.resourceKind === "config_object") {
    const existing = await db
      .select()
      .from(ConfigObjectAccessGrantTable)
      .where(and(
        eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId),
        input.value.orgMembershipId
          ? eq(ConfigObjectAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
          : input.value.teamId
            ? eq(ConfigObjectAccessGrantTable.teamId, input.value.teamId)
            : eq(ConfigObjectAccessGrantTable.orgWide, true),
      ))
      .limit(1)

    if (existing[0]) {
      await db
        .update(ConfigObjectAccessGrantTable)
        .set({
          createdByOrgMembershipId,
          orgMembershipId: input.value.orgMembershipId ?? null,
          orgWide: input.value.orgWide ?? false,
          removedAt: null,
          role: input.value.role,
          teamId: input.value.teamId ?? null,
        })
        .where(eq(ConfigObjectAccessGrantTable.id, existing[0].id))
      return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
    }

    const row = {
      configObjectId: input.resourceId,
      createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId,
      orgMembershipId: input.value.orgMembershipId ?? null,
      orgWide: input.value.orgWide ?? false,
      role: input.value.role,
      teamId: input.value.teamId ?? null,
    }
    await db.insert(ConfigObjectAccessGrantTable).values(row)
    return serializeAccessGrant({ ...row, removedAt: null })
  }

  if (input.resourceKind === "marketplace") {
    const existing = await db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId),
        input.value.orgMembershipId
          ? eq(MarketplaceAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
          : input.value.teamId
            ? eq(MarketplaceAccessGrantTable.teamId, input.value.teamId)
            : eq(MarketplaceAccessGrantTable.orgWide, true),
      ))
      .limit(1)

    if (existing[0]) {
      await db
        .update(MarketplaceAccessGrantTable)
        .set({
          createdByOrgMembershipId,
          orgMembershipId: input.value.orgMembershipId ?? null,
          orgWide: input.value.orgWide ?? false,
          removedAt: null,
          role: input.value.role,
          teamId: input.value.teamId ?? null,
        })
        .where(eq(MarketplaceAccessGrantTable.id, existing[0].id))
      return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
    }

    const row = {
      createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("marketplaceAccessGrant"),
      marketplaceId: input.resourceId,
      organizationId,
      orgMembershipId: input.value.orgMembershipId ?? null,
      orgWide: input.value.orgWide ?? false,
      role: input.value.role,
      teamId: input.value.teamId ?? null,
    }
    await db.insert(MarketplaceAccessGrantTable).values(row)
    return serializeAccessGrant({ ...row, removedAt: null })
  }

  if (input.resourceKind === "plugin") {
    const existing = await db
      .select()
      .from(PluginAccessGrantTable)
      .where(and(
        eq(PluginAccessGrantTable.pluginId, input.resourceId),
        input.value.orgMembershipId
          ? eq(PluginAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
          : input.value.teamId
            ? eq(PluginAccessGrantTable.teamId, input.value.teamId)
            : eq(PluginAccessGrantTable.orgWide, true),
      ))
      .limit(1)

    if (existing[0]) {
      await db
        .update(PluginAccessGrantTable)
        .set({
          createdByOrgMembershipId,
          orgMembershipId: input.value.orgMembershipId ?? null,
          orgWide: input.value.orgWide ?? false,
          removedAt: null,
          role: input.value.role,
          teamId: input.value.teamId ?? null,
        })
        .where(eq(PluginAccessGrantTable.id, existing[0].id))
      return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
    }

    const row = {
      createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      orgMembershipId: input.value.orgMembershipId ?? null,
      orgWide: input.value.orgWide ?? false,
      pluginId: input.resourceId,
      role: input.value.role,
      teamId: input.value.teamId ?? null,
    }
    await db.insert(PluginAccessGrantTable).values(row)
    return serializeAccessGrant({ ...row, removedAt: null })
  }

  const existing = await db
    .select()
    .from(ConnectorInstanceAccessGrantTable)
    .where(and(
      eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId),
      input.value.orgMembershipId
        ? eq(ConnectorInstanceAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
        : input.value.teamId
          ? eq(ConnectorInstanceAccessGrantTable.teamId, input.value.teamId)
          : eq(ConnectorInstanceAccessGrantTable.orgWide, true),
    ))
    .limit(1)

  if (existing[0]) {
    await db
      .update(ConnectorInstanceAccessGrantTable)
      .set({
        createdByOrgMembershipId,
        orgMembershipId: input.value.orgMembershipId ?? null,
        orgWide: input.value.orgWide ?? false,
        removedAt: null,
        role: input.value.role,
        teamId: input.value.teamId ?? null,
      })
      .where(eq(ConnectorInstanceAccessGrantTable.id, existing[0].id))
    return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
  }

  const row = {
    connectorInstanceId: input.resourceId,
    createdAt,
    createdByOrgMembershipId,
    id: createDenTypeId("connectorInstanceAccessGrant"),
    organizationId,
    orgMembershipId: input.value.orgMembershipId ?? null,
    orgWide: input.value.orgWide ?? false,
    role: input.value.role,
    teamId: input.value.teamId ?? null,
  }
  await db.insert(ConnectorInstanceAccessGrantTable).values(row)
  return serializeAccessGrant({ ...row, removedAt: null })
}

async function removeGrant(input: GrantTarget & { context: PluginArchActorContext }) {
  const removedAt = new Date()
  if (input.resourceKind === "config_object") {
    const rows = await db
      .select()
      .from(ConfigObjectAccessGrantTable)
      .where(and(eq(ConfigObjectAccessGrantTable.id, input.grantId), eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId)))
      .limit(1)
    if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
    await db.update(ConfigObjectAccessGrantTable).set({ removedAt }).where(eq(ConfigObjectAccessGrantTable.id, input.grantId))
    return
  }
  if (input.resourceKind === "marketplace") {
    const rows = await db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(eq(MarketplaceAccessGrantTable.id, input.grantId), eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId)))
      .limit(1)
    if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
    await db.update(MarketplaceAccessGrantTable).set({ removedAt }).where(eq(MarketplaceAccessGrantTable.id, input.grantId))
    return
  }
  if (input.resourceKind === "plugin") {
    const rows = await db
      .select()
      .from(PluginAccessGrantTable)
      .where(and(eq(PluginAccessGrantTable.id, input.grantId), eq(PluginAccessGrantTable.pluginId, input.resourceId)))
      .limit(1)
    if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
    await db.update(PluginAccessGrantTable).set({ removedAt }).where(eq(PluginAccessGrantTable.id, input.grantId))
    return
  }
  const rows = await db
    .select()
    .from(ConnectorInstanceAccessGrantTable)
    .where(and(eq(ConnectorInstanceAccessGrantTable.id, input.grantId), eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId)))
    .limit(1)
  if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
  await db.update(ConnectorInstanceAccessGrantTable).set({ removedAt }).where(eq(ConnectorInstanceAccessGrantTable.id, input.grantId))
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
  sourceMode: ConfigObjectRow["sourceMode"]
  value: ConfigObjectInput
}) {
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
      currentRelativePath: null,
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
      sourceRevisionRef: normalizeOptionalString(input.value.sourceRevisionRef),
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

export async function createConfigObjectVersion(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; reason?: string; value: ConfigObjectInput }) {
  const row = await getConfigObjectRow(input.context.organizationContext.organization.id, input.configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object", role: "editor" })

  const now = new Date()
  const previousVersion = (await getLatestVersions([row.id])).get(row.id) ?? null
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
    previousVersion,
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
  await ensureVisibleConfigObject(input.context, input.configObjectId)
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
  await ensureEditablePlugin(input.context, input.pluginId)
  const rows = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, input.configObjectId), isNull(PluginConfigObjectTable.removedAt)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "plugin_membership_not_found", "Plugin membership not found.")
  }
  const [latestVersions, bindings] = await Promise.all([
    getLatestVersions([configObject.id]),
    db
      .select({ externalMcpConnectionId: PluginMcpRequirementBindingTable.externalMcpConnectionId })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.context.organizationContext.organization.id),
        eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
        eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
      )),
  ])
  const latestVersion = latestVersions.get(configObject.id)
  const ownedConnectionId = latestVersion
    ? ownedImportedExternalMcpConnectionId(parseConfigObjectVersionSpec(latestVersion))
    : null
  await db.update(PluginConfigObjectTable).set({ removedAt: new Date() }).where(eq(PluginConfigObjectTable.id, rows[0].id))
  await deletePluginMcpRequirementBindingsForPluginConfigObject({
    configObjectId: input.configObjectId,
    organizationId: input.context.organizationContext.organization.id,
    pluginId: input.pluginId,
  })
  await deleteOwnedImportedExternalMcpConnectionsWithoutBindings({
    connectionIds: bindings.flatMap((binding) => binding.externalMcpConnectionId === ownedConnectionId
      ? [binding.externalMcpConnectionId]
      : []),
    organizationId: input.context.organizationContext.organization.id,
  })
}

export async function listResourceAccess(input: { context: PluginArchActorContext } & ResourceTarget) {
  await ensureResourceInOrganization(input.context, input)
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })

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

export async function createResourceAccessGrant(input: { context: PluginArchActorContext; value: AccessGrantWrite } & ResourceTarget) {
  await ensureResourceInOrganization(input.context, input)
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })
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

export async function listPlugins(input: { context: PluginArchActorContext; cursor?: string; limit?: number; q?: string; status?: PluginRow["status"] }) {
  const rows = await db
    .select()
    .from(PluginTable)
    .where(eq(PluginTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(PluginTable.updatedAt), desc(PluginTable.id))

  const memberships = await db
    .select({ pluginId: PluginConfigObjectTable.pluginId, count: PluginConfigObjectTable.id })
    .from(PluginConfigObjectTable)
    .where(isNull(PluginConfigObjectTable.removedAt))

  const counts = memberships.reduce((accumulator, row) => {
    accumulator.set(row.pluginId, (accumulator.get(row.pluginId) ?? 0) + 1)
    return accumulator
  }, new Map<string, number>())

  const marketplaceMembers = await collectPluginMarketplaces(
    input.context.organizationContext.organization.id,
    rows.map((row) => row.id),
  )

  const visible: ReturnType<typeof serializePlugin>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "plugin" })
    if (!role) continue
    if (input.status && row.status !== input.status) continue
    if (input.q) {
      const haystack = `${row.name}\n${row.description ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    visible.push(serializePlugin(row, counts.get(row.id) ?? 0, marketplaceMembers.get(row.id) ?? []))
  }

  return pageItems(visible, input.cursor, input.limit)
}

export async function getPluginDetail(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await ensureVisiblePlugin(context, pluginId)
  const memberships = await db.select({ id: PluginConfigObjectTable.id }).from(PluginConfigObjectTable).where(and(eq(PluginConfigObjectTable.pluginId, row.id), isNull(PluginConfigObjectTable.removedAt)))
  const marketplaceMembers = await collectPluginMarketplaces(context.organizationContext.organization.id, [row.id])
  return serializePlugin(row, memberships.length, marketplaceMembers.get(row.id) ?? [])
}

export async function createPlugin(input: { context: PluginArchActorContext; description?: string | null; name: string }) {
  const now = new Date()
  const row = {
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    deletedAt: null,
    description: normalizeOptionalString(input.description ?? undefined),
    id: createDenTypeId("plugin"),
    name: input.name.trim(),
    organizationId: input.context.organizationContext.organization.id,
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

export async function createPluginBundle(input: {
  components?: { type: ConfigObjectRow["objectType"]; value: ConfigObjectInput }[]
  context: PluginArchActorContext
  description?: string | null
  marketplaceId?: MarketplaceId
  name: string
  orgWide?: boolean
}) {
  if (input.marketplaceId) {
    // Validate the publish target before creating anything so a bad marketplace cannot leave an orphan plugin.
    await ensureEditableMarketplace(input.context, input.marketplaceId)
  }

  const plugin = await createPlugin({ context: input.context, description: input.description, name: input.name })

  for (const component of input.components ?? []) {
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

export async function listPluginMemberships(input: { context: PluginArchActorContext; pluginId: PluginId; includeConfigObjects?: boolean; onlyActive?: boolean }) {
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
  const latestVersions = await getLatestVersions(configObjects.map((row) => row.id))
  const byId = new Map<string, ReturnType<typeof serializeConfigObject>>(configObjects.map((row) => [row.id, serializeConfigObject(row, latestVersions.get(row.id) ?? null)]))
  return { items: memberships.map((membership) => serializeMembership(membership, byId.get(membership.configObjectId))), nextCursor: null }
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
  const now = new Date()
  const anthropicMarketplace = await ensureDefaultMarketplace({
    context,
    createdAt: now,
    description: DEFAULT_ANTHROPIC_MARKETPLACE_DESCRIPTION,
    logoUrl: DEFAULT_ANTHROPIC_MARKETPLACE_LOGO_URL,
    name: DEFAULT_ANTHROPIC_MARKETPLACE_NAME,
  })
  await ensureDefaultMarketplacePlugins({
    context,
    createdAt: now,
    entries: DEFAULT_ANTHROPIC_STARTER_PLUGINS,
    marketplaceId: anthropicMarketplace.id,
  })

  const marketplace = await ensureDefaultMarketplace({
    context,
    createdAt: now,
    description: DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
    logoUrl: DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
    name: DEFAULT_OPENWORK_MARKETPLACE_NAME,
  })
  await ensureDefaultMarketplacePlugins({
    context,
    createdAt: now,
    entries: DEFAULT_OPENWORK_EXTENSION_MANIFESTS.map((manifest) => ({ description: manifest.description, name: manifest.name })),
    marketplaceId: marketplace.id,
  })
}

async function ensureDefaultMarketplacePlugins(input: {
  context: PluginArchActorContext
  createdAt: Date
  entries: DefaultMarketplacePluginEntry[]
  marketplaceId: MarketplaceId
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id

  for (const entry of input.entries) {
    let plugin = (await db
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
        status: "active" as const,
        updatedAt: input.createdAt,
      }
      await db.insert(PluginTable).values(pluginRow)
      plugin = pluginRow
    }

    await ensureOrgWidePluginAccess({ context: input.context, pluginId: plugin.id, role: "viewer" })

    const existingMembership = (await db
      .select()
      .from(MarketplacePluginTable)
      .where(and(
        eq(MarketplacePluginTable.marketplaceId, input.marketplaceId),
        eq(MarketplacePluginTable.pluginId, plugin.id),
      ))
      .limit(1))[0]

    if (existingMembership) {
      if (existingMembership.removedAt) {
        await db.update(MarketplacePluginTable).set({ membershipSource: "system", removedAt: null }).where(eq(MarketplacePluginTable.id, existingMembership.id))
      }
      continue
    }

    await db.insert(MarketplacePluginTable).values({
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
  description: string
  logoUrl: string
  name: string
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id

  let marketplace = (await db
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
    await db.insert(MarketplaceTable).values(marketplaceRow)
    marketplace = marketplaceRow
  } else if (!marketplace.logoUrl) {
    await db.update(MarketplaceTable).set({ logoUrl: input.logoUrl }).where(eq(MarketplaceTable.id, marketplace.id))
    marketplace = { ...marketplace, logoUrl: input.logoUrl }
  }

  await ensureOrgWideMarketplaceAccess({ context: input.context, marketplaceId: marketplace.id, role: "viewer" })
  return marketplace
}

async function ensureOrgWideMarketplaceAccess(input: {
  context: PluginArchActorContext
  marketplaceId: MarketplaceId
  role: PluginArchRole
}) {
  const createdAt = new Date()
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id

  const existing = (await db
    .select()
    .from(MarketplaceAccessGrantTable)
    .where(and(eq(MarketplaceAccessGrantTable.marketplaceId, input.marketplaceId), eq(MarketplaceAccessGrantTable.orgWide, true)))
    .limit(1))[0]
  if (existing) {
    if (existing.removedAt || existing.role !== input.role) {
      await db.update(MarketplaceAccessGrantTable).set({ createdByOrgMembershipId, removedAt: null, role: input.role }).where(eq(MarketplaceAccessGrantTable.id, existing.id))
    }
    return
  }
  await db.insert(MarketplaceAccessGrantTable).values({
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
  pluginId: PluginId
  role: PluginArchRole
}) {
  const createdAt = new Date()
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id

  const existing = (await db
    .select()
    .from(PluginAccessGrantTable)
    .where(and(eq(PluginAccessGrantTable.pluginId, input.pluginId), eq(PluginAccessGrantTable.orgWide, true)))
    .limit(1))[0]
  if (existing) {
    if (existing.removedAt || existing.role !== input.role) {
      await db.update(PluginAccessGrantTable).set({ createdByOrgMembershipId, removedAt: null, role: input.role }).where(eq(PluginAccessGrantTable.id, existing.id))
    }
    return
  }
  await db.insert(PluginAccessGrantTable).values({
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

export async function createMarketplace(input: { context: PluginArchActorContext; description?: string | null; logoUrl?: string | null; name: string }) {
  const now = new Date()
  const row = {
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

export async function setMarketplaceLifecycle(input: { action: "archive" | "restore"; context: PluginArchActorContext; marketplaceId: MarketplaceId }) {
  const row = await ensureVisibleMarketplace(input.context, input.marketplaceId)
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "marketplace", role: "manager" })
  const updatedAt = new Date()
  await db.update(MarketplaceTable).set({
    deletedAt: input.action === "archive" ? row.deletedAt : null,
    status: input.action === "archive" ? "archived" : "active",
    updatedAt,
  }).where(eq(MarketplaceTable.id, row.id))
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

  const cloudReadinessByPlugin = memberFacingMcpConnectionsEnabled(input.context.organizationContext.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })
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
    marketplace: serializeMarketplace(marketplaceRow, plugins.length),
    plugins,
    source,
  }
}

export async function attachPluginToMarketplace(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId; membershipSource?: MarketplaceMembershipRow["membershipSource"]; pluginId: PluginId }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  await ensureEditableMarketplace(input.context, input.marketplaceId)

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

export async function listConnectorAccounts(input: { context: PluginArchActorContext; connectorType?: ConnectorAccountRow["connectorType"]; cursor?: string; limit?: number; q?: string; status?: ConnectorAccountRow["status"] }) {
  const rows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(eq(ConnectorAccountTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(ConnectorAccountTable.updatedAt), desc(ConnectorAccountTable.id))

  const filtered = rows
    .filter((row) => !input.connectorType || row.connectorType === input.connectorType)
    .filter((row) => !input.status || row.status === input.status)
    .filter((row) => !input.q || `${row.displayName}\n${row.remoteId}\n${row.externalAccountRef ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((row) => serializeConnectorAccount(row, resolveCreatorName(input.context, row.createdByOrgMembershipId)))

  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorAccount(input: { context: PluginArchActorContext; connectorType: ConnectorAccountRow["connectorType"]; displayName: string; externalAccountRef?: string | null; metadata?: Record<string, unknown>; remoteId: string }) {
  const now = new Date()
  const row = {
    connectorType: input.connectorType,
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    displayName: input.displayName.trim(),
    externalAccountRef: normalizeOptionalString(input.externalAccountRef ?? undefined),
    id: createDenTypeId("connectorAccount"),
    metadataJson: input.metadata ?? null,
    organizationId: input.context.organizationContext.organization.id,
    remoteId: input.remoteId.trim(),
    status: "active" as const,
    updatedAt: now,
  }
  await db.insert(ConnectorAccountTable).values(row)
  return serializeConnectorAccount(row)
}

export async function getConnectorAccountDetail(context: PluginArchActorContext, connectorAccountId: ConnectorAccountId) {
  const row = await getConnectorAccountRow(context.organizationContext.organization.id, connectorAccountId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  return serializeConnectorAccount(row, resolveCreatorName(context, row.createdByOrgMembershipId))
}

export async function disconnectConnectorAccount(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; reason?: string }) {
  const organizationId = input.context.organizationContext.organization.id
  const row = await getConnectorAccountRow(organizationId, input.connectorAccountId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }

  const instances = await db
    .select({ id: ConnectorInstanceTable.id })
    .from(ConnectorInstanceTable)
    .where(and(
      eq(ConnectorInstanceTable.organizationId, organizationId),
      eq(ConnectorInstanceTable.connectorAccountId, row.id),
    ))
  const instanceIds = instances.map((entry) => entry.id)

  const mappingRows = instanceIds.length === 0
    ? []
    : await db
      .select({ id: ConnectorMappingTable.id, pluginId: ConnectorMappingTable.pluginId })
      .from(ConnectorMappingTable)
      .where(inArray(ConnectorMappingTable.connectorInstanceId, instanceIds))
  const mappingIds = mappingRows.map((entry) => entry.id)
  const connectorPluginIds = [...new Set(mappingRows.map((entry) => entry.pluginId).filter((value): value is PluginId => Boolean(value)))]

  const configObjectRows = instanceIds.length === 0
    ? []
    : await db
      .select({ id: ConfigObjectTable.id })
      .from(ConfigObjectTable)
      .where(inArray(ConfigObjectTable.connectorInstanceId, instanceIds))
  const configObjectIds = configObjectRows.map((entry) => entry.id)

  // Resolve every imported marketplace/plugin id to delete up front so the
  // transaction below is a single pass of pure writes (no reads on the tx).
  const importedResourceCleanupPlan = await planConnectorImportedResourceCleanupIds({ organizationId, seedPluginIds: connectorPluginIds })
  const pluginMcpRequirementBindingIdsToDelete = await pluginMcpRequirementBindingIdsForHardDeletedResources({
    configObjectIds,
    organizationId,
    pluginIds: importedResourceCleanupPlan.pluginIdsToDelete,
  })
  importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete = uniqueIds([
    ...importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
    ...pluginMcpRequirementBindingIdsToDelete,
  ])

  await db.transaction(async (tx) => {
    await deletePluginMcpRequirementBindingsForHardDelete({
      bindingIds: importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
      tx,
    })

    if (instanceIds.length > 0) {
      await tx.delete(ConnectorSourceTombstoneTable).where(inArray(ConnectorSourceTombstoneTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorSourceBindingTable).where(inArray(ConnectorSourceBindingTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorSyncEventTable).where(inArray(ConnectorSyncEventTable.connectorInstanceId, instanceIds))
    }

    if (configObjectIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.id, configObjectIds))
    }

    if (mappingIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.connectorMappingId, mappingIds))
      await tx.delete(ConnectorMappingTable).where(inArray(ConnectorMappingTable.id, mappingIds))
    }

    if (instanceIds.length > 0) {
      await tx.delete(ConnectorTargetTable).where(inArray(ConnectorTargetTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorInstanceAccessGrantTable).where(inArray(ConnectorInstanceAccessGrantTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorInstanceTable).where(inArray(ConnectorInstanceTable.id, instanceIds))
    }

    await deleteConnectorImportedResources({ organizationId, plan: importedResourceCleanupPlan, tx })

    await tx.delete(ConnectorAccountTable).where(eq(ConnectorAccountTable.id, row.id))
  })

  return {
    deletedConfigObjectCount: configObjectIds.length,
    deletedConnectorInstanceCount: instanceIds.length,
    deletedConnectorMappingCount: mappingIds.length,
    disconnectedAccountId: row.id,
    reason: input.reason ?? null,
  }
}

export async function listConnectorInstances(input: { connectorAccountId?: ConnectorAccountId; context: PluginArchActorContext; cursor?: string; limit?: number; pluginId?: PluginId; q?: string; status?: ConnectorInstanceRow["status"] }) {
  const rows = await db
    .select()
    .from(ConnectorInstanceTable)
    .where(eq(ConnectorInstanceTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(ConnectorInstanceTable.updatedAt), desc(ConnectorInstanceTable.id))

  const filtered: ReturnType<typeof serializeConnectorInstance>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "connector_instance" })
    if (!role) continue
    if (input.connectorAccountId && row.connectorAccountId !== input.connectorAccountId) continue
    if (input.status && row.status !== input.status) continue
    if (input.q && !`${row.name}\n${row.remoteId ?? ""}`.toLowerCase().includes(input.q.toLowerCase())) continue
    if (input.pluginId) {
      const mappings = await db
        .select({ id: ConnectorMappingTable.id })
        .from(ConnectorMappingTable)
        .where(and(eq(ConnectorMappingTable.connectorInstanceId, row.id), eq(ConnectorMappingTable.pluginId, input.pluginId)))
        .limit(1)
      if (!mappings[0]) continue
    }
    filtered.push(serializeConnectorInstance(row))
  }

  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorInstance(input: { connectorAccountId: ConnectorAccountId; connectorType: ConnectorInstanceRow["connectorType"]; config?: Record<string, unknown>; context: PluginArchActorContext; name: string; remoteId?: string | null }) {
  const account = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!account) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  const now = new Date()
  const row = {
    connectorAccountId: account.id,
    connectorType: input.connectorType,
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    id: createDenTypeId("connectorInstance"),
    instanceConfigJson: input.config ?? null,
    lastSyncCursor: null,
    lastSyncStatus: null,
    lastSyncedAt: null,
    name: input.name.trim(),
    organizationId: input.context.organizationContext.organization.id,
    remoteId: normalizeOptionalString(input.remoteId ?? undefined),
    status: "active" as const,
    updatedAt: now,
  }
  await db.transaction(async (tx) => {
    await tx.insert(ConnectorInstanceTable).values(row)
    await tx.insert(ConnectorInstanceAccessGrantTable).values({
      connectorInstanceId: row.id,
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: createDenTypeId("connectorInstanceAccessGrant"),
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      role: "manager",
      teamId: null,
    })
  })
  return serializeConnectorInstance(row)
}

export async function getConnectorInstanceDetail(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await ensureVisibleConnectorInstance(context, connectorInstanceId)
  return serializeConnectorInstance(row)
}

export async function updateConnectorInstance(input: { connectorInstanceId: ConnectorInstanceId; config?: Record<string, unknown>; context: PluginArchActorContext; name?: string; remoteId?: string | null; status?: ConnectorInstanceRow["status"] }) {
  const row = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  await db.update(ConnectorInstanceTable).set({
    instanceConfigJson: input.config === undefined ? row.instanceConfigJson : input.config,
    name: input.name?.trim() || row.name,
    remoteId: input.remoteId === undefined ? row.remoteId : normalizeOptionalString(input.remoteId ?? undefined),
    status: input.status ?? row.status,
    updatedAt: new Date(),
  }).where(eq(ConnectorInstanceTable.id, row.id))
  return getConnectorInstanceDetail(input.context, row.id)
}

export async function setConnectorInstanceLifecycle(input: { action: "archive" | "disable" | "enable"; connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const row = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const status = input.action === "archive" ? "archived" : input.action === "disable" ? "disabled" : "active"
  await db.update(ConnectorInstanceTable).set({ status, updatedAt: new Date() }).where(eq(ConnectorInstanceTable.id, row.id))
  return getConnectorInstanceDetail(input.context, row.id)
}

function commonSelectorRootPath(selectors: string[]): string | null {
  const normalized = selectors
    .map((selector) => {
      let path = selector.trim().replace(/^\/+/, "").replace(/\/+$/, "")
      if (path.endsWith("/**")) {
        path = path.slice(0, -3)
      }
      const knownLeafSegments = ["skills", "commands", "agents", "hooks", "monitors", "mcp", ".mcp.json", ".lsp.json", "settings.json", "hooks.json"]
      for (const leaf of knownLeafSegments) {
        if (path === leaf) return ""
        if (path.endsWith(`/${leaf}`)) return path.slice(0, -(leaf.length + 1))
      }
      return path
    })
    .filter((path): path is string => path !== null)

  if (normalized.length === 0) return null
  if (normalized.every((path) => path === normalized[0])) {
    return normalized[0]
  }

  const parts = normalized[0].split("/")
  for (let index = parts.length; index > 0; index -= 1) {
    const candidate = parts.slice(0, index).join("/")
    if (normalized.every((path) => path === candidate || path.startsWith(`${candidate}/`))) {
      return candidate
    }
  }
  return ""
}

type ConnectorImportedResourceCleanupPlan = {
  marketplaceIdsToDelete: MarketplaceId[]
  pluginMcpRequirementBindingIdsToDelete: PluginMcpRequirementBindingId[]
  pluginIdsToDelete: PluginId[]
}

async function pluginMcpRequirementBindingIdsForHardDeletedResources(input: {
  configObjectIds: ConfigObjectId[]
  organizationId: OrganizationId
  pluginIds: PluginId[]
}) {
  const bindingIds = new Set<PluginMcpRequirementBindingId>()
  const configObjectIds = uniqueIds(input.configObjectIds)
  const pluginIds = uniqueIds(input.pluginIds)

  if (configObjectIds.length > 0) {
    const rows = await db
      .select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        inArray(PluginMcpRequirementBindingTable.configObjectId, configObjectIds),
      ))
    for (const row of rows) bindingIds.add(row.id)
  }

  if (pluginIds.length > 0) {
    const rows = await db
      .select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        inArray(PluginMcpRequirementBindingTable.pluginId, pluginIds),
      ))
    for (const row of rows) bindingIds.add(row.id)
  }

  return [...bindingIds]
}

async function pluginMcpRequirementBindingIdsForConnectorMapping(input: {
  connectorMappingId: ConnectorMappingId
  organizationId: OrganizationId
}) {
  const memberships = await db
    .select({
      configObjectId: PluginConfigObjectTable.configObjectId,
      pluginId: PluginConfigObjectTable.pluginId,
    })
    .from(PluginConfigObjectTable)
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.connectorMappingId, input.connectorMappingId),
    ))
  const configObjectIds = uniqueIds(memberships.map((membership) => membership.configObjectId))
  const pluginIds = uniqueIds(memberships.map((membership) => membership.pluginId))
  if (configObjectIds.length === 0 || pluginIds.length === 0) return []
  const membershipKeys = new Set(memberships.map((membership) => `${membership.pluginId}:${membership.configObjectId}`))
  const rows = await db
    .select({
      configObjectId: PluginMcpRequirementBindingTable.configObjectId,
      id: PluginMcpRequirementBindingTable.id,
      pluginId: PluginMcpRequirementBindingTable.pluginId,
    })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      inArray(PluginMcpRequirementBindingTable.configObjectId, configObjectIds),
      inArray(PluginMcpRequirementBindingTable.pluginId, pluginIds),
    ))
  return rows
    .filter((row) => membershipKeys.has(`${row.pluginId}:${row.configObjectId}`))
    .map((row) => row.id)
}

async function deletePluginMcpRequirementBindingsForHardDelete(input: {
  bindingIds: PluginMcpRequirementBindingId[]
  tx: DbTransaction
}) {
  const bindingIds = uniqueIds(input.bindingIds)
  if (bindingIds.length === 0) return
  await input.tx.delete(ExternalMcpConnectionAccessGrantTable).where(inArray(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, bindingIds))
  await input.tx.delete(PluginMcpRequirementBindingTable).where(inArray(PluginMcpRequirementBindingTable.id, bindingIds))
}

// Read-only planning pass. Runs outside of any transaction so that the
// subsequent delete pass can execute as a single transaction of pure writes.
async function planConnectorImportedResourceCleanupIds(input: { organizationId: OrganizationId; seedPluginIds: PluginId[] }): Promise<ConnectorImportedResourceCleanupPlan> {
  const uniqueSeedPluginIds = uniqueIds(input.seedPluginIds)
  if (uniqueSeedPluginIds.length === 0) {
    return { marketplaceIdsToDelete: [], pluginMcpRequirementBindingIdsToDelete: [], pluginIdsToDelete: [] }
  }

  const connectorMarketplaceRows = await db
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .where(and(
      inArray(MarketplacePluginTable.pluginId, uniqueSeedPluginIds),
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplacePluginTable.membershipSource, "connector"),
      isNull(MarketplacePluginTable.removedAt),
    ))
  const candidateMarketplaceIds = uniqueIds(connectorMarketplaceRows.map((row) => row.marketplaceId))

  const activeMarketplaceMemberships = candidateMarketplaceIds.length === 0
    ? []
    : await db
      .select({
        marketplaceId: MarketplacePluginTable.marketplaceId,
        membershipSource: MarketplacePluginTable.membershipSource,
        pluginId: MarketplacePluginTable.pluginId,
      })
      .from(MarketplacePluginTable)
      .where(and(
        inArray(MarketplacePluginTable.marketplaceId, candidateMarketplaceIds),
        eq(MarketplacePluginTable.organizationId, input.organizationId),
        isNull(MarketplacePluginTable.removedAt),
      ))

  const candidatePluginIds = uniqueIds([
    ...uniqueSeedPluginIds,
    ...activeMarketplaceMemberships
      .filter((membership) => membership.membershipSource === "connector")
      .map((membership) => membership.pluginId),
  ])

  const activePluginMembershipRows = candidatePluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId })
      .from(PluginConfigObjectTable)
      .where(and(
        inArray(PluginConfigObjectTable.pluginId, candidatePluginIds),
        eq(PluginConfigObjectTable.organizationId, input.organizationId),
        isNull(PluginConfigObjectTable.removedAt),
      ))

  const activeMappingRows = candidatePluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: ConnectorMappingTable.pluginId })
      .from(ConnectorMappingTable)
      .where(and(
        inArray(ConnectorMappingTable.pluginId, candidatePluginIds),
        eq(ConnectorMappingTable.organizationId, input.organizationId),
      ))

  const plan = planConnectorImportedResourceCleanup({
    activeMarketplaceMemberships,
    activeMappingPluginIds: activeMappingRows
      .map((row) => row.pluginId)
      .filter((pluginId): pluginId is PluginId => Boolean(pluginId)),
    activePluginMembershipPluginIds: activePluginMembershipRows.map((row) => row.pluginId),
    candidateMarketplaceIds,
    candidatePluginIds,
  })

  return {
    ...plan,
    pluginMcpRequirementBindingIdsToDelete: await pluginMcpRequirementBindingIdsForHardDeletedResources({
      configObjectIds: [],
      organizationId: input.organizationId,
      pluginIds: plan.pluginIdsToDelete,
    }),
  }
}

// Write-only delete pass. Must run inside a transaction. Contains no reads so it
// is safe to run alongside the other deletes on the same Vitess connection.
async function deleteConnectorImportedResources(input: {
  organizationId: OrganizationId
  plan: ConnectorImportedResourceCleanupPlan
  tx: DbTransaction
}) {
  const { marketplaceIdsToDelete, pluginIdsToDelete } = input.plan

  if (pluginIdsToDelete.length > 0) {
    await input.tx.delete(PluginConfigObjectTable).where(and(inArray(PluginConfigObjectTable.pluginId, pluginIdsToDelete), eq(PluginConfigObjectTable.organizationId, input.organizationId)))
    await input.tx.delete(MarketplacePluginTable).where(and(inArray(MarketplacePluginTable.pluginId, pluginIdsToDelete), eq(MarketplacePluginTable.organizationId, input.organizationId)))
    await input.tx.delete(PluginAccessGrantTable).where(and(inArray(PluginAccessGrantTable.pluginId, pluginIdsToDelete), eq(PluginAccessGrantTable.organizationId, input.organizationId)))
    await input.tx.delete(PluginTable).where(and(inArray(PluginTable.id, pluginIdsToDelete), eq(PluginTable.organizationId, input.organizationId)))
  }

  if (marketplaceIdsToDelete.length > 0) {
    await input.tx.delete(MarketplacePluginTable).where(and(inArray(MarketplacePluginTable.marketplaceId, marketplaceIdsToDelete), eq(MarketplacePluginTable.organizationId, input.organizationId)))
    await input.tx.delete(MarketplaceAccessGrantTable).where(and(inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIdsToDelete), eq(MarketplaceAccessGrantTable.organizationId, input.organizationId)))
    await input.tx.delete(MarketplaceTable).where(and(inArray(MarketplaceTable.id, marketplaceIdsToDelete), eq(MarketplaceTable.organizationId, input.organizationId)))
  }
}

export async function getConnectorInstanceConfiguration(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const instance = await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  const mappings = await db
    .select()
    .from(ConnectorMappingTable)
    .where(eq(ConnectorMappingTable.connectorInstanceId, instance.id))
    .orderBy(desc(ConnectorMappingTable.createdAt), desc(ConnectorMappingTable.id))

  const pluginIds = [...new Set(mappings.map((row) => row.pluginId).filter((value): value is PluginId => Boolean(value)))]
  const pluginRows = pluginIds.length === 0
    ? []
    : await db.select().from(PluginTable).where(inArray(PluginTable.id, pluginIds))
  const memberships = pluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId, configObjectId: PluginConfigObjectTable.configObjectId })
      .from(PluginConfigObjectTable)
      .where(and(inArray(PluginConfigObjectTable.pluginId, pluginIds), isNull(PluginConfigObjectTable.removedAt)))
  const configObjectIds = [...new Set(memberships.map((entry) => entry.configObjectId))]
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

  const pluginComponentCounts = new Map<string, Map<string, number>>()
  const membershipCounts = new Map<string, number>()
  for (const membership of memberships) {
    membershipCounts.set(membership.pluginId, (membershipCounts.get(membership.pluginId) ?? 0) + 1)
    const objectType = configObjectTypeById.get(membership.configObjectId)
    if (!objectType) continue
    let counts = pluginComponentCounts.get(membership.pluginId)
    if (!counts) {
      counts = new Map<string, number>()
      pluginComponentCounts.set(membership.pluginId, counts)
    }
    counts.set(objectType, (counts.get(objectType) ?? 0) + 1)
  }

  const pluginRootPaths = new Map<string, string | null>()
  for (const pluginId of pluginIds) {
    const selectors = mappings
      .filter((mapping) => mapping.pluginId === pluginId)
      .map((mapping) => mapping.selector)
    pluginRootPaths.set(pluginId, commonSelectorRootPath(selectors))
  }

  const configObjectRows = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(eq(ConfigObjectTable.connectorInstanceId, instance.id))

  const instanceConfig = instance.instanceConfigJson && typeof instance.instanceConfigJson === "object"
    ? instance.instanceConfigJson as Record<string, unknown>
    : {}
  const savedAutoImport = instanceConfig.autoImportNewPlugins

  return {
    autoImportNewPlugins: typeof savedAutoImport === "boolean" ? savedAutoImport : true,
    configuredPlugins: pluginRows.map((row) => {
      const componentCounts = Object.fromEntries(pluginComponentCounts.get(row.id) ?? new Map())
      return {
        ...serializePlugin(row, membershipCounts.get(row.id) ?? 0, [], componentCounts),
        componentCounts,
        rootPath: pluginRootPaths.get(row.id) ?? null,
      }
    }),
    connectorInstance: serializeConnectorInstance(instance),
    importedConfigObjectCount: configObjectRows.length,
    mappingCount: mappings.length,
  }
}

export async function setConnectorInstanceAutoImport(input: { autoImportNewPlugins: boolean; connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const instance = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const currentConfig = instance.instanceConfigJson && typeof instance.instanceConfigJson === "object"
    ? instance.instanceConfigJson as Record<string, unknown>
    : {}
  await db.update(ConnectorInstanceTable).set({
    instanceConfigJson: {
      ...currentConfig,
      autoImportNewPlugins: input.autoImportNewPlugins,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorInstanceTable.id, instance.id))

  return getConnectorInstanceConfiguration({ connectorInstanceId: instance.id, context: input.context })
}

export async function removeConnectorInstance(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const instance = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)

  const mappingRows = await db
    .select({ id: ConnectorMappingTable.id, pluginId: ConnectorMappingTable.pluginId })
    .from(ConnectorMappingTable)
    .where(eq(ConnectorMappingTable.connectorInstanceId, instance.id))
  const mappingIds = mappingRows.map((entry) => entry.id)
  const pluginIds = [...new Set(mappingRows.map((entry) => entry.pluginId).filter((value): value is PluginId => Boolean(value)))]

  const configObjectRows = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(eq(ConfigObjectTable.connectorInstanceId, instance.id))
  const configObjectIds = configObjectRows.map((entry) => entry.id)

  // Resolve every imported marketplace/plugin id to delete up front so the
  // transaction below is a single pass of pure writes (no reads on the tx).
  const importedResourceCleanupPlan = await planConnectorImportedResourceCleanupIds({ organizationId: instance.organizationId, seedPluginIds: pluginIds })
  const pluginMcpRequirementBindingIdsToDelete = await pluginMcpRequirementBindingIdsForHardDeletedResources({
    configObjectIds,
    organizationId: instance.organizationId,
    pluginIds: importedResourceCleanupPlan.pluginIdsToDelete,
  })
  importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete = uniqueIds([
    ...importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
    ...pluginMcpRequirementBindingIdsToDelete,
  ])

  await db.transaction(async (tx) => {
    await deletePluginMcpRequirementBindingsForHardDelete({
      bindingIds: importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
      tx,
    })

    await tx.delete(ConnectorSourceTombstoneTable).where(eq(ConnectorSourceTombstoneTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorSourceBindingTable).where(eq(ConnectorSourceBindingTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.connectorInstanceId, instance.id))

    if (configObjectIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.id, configObjectIds))
    }

    if (mappingIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.connectorMappingId, mappingIds))
      await tx.delete(ConnectorMappingTable).where(inArray(ConnectorMappingTable.id, mappingIds))
    }

    await tx.delete(ConnectorTargetTable).where(eq(ConnectorTargetTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorInstanceAccessGrantTable).where(eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorInstanceTable).where(eq(ConnectorInstanceTable.id, instance.id))

    await deleteConnectorImportedResources({ organizationId: instance.organizationId, plan: importedResourceCleanupPlan, tx })
  })

  return {
    deletedConfigObjectCount: configObjectIds.length,
    deletedConnectorMappingCount: mappingIds.length,
    removedConnectorInstanceId: instance.id,
  }
}

export async function listConnectorTargets(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; cursor?: string; limit?: number; q?: string; targetKind?: ConnectorTargetRow["targetKind"] }) {
  await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  const rows = await db
    .select()
    .from(ConnectorTargetTable)
    .where(eq(ConnectorTargetTable.connectorInstanceId, input.connectorInstanceId))
    .orderBy(desc(ConnectorTargetTable.updatedAt), desc(ConnectorTargetTable.id))

  const filtered = rows
    .filter((row) => !input.targetKind || row.targetKind === input.targetKind)
    .filter((row) => !input.q || `${row.remoteId}\n${row.externalTargetRef ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((row) => serializeConnectorTarget(row))

  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorTarget(input: { config: Record<string, unknown>; connectorInstanceId: ConnectorInstanceId; connectorType: ConnectorTargetRow["connectorType"]; context: PluginArchActorContext; externalTargetRef?: string | null; remoteId: string; targetKind: ConnectorTargetRow["targetKind"] }) {
  await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const row = {
    connectorInstanceId: input.connectorInstanceId,
    connectorType: input.connectorType,
    createdAt: new Date(),
    externalTargetRef: normalizeOptionalString(input.externalTargetRef ?? undefined),
    id: createDenTypeId("connectorTarget"),
    organizationId: input.context.organizationContext.organization.id,
    remoteId: input.remoteId.trim(),
    targetConfigJson: input.config,
    targetKind: input.targetKind,
    updatedAt: new Date(),
  }
  await db.insert(ConnectorTargetTable).values(row)
  return serializeConnectorTarget(row)
}

export async function getConnectorTargetDetail(context: PluginArchActorContext, connectorTargetId: ConnectorTargetId) {
  const target = await getConnectorTargetRow(context.organizationContext.organization.id, connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureVisibleConnectorInstance(context, target.connectorInstanceId)
  return serializeConnectorTarget(target)
}

export async function updateConnectorTarget(input: { config?: Record<string, unknown>; connectorTargetId: ConnectorTargetId; context: PluginArchActorContext; externalTargetRef?: string | null; remoteId?: string }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureEditableConnectorInstance(input.context, target.connectorInstanceId)
  await db.update(ConnectorTargetTable).set({
    externalTargetRef: input.externalTargetRef === undefined ? target.externalTargetRef : normalizeOptionalString(input.externalTargetRef ?? undefined),
    remoteId: input.remoteId?.trim() || target.remoteId,
    targetConfigJson: input.config === undefined ? target.targetConfigJson : input.config,
    updatedAt: new Date(),
  }).where(eq(ConnectorTargetTable.id, target.id))
  return getConnectorTargetDetail(input.context, target.id)
}

export async function queueConnectorTargetResync(input: { connectorTargetId: ConnectorTargetId; context: PluginArchActorContext }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  const instance = await ensureEditableConnectorInstance(input.context, target.connectorInstanceId)
  const eventId = createDenTypeId("connectorSyncEvent")
  await db.insert(ConnectorSyncEventTable).values({
    completedAt: null,
    connectorInstanceId: instance.id,
    connectorTargetId: target.id,
    connectorType: target.connectorType,
    eventType: "manual_resync",
    externalEventRef: null,
    id: eventId,
    organizationId: instance.organizationId,
    remoteId: target.remoteId,
    sourceRevisionRef: null,
    startedAt: new Date(),
    status: "queued",
    summaryJson: { queuedBy: input.context.organizationContext.currentMember.id },
  })
  return { id: eventId }
}

export async function listConnectorMappings(input: { connectorTargetId: ConnectorTargetId; context: PluginArchActorContext; cursor?: string; limit?: number; mappingKind?: ConnectorMappingRow["mappingKind"]; objectType?: ConnectorMappingRow["objectType"]; pluginId?: PluginId; q?: string }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureVisibleConnectorInstance(input.context, target.connectorInstanceId)
  const rows = await db.select().from(ConnectorMappingTable).where(eq(ConnectorMappingTable.connectorTargetId, target.id)).orderBy(desc(ConnectorMappingTable.updatedAt), desc(ConnectorMappingTable.id))
  const filtered = rows
    .filter((row) => !input.mappingKind || row.mappingKind === input.mappingKind)
    .filter((row) => !input.objectType || row.objectType === input.objectType)
    .filter((row) => !input.pluginId || row.pluginId === input.pluginId)
    .filter((row) => !input.q || `${row.selector}\n${row.remoteId ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((row) => serializeConnectorMapping(row))
  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorMapping(input: { autoAddToPlugin: boolean; config?: Record<string, unknown>; connectorTargetId: ConnectorTargetId; context: PluginArchActorContext; mappingKind: ConnectorMappingRow["mappingKind"]; objectType: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector: string }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureEditableConnectorInstance(input.context, target.connectorInstanceId)
  if (input.pluginId) {
    await ensureEditablePlugin(input.context, input.pluginId)
  }
  const row = {
    autoAddToPlugin: input.autoAddToPlugin,
    connectorInstanceId: target.connectorInstanceId,
    connectorTargetId: target.id,
    connectorType: target.connectorType,
    createdAt: new Date(),
    id: createDenTypeId("connectorMapping"),
    mappingConfigJson: input.config ?? null,
    mappingKind: input.mappingKind,
    objectType: input.objectType,
    organizationId: input.context.organizationContext.organization.id,
    pluginId: input.pluginId ?? null,
    remoteId: null,
    selector: input.selector.trim(),
    updatedAt: new Date(),
  }
  await db.insert(ConnectorMappingTable).values(row)
  return serializeConnectorMapping(row)
}

export async function updateConnectorMapping(input: { autoAddToPlugin?: boolean; config?: Record<string, unknown>; connectorMappingId: ConnectorMappingId; context: PluginArchActorContext; objectType?: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector?: string }) {
  const mapping = await getConnectorMappingRow(input.context.organizationContext.organization.id, input.connectorMappingId)
  if (!mapping) throw new PluginArchRouteFailure(404, "connector_mapping_not_found", "Connector mapping not found.")
  await ensureEditableConnectorInstance(input.context, mapping.connectorInstanceId)
  if (input.pluginId) {
    await ensureEditablePlugin(input.context, input.pluginId)
  }
  await db.update(ConnectorMappingTable).set({
    autoAddToPlugin: input.autoAddToPlugin ?? mapping.autoAddToPlugin,
    mappingConfigJson: input.config === undefined ? mapping.mappingConfigJson : input.config,
    objectType: input.objectType ?? mapping.objectType,
    pluginId: input.pluginId === undefined ? mapping.pluginId : input.pluginId,
    selector: input.selector?.trim() || mapping.selector,
    updatedAt: new Date(),
  }).where(eq(ConnectorMappingTable.id, mapping.id))
  return serializeConnectorMapping({ ...mapping, autoAddToPlugin: input.autoAddToPlugin ?? mapping.autoAddToPlugin, mappingConfigJson: input.config === undefined ? mapping.mappingConfigJson : input.config, objectType: input.objectType ?? mapping.objectType, pluginId: input.pluginId === undefined ? mapping.pluginId : input.pluginId, selector: input.selector?.trim() || mapping.selector, updatedAt: new Date() })
}

export async function deleteConnectorMapping(input: { connectorMappingId: ConnectorMappingId; context: PluginArchActorContext }) {
  const mapping = await getConnectorMappingRow(input.context.organizationContext.organization.id, input.connectorMappingId)
  if (!mapping) throw new PluginArchRouteFailure(404, "connector_mapping_not_found", "Connector mapping not found.")
  await ensureEditableConnectorInstance(input.context, mapping.connectorInstanceId)
  const bindingIds = await pluginMcpRequirementBindingIdsForConnectorMapping({
    connectorMappingId: mapping.id,
    organizationId: mapping.organizationId,
  })
  await db.transaction(async (tx) => {
    await deletePluginMcpRequirementBindingsForHardDelete({ bindingIds, tx })
    await tx.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.connectorMappingId, mapping.id))
    await tx.delete(ConnectorMappingTable).where(eq(ConnectorMappingTable.id, mapping.id))
  })
}

export async function listConnectorSyncEvents(input: { connectorInstanceId?: ConnectorInstanceId; connectorTargetId?: ConnectorTargetId; context: PluginArchActorContext; cursor?: string; eventType?: ConnectorSyncEventRow["eventType"]; limit?: number; q?: string; status?: ConnectorSyncEventRow["status"] }) {
  const rows = await db
    .select({ event: ConnectorSyncEventTable, instance: ConnectorInstanceTable })
    .from(ConnectorSyncEventTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorSyncEventTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(eq(ConnectorInstanceTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(ConnectorSyncEventTable.startedAt), desc(ConnectorSyncEventTable.id))

  const filtered: ReturnType<typeof serializeConnectorSyncEvent>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.instance.id, resourceKind: "connector_instance" })
    if (!role) continue
    if (input.connectorInstanceId && row.event.connectorInstanceId !== input.connectorInstanceId) continue
    if (input.connectorTargetId && row.event.connectorTargetId !== input.connectorTargetId) continue
    if (input.eventType && row.event.eventType !== input.eventType) continue
    if (input.status && row.event.status !== input.status) continue
    if (input.q && !`${row.event.externalEventRef ?? ""}\n${row.event.sourceRevisionRef ?? ""}`.toLowerCase().includes(input.q.toLowerCase())) continue
    filtered.push(serializeConnectorSyncEvent(row.event))
  }
  return pageItems(filtered, input.cursor, input.limit)
}

export async function getConnectorSyncEventDetail(context: PluginArchActorContext, connectorSyncEventId: ConnectorSyncEventId) {
  const row = await getConnectorSyncEventRow(context.organizationContext.organization.id, connectorSyncEventId)
  if (!row) throw new PluginArchRouteFailure(404, "connector_sync_event_not_found", "Connector sync event not found.")
  await ensureVisibleConnectorInstance(context, row.connectorInstanceId)
  return serializeConnectorSyncEvent(row)
}

export async function retryConnectorSyncEvent(input: { connectorSyncEventId: ConnectorSyncEventId; context: PluginArchActorContext }) {
  const row = await getConnectorSyncEventRow(input.context.organizationContext.organization.id, input.connectorSyncEventId)
  if (!row) throw new PluginArchRouteFailure(404, "connector_sync_event_not_found", "Connector sync event not found.")
  await ensureEditableConnectorInstance(input.context, row.connectorInstanceId)
  await db.update(ConnectorSyncEventTable).set({ completedAt: null, startedAt: new Date(), status: "queued" }).where(eq(ConnectorSyncEventTable.id, row.id))
  return { id: row.id }
}

function githubConnectorAppConfig() {
  try {
    return getGithubConnectorAppConfig(env.githubConnectorApp)
  } catch (error) {
    if (error instanceof GithubConnectorConfigError) {
      throw new PluginArchRouteFailure(409, "github_connector_app_not_configured", error.message)
    }
    throw error
  }
}

export function consumeGithubInstallState(state: string) {
  const parsed = verifyGithubInstallStateToken({ secret: env.betterAuthSecret, token: state })
  if (!parsed) {
    throw new PluginArchRouteFailure(400, "invalid_github_install_state", "GitHub install state is invalid or expired.")
  }
  return parsed
}

function wrapGithubConnectorError(error: unknown): never {
  if (error instanceof PluginArchRouteFailure) {
    throw error
  }

  if (error instanceof GithubConnectorConfigError) {
    throw new PluginArchRouteFailure(409, "github_connector_app_not_configured", error.message)
  }

  if (error instanceof GithubConnectorRequestError) {
    throw new PluginArchRouteFailure(409, "github_connector_request_failed", error.message)
  }

  throw error
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
      input.classification === "claude_single_plugin_repo" || input.classification === "claude_multi_plugin_repo"
        ? "completed"
        : "warning",
      "check_plugin_manifests",
      "Check for plugin manifests",
    ),
    discoveryStep(input.discoveredPlugins.length > 0 ? "completed" : "warning", "prepare_discovered_plugins", "Prepare discovered plugins"),
  ] satisfies GithubConnectorDiscoveryStep[]
}

function buildGithubDiscoveryImportPlans(input: { discoveredPlugins: GithubDiscoveredPlugin[]; treeEntries: GithubDiscoveryTreeEntry[] }) {
  return Object.fromEntries(input.discoveredPlugins.map((plugin) => [
    plugin.key,
    discoveryMappingsForPlugin(plugin).map((mapping) => {
      const entries = importableGithubPathsForMapping({ mapping, treeEntries: input.treeEntries })
      const fileShaByPath: Record<string, string> = {}
      for (const entry of entries) {
        if (entry.sha) {
          fileShaByPath[entry.path] = entry.sha
        }
      }
      return {
        fileShaByPath,
        objectType: mapping.objectType,
        paths: entries.map((entry) => entry.path),
        selector: mapping.selector,
      } satisfies GithubDiscoveryImportPlan
    }),
  ])) satisfies Record<string, GithubDiscoveryImportPlan[]>
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
  const serverName = boundedPublisherName(input.serverName, "")
  const pluginName = boundedPublisherName(input.pluginName, "")
  if (!pluginName) return serverName || "Imported MCP"
  if (!serverName) return pluginName
  return boundedPublisherName(`${pluginName} / ${serverName}`, "Imported MCP")
}

function githubPluginMcpServerKey(input: { name: string; pluginKey: string; sourcePath: string; url: string | null }) {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.pluginKey, input.sourcePath, input.name, input.url ?? ""]))
    .digest("base64url")
  return `github-mcp:${digest}`
}

const githubPluginMcpManifestByServer = new WeakMap<GithubPluginMcpImportServer, Record<string, unknown>>()

function githubPluginMcpImportServer(
  input: Omit<GithubPluginMcpImportServer, "authType" | "discovery" | "serverKey">,
  manifestConfig?: Record<string, unknown>,
): GithubPluginMcpImportServer {
  const sourcePath = safePublicGithubPath(input.sourcePath)
  if (!sourcePath) {
    throw new PluginArchRouteFailure(400, "invalid_github_path", "GitHub MCP declarations must come from a safe repository path.")
  }
  const normalizedInput = {
    ...input,
    name: boundedPublisherName(input.name, "MCP server"),
    pluginName: boundedPublisherName(input.pluginName, "GitHub plugin"),
    sourcePath,
  }
  const server: GithubPluginMcpImportServer = {
    ...normalizedInput,
    authType: "unknown",
    discovery: null,
    serverKey: githubPluginMcpServerKey(normalizedInput),
  }
  if (manifestConfig) githubPluginMcpManifestByServer.set(server, manifestConfig)
  return server
}

function declaredGithubMcpLimitFailure(): never {
  throw new PluginArchRouteFailure(
    400,
    "github_import_limit_exceeded",
    `GitHub plugin imports are limited to ${PUBLIC_GITHUB_IMPORT_LIMITS.declaredMcpServers} declared MCP servers. Narrow the GitHub URL to a plugin subdirectory.`,
  )
}

export function mcpServerEntriesFromPayload(input: {
  declarationLimit?: number
  plugin: GithubDiscoveredPlugin
  rawSourceText: string
  sourcePath: string
}): GithubPluginMcpImportServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.rawSourceText)
  } catch {
    return [githubPluginMcpImportServer({
      connectionId: null,
      name: input.sourcePath,
      pluginKey: input.plugin.key,
      pluginName: input.plugin.displayName,
      skippedReason: "invalid_url",
      sourcePath: input.sourcePath,
      supported: false,
      url: null,
    })]
  }

  const root = isRecord(parsed) ? parsed : {}
  const declarationLimit = Math.max(0, Math.min(
    input.declarationLimit ?? PUBLIC_GITHUB_IMPORT_LIMITS.declaredMcpServers,
    PUBLIC_GITHUB_IMPORT_LIMITS.declaredMcpServers,
  ))
  type DeclaredMcpEntry = { forcedLocal: boolean; rawConfig: unknown; rawName: string }
  const entries: DeclaredMcpEntry[] = []
  const pushEntry = (entry: DeclaredMcpEntry) => {
    if (entries.length >= declarationLimit) declaredGithubMcpLimitFailure()
    entries.push(entry)
  }
  const containers = [
    isRecord(root.mcpServers) ? root.mcpServers : null,
    isRecord(root.mcp) ? root.mcp : null,
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry))
  for (const container of containers) {
    for (const rawName in container) {
      if (!Object.prototype.hasOwnProperty.call(container, rawName)) continue
      pushEntry({ forcedLocal: false, rawConfig: container[rawName], rawName })
    }
  }
  const pluginDisplayName = boundedPublisherName(input.plugin.displayName, "GitHub plugin")
  const registryTitle = boundedPublisherName(typeof root.title === "string" ? root.title : null, "")
  const registryDeclaredName = boundedPublisherName(typeof root.name === "string" ? root.name : null, "")
  const registryName = registryTitle || registryDeclaredName || pluginDisplayName
  if (entries.length === 0) {
    const registryRemoteValues = Array.isArray(root.remotes) ? root.remotes : []
    const registryPackageValues = Array.isArray(root.packages) ? root.packages : []
    if (registryRemoteValues.length + registryPackageValues.length > declarationLimit) {
      declaredGithubMcpLimitFailure()
    }
    for (let index = 0; index < registryRemoteValues.length; index += 1) {
      const rawConfig = registryRemoteValues[index]
      if (!isRecord(rawConfig)) continue
      pushEntry({
        forcedLocal: false,
        rawConfig,
        rawName: boundedPublisherName(
          typeof rawConfig.name === "string" ? rawConfig.name : null,
          registryRemoteValues.length === 1 ? registryName : `${registryName} remote ${index + 1}`,
        ),
      })
    }
    for (let index = 0; index < registryPackageValues.length; index += 1) {
      const rawConfig = registryPackageValues[index]
      if (!isRecord(rawConfig)) continue
      pushEntry({
        forcedLocal: true,
        rawConfig,
        rawName: boundedPublisherName(
          typeof rawConfig.name === "string" ? rawConfig.name : null,
          `${registryName} package ${index + 1}`,
        ),
      })
    }
  }
  if (entries.length === 0) {
    pushEntry({ forcedLocal: false, rawConfig: root, rawName: pluginDisplayName })
  }

  return entries.map(({ forcedLocal, rawName, rawConfig }) => {
    const config = isRecord(rawConfig) ? rawConfig : {}
    const name = boundedPublisherName(rawName, pluginDisplayName)
    const url = typeof config.url === "string" ? config.url.trim() : ""
    const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : ""
    const command = typeof config.command === "string"
      ? config.command.trim()
      : Array.isArray(config.command) && config.command.some((part) => typeof part === "string" && part.trim())
        ? "local command"
        : ""

    if (forcedLocal) {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "local_unsupported",
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })
    }

    if (!url) {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: command ? "local_unsupported" : "missing_url",
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })
    }

    if (url.length > MAX_IMPORTED_MCP_URL_LENGTH) {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
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
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourcePath: input.sourcePath,
        supported: false,
        // Do not reflect an unparseable publisher-controlled value. It may
        // contain a credential-like substring that URLSearchParams cannot
        // safely classify.
        url: null,
      })
    }

    if (
      parsedUrl.hash
      || parsedUrl.username
      || parsedUrl.password
      || [...parsedUrl.searchParams.keys()].some(isSensitiveExternalMcpCredentialKey)
    ) {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })
    }

    const normalizedUrl = parsedUrl.toString()
    if (normalizedUrl.length > MAX_IMPORTED_MCP_URL_LENGTH) {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "invalid_url",
        sourcePath: input.sourcePath,
        supported: false,
        url: null,
      })
    }

    if (type && type !== "http" && type !== "remote" && type !== "streamable-http" && type !== "sse") {
      return githubPluginMcpImportServer({
        connectionId: null,
        name,
        pluginKey: input.plugin.key,
        pluginName: input.plugin.displayName,
        skippedReason: "local_unsupported",
        sourcePath: input.sourcePath,
        supported: false,
        url: normalizedUrl,
      })
    }

    return githubPluginMcpImportServer({
      connectionId: null,
      name,
      pluginKey: input.plugin.key,
      pluginName: input.plugin.displayName,
      skippedReason: null,
      sourcePath: input.sourcePath,
      supported: true,
      url: normalizedUrl,
    }, config)
  })
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

function skillEntryFromSource(input: {
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
    sourcePath: input.sourcePath,
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

const MAX_GITHUB_MCP_LIVE_DISCOVERIES = 12
const MAX_GITHUB_MCP_IMPORT_SELECTIONS = 12
const GITHUB_MCP_DISCOVERY_CONCURRENCY = 4
const GITHUB_MCP_DISCOVERY_TIMEOUT_MS = 4_000
const GITHUB_MCP_PREVIEW_OPERATION_TIMEOUT_MS = 18_000
const MARKETPLACE_MCP_CONFIGURE_OPERATION_TIMEOUT_MS = 15_000
// Stay comfortably below the dashboard's 30s request timeout so a client
// never retries while the first import can still materialize state.
const GITHUB_MCP_IMPORT_OPERATION_TIMEOUT_MS = 24_000
// GitHub/network inspection must leave a deterministic database window. The
// import still has a 24s server ceiling, while the dashboard retains another
// 6s to receive the response (or a completed rollback) before its own timeout.
const GITHUB_MCP_IMPORT_MATERIALIZATION_RESERVE_MS = 6_000
const GITHUB_MCP_IMPORT_FINAL_COMMIT_RESERVE_MS = 1_500
const MAX_GITHUB_MCP_IMPORT_COMPONENTS = 12
const MAX_GITHUB_MCP_IMPORT_ACCESS_TARGETS = 100

function marketplaceMcpRemainingTimeoutMs(deadlineAt: number, maximumMs: number) {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) {
    throw new PluginArchRouteFailure(
      502,
      "marketplace_mcp_configuration_timeout",
      "MCP inspection and validation exceeded its total time limit. Retry the configuration.",
    )
  }
  return Math.max(1, Math.min(maximumMs, remainingMs))
}

function githubMcpRemainingTimeoutMs(deadlineAt: number, maximumMs: number) {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) {
    throw new PluginArchRouteFailure(
      502,
      "github_import_timeout",
      "GitHub plugin inspection and MCP validation exceeded its total time limit. Retry or select fewer servers.",
    )
  }
  return Math.max(1, Math.min(maximumMs, remainingMs))
}

function requireGithubImportTime(deadlineAt: number, minimumRemainingMs = 1) {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs < minimumRemainingMs) {
    throw new PluginArchRouteFailure(
      502,
      "github_import_timeout",
      "GitHub plugin import exceeded its bounded server time. Retry or select fewer components.",
    )
  }
  return remainingMs
}

async function mapWithConcurrency<TInput, TOutput>(input: {
  concurrency: number
  items: TInput[]
  map: (item: TInput, index: number) => Promise<TOutput>
}): Promise<TOutput[]> {
  const output = new Array<TOutput>(input.items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(input.concurrency, input.items.length) }, async () => {
    while (nextIndex < input.items.length) {
      const index = nextIndex++
      output[index] = await input.map(input.items[index] as TInput, index)
    }
  })
  await Promise.all(workers)
  return output
}

async function discoverGithubPluginMcpImportServers(input: {
  deadlineAt: number
  live: boolean
  servers: GithubPluginMcpImportServer[]
}) {
  const liveServerIndexes = new Set(input.live ? input.servers
    .flatMap((server, index) => server.supported && server.url ? [index] : [])
    .slice(0, MAX_GITHUB_MCP_LIVE_DISCOVERIES) : [])
  const unavailableFetch = async (): Promise<Response> => {
    throw new Error("Live MCP discovery was not scheduled for this preview item.")
  }

  return mapWithConcurrency({
    concurrency: GITHUB_MCP_DISCOVERY_CONCURRENCY,
    items: input.servers,
    map: async (server, index) => {
      if (!server.supported || !server.url) return server
      const manifestConfig = githubPluginMcpManifestByServer.get(server)
      const discovery = await discoverExternalMcpConfiguration({
        config: manifestConfig,
        ...(liveServerIndexes.has(index) ? {} : { fetch: unavailableFetch }),
        timeoutMs: githubMcpRemainingTimeoutMs(input.deadlineAt, GITHUB_MCP_DISCOVERY_TIMEOUT_MS),
        url: server.url,
      })
      const discoveredServer: GithubPluginMcpImportServer = discovery.support.status === "unsupported"
        ? { ...server, authType: discovery.auth.kind, discovery, skippedReason: "unsupported_configuration" as const, supported: false }
        : { ...server, authType: discovery.auth.kind, discovery }
      // Spreading creates a new object identity. Rebind the internal-only
      // manifest so import-time scope/config validation sees the exact source
      // that produced this preview without serializing secret placeholders.
      if (manifestConfig) githubPluginMcpManifestByServer.set(discoveredServer, manifestConfig)
      return discoveredServer
    },
  })
}

async function computeGithubPluginMcpImportPlan(input: {
  githubUrl: string
  includeDiscovery?: boolean
  includeSkillText?: boolean
  operationDeadlineAt?: number
}): Promise<GithubPluginMcpImportPlan> {
  const operationDeadlineAt = input.operationDeadlineAt
    ?? Date.now() + GITHUB_MCP_PREVIEW_OPERATION_TIMEOUT_MS
  const target = parsePublicGithubPluginUrl(input.githubUrl)
  const snapshot = await getPublicGithubRepositoryTree(target, operationDeadlineAt)
  const fileTextByPath = await getPublicGithubDiscoveryFileTexts(snapshot)
  const discovery = buildGithubRepoDiscovery({
    entries: snapshot.treeEntries,
    fileTextByPath,
  })
  const importPlansByPluginKey = buildGithubDiscoveryImportPlans({
    discoveredPlugins: discovery.discoveredPlugins,
    treeEntries: snapshot.treeEntries,
  })

  const servers: GithubPluginMcpImportServer[] = []
  const skills: GithubPluginSkillImportSkill[] = []
  for (const plugin of discovery.discoveredPlugins.filter((entry) => entry.supported)) {
    const componentPlans = importPlansByPluginKey[plugin.key] ?? []
    for (const plan of componentPlans.filter((entry) => entry.objectType === "mcp")) {
      for (const path of plan.paths) {
        const rawSourceText = await getPublicGithubTextFile({
          discoveryPath: path,
          snapshot,
        })
        if (!rawSourceText) continue
        const declaredServers = mcpServerEntriesFromPayload({
          declarationLimit: PUBLIC_GITHUB_IMPORT_LIMITS.declaredMcpServers - servers.length,
          plugin,
          rawSourceText,
          sourcePath: path,
        })
        for (const server of declaredServers) {
          if (servers.length >= PUBLIC_GITHUB_IMPORT_LIMITS.declaredMcpServers) declaredGithubMcpLimitFailure()
          servers.push(server)
        }
      }
    }
    for (const plan of componentPlans.filter((entry) => entry.objectType === "skill")) {
      for (const path of plan.paths) {
        const rawSourceText = await getPublicGithubTextFile({
          discoveryPath: path,
          snapshot,
        })
        if (!rawSourceText) continue
        skills.push(skillEntryFromSource({
          includeRawSourceText: input.includeSkillText === true,
          plugin,
          rawSourceText,
          sourcePath: path,
        }))
      }
    }
  }

  const serverByKey = new Map<string, GithubPluginMcpImportServer>()
  for (const server of servers) {
    if (!serverByKey.has(server.serverKey)) serverByKey.set(server.serverKey, server)
  }
  const uniqueServers = [...serverByKey.values()]
  const duplicateServerCount = servers.length - uniqueServers.length
  const discoveredServerCount = uniqueServers.filter((server) => server.supported && server.url).length
  const serversWithDiscovery = await discoverGithubPluginMcpImportServers({
    deadlineAt: operationDeadlineAt,
    live: input.includeDiscovery !== false,
    servers: uniqueServers,
  })

  const plugins = discovery.discoveredPlugins
    .filter((plugin) => plugin.supported)
    .map((plugin) => ({
      description: plugin.description,
      key: plugin.key,
      mcpCount: serversWithDiscovery.filter((server) => server.pluginKey === plugin.key && server.supported).length,
      name: boundedPublisherName(plugin.displayName, "GitHub plugin"),
      skillCount: skills.filter((skill) => skill.pluginKey === plugin.key && skill.supported).length,
    } satisfies GithubPluginMcpImportPlugin))
    .filter((plugin) => plugin.mcpCount > 0 || plugin.skillCount > 0)

  return {
    branch: snapshot.branch,
    classification: discovery.classification,
    marketplace: discovery.marketplace,
    plugins,
    repositoryFullName: snapshot.repositoryFullName,
    rootPath: snapshot.rootPath,
    servers: serversWithDiscovery,
    skills,
    sourceRevisionRef: snapshot.headSha,
    warnings: [
      ...discovery.warnings,
      ...(duplicateServerCount > 0 ? [`Ignored ${duplicateServerCount} duplicate MCP server declaration${duplicateServerCount === 1 ? "" : "s"} with the same stable key.`] : []),
      ...(input.includeDiscovery !== false && discoveredServerCount > MAX_GITHUB_MCP_LIVE_DISCOVERIES
        ? [`Live MCP discovery is capped at ${MAX_GITHUB_MCP_LIVE_DISCOVERIES} servers per preview. Remaining servers use manifest-only configuration guidance.`]
        : []),
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

function ownedImportedExternalMcpConnectionId(spec: Record<string, unknown>) {
  if (spec.externalMcpConnectionOwnedByPlugin !== true) return null
  return readRecordString(spec, "externalMcpConnectionId") || null
}

async function deleteOwnedImportedExternalMcpConnectionsWithoutBindings(input: {
  connectionIds: string[]
  organizationId: OrganizationId
}) {
  for (const rawConnectionId of new Set(input.connectionIds)) {
    let connectionId: ExternalMcpConnectionRow["id"]
    try {
      connectionId = normalizeDenTypeId("externalMcpConnection", rawConnectionId)
    } catch {
      continue
    }
    await deleteExternalMcpConnectionIfUnused({
      allowConnectedAt: true,
      connectionId,
      organizationId: input.organizationId,
    })
  }
}

async function deleteStalePluginMcpRequirementBindingsForConfigObject(input: {
  configObject: ConfigObjectRow
  previousVersion: ConfigObjectVersionRow | null
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
  const previouslyOwnedConnectionId = input.previousVersion
    ? ownedImportedExternalMcpConnectionId(parseConfigObjectVersionSpec(input.previousVersion))
    : null
  const ownedConnectionIds = bindings.flatMap((row) => previouslyOwnedConnectionId === row.connection.id
    ? [row.connection.id]
    : [])
  await deletePluginMcpRequirementBindingsByIds({ bindingIds: staleBindingIds })
  const staleBindingIdSet = new Set(staleBindingIds)
  await deleteOwnedImportedExternalMcpConnectionsWithoutBindings({
    connectionIds: bindings.flatMap((row) => staleBindingIdSet.has(row.binding.id) && ownedConnectionIds.includes(row.connection.id)
      ? [row.connection.id]
      : []),
    organizationId: input.configObject.organizationId,
  })
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

  for (const parameter of parsed.searchParams.keys()) {
    if (isSensitiveExternalMcpCredentialKey(parameter)) {
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
    .select({ id: PluginConfigObjectTable.id })
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

async function derivePluginMcpRequirementAccessForCommit(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
  tx: DbTransaction
}): Promise<PluginMcpRequirementAccess> {
  // This active membership row is the stable per-requirement mutex. It also
  // orders concurrent configure calls before either can publish a connection.
  const activeRows = await input.tx
    .select({ id: PluginConfigObjectTable.id })
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
    .for("update")
  if (!activeRows[0]) {
    throw new PluginArchRouteFailure(409, "mcp_requirement_changed", "The plugin MCP requirement changed while it was being configured. Inspect it again and retry.")
  }

  const marketplaceRows = await input.tx
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
    .for("update")
  const marketplaceIds = marketplaceRows.map((row) => row.marketplaceId)
  const configObjectGrants = await input.tx
    .select({
      orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
      orgWide: ConfigObjectAccessGrantTable.orgWide,
      teamId: ConfigObjectAccessGrantTable.teamId,
    })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, input.organizationId),
      eq(ConfigObjectAccessGrantTable.configObjectId, input.configObjectId),
      isNull(ConfigObjectAccessGrantTable.removedAt),
    ))
    .for("update")
  const pluginGrants = await input.tx
    .select({
      orgMembershipId: PluginAccessGrantTable.orgMembershipId,
      orgWide: PluginAccessGrantTable.orgWide,
      teamId: PluginAccessGrantTable.teamId,
    })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, input.organizationId),
      eq(PluginAccessGrantTable.pluginId, input.pluginId),
      isNull(PluginAccessGrantTable.removedAt),
    ))
    .for("update")
  const marketplaceGrants = marketplaceIds.length > 0
    ? await input.tx
      .select({
        orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
        orgWide: MarketplaceAccessGrantTable.orgWide,
        teamId: MarketplaceAccessGrantTable.teamId,
      })
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.organizationId, input.organizationId),
        inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
        isNull(MarketplaceAccessGrantTable.removedAt),
      ))
      .for("update")
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

async function syncPluginMcpRequirementAccessForResource(input: ResourceTarget & { context: PluginArchActorContext }) {
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

function sameRequestedOAuthScopes(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
) {
  const normalizedLeft = normalizeExternalMcpRequestedOAuthScopes(left)?.slice().sort() ?? []
  const normalizedRight = normalizeExternalMcpRequestedOAuthScopes(right)?.slice().sort() ?? []
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((scope, index) => scope === normalizedRight[index])
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

function assertPluginMcpDiscoveryAllowsConfiguration(input: {
  authType: PluginMcpRequirementAuthType
  discovery: ExternalMcpConfigurationDiscovery
  oauthClient?: { clientId: string; clientSecret?: string }
  requireVerifiedOauthPkce?: boolean
}) {
  if (input.discovery.support.status === "unsupported"
    || input.discovery.inputs.some((field) => field.required && !field.supported)) {
    throw new PluginArchRouteFailure(
      409,
      "unsupported_mcp_configuration",
      "This MCP declaration requires transport or configuration values OpenWork Cloud cannot apply safely.",
    )
  }
  if (input.discovery.auth.kind !== "unknown" && input.discovery.auth.kind !== input.authType) {
    throw new PluginArchRouteFailure(
      409,
      "mcp_auth_discovery_mismatch",
      `The MCP server advertises ${input.discovery.auth.kind} authentication, not ${input.authType}. Inspect it again before configuring the connection.`,
    )
  }
  if (input.authType !== "oauth" || !input.discovery.oauth) return
  if (input.requireVerifiedOauthPkce && (
    input.discovery.oauth.pkce !== "s256"
    || (input.discovery.auth.source !== "live_protocol" && input.discovery.auth.source !== "oauth_metadata")
  )) {
    throw new PluginArchRouteFailure(
      409,
      "mcp_oauth_pkce_unverified",
      "OpenWork could not verify this MCP server's live OAuth metadata and PKCE S256 support. Retry after the provider endpoint is available.",
    )
  }
  if (input.discovery.oauth.pkce === "missing") {
    throw new PluginArchRouteFailure(
      409,
      "mcp_oauth_pkce_unsupported",
      "The MCP authorization server does not advertise required PKCE S256 support.",
    )
  }
  if (input.discovery.oauth.clientIdRequired && !input.oauthClient?.clientId) {
    throw new PluginArchRouteFailure(
      400,
      "mcp_oauth_client_required",
      "This MCP server requires a pre-registered OAuth client ID.",
    )
  }
  if (input.discovery.oauth.clientSecretRequired && !input.oauthClient?.clientSecret) {
    throw new PluginArchRouteFailure(
      400,
      "mcp_oauth_client_secret_required",
      "This MCP server requires a pre-registered OAuth client secret.",
    )
  }
}

function trustedPluginMcpRequestedOAuthScopes(input: {
  discovery: ExternalMcpConfigurationDiscovery
  server: PluginMcpRequirementServer
}) {
  const scopesSource = input.discovery.oauth?.scopesSource
  if (scopesSource === "challenge"
    || scopesSource === "protected_resource"
    || scopesSource === "plugin_manifest") {
    return normalizeExternalMcpRequestedOAuthScopes(input.discovery.oauth?.scopes) ?? []
  }
  // A manually selected OAuth flow can still carry publisher-declared scopes
  // even when live probing could not establish enough metadata to build an
  // OAuth descriptor. Never substitute the authorization server's broad
  // scopes_supported catalog for resource requirements.
  if (!input.discovery.oauth) {
    return normalizeExternalMcpRequestedOAuthScopes(inferExternalMcpManifestConfiguration({
      config: input.server.config,
      url: input.server.url,
    }).scopes) ?? []
  }
  return []
}

async function connectionCompatibleWithRequirement(input: {
  apiKey?: string | null
  authType: PluginMcpRequirementAuthType
  connection: ExternalMcpConnectionRow
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  organizationId: OrganizationId
  requestedOAuthScopes?: string[]
  url: string
}) {
  const baseCompatible = comparablePluginMcpRequirementUrl(input.connection.url) === comparablePluginMcpRequirementUrl(input.url)
    && input.connection.authType === input.authType
    && input.connection.credentialMode === input.credentialMode
  if (!baseCompatible) return false
  if (input.authType === "oauth"
    && input.connection.requestedOAuthScopes?.length
    && !sameRequestedOAuthScopes(input.connection.requestedOAuthScopes, input.requestedOAuthScopes)) return false
  if (input.authType === "apikey") {
    const apiKey = normalizedPluginMcpApiKey(input.apiKey ?? undefined)
    return Boolean(apiKey) && input.connection.apiKey === apiKey
  }
  if (!input.oauthClient || input.authType !== "oauth") return true
  const existingClient = await getOrgOAuthClient(input.organizationId, input.connection.id)
  return existingClient?.clientId === input.oauthClient.clientId
}

async function createOrReusePluginMcpRequirementConnection(input: {
  apiKey?: string | null
  authType: PluginMcpRequirementAuthType
  context: PluginArchActorContext
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  plugin: PluginRow
  requestedOAuthScopes: string[]
  server: PluginMcpRequirementServer
}): Promise<{
  connection: ExternalMcpConnectionRow
  created: boolean
  requestedOAuthScopes: string[]
  shouldAdoptRequestedOAuthScopes: boolean
}> {
  const organizationId = input.context.organizationContext.organization.id
  const requestedOAuthScopes = input.authType === "oauth" ? input.requestedOAuthScopes : []
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
      requestedOAuthScopes,
      url: input.server.url,
    })) {
      compatible = connection
      break
    }
  }

  if (compatible) {
    return {
      connection: compatible,
      created: false,
      requestedOAuthScopes,
      shouldAdoptRequestedOAuthScopes: input.authType === "oauth"
        && !compatible.requestedOAuthScopes?.length
        && requestedOAuthScopes.length > 0,
    }
  }

  const now = new Date()
  const created: ExternalMcpConnectionRow = {
    id: createDenTypeId("externalMcpConnection"),
    accessToken: null,
    apiKey: input.authType === "apikey" ? input.apiKey ?? null : null,
    authType: input.authType,
    connectedAt: null,
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    credentialMode: input.credentialMode,
    expiresAt: null,
    name: externalMcpConnectionName({ pluginName: input.plugin.name, serverName: input.server.name }),
    oauthAuthorizationEpoch: 0,
    oauthRegistrationLeaseStartedAt: null,
    oauthRegistrationLeaseToken: null,
    organizationId,
    pendingCodeVerifier: null,
    refreshToken: null,
    requestedOAuthScopes: input.authType === "oauth"
      ? normalizeExternalMcpRequestedOAuthScopes(requestedOAuthScopes)
      : null,
    scope: null,
    tokenType: null,
    updatedAt: now,
    url: input.server.url,
  }
  return {
    connection: created,
    created: true,
    requestedOAuthScopes,
    shouldAdoptRequestedOAuthScopes: false,
  }
}

function pluginMcpRequirementAccessGrantRows(input: {
  access: PluginMcpRequirementAccess
  bindingId: PluginMcpRequirementBindingId
  connectionId: ExternalMcpConnectionRow["id"]
  createdByOrgMembershipId: MemberId
  organizationId: OrganizationId
}): (typeof ExternalMcpConnectionAccessGrantTable.$inferInsert)[] {
  const common = {
    organizationId: input.organizationId,
    externalMcpConnectionId: input.connectionId,
    pluginMcpRequirementBindingId: input.bindingId,
    sourceKey: input.bindingId,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  }
  if (input.access.orgWide) {
    return [{
      ...common,
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      orgWide: true,
    }]
  }
  const rows: (typeof ExternalMcpConnectionAccessGrantTable.$inferInsert)[] = []
  for (const orgMembershipId of new Set(input.access.memberIds)) {
    rows.push({
      ...common,
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      orgMembershipId,
    })
  }
  for (const teamId of new Set(input.access.teamIds)) {
    rows.push({
      ...common,
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      teamId,
    })
  }
  return rows
}

async function commitPluginMcpRequirementConfiguration(input: {
  apiPublicBaseUrl?: string
  apiKey: string | null
  authType: PluginMcpRequirementAuthType
  configObjectId: ConfigObjectId
  connectionResult: Awaited<ReturnType<typeof createOrReusePluginMcpRequirementConnection>>
  context: PluginArchActorContext
  credentialMode: PluginMcpRequirementCredentialMode
  inspectedBinding: PluginMcpRequirementBindingRow | null
  oauthClient?: { clientId: string; clientSecret?: string }
  operationDeadlineAt?: number
  pluginId: PluginId
  serverName: string
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  return db.transaction(async (tx) => {
    const access = await derivePluginMcpRequirementAccessForCommit({
      configObjectId: input.configObjectId,
      organizationId,
      pluginId: input.pluginId,
      tx,
    })
    // Read the binding identity after acquiring the requirement mutex, then
    // lock the destination connection before the binding. Connection edits
    // use the same connection -> binding order, avoiding a deadlock between
    // marketplace setup and an administrator editing that connection.
    const observedBindingRows = await tx
      .select()
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
        eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
        eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
        eq(PluginMcpRequirementBindingTable.serverName, input.serverName),
      ))
      .limit(1)
    const observedBinding = observedBindingRows[0] ?? null
    if (input.inspectedBinding
      && (!observedBinding
        || observedBinding.id !== input.inspectedBinding.id
        || observedBinding.externalMcpConnectionId !== input.inspectedBinding.externalMcpConnectionId)) {
      throw new PluginArchRouteFailure(
        409,
        "mcp_requirement_binding_changed",
        "The plugin MCP binding changed while it was being configured. Inspect it again and retry.",
      )
    }

    let connection: ExternalMcpConnectionRow | undefined
    if (!input.inspectedBinding && observedBinding) {
      // Another configure request won the requirement mutex after this one
      // inspected an empty binding. Reconcile to its connection instead of
      // publishing a second row and orphaning the winner.
      const connectionRows = await tx
        .select()
        .from(ExternalMcpConnectionTable)
        .where(and(
          eq(ExternalMcpConnectionTable.organizationId, organizationId),
          eq(ExternalMcpConnectionTable.id, observedBinding.externalMcpConnectionId),
        ))
        .limit(1)
        .for("update")
      connection = connectionRows[0]
    } else if (input.connectionResult.created) {
      // New rows remain invisible until the entire configuration commits.
      // Validation already ran against this in-memory row, so no orphan can
      // escape if a later client, binding, access, or adoption write fails.
      await tx.insert(ExternalMcpConnectionTable).values(input.connectionResult.connection)
      connection = input.connectionResult.connection
    } else {
      const connectionRows = await tx
        .select()
        .from(ExternalMcpConnectionTable)
        .where(and(
          eq(ExternalMcpConnectionTable.organizationId, organizationId),
          eq(ExternalMcpConnectionTable.id, input.connectionResult.connection.id),
        ))
        .limit(1)
        .for("update")
      connection = connectionRows[0]
    }

    const bindingRows = await tx
      .select()
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
        eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
        eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
        eq(PluginMcpRequirementBindingTable.serverName, input.serverName),
      ))
      .limit(1)
      .for("update")
    const currentBinding = bindingRows[0] ?? null
    if ((observedBinding === null) !== (currentBinding === null)
      || (observedBinding && currentBinding && (
        observedBinding.id !== currentBinding.id
        || observedBinding.externalMcpConnectionId !== currentBinding.externalMcpConnectionId
      ))) {
      throw new PluginArchRouteFailure(
        409,
        "mcp_requirement_binding_changed",
        "The plugin MCP binding changed while it was being configured. Inspect it again and retry.",
      )
    }
    if (!connection
      || comparablePluginMcpRequirementUrl(connection.url) !== comparablePluginMcpRequirementUrl(input.connectionResult.connection.url)
      || connection.authType !== input.authType
      || connection.credentialMode !== input.credentialMode
      || (input.authType === "apikey" && connection.apiKey !== input.apiKey)) {
      throw new PluginArchRouteFailure(
        409,
        "external_mcp_connection_changed",
        "The MCP connection changed while this plugin was being configured. Inspect it again and retry.",
      )
    }
    if (input.authType === "oauth") {
      const liveScopes = connection.requestedOAuthScopes
      const inspectedScopes = input.connectionResult.connection.requestedOAuthScopes
      const liveScopesConflict = liveScopes?.length
        ? !sameRequestedOAuthScopes(liveScopes, input.connectionResult.requestedOAuthScopes)
        : Boolean(inspectedScopes?.length)
      if (liveScopesConflict) {
        throw new PluginArchRouteFailure(
          409,
          "external_mcp_connection_changed",
          "The MCP connection scopes changed while this plugin was being configured. Inspect it again and retry.",
        )
      }
    }

    if (input.operationDeadlineAt !== undefined) {
      marketplaceMcpRemainingTimeoutMs(input.operationDeadlineAt, MARKETPLACE_MCP_CONFIGURE_OPERATION_TIMEOUT_MS)
    }

    if (input.oauthClient) {
      const clientRows = await tx
        .select()
        .from(OrgOAuthClientTable)
        .where(and(
          eq(OrgOAuthClientTable.organizationId, organizationId),
          eq(OrgOAuthClientTable.providerId, connection.id),
        ))
        .limit(1)
        .for("update")
      const existingClient = clientRows[0]
      if (existingClient && existingClient.clientId !== input.oauthClient.clientId) {
        throw new PluginArchRouteFailure(
          409,
          "external_mcp_connection_oauth_client_mismatch",
          "The MCP OAuth client changed while this plugin was being configured. Inspect it again and retry.",
        )
      }
      if (existingClient) {
        await tx
          .update(OrgOAuthClientTable)
          .set({
            clientId: input.oauthClient.clientId,
            ...(input.oauthClient.clientSecret !== undefined
              ? { clientSecret: input.oauthClient.clientSecret }
              : {}),
            extra: externalMcpPreRegisteredClientExtra(),
          })
          .where(eq(OrgOAuthClientTable.id, existingClient.id))
      } else {
        await tx.insert(OrgOAuthClientTable).values({
          id: createDenTypeId("orgOAuthClient"),
          organizationId,
          providerId: connection.id,
          clientId: input.oauthClient.clientId,
          clientSecret: input.oauthClient.clientSecret ?? null,
          extra: externalMcpPreRegisteredClientExtra(),
          createdByOrgMembershipId,
        })
      }
    }

    const now = new Date()
    let binding: PluginMcpRequirementBindingRow
    if (currentBinding) {
      await tx
        .update(PluginMcpRequirementBindingTable)
        .set({ externalMcpConnectionId: connection.id, updatedAt: now })
        .where(eq(PluginMcpRequirementBindingTable.id, currentBinding.id))
      binding = {
        ...currentBinding,
        externalMcpConnectionId: connection.id,
        updatedAt: now,
      }
    } else {
      binding = {
        id: createDenTypeId("pluginMcpRequirementBinding"),
        organizationId,
        pluginId: input.pluginId,
        configObjectId: input.configObjectId,
        serverName: input.serverName,
        externalMcpConnectionId: connection.id,
        createdByOrgMembershipId,
        createdAt: now,
        updatedAt: now,
      }
      await tx.insert(PluginMcpRequirementBindingTable).values(binding)
    }

    await tx
      .delete(ExternalMcpConnectionAccessGrantTable)
      .where(eq(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, binding.id))
    const accessRows = pluginMcpRequirementAccessGrantRows({
      access,
      bindingId: binding.id,
      connectionId: connection.id,
      createdByOrgMembershipId,
      organizationId,
    })
    if (accessRows.length > 0) {
      await tx.insert(ExternalMcpConnectionAccessGrantTable).values(accessRows)
    }

    let committedConnection = connection
    if (input.authType === "none") {
      await tx
        .update(ExternalMcpConnectionTable)
        .set({ connectedAt: now })
        .where(eq(ExternalMcpConnectionTable.id, connection.id))
      committedConnection = { ...committedConnection, connectedAt: now }
    }

    // Scope adoption is deliberately the final database mutation group. It
    // revokes legacy tokens/accounts, so it must share this transaction with
    // the client, binding, and sourced-grant writes and leave no later
    // fallible persistence step that could commit a half-configured request.
    if (input.connectionResult.shouldAdoptRequestedOAuthScopes
      && !connection.requestedOAuthScopes?.length) {
      const requestedOAuthScopes = normalizeExternalMcpRequestedOAuthScopes(input.connectionResult.requestedOAuthScopes)
      if (!requestedOAuthScopes?.length) {
        throw new PluginArchRouteFailure(409, "external_mcp_connection_changed", "The MCP connection scopes could not be adopted. Inspect it again and retry.")
      }
      await tx
        .update(ExternalMcpConnectionTable)
        .set({
          accessToken: null,
          connectedAt: null,
          expiresAt: null,
          oauthAuthorizationEpoch: connection.oauthAuthorizationEpoch + 1,
          oauthRegistrationLeaseStartedAt: null,
          oauthRegistrationLeaseToken: null,
          pendingCodeVerifier: null,
          refreshToken: null,
          requestedOAuthScopes,
          scope: null,
          tokenType: null,
        })
        .where(eq(ExternalMcpConnectionTable.id, connection.id))
      await tx.delete(ConnectedAccountTable).where(and(
        eq(ConnectedAccountTable.organizationId, organizationId),
        eq(ConnectedAccountTable.providerId, connection.id),
      ))
      await tx.delete(ExternalMcpOAuthTransactionTable).where(and(
        eq(ExternalMcpOAuthTransactionTable.organizationId, organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
      ))
      committedConnection = {
        ...committedConnection,
        accessToken: null,
        connectedAt: null,
        expiresAt: null,
        oauthAuthorizationEpoch: connection.oauthAuthorizationEpoch + 1,
        oauthRegistrationLeaseStartedAt: null,
        oauthRegistrationLeaseToken: null,
        pendingCodeVerifier: null,
        refreshToken: null,
        requestedOAuthScopes,
        scope: null,
        tokenType: null,
      }
    }

    return {
      binding: serializePluginMcpRequirementBinding(binding),
      connection: serializePluginMcpRequirementConnection(committedConnection),
      links: {
        ...(input.authType === "oauth" && input.oauthClient
          ? { oauthCallback: pluginMcpValidationRedirectUri(connection.id, input.apiPublicBaseUrl) }
          : {}),
        yourConnections: openworkYourConnectionsUrl(connection.id),
      },
    }
  })
}

function pluginMcpValidationRedirectUri(connectionId: string, apiPublicBaseUrl?: string) {
  const baseUrl = apiPublicBaseUrl ?? env.apiPublicUrl ?? env.betterAuthUrl
  return appendPublicApiPath(baseUrl, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`)
}

async function validateConfiguredPluginMcpConnection(input: {
  authType: PluginMcpRequirementAuthType
  apiPublicBaseUrl?: string
  connection: ExternalMcpConnectionRow
  lifecycleDeadline?: ReturnType<typeof createExternalMcpLifecycleDeadline>
  markConnected?: boolean
}) {
  if (input.authType === "oauth") return
  try {
    await connectExternalMcp(
      input.connection,
      pluginMcpValidationRedirectUri(input.connection.id, input.apiPublicBaseUrl),
      undefined,
      undefined,
      input.connection.id,
      undefined,
      input.lifecycleDeadline,
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

  if (input.authType === "none" && input.markConnected !== false) {
    await markImportedExternalMcpConnectionConnected(input.connection.id)
  }
}

function sortedUnique<TValue extends string>(values: TValue[]): TValue[] {
  return [...new Set(values)].sort()
}

async function requireExistingExternalMcpConnectionMatchesImport(input: {
  apiKey?: string | null
  authType: PluginMcpRequirementAuthType
  credentialMode: PluginMcpRequirementCredentialMode
  existingApiKey?: string | null
  existingAuthType: "apikey" | "none" | "oauth"
  existingCredentialMode: "per_member" | "shared"
  existingRequestedOAuthScopes?: string[] | null
  requestedOAuthScopes?: string[]
}) {
  const expectedCredentialMode = expectedMcpRequirementCredentialMode(input)
  if (input.existingAuthType !== input.authType || input.existingCredentialMode !== expectedCredentialMode) {
    throw new PluginArchRouteFailure(
      409,
      "external_mcp_connection_config_mismatch",
      "An External MCP Connection already exists for this URL with different authentication or credential mode. Edit the existing connection or import with matching settings.",
    )
  }
  if (input.authType === "apikey" && input.existingApiKey !== input.apiKey) {
    throw new PluginArchRouteFailure(
      409,
      "external_mcp_connection_config_mismatch",
      "An External MCP Connection already exists for this URL with a different API key. Edit the existing connection or import with matching settings.",
    )
  }
  if (input.authType === "oauth"
    && input.existingRequestedOAuthScopes?.length
    && !sameRequestedOAuthScopes(input.existingRequestedOAuthScopes, input.requestedOAuthScopes)) {
    throw new PluginArchRouteFailure(
      409,
      "external_mcp_connection_scope_mismatch",
      "An External MCP Connection already exists for this URL with different requested OAuth scopes. Review the existing connection before importing this server.",
    )
  }
}

async function ensureImportedExternalMcpConnection(input: {
  access: GithubPluginMcpImportAccess
  apiKey?: string | null
  authType: PluginMcpRequirementAuthType
  context: PluginArchActorContext
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  requestedOAuthScopes?: string[]
  server: GithubPluginMcpImportServer
}): Promise<{
  connection: Awaited<ReturnType<typeof createExternalMcpConnection>>
  ownedByImportedPlugin: boolean
}> {
  if (!input.server.url) {
    throw new PluginArchRouteFailure(400, "invalid_mcp_import", "MCP server URL is required.")
  }
  const serverUrl = input.server.url

  await assertRemotePluginMcpUrl(serverUrl)
  const organizationId = input.context.organizationContext.organization.id
  const requestedOAuthScopes = input.authType === "oauth"
    ? normalizeExternalMcpRequestedOAuthScopes(input.requestedOAuthScopes) ?? []
    : []
  const existing = (await listExternalMcpConnections(organizationId))
    .find((connection) => comparablePluginMcpRequirementUrl(connection.url) === comparablePluginMcpRequirementUrl(serverUrl))

  if (existing) {
    await requireExistingExternalMcpConnectionMatchesImport({
      apiKey: input.apiKey,
      authType: input.authType,
      credentialMode: input.credentialMode,
      existingApiKey: existing.apiKey,
      existingAuthType: existing.authType,
      existingCredentialMode: existing.credentialMode,
      existingRequestedOAuthScopes: existing.requestedOAuthScopes,
      requestedOAuthScopes,
    })
    if (input.oauthClient && input.authType === "oauth") {
      const existingClient = await getOrgOAuthClient(organizationId, existing.id)
      if (!existingClient
        || existingClient.clientId !== input.oauthClient.clientId
        || (input.oauthClient.clientSecret !== undefined
          && existingClient.clientSecret !== input.oauthClient.clientSecret)) {
        throw new PluginArchRouteFailure(
          409,
          "external_mcp_connection_oauth_client_mismatch",
          "An External MCP Connection already exists for this URL without this exact OAuth client. Edit and reconnect the existing connection before importing the plugin.",
        )
      }
    }
    if (input.authType === "oauth"
      && !existing.requestedOAuthScopes?.length
      && requestedOAuthScopes.length > 0) {
      throw new PluginArchRouteFailure(
        409,
        "external_mcp_connection_scope_review_required",
        "An existing MCP connection for this URL predates requested-scope tracking. Review or recreate that connection before importing a plugin that advertises OAuth scopes.",
      )
    }
    return { connection: existing, ownedByImportedPlugin: false }
  }

  const created = await createExternalMcpConnection({
    access: { memberIds: [], orgWide: false, teamIds: [] },
    apiKey: input.authType === "apikey" ? input.apiKey : null,
    authType: input.authType,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    credentialMode: expectedMcpRequirementCredentialMode(input),
    name: externalMcpConnectionName({ pluginName: input.server.pluginName, serverName: input.server.name }),
    organizationId,
    requestedOAuthScopes,
    url: serverUrl,
  })
  return { connection: created, ownedByImportedPlugin: true }
}

async function markImportedExternalMcpConnectionConnected(connectionId: typeof ExternalMcpConnectionTable.$inferSelect.id) {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ connectedAt: new Date() })
    .where(eq(ExternalMcpConnectionTable.id, connectionId))
}

function importedConnectionBackedMcpPayload(input: {
  connectionId: string
  ownedByImportedPlugin: boolean
  repositoryFullName: string
  server: GithubPluginMcpImportServer
  sourceRevisionRef: string
}) {
  const serverName = slugifyPluginMcpName(input.server.name)
  return {
    mcpServers: {
      [serverName]: {
        type: "remote",
        url: input.server.url,
        openworkManaged: "den_external_mcp",
        externalMcpConnectionId: input.connectionId,
        externalMcpConnectionOwnedByPlugin: input.ownedByImportedPlugin,
      },
    },
    openworkManaged: "den_external_mcp",
    externalMcpConnectionId: input.connectionId,
    externalMcpConnectionOwnedByPlugin: input.ownedByImportedPlugin,
    source: {
      provider: "github",
      repositoryFullName: input.repositoryFullName,
      revision: input.sourceRevisionRef,
      path: input.server.sourcePath,
    },
    sourceRevisionRef: input.sourceRevisionRef,
  }
}

function importedDenSkillPayload(input: {
  repositoryFullName: string
  skillId: SkillId
  sourcePath: string
  sourceRevisionRef: string
}) {
  return {
    denSkillId: input.skillId,
    openworkManaged: "den_skill",
    source: {
      provider: "github",
      repositoryFullName: input.repositoryFullName,
      revision: input.sourceRevisionRef,
      path: input.sourcePath,
    },
    sourceRevisionRef: input.sourceRevisionRef,
  }
}

async function createSkillHubForImportedSkills(input: {
  access: GithubPluginMcpImportAccess
  context: PluginArchActorContext
  name: string
}) {
  if (input.access.orgWide) return null
  const now = new Date()
  const skillHubId = createDenTypeId("skillHub")
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id
  const accessRows: (typeof SkillHubMemberTable.$inferInsert)[] = []
  for (const memberId of new Set(input.access.memberIds)) {
    accessRows.push({
      id: createDenTypeId("skillHubMember"),
      skillHubId,
      orgMembershipId: memberId,
      teamId: null,
      createdAt: now,
    })
  }
  for (const teamId of new Set(input.access.teamIds)) {
    accessRows.push({
      id: createDenTypeId("skillHubMember"),
      skillHubId,
      orgMembershipId: null,
      teamId,
      createdAt: now,
    })
  }

  const row: typeof SkillHubTable.$inferSelect = {
    id: skillHubId,
    organizationId,
    createdByOrgMembershipId,
    name: input.name,
    description: "Skills imported from a GitHub plugin.",
    createdAt: now,
    updatedAt: now,
  }

  await db.insert(SkillHubTable).values(row)
  return { memberRows: accessRows, row }
}

async function createImportedSkill(input: {
  context: PluginArchActorContext
  repositoryFullName: string
  skill: GithubPluginSkillImportSkill
  skillHubId: typeof SkillHubTable.$inferSelect.id | null
  sourceRevisionRef: string
}) {
  const skillText = input.skill.rawSourceText
  if (!skillText) {
    throw new PluginArchRouteFailure(400, "invalid_skill_import", "Selected skill content was unavailable.")
  }
  const metadata = skillMetadataFromText(skillText)
  const sourceAudit = `GitHub source: ${input.repositoryFullName}@${input.sourceRevisionRef}:${input.skill.sourcePath}`
  const auditedDescription = [sourceAudit, metadata.description].filter(Boolean).join("\n\n").slice(0, 65_535)
  const now = new Date()
  const skillId = createDenTypeId("skill")
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id
  const row: typeof SkillTable.$inferSelect = {
    id: skillId,
    organizationId,
    createdByOrgMembershipId,
    title: metadata.title,
    description: auditedDescription,
    skillText,
    // Skill visibility is published atomically with the plugin. Until then,
    // only the importing administrator can reach this staged row.
    shared: null,
    createdAt: now,
    updatedAt: now,
  }
  let skillHubSkillId: typeof SkillHubSkillTable.$inferSelect.id | null = null
  await db.transaction(async (tx) => {
    await tx.insert(SkillTable).values(row)
    if (input.skillHubId) {
      skillHubSkillId = createDenTypeId("skillHubSkill")
      await tx.insert(SkillHubSkillTable).values({
        id: skillHubSkillId,
        skillHubId: input.skillHubId,
        skillId,
        addedByOrgMembershipId: createdByOrgMembershipId,
        createdAt: now,
      })
    }
  })
  return { row, skillHubSkillId }
}

function importedPluginName(plan: GithubPluginMcpImportPlan) {
  const candidate = plan.plugins.length === 1
    ? plan.plugins[0].name
    : plan.marketplace?.name
      || plan.rootPath.split("/").filter(Boolean).at(-1)
      || plan.repositoryFullName.split("/").at(-1)
  return boundedPublisherName(candidate, "GitHub MCP Plugin")
}

export async function previewGithubPluginMcpImport(input: { githubUrl: string }) {
  return computeGithubPluginMcpImportPlan({ githubUrl: input.githubUrl })
}

export async function discoverMarketplacePluginMcpRequirement(input: {
  configObjectId: ConfigObjectId
  context: PluginArchActorContext
  pluginId: PluginId
  serverName: string
}) {
  const organizationId = input.context.organizationContext.organization.id
  const requirement = await activePluginMcpRequirement({
    configObjectId: input.configObjectId,
    organizationId,
    pluginId: input.pluginId,
  })
  const versions = await getLatestVersions([requirement.configObject.id])
  const version = versions.get(requirement.configObject.id)
  if (!version) {
    throw new PluginArchRouteFailure(409, "mcp_requirement_not_synced", "MCP config object has no active version to inspect.")
  }

  const server = mcpRequirementServerFromVersion({
    configObject: requirement.configObject,
    serverName: input.serverName,
    version,
  })
  await assertRemotePluginMcpUrl(server.url)
  const [discovery, access] = await Promise.all([
    discoverExternalMcpConfiguration({ config: server.config, url: server.url }),
    derivePluginMcpRequirementAccess({
      configObjectId: requirement.configObject.id,
      organizationId,
      pluginId: requirement.plugin.id,
    }),
  ])

  return {
    assignment: {
      access,
      policy: "union_of_active_config_object_plugin_and_marketplace_grants" as const,
    },
    configObjectId: requirement.configObject.id,
    discovery,
    pluginId: requirement.plugin.id,
    serverName: server.name,
    url: server.url,
  }
}

export async function configureMarketplacePluginMcpRequirement(input: {
  apiPublicBaseUrl?: string
  apiKey?: string
  authType: PluginMcpRequirementAuthType
  configObjectId: ConfigObjectId
  context: PluginArchActorContext
  credentialMode: PluginMcpRequirementCredentialMode
  oauthClient?: { clientId: string; clientSecret?: string }
  pluginId: PluginId
  serverName: string
}) {
  const operationDeadlineAt = Date.now() + MARKETPLACE_MCP_CONFIGURE_OPERATION_TIMEOUT_MS
  const lifecycleDeadline = createExternalMcpLifecycleDeadline(MARKETPLACE_MCP_CONFIGURE_OPERATION_TIMEOUT_MS)
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
  await assertRemotePluginMcpUrl(server.url)
  const discovery = await discoverExternalMcpConfiguration({
    config: server.config,
    timeoutMs: marketplaceMcpRemainingTimeoutMs(operationDeadlineAt, GITHUB_MCP_DISCOVERY_TIMEOUT_MS),
    url: server.url,
  })
  assertPluginMcpDiscoveryAllowsConfiguration({
    authType: input.authType,
    discovery,
    oauthClient: input.oauthClient,
  })
  const credentialMode = expectedMcpRequirementCredentialMode(input)
  const apiKey = normalizedPluginMcpApiKey(input.apiKey)
  const inspectedBinding = (await db
    .select()
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
      eq(PluginMcpRequirementBindingTable.pluginId, requirement.plugin.id),
      eq(PluginMcpRequirementBindingTable.configObjectId, requirement.configObject.id),
      eq(PluginMcpRequirementBindingTable.serverName, server.name),
    ))
    .limit(1))[0] ?? null
  const connectionResult = await createOrReusePluginMcpRequirementConnection({
    apiKey,
    authType: input.authType,
    context: input.context,
    credentialMode,
    oauthClient: input.oauthClient,
    plugin: requirement.plugin,
    requestedOAuthScopes: input.authType === "oauth"
      ? trustedPluginMcpRequestedOAuthScopes({ discovery, server })
      : [],
    server,
  })
  const connection = connectionResult.connection

  try {
    await validateConfiguredPluginMcpConnection({
      apiPublicBaseUrl: input.apiPublicBaseUrl,
      authType: input.authType,
      connection,
      lifecycleDeadline,
      markConnected: false,
    })
    marketplaceMcpRemainingTimeoutMs(operationDeadlineAt, MARKETPLACE_MCP_CONFIGURE_OPERATION_TIMEOUT_MS)
    return await commitPluginMcpRequirementConfiguration({
      apiPublicBaseUrl: input.apiPublicBaseUrl,
      apiKey,
      authType: input.authType,
      configObjectId: requirement.configObject.id,
      connectionResult,
      context: input.context,
      credentialMode,
      inspectedBinding,
      oauthClient: input.oauthClient,
      operationDeadlineAt,
      pluginId: requirement.plugin.id,
      serverName: server.name,
    })
  } catch (error) {
    if (connectionResult.created) {
      try {
        await deleteExternalMcpConnectionIfUnused({ connectionId: connection.id, organizationId })
      } catch (cleanupError) {
        logger.error("plugin MCP configuration rollback failed", {
          cleanupError,
          connectionId: connection.id,
          organizationId,
        })
      }
    }
    throw error
  }
}

async function validateGithubImportAccess(input: {
  access: GithubPluginMcpImportAccess
  context: PluginArchActorContext
}): Promise<GithubPluginMcpImportAccess> {
  const organizationId = input.context.organizationContext.organization.id
  const access = input.access.orgWide
    ? { memberIds: [], orgWide: true, teamIds: [] }
    : {
        memberIds: sortedUnique(input.access.memberIds),
        orgWide: false,
        teamIds: sortedUnique(input.access.teamIds),
      }
  if (access.memberIds.length + access.teamIds.length > MAX_GITHUB_MCP_IMPORT_ACCESS_TARGETS) {
    throw new PluginArchRouteFailure(
      400,
      "github_import_access_limit_exceeded",
      `Choose at most ${MAX_GITHUB_MCP_IMPORT_ACCESS_TARGETS} people and teams for one GitHub import.`,
    )
  }

  const [members, teams] = await Promise.all([
    access.memberIds.length === 0
      ? []
      : db
        .select({ id: MemberTable.id })
        .from(MemberTable)
        .where(and(
          eq(MemberTable.organizationId, organizationId),
          inArray(MemberTable.id, access.memberIds),
        )),
    access.teamIds.length === 0
      ? []
      : db
        .select({ id: TeamTable.id })
        .from(TeamTable)
        .where(and(
          eq(TeamTable.organizationId, organizationId),
          inArray(TeamTable.id, access.teamIds),
        )),
  ])
  if (members.length !== access.memberIds.length) {
    throw new PluginArchRouteFailure(404, "member_not_found", "One or more selected members no longer belong to this organization.")
  }
  if (teams.length !== access.teamIds.length) {
    throw new PluginArchRouteFailure(404, "team_not_found", "One or more selected teams no longer belong to this organization.")
  }
  return access
}

function githubPluginMcpServerConfiguration(input: {
  discoveredAuthType: GithubPluginMcpImportServer["authType"]
  fallbackAuthType: "none" | "oauth"
  fallbackCredentialMode: PluginMcpRequirementCredentialMode
  configured?: GithubPluginMcpImportServerConfiguration
}) {
  const discoveredAuthType = input.discoveredAuthType === "unknown" ? null : input.discoveredAuthType
  if (input.configured && discoveredAuthType && input.configured.authType !== discoveredAuthType) {
    throw new PluginArchRouteFailure(
      409,
      "mcp_auth_discovery_mismatch",
      `The MCP manifest advertises ${discoveredAuthType} authentication, not ${input.configured.authType}. Preview and configure that server again.`,
    )
  }
  const authType = input.configured?.authType ?? discoveredAuthType ?? input.fallbackAuthType
  const credentialMode = input.configured?.credentialMode
    ?? (input.configured && authType !== "oauth" ? "shared" : input.fallbackCredentialMode)
  const value = {
    apiKey: input.configured?.apiKey,
    authType,
    credentialMode,
    oauthClient: input.configured?.oauthClient,
  }
  validatePluginMcpRequirementAuth(value)
  return {
    ...value,
    apiKey: normalizedPluginMcpApiKey(value.apiKey),
    credentialMode: expectedMcpRequirementCredentialMode({ authType, credentialMode }),
  }
}

type GithubImportOAuthClientMutation = {
  appliedRevision: ExternalMcpOAuthClientRevision
  appliedValue: ExternalMcpOAuthClientValue
}

type GithubImportRollbackState = {
  access: GithubPluginMcpImportAccess
  bindingIds: Set<PluginMcpRequirementBindingId>
  bindings: Map<PluginMcpRequirementBindingId, PluginMcpRequirementBindingRow>
  configObjectIds: Set<ConfigObjectId>
  configObjects: Map<ConfigObjectId, ConfigObjectRow>
  newlyCreatedConnectionIds: Set<ExternalMcpConnectionRow["id"]>
  newlyCreatedConnections: Map<ExternalMcpConnectionRow["id"], ExternalMcpConnectionRow>
  oauthClientMutations: Map<ExternalMcpConnectionRow["id"], GithubImportOAuthClientMutation>
  pluginId: PluginId | null
  pluginManagerGrantId: PluginAccessGrantId | null
  pluginSnapshot: PluginRow | null
  skillHubId: typeof SkillHubTable.$inferSelect.id | null
  skillHubMembers: (typeof SkillHubMemberTable.$inferInsert)[]
  skillHubSnapshot: typeof SkillHubTable.$inferSelect | null
  skillHubSkillIds: Set<typeof SkillHubSkillTable.$inferSelect.id>
  skillIds: Set<SkillId>
  skills: Map<SkillId, typeof SkillTable.$inferSelect>
  validatedConnections: Map<ExternalMcpConnectionRow["id"], ExternalMcpConnectionRow>
}

function createGithubImportRollbackState(access: GithubPluginMcpImportAccess): GithubImportRollbackState {
  return {
    access,
    bindingIds: new Set(),
    bindings: new Map(),
    configObjectIds: new Set(),
    configObjects: new Map(),
    newlyCreatedConnectionIds: new Set(),
    newlyCreatedConnections: new Map(),
    oauthClientMutations: new Map(),
    pluginId: null,
    pluginManagerGrantId: null,
    pluginSnapshot: null,
    skillHubId: null,
    skillHubMembers: [],
    skillHubSnapshot: null,
    skillHubSkillIds: new Set(),
    skillIds: new Set(),
    skills: new Map(),
    validatedConnections: new Map(),
  }
}

async function createStagedGithubImportPlugin(input: {
  context: PluginArchActorContext
  description: string
  name: string
}) {
  const now = new Date()
  const managerGrantId = createDenTypeId("pluginAccessGrant")
  const row: PluginRow = {
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    deletedAt: null,
    description: input.description,
    id: createDenTypeId("plugin"),
    name: input.name,
    organizationId: input.context.organizationContext.organization.id,
    // Staged imports are intentionally absent from active marketplace
    // resolution until the final publication transaction commits.
    status: "inactive",
    updatedAt: now,
  }
  await db.transaction(async (tx) => {
    await tx.insert(PluginTable).values(row)
    await tx.insert(PluginAccessGrantTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: managerGrantId,
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      pluginId: row.id,
      role: "manager",
      teamId: null,
    })
  })
  return { managerGrantId, row }
}

function rememberGithubImportConnection(
  state: GithubImportRollbackState,
  importedConnection: Awaited<ReturnType<typeof ensureImportedExternalMcpConnection>>,
) {
  const connection = importedConnection.connection
  state.validatedConnections.set(connection.id, connection)
  if (importedConnection.ownedByImportedPlugin) {
    state.newlyCreatedConnectionIds.add(connection.id)
    state.newlyCreatedConnections.set(connection.id, connection)
  }
}

async function persistGithubImportOAuthClient(input: {
  client: { clientId: string; clientSecret?: string }
  connection: ExternalMcpConnectionRow
  context: PluginArchActorContext
  ownedByImportedPlugin: boolean
  state: GithubImportRollbackState
}) {
  const organizationId = input.context.organizationContext.organization.id
  const existingMutation = input.state.oauthClientMutations.get(input.connection.id)
  if (existingMutation) {
    if (existingMutation.appliedValue.clientId !== input.client.clientId
      || (input.client.clientSecret !== undefined
        && existingMutation.appliedValue.clientSecret !== input.client.clientSecret)) {
      throw new PluginArchRouteFailure(
        409,
        "external_mcp_connection_oauth_client_mismatch",
        "Two selected MCP declarations require different OAuth clients for the same connection. Configure one client on the connection and retry.",
      )
    }
    return
  }

  const observedClient = await getOrgOAuthClient(organizationId, input.connection.id)
  if (!input.ownedByImportedPlugin) {
    // Importing a plugin must never rotate a reusable connection as a side
    // effect. Rotation belongs to the connection editor, where reconnect and
    // authorization-epoch semantics can be reviewed explicitly.
    if (!observedClient
      || observedClient.clientId !== input.client.clientId
      || (input.client.clientSecret !== undefined && observedClient.clientSecret !== input.client.clientSecret)) {
      throw new PluginArchRouteFailure(
        409,
        "external_mcp_connection_oauth_client_mismatch",
        "The existing MCP connection does not already use this exact OAuth client. Edit and reconnect that connection before importing the plugin.",
      )
    }
    return
  }

  // A client appearing on a saga-created connection means a concurrent DCR,
  // OAuth start, or administrator adopted it. Never overwrite that actor.
  if (observedClient) {
    throw new PluginArchRouteFailure(
      409,
      "external_mcp_connection_changed",
      "The MCP connection acquired an OAuth client while the GitHub plugin was being imported. Inspect it again and retry.",
    )
  }
  const next: ExternalMcpOAuthClientValue = {
    clientId: input.client.clientId,
    clientSecret: input.client.clientSecret ?? null,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    extra: externalMcpPreRegisteredClientExtra(),
  }
  const result = await compareAndSetExternalMcpOAuthClient({
    organizationId,
    connectionId: input.connection.id,
    expectedAuthorizationEpoch: input.connection.oauthAuthorizationEpoch,
    expectedConnection: input.connection,
    expected: null,
    next,
    requireNoDependentState: true,
  })
  if (result.status !== "applied" || !result.revision) {
    throw new PluginArchRouteFailure(
      409,
      "external_mcp_connection_changed",
      "The MCP connection or OAuth client changed while the GitHub plugin was being imported. Inspect it again and retry.",
    )
  }
  input.state.oauthClientMutations.set(input.connection.id, {
    appliedRevision: result.revision,
    appliedValue: next,
  })
}

function githubImportDatesMatch(left: Date | null, right: Date | null) {
  return left === null || right === null
    ? left === right
    : left.getTime() === right.getTime()
}

function githubImportConnectionSnapshotMatches(
  current: ExternalMcpConnectionRow,
  expected: ExternalMcpConnectionRow,
) {
  return current.id === expected.id
    && current.organizationId === expected.organizationId
    && current.name === expected.name
    && current.url === expected.url
    && current.authType === expected.authType
    && current.credentialMode === expected.credentialMode
    && current.apiKey === expected.apiKey
    && current.createdByOrgMembershipId === expected.createdByOrgMembershipId
    && current.oauthAuthorizationEpoch === expected.oauthAuthorizationEpoch
    && JSON.stringify(current.requestedOAuthScopes) === JSON.stringify(expected.requestedOAuthScopes)
    && githubImportDatesMatch(current.createdAt, expected.createdAt)
    && githubImportDatesMatch(current.updatedAt, expected.updatedAt)
}

async function githubImportPluginStateStillOwned(input: {
  organizationId: OrganizationId
  state: GithubImportRollbackState
  tx: DbTransaction
}) {
  const pluginSnapshot = input.state.pluginSnapshot
  if (!pluginSnapshot || !input.state.pluginId || !input.state.pluginManagerGrantId) {
    return input.state.pluginId === null
      && input.state.configObjectIds.size === 0
      && input.state.bindingIds.size === 0
      && input.state.skillIds.size === 0
      && input.state.skillHubId === null
  }
  const actorId = pluginSnapshot.createdByOrgMembershipId
  const pluginRows = await input.tx
    .select()
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.id, pluginSnapshot.id),
    ))
    .limit(1)
    .for("update")
  const plugin = pluginRows[0]
  if (!plugin
    || plugin.status !== "inactive"
    || plugin.deletedAt !== null
    || plugin.name !== pluginSnapshot.name
    || plugin.description !== pluginSnapshot.description
    || plugin.createdByOrgMembershipId !== actorId
    || !githubImportDatesMatch(plugin.createdAt, pluginSnapshot.createdAt)
    || !githubImportDatesMatch(plugin.updatedAt, pluginSnapshot.updatedAt)) return false

  const pluginGrants = await input.tx
    .select()
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, input.organizationId),
      eq(PluginAccessGrantTable.pluginId, plugin.id),
    ))
    .for("update")
  if (pluginGrants.length !== 1) return false
  const managerGrant = pluginGrants[0]
  if (managerGrant.id !== input.state.pluginManagerGrantId
    || managerGrant.createdByOrgMembershipId !== actorId
    || managerGrant.orgMembershipId !== actorId
    || managerGrant.teamId !== null
    || managerGrant.orgWide
    || managerGrant.role !== "manager"
    || managerGrant.removedAt !== null) return false

  const marketplaceMemberships = await input.tx
    .select({ id: MarketplacePluginTable.id })
    .from(MarketplacePluginTable)
    .where(and(
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      eq(MarketplacePluginTable.pluginId, plugin.id),
    ))
    .for("update")
  if (marketplaceMemberships.length > 0) return false

  const configObjectIds = [...input.state.configObjectIds]
  if (configObjectIds.length !== input.state.configObjects.size) return false
  if (configObjectIds.length > 0) {
    const configObjects = await input.tx.select().from(ConfigObjectTable).where(and(
      eq(ConfigObjectTable.organizationId, input.organizationId),
      inArray(ConfigObjectTable.id, configObjectIds),
    )).for("update")
    const versions = await input.tx.select().from(ConfigObjectVersionTable).where(and(
      eq(ConfigObjectVersionTable.organizationId, input.organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, configObjectIds),
    )).for("update")
    const membershipsByConfig = await input.tx.select().from(PluginConfigObjectTable).where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      inArray(PluginConfigObjectTable.configObjectId, configObjectIds),
    )).for("update")
    const membershipsByPlugin = await input.tx.select().from(PluginConfigObjectTable).where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.pluginId, plugin.id),
    )).for("update")
    const configGrants = await input.tx.select().from(ConfigObjectAccessGrantTable).where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, input.organizationId),
      inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
    )).for("update")
    if (configObjects.length !== configObjectIds.length
      || versions.length !== configObjectIds.length
      || membershipsByConfig.length !== configObjectIds.length
      || membershipsByPlugin.length !== configObjectIds.length
      || configGrants.length !== configObjectIds.length) return false
    for (const row of configObjects) {
      const snapshot = input.state.configObjects.get(row.id)
      if (!snapshot
        || row.createdByOrgMembershipId !== actorId
        || row.sourceMode !== "import"
        || row.status !== "active"
        || row.deletedAt !== null
        || !githubImportDatesMatch(row.createdAt, snapshot.createdAt)
        || !githubImportDatesMatch(row.updatedAt, snapshot.updatedAt)) return false
    }
    if (versions.some((row) => row.createdByOrgMembershipId !== actorId)) return false
    if ([...membershipsByConfig, ...membershipsByPlugin].some((row) =>
      row.pluginId !== plugin.id
      || !input.state.configObjectIds.has(row.configObjectId)
      || row.createdByOrgMembershipId !== actorId
      || row.membershipSource !== "manual"
      || row.removedAt !== null)) return false
    if (configGrants.some((row) =>
      row.createdByOrgMembershipId !== actorId
      || row.orgMembershipId !== actorId
      || row.teamId !== null
      || row.orgWide
      || row.role !== "manager"
      || row.removedAt !== null)) return false
  }

  const bindings = await input.tx
    .select()
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.pluginId, plugin.id),
    ))
    .for("update")
  if (bindings.length !== input.state.bindings.size) return false
  for (const row of bindings) {
    const expected = input.state.bindings.get(row.id)
    if (!expected
      || row.configObjectId !== expected.configObjectId
      || row.externalMcpConnectionId !== expected.externalMcpConnectionId
      || row.serverName !== expected.serverName
      || row.createdByOrgMembershipId !== expected.createdByOrgMembershipId
      || !githubImportDatesMatch(row.createdAt, expected.createdAt)
      || !githubImportDatesMatch(row.updatedAt, expected.updatedAt)) return false
  }

  const skillIds = [...input.state.skillIds]
  if (skillIds.length !== input.state.skills.size) return false
  const skills = skillIds.length === 0
    ? []
    : await input.tx.select().from(SkillTable).where(and(
      eq(SkillTable.organizationId, input.organizationId),
      inArray(SkillTable.id, skillIds),
    )).for("update")
  if (skills.length !== skillIds.length) return false
  for (const row of skills) {
    const expected = input.state.skills.get(row.id)
    if (!expected
      || row.createdByOrgMembershipId !== actorId
      || row.title !== expected.title
      || row.description !== expected.description
      || row.skillText !== expected.skillText
      || row.shared !== expected.shared
      || !githubImportDatesMatch(row.createdAt, expected.createdAt)
      || !githubImportDatesMatch(row.updatedAt, expected.updatedAt)) return false
  }

  const skillLinks = skillIds.length === 0
    ? []
    : await input.tx.select().from(SkillHubSkillTable).where(inArray(SkillHubSkillTable.skillId, skillIds)).for("update")
  if (skillLinks.length !== input.state.skillHubSkillIds.size
    || skillLinks.some((row) => !input.state.skillHubSkillIds.has(row.id)
      || row.skillHubId !== input.state.skillHubId
      || !input.state.skillIds.has(row.skillId))) return false

  if (input.state.skillHubId) {
    const hubRows = await input.tx.select().from(SkillHubTable).where(and(
      eq(SkillHubTable.organizationId, input.organizationId),
      eq(SkillHubTable.id, input.state.skillHubId),
    )).limit(1).for("update")
    const hub = hubRows[0]
    const expected = input.state.skillHubSnapshot
    if (!hub || !expected
      || hub.createdByOrgMembershipId !== actorId
      || hub.name !== expected.name
      || hub.description !== expected.description
      || !githubImportDatesMatch(hub.createdAt, expected.createdAt)
      || !githubImportDatesMatch(hub.updatedAt, expected.updatedAt)) return false
    const hubMembers = await input.tx.select().from(SkillHubMemberTable)
      .where(eq(SkillHubMemberTable.skillHubId, hub.id)).for("update")
    // Audience rows are intentionally deferred to the final publication
    // transaction; any row here was added by another actor.
    if (hubMembers.length > 0) return false
  } else if (input.state.skillHubSnapshot || input.state.skillHubMembers.length > 0) {
    return false
  }

  return true
}

async function rollbackGithubPluginMcpImport(input: {
  context: PluginArchActorContext
  state: GithubImportRollbackState
}) {
  const organizationId = input.context.organizationContext.organization.id
  const bindingIds = [...input.state.bindingIds]
  const configObjectIds = [...input.state.configObjectIds]
  const skillIds = [...input.state.skillIds]

  let removedOwnedPluginState = false
  try {
    removedOwnedPluginState = await db.transaction(async (tx) => {
      if (!await githubImportPluginStateStillOwned({ organizationId, state: input.state, tx })) {
        return false
      }
      if (bindingIds.length > 0) {
        await tx.delete(ExternalMcpConnectionAccessGrantTable).where(inArray(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, bindingIds))
        await tx.delete(PluginMcpRequirementBindingTable).where(inArray(PluginMcpRequirementBindingTable.id, bindingIds))
      }
      if (input.state.pluginId) {
        await tx.delete(MarketplacePluginTable).where(and(
          eq(MarketplacePluginTable.organizationId, organizationId),
          eq(MarketplacePluginTable.pluginId, input.state.pluginId),
        ))
      }
      if (configObjectIds.length > 0) {
        await tx.delete(PluginConfigObjectTable).where(and(
          eq(PluginConfigObjectTable.organizationId, organizationId),
          inArray(PluginConfigObjectTable.configObjectId, configObjectIds),
        ))
        await tx.delete(ConfigObjectAccessGrantTable).where(and(
          eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
          inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
        ))
        await tx.delete(ConfigObjectVersionTable).where(and(
          eq(ConfigObjectVersionTable.organizationId, organizationId),
          inArray(ConfigObjectVersionTable.configObjectId, configObjectIds),
        ))
        await tx.delete(ConfigObjectTable).where(and(
          eq(ConfigObjectTable.organizationId, organizationId),
          inArray(ConfigObjectTable.id, configObjectIds),
        ))
      }
      if (skillIds.length > 0) {
        await tx.delete(SkillHubSkillTable).where(inArray(SkillHubSkillTable.skillId, skillIds))
        await tx.delete(SkillTable).where(and(
          eq(SkillTable.organizationId, organizationId),
          inArray(SkillTable.id, skillIds),
        ))
      }
      if (input.state.skillHubId) {
        await tx.delete(SkillHubMemberTable).where(eq(SkillHubMemberTable.skillHubId, input.state.skillHubId))
        await tx.delete(SkillHubSkillTable).where(eq(SkillHubSkillTable.skillHubId, input.state.skillHubId))
        await tx.delete(SkillHubTable).where(and(
          eq(SkillHubTable.organizationId, organizationId),
          eq(SkillHubTable.id, input.state.skillHubId),
        ))
      }
      if (input.state.pluginId) {
        await tx.delete(PluginAccessGrantTable).where(and(
          eq(PluginAccessGrantTable.organizationId, organizationId),
          eq(PluginAccessGrantTable.pluginId, input.state.pluginId),
        ))
        await tx.delete(PluginTable).where(and(
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.id, input.state.pluginId),
        ))
      }
      return true
    })
  } catch (error) {
    logger.error("failed to roll back GitHub-import plugin objects", {
      error: error instanceof Error ? error.message : String(error),
      organizationId,
      pluginId: input.state.pluginId,
    })
    return
  }

  if (!removedOwnedPluginState) {
    logger.warn("preserved a GitHub import after its staged plugin was modified or adopted concurrently", {
      organizationId,
      pluginId: input.state.pluginId,
    })
    return
  }

  for (const [connectionId, connection] of input.state.newlyCreatedConnections) {
    try {
      const cleanup = await deleteExternalMcpConnectionIfUnused({
        connectionId,
        expectedConnection: connection,
        expectedOwnedOAuthClient: input.state.oauthClientMutations.get(connectionId)?.appliedRevision,
        organizationId,
      })
      if (cleanup === "in_use") {
        logger.info("kept a GitHub-import MCP connection or OAuth client that became used or changed concurrently", {
          connectionId,
          organizationId,
        })
      }
    } catch (error) {
      logger.error("failed to delete a new MCP connection after GitHub import rollback", {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
        organizationId,
      })
    }
  }
}

function githubImportViewerAccessGrantRows(input: {
  access: GithubPluginMcpImportAccess
  configObjectIds: ConfigObjectId[]
  context: PluginArchActorContext
  pluginId: PluginId
  publishedAt: Date
}) {
  const actorId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id
  const targets = input.access.orgWide
    ? [{ orgMembershipId: null, orgWide: true, teamId: null }]
    : [
        ...input.access.memberIds
          .filter((orgMembershipId) => orgMembershipId !== actorId)
          .map((orgMembershipId) => ({ orgMembershipId, orgWide: false, teamId: null })),
        ...input.access.teamIds
          .map((teamId) => ({ orgMembershipId: null, orgWide: false, teamId })),
      ]
  const pluginRows: (typeof PluginAccessGrantTable.$inferInsert)[] = targets.map((target) => ({
    ...target,
    createdAt: input.publishedAt,
    createdByOrgMembershipId: actorId,
    id: createDenTypeId("pluginAccessGrant"),
    organizationId,
    pluginId: input.pluginId,
    role: "viewer",
  }))
  const configObjectRows: (typeof ConfigObjectAccessGrantTable.$inferInsert)[] = input.configObjectIds.flatMap((configObjectId) =>
    targets.map((target) => ({
      ...target,
      configObjectId,
      createdAt: input.publishedAt,
      createdByOrgMembershipId: actorId,
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId,
      role: "viewer" as const,
    })))
  return { configObjectRows, pluginRows }
}

async function publishStagedGithubImport(input: {
  context: PluginArchActorContext
  marketplaceId: MarketplaceId
  noAuthConnectionIds: ExternalMcpConnectionRow["id"][]
  operationDeadlineAt: number
  state: GithubImportRollbackState
}) {
  requireGithubImportTime(input.operationDeadlineAt, GITHUB_MCP_IMPORT_FINAL_COMMIT_RESERVE_MS)
  const organizationId = input.context.organizationContext.organization.id
  const actorId = input.context.organizationContext.currentMember.id
  return db.transaction(async (tx) => {
    // Connection-first ordering matches binding creation/deletion and OAuth
    // lifecycle writers. Do not take a binding lock before these rows.
    const connectionIds = [...input.state.validatedConnections.keys()]
    const connections = connectionIds.length === 0
      ? []
      : await tx.select().from(ExternalMcpConnectionTable).where(and(
        eq(ExternalMcpConnectionTable.organizationId, organizationId),
        inArray(ExternalMcpConnectionTable.id, connectionIds),
      )).for("update")
    if (connections.length !== connectionIds.length
      || connections.some((connection) => {
        const expected = input.state.validatedConnections.get(connection.id)
        return !expected || !githubImportConnectionSnapshotMatches(connection, expected)
      })) {
      throw new PluginArchRouteFailure(
        409,
        "external_mcp_connection_changed",
        "An MCP connection changed after validation. Inspect the GitHub plugin again and retry.",
      )
    }
    if (!await githubImportPluginStateStillOwned({ organizationId, state: input.state, tx })) {
      throw new PluginArchRouteFailure(
        409,
        "github_import_adopted",
        "The staged plugin was modified while GitHub import was running. OpenWork preserved it instead of overwriting or deleting another administrator's work.",
      )
    }
    const plugin = input.state.pluginSnapshot
    if (!plugin) throw new PluginArchRouteFailure(409, "github_import_changed", "The staged GitHub plugin is no longer available.")
    const marketplaceRows = await tx.select().from(MarketplaceTable).where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.id, input.marketplaceId),
    )).limit(1).for("update")
    const marketplace = marketplaceRows[0]
    if (!marketplace || marketplace.status !== "active" || marketplace.deletedAt !== null) {
      throw new PluginArchRouteFailure(409, "marketplace_changed", "The target marketplace changed while the GitHub plugin was importing. Retry the import.")
    }

    requireGithubImportTime(input.operationDeadlineAt, 500)
    const publishedAt = new Date()
    const configObjectIds = [...input.state.configObjectIds]
    const viewerRows = githubImportViewerAccessGrantRows({
      access: input.state.access,
      configObjectIds,
      context: input.context,
      pluginId: plugin.id,
      publishedAt,
    })
    if (viewerRows.pluginRows.length > 0) await tx.insert(PluginAccessGrantTable).values(viewerRows.pluginRows)
    if (viewerRows.configObjectRows.length > 0) await tx.insert(ConfigObjectAccessGrantTable).values(viewerRows.configObjectRows)
    if (input.state.skillHubMembers.length > 0) {
      await tx.insert(SkillHubMemberTable).values(input.state.skillHubMembers)
    }
    if (input.state.access.orgWide && input.state.skillIds.size > 0) {
      await tx.update(SkillTable).set({ shared: "org", updatedAt: publishedAt }).where(and(
        eq(SkillTable.organizationId, organizationId),
        inArray(SkillTable.id, [...input.state.skillIds]),
      ))
    }

    await tx.insert(MarketplacePluginTable).values({
      createdAt: publishedAt,
      createdByOrgMembershipId: actorId,
      id: createDenTypeId("marketplacePlugin"),
      marketplaceId: marketplace.id,
      membershipSource: "api",
      organizationId,
      pluginId: plugin.id,
      removedAt: null,
    })

    const marketplaceGrants = await tx.select({
      orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
      orgWide: MarketplaceAccessGrantTable.orgWide,
      teamId: MarketplaceAccessGrantTable.teamId,
    }).from(MarketplaceAccessGrantTable).where(and(
      eq(MarketplaceAccessGrantTable.organizationId, organizationId),
      eq(MarketplaceAccessGrantTable.marketplaceId, marketplace.id),
      isNull(MarketplaceAccessGrantTable.removedAt),
    )).for("update")
    const effectiveAccess: PluginMcpRequirementAccess = {
      memberIds: sortedUnique([
        actorId,
        ...input.state.access.memberIds,
        ...marketplaceGrants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []),
      ]),
      orgWide: input.state.access.orgWide || marketplaceGrants.some((grant) => grant.orgWide),
      teamIds: sortedUnique([
        ...input.state.access.teamIds,
        ...marketplaceGrants.flatMap((grant) => grant.teamId ? [grant.teamId] : []),
      ]),
    }
    const bindings = [...input.state.bindings.values()]
    if (bindings.length > 0) {
      await tx.delete(ExternalMcpConnectionAccessGrantTable).where(inArray(
        ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId,
        bindings.map((binding) => binding.id),
      ))
      const accessRows = bindings.flatMap((binding) => pluginMcpRequirementAccessGrantRows({
        access: effectiveAccess,
        bindingId: binding.id,
        connectionId: binding.externalMcpConnectionId,
        createdByOrgMembershipId: binding.createdByOrgMembershipId,
        organizationId,
      }))
      if (accessRows.length > 0) await tx.insert(ExternalMcpConnectionAccessGrantTable).values(accessRows)
    }

    const noAuthConnectionIds = sortedUnique(input.noAuthConnectionIds)
    if (noAuthConnectionIds.length > 0) {
      await tx.update(ExternalMcpConnectionTable)
        .set({ connectedAt: publishedAt })
        .where(and(
          eq(ExternalMcpConnectionTable.organizationId, organizationId),
          inArray(ExternalMcpConnectionTable.id, noAuthConnectionIds),
        ))
    }
    await tx.update(PluginTable).set({ status: "active", updatedAt: publishedAt }).where(and(
      eq(PluginTable.organizationId, organizationId),
      eq(PluginTable.id, plugin.id),
    ))
    return { marketplaceName: marketplace.name, publishedAt }
  })
}

export async function importGithubPluginMcps(input: {
  access?: GithubPluginMcpImportAccess
  apiPublicBaseUrl?: string
  authType: "none" | "oauth"
  context: PluginArchActorContext
  credentialMode: "per_member" | "shared"
  githubUrl: string
  marketplaceId: MarketplaceId
  serverConfigurations?: GithubPluginMcpImportServerConfiguration[]
  sourceRevisionRef?: string
  selectedSkillKeys?: string[]
  selectedServerKeys?: string[]
  selectedServerNames?: string[]
}) {
  const operationDeadlineAt = Date.now() + GITHUB_MCP_IMPORT_OPERATION_TIMEOUT_MS
  const inspectionDeadlineAt = operationDeadlineAt - GITHUB_MCP_IMPORT_MATERIALIZATION_RESERVE_MS
  const marketplace = await ensureEditableMarketplace(input.context, input.marketplaceId)
  const canonicalGithubUrl = parsePublicGithubPluginUrl(input.githubUrl).canonicalUrl
  const sourceRevisionRef = normalizeOptionalString(input.sourceRevisionRef)
  const requiresReviewedRevision = (input.selectedSkillKeys?.length ?? 0) > 0
    || (input.selectedServerKeys !== undefined && input.selectedServerKeys.length > 0)
    || (input.selectedServerNames?.length ?? 0) > 0
  if (requiresReviewedRevision && !sourceRevisionRef) {
    throw new PluginArchRouteFailure(
      400,
      "github_source_revision_required",
      "Preview and review the pinned GitHub revision before importing selected plugin components.",
    )
  }
  const plan = await computeGithubPluginMcpImportPlan({
    githubUrl: canonicalGithubUrl,
    includeDiscovery: false,
    includeSkillText: true,
    operationDeadlineAt: inspectionDeadlineAt,
  })
  if (sourceRevisionRef && sourceRevisionRef !== plan.sourceRevisionRef) {
    throw new PluginArchRouteFailure(
      409,
      "github_source_revision_changed",
      "The GitHub plugin changed after the preview. Preview it again before importing.",
    )
  }
  const selectedSkillKeys = new Set(input.selectedSkillKeys?.map((key) => key.trim()).filter(Boolean) ?? [])
  const selectedServerKeys = new Set(input.selectedServerKeys?.map((key) => key.trim()).filter(Boolean) ?? [])
  const selectedServerNames = new Set(input.selectedServerNames?.map((name) => name.trim()).filter(Boolean) ?? [])
  const legacyNameSelectedServers = selectedServerNames.size > 0
    ? plan.servers.filter((server) => selectedServerNames.has(server.name))
    : []
  if (legacyNameSelectedServers.some((server) => server.discovery?.support.status === "needs_review")) {
    throw new PluginArchRouteFailure(
      400,
      "github_server_review_required",
      "This MCP server requires explicit review. Preview it again and select its stable server key before importing.",
    )
  }
  // `undefined` is the legacy "import every server" contract. An explicit
  // empty key list means the admin selected skills only and must never fall
  // through to importing MCP servers they unchecked in the preview.
  const consideredServers = input.selectedServerKeys !== undefined
    ? plan.servers.filter((server) => selectedServerKeys.has(server.serverKey))
    : selectedServerNames.size > 0
    ? legacyNameSelectedServers
    : plan.servers.filter((server) => server.discovery?.support.status !== "needs_review")
  const consideredSkills = selectedSkillKeys.size > 0
    ? plan.skills.filter((skill) => selectedSkillKeys.has(skill.skillKey))
    : []
  const serverConfigurations = new Map<string, GithubPluginMcpImportServerConfiguration>()
  for (const configuration of input.serverConfigurations ?? []) {
    if (serverConfigurations.has(configuration.serverKey)) {
      throw new PluginArchRouteFailure(400, "duplicate_server_configuration", `MCP server "${configuration.serverKey}" was configured more than once.`)
    }
    serverConfigurations.set(configuration.serverKey, configuration)
  }
  const planServerKeys = new Set(plan.servers.map((server) => server.serverKey))
  const consideredServerKeys = new Set(consideredServers.map((server) => server.serverKey))
  for (const serverKey of serverConfigurations.keys()) {
    if (!planServerKeys.has(serverKey)) {
      throw new PluginArchRouteFailure(400, "unknown_server_configuration", `MCP server configuration key "${serverKey}" is not present in the current GitHub revision.`)
    }
    if (!consideredServerKeys.has(serverKey)) {
      throw new PluginArchRouteFailure(400, "unselected_server_configuration", `MCP server configuration key "${serverKey}" was not selected for import.`)
    }
  }
  const supportedServers = consideredServers.filter((server) => server.supported && server.url)
  const supportedSkills = consideredSkills.filter((skill) => skill.supported && skill.rawSourceText)
  if (supportedServers.length > MAX_GITHUB_MCP_IMPORT_SELECTIONS) {
    throw new PluginArchRouteFailure(
      400,
      "github_import_limit_exceeded",
      `Select at most ${MAX_GITHUB_MCP_IMPORT_SELECTIONS} MCP servers per import so OpenWork can validate them within one bounded request.`,
    )
  }
  if (supportedServers.length + supportedSkills.length > MAX_GITHUB_MCP_IMPORT_COMPONENTS) {
    throw new PluginArchRouteFailure(
      400,
      "github_import_limit_exceeded",
      `Select at most ${MAX_GITHUB_MCP_IMPORT_COMPONENTS} total MCP servers and skills per import so publication remains atomic and bounded.`,
    )
  }
  if (supportedServers.length === 0 && supportedSkills.length === 0) {
    throw new PluginArchRouteFailure(400, "no_supported_plugin_components", "No supported remote MCP servers or skills were selected from that plugin.")
  }
  const resolvedServerConfigurations = new Map(supportedServers.map((server) => [
    server.serverKey,
    githubPluginMcpServerConfiguration({
      configured: serverConfigurations.get(server.serverKey),
      discoveredAuthType: server.authType,
      fallbackAuthType: input.authType,
      fallbackCredentialMode: input.credentialMode,
    }),
  ]))

  const requestedAccess = input.access ?? {
    memberIds: [],
    orgWide: true,
    teamIds: [],
  }
  if (!requestedAccess.orgWide && requestedAccess.memberIds.length === 0 && requestedAccess.teamIds.length === 0) {
    throw new PluginArchRouteFailure(400, "missing_import_access", "Choose who can use the imported MCP connections.")
  }
  const access = await validateGithubImportAccess({ access: requestedAccess, context: input.context })

  // Re-check the selected declarations server-side. Preview guidance is not a
  // trust boundary: older clients may omit per-server configuration, and a
  // crafted request must not bypass unsupported inputs or missing PKCE. Every
  // selected OAuth server receives a live metadata probe within the shared
  // request budget; manifest declarations alone cannot authorize an import.
  const liveOAuthServerKeys = new Set(supportedServers
    .filter((server) => resolvedServerConfigurations.get(server.serverKey)?.authType === "oauth")
    .map((server) => server.serverKey))
  const unavailableValidationFetch = async (): Promise<Response> => {
    throw new Error("Live MCP validation was not scheduled for this import item.")
  }
  const validatedDiscoveries = new Map<string, ExternalMcpConfigurationDiscovery>()
  await mapWithConcurrency({
    concurrency: GITHUB_MCP_DISCOVERY_CONCURRENCY,
    items: supportedServers,
    map: async (server) => {
      const configuration = resolvedServerConfigurations.get(server.serverKey)
      if (!configuration || !server.url) return
      const discovery = await discoverExternalMcpConfiguration({
        config: githubPluginMcpManifestByServer.get(server),
        ...(liveOAuthServerKeys.has(server.serverKey) ? {} : { fetch: unavailableValidationFetch }),
        timeoutMs: githubMcpRemainingTimeoutMs(inspectionDeadlineAt, GITHUB_MCP_DISCOVERY_TIMEOUT_MS),
        url: server.url,
      })
      assertPluginMcpDiscoveryAllowsConfiguration({
        authType: configuration.authType,
        discovery,
        oauthClient: configuration.oauthClient,
        requireVerifiedOauthPkce: configuration.authType === "oauth",
      })
      validatedDiscoveries.set(server.serverKey, discovery)
    },
  })

  const preparedConnections: Array<{
    configuration: ReturnType<typeof githubPluginMcpServerConfiguration>
    importedConnection: Awaited<ReturnType<typeof ensureImportedExternalMcpConnection>>
    server: GithubPluginMcpImportServer
  }> = []
  const rollbackState = createGithubImportRollbackState(access)
  const validationLifecycleDeadline = createExternalMcpLifecycleDeadline(
    githubMcpRemainingTimeoutMs(inspectionDeadlineAt, GITHUB_MCP_IMPORT_OPERATION_TIMEOUT_MS),
  )
  try {
    for (const server of supportedServers) {
      requireGithubImportTime(inspectionDeadlineAt)
      const configuration = resolvedServerConfigurations.get(server.serverKey)
      if (!configuration) throw new PluginArchRouteFailure(400, "missing_server_configuration", `MCP server "${server.name}" configuration is missing.`)
      const discovery = validatedDiscoveries.get(server.serverKey)
      if (!discovery || !server.url) {
        throw new PluginArchRouteFailure(409, "mcp_discovery_stale", `MCP server "${server.name}" must be inspected again before import.`)
      }
      const ensuredConnection = await ensureImportedExternalMcpConnection({
        access,
        apiKey: configuration.apiKey,
        authType: configuration.authType,
        context: input.context,
        credentialMode: configuration.credentialMode,
        oauthClient: configuration.oauthClient,
        requestedOAuthScopes: configuration.authType === "oauth"
          ? trustedPluginMcpRequestedOAuthScopes({
              discovery,
              server: {
                config: githubPluginMcpManifestByServer.get(server) ?? {},
                name: server.name,
                url: server.url,
              },
            })
          : [],
        server,
      })
      // Multiple declarations in one import can intentionally share a URL.
      // Once this saga created that row, every config object in the same saga
      // must retain plugin ownership so removing the last binding can reclaim
      // it later.
      const importedConnection = rollbackState.newlyCreatedConnectionIds.has(ensuredConnection.connection.id)
        ? { ...ensuredConnection, ownedByImportedPlugin: true }
        : ensuredConnection
      rememberGithubImportConnection(rollbackState, importedConnection)
      await validateConfiguredPluginMcpConnection({
        apiPublicBaseUrl: input.apiPublicBaseUrl,
        authType: configuration.authType,
        connection: importedConnection.connection,
        lifecycleDeadline: validationLifecycleDeadline,
        markConnected: false,
      })
      preparedConnections.push({ configuration, importedConnection, server })
    }
    requireGithubImportTime(operationDeadlineAt, GITHUB_MCP_IMPORT_MATERIALIZATION_RESERVE_MS - 1_000)
    const stagedPlugin = await createStagedGithubImportPlugin({
      context: input.context,
      description: `Plugin components imported from ${plan.repositoryFullName}${plan.rootPath ? `/${plan.rootPath}` : ""} at immutable GitHub revision ${plan.sourceRevisionRef}.`,
      name: importedPluginName(plan),
    })
    const plugin = stagedPlugin.row
    rollbackState.pluginId = plugin.id
    rollbackState.pluginManagerGrantId = stagedPlugin.managerGrantId
    rollbackState.pluginSnapshot = plugin

    const imported: Array<{ connectionId: string; name: string; oauthCallback?: string; url: string }> = []
    const importedSkills: Array<{ name: string; skillId: SkillId; sourcePath: string }> = []
    for (const { configuration, importedConnection, server } of preparedConnections) {
      requireGithubImportTime(operationDeadlineAt)
      const connection = importedConnection.connection
      if (configuration.oauthClient && configuration.authType === "oauth") {
        await persistGithubImportOAuthClient({
          client: configuration.oauthClient,
          connection,
          context: input.context,
          ownedByImportedPlugin: importedConnection.ownedByImportedPlugin,
          state: rollbackState,
        })
      }
      const payload = importedConnectionBackedMcpPayload({
        connectionId: connection.id,
        ownedByImportedPlugin: importedConnection.ownedByImportedPlugin,
        repositoryFullName: plan.repositoryFullName,
        server,
        sourceRevisionRef: plan.sourceRevisionRef,
      })
      const configObject = await createConfigObject({
        context: input.context,
        objectType: "mcp",
        pluginIds: [plugin.id],
        sourceMode: "import",
        value: {
          metadata: {
            description: `Den-hosted MCP connection imported from ${server.sourcePath}.`,
            externalMcpConnectionId: connection.id,
            externalMcpConnectionOwnedByPlugin: importedConnection.ownedByImportedPlugin,
            githubUrl: canonicalGithubUrl,
            name: externalMcpConnectionName({ pluginName: server.pluginName, serverName: server.name }),
            openworkManaged: "den_external_mcp",
            repositoryFullName: plan.repositoryFullName,
            sourcePath: server.sourcePath,
            sourceRevisionRef: plan.sourceRevisionRef,
          },
          normalizedPayloadJson: payload,
          schemaVersion: "openwork.den_external_mcp.v1",
          sourceRevisionRef: plan.sourceRevisionRef,
        },
      })
      rollbackState.configObjectIds.add(configObject.id)
      const configObjectSnapshot = await getConfigObjectRow(
        input.context.organizationContext.organization.id,
        configObject.id,
      )
      if (!configObjectSnapshot) {
        throw new PluginArchRouteFailure(409, "github_import_changed", "An imported config object disappeared before publication.")
      }
      rollbackState.configObjects.set(configObject.id, configObjectSnapshot)
      let binding: PluginMcpRequirementBindingRow
      try {
        binding = await upsertPluginMcpRequirementBinding({
          configObjectId: configObject.id,
          createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
          externalMcpConnectionId: connection.id,
          organizationId: input.context.organizationContext.organization.id,
          pluginId: plugin.id,
          serverName: slugifyPluginMcpName(server.name),
        })
      } catch (error) {
        if (error instanceof PluginMcpRequirementConnectionMissingError) {
          throw new PluginArchRouteFailure(
            409,
            "external_mcp_connection_changed",
            "The MCP connection was removed while the GitHub plugin was being imported. Inspect it again and retry.",
          )
        }
        throw error
      }
      rollbackState.bindingIds.add(binding.id)
      rollbackState.bindings.set(binding.id, binding)
      imported.push({
        connectionId: connection.id,
        name: server.name,
        ...(configuration.authType === "oauth" && configuration.oauthClient
          ? { oauthCallback: pluginMcpValidationRedirectUri(connection.id, input.apiPublicBaseUrl) }
          : {}),
        url: server.url ?? "",
      })
    }

    requireGithubImportTime(operationDeadlineAt)
    const createdSkillHub = supportedSkills.length > 0
      ? await createSkillHubForImportedSkills({
        access,
        context: input.context,
        name: boundedPublisherName(`${plugin.name} skills`, "GitHub plugin skills"),
      })
      : null
    rollbackState.skillHubId = createdSkillHub?.row.id ?? null
    rollbackState.skillHubSnapshot = createdSkillHub?.row ?? null
    rollbackState.skillHubMembers = createdSkillHub?.memberRows ?? []
    for (const skill of supportedSkills) {
      requireGithubImportTime(operationDeadlineAt)
      const createdSkill = await createImportedSkill({
        context: input.context,
        repositoryFullName: plan.repositoryFullName,
        skill,
        skillHubId: rollbackState.skillHubId,
        sourceRevisionRef: plan.sourceRevisionRef,
      })
      rollbackState.skillIds.add(createdSkill.row.id)
      rollbackState.skills.set(createdSkill.row.id, createdSkill.row)
      if (createdSkill.skillHubSkillId) rollbackState.skillHubSkillIds.add(createdSkill.skillHubSkillId)
      const configObject = await createConfigObject({
        context: input.context,
        objectType: "skill",
        pluginIds: [plugin.id],
        sourceMode: "import",
        value: {
          metadata: {
            description: createdSkill.row.description ?? `Den skill imported from ${skill.sourcePath}.`,
            denSkillId: createdSkill.row.id,
            githubUrl: canonicalGithubUrl,
            name: createdSkill.row.title,
            openworkManaged: "den_skill",
            repositoryFullName: plan.repositoryFullName,
            sourcePath: skill.sourcePath,
            sourceRevisionRef: plan.sourceRevisionRef,
          },
          normalizedPayloadJson: importedDenSkillPayload({
            repositoryFullName: plan.repositoryFullName,
            skillId: createdSkill.row.id,
            sourcePath: skill.sourcePath,
            sourceRevisionRef: plan.sourceRevisionRef,
          }),
          schemaVersion: "openwork.den_skill.v1",
          sourceRevisionRef: plan.sourceRevisionRef,
        },
      })
      rollbackState.configObjectIds.add(configObject.id)
      const configObjectSnapshot = await getConfigObjectRow(
        input.context.organizationContext.organization.id,
        configObject.id,
      )
      if (!configObjectSnapshot) {
        throw new PluginArchRouteFailure(409, "github_import_changed", "An imported skill config object disappeared before publication.")
      }
      rollbackState.configObjects.set(configObject.id, configObjectSnapshot)
      importedSkills.push({ name: createdSkill.row.title, skillId: createdSkill.row.id, sourcePath: skill.sourcePath })
    }

    const skipped = consideredServers.flatMap((server) =>
      server.supported || !server.skippedReason ? [] : [{ name: server.name, reason: server.skippedReason }])
    const skippedSkills = consideredSkills.flatMap((skill) =>
      skill.supported || !skill.skippedReason ? [] : [{ name: skill.name, reason: skill.skippedReason, sourcePath: skill.sourcePath }])
    const stagedPluginDetail = await getPluginDetail(input.context, plugin.id)
    // Re-check route-level authority immediately before the commit fence. The
    // transaction below separately locks and verifies the live marketplace.
    await ensureEditableMarketplace(input.context, input.marketplaceId)
    const published = await publishStagedGithubImport({
      context: input.context,
      marketplaceId: input.marketplaceId,
      noAuthConnectionIds: preparedConnections.flatMap(({ configuration, importedConnection }) =>
        configuration.authType === "none" ? [importedConnection.connection.id] : []),
      operationDeadlineAt,
      state: rollbackState,
    })

    return {
      imported,
      importedSkills,
      marketplaceId: input.marketplaceId,
      plugin: {
        ...stagedPluginDetail,
        marketplaces: [{ id: marketplace.id, name: published.marketplaceName }],
        status: "active" as const,
        updatedAt: published.publishedAt.toISOString(),
      },
      skipped,
      skippedSkills,
    }
  } catch (error) {
    await rollbackGithubPluginMcpImport({ context: input.context, state: rollbackState })
    throw error
  }
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

function withGithubDiscoveryCache(config: Record<string, unknown>, cache: GithubDiscoveryCacheEntry) {
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

  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.connectorInstance.organizationId),
      eq(MemberTable.id, input.connectorInstance.createdByOrgMembershipId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const member = memberRows[0] as MemberRow | undefined
  if (!member) {
    throw new PluginArchRouteFailure(404, "member_not_found", "Connector creator member not found.")
  }

  if (!member.userId) {
    throw new PluginArchRouteFailure(404, "member_not_joined", "Connector creator member has not joined the organization.")
  }

  return {
    memberTeams: [],
    session: null,
    organizationContext: {
      currentMember: {
        createdAt: member.createdAt,
        id: member.id,
        isOwner: roleIncludesOwner(member.role),
        joinedAt: member.joinedAt,
        role: member.role,
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

async function computeGithubDiscoverySnapshot(input: {
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

function discoveryMappingsForPlugin(plugin: GithubDiscoveredPlugin) {
  return [
    ...plugin.componentPaths.skills.map((selector) => ({ objectType: "skill" as const, selector: `${selector}/**` })),
    ...plugin.componentPaths.commands.map((selector) => ({ objectType: "command" as const, selector: `${selector}/**` })),
    ...plugin.componentPaths.agents.map((selector) => ({ objectType: "agent" as const, selector: `${selector}/**` })),
    ...plugin.componentPaths.hooks.map((selector) => ({ objectType: "hook" as const, selector })),
    ...plugin.componentPaths.mcpServers.map((selector) => ({ objectType: "mcp" as const, selector })),
  ]
}

function mappingSelectorMatchesPath(selector: string, path: string) {
  const normalizedSelector = selector.trim().replace(/^\/+/, "")
  const normalizedPath = path.trim().replace(/^\/+/, "")
  if (normalizedSelector.endsWith("/**")) {
    const prefix = normalizedSelector.slice(0, -3)
    return normalizedPath.startsWith(`${prefix}/`)
  }
  return normalizedPath === normalizedSelector
}

function importableGithubPathsForMapping(input: {
  mapping: Pick<ReturnType<typeof serializeConnectorMapping>, "objectType" | "selector">
  treeEntries: GithubDiscoveryTreeEntry[]
}) {
  const matchingBlobs = input.treeEntries
    .filter((entry) => entry.kind === "blob")
    .filter((entry) => mappingSelectorMatchesPath(input.mapping.selector, entry.path))

  if (input.mapping.objectType === "skill") {
    const preferred = matchingBlobs.filter((entry) => entry.path.endsWith("/SKILL.md"))
    return preferred.length > 0 ? preferred : matchingBlobs.filter((entry) => entry.path.endsWith(".md"))
  }
  if (input.mapping.objectType === "agent") {
    const preferred = matchingBlobs.filter((entry) => entry.path.endsWith("/AGENT.md"))
    return preferred.length > 0 ? preferred : matchingBlobs.filter((entry) => entry.path.endsWith(".md"))
  }
  if (input.mapping.objectType === "command") {
    return matchingBlobs.filter((entry) => entry.path.endsWith(".md"))
  }
  return matchingBlobs
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

  return {
    metadata,
    normalizedPayloadJson: (() => {
      if (!fileName.endsWith(".json")) {
        return undefined
      }
      try {
        const parsed = JSON.parse(input.rawSourceText) as unknown
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
      } catch {
        return undefined
      }
    })(),
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
  const metadata = importedObjectMetadata({
    objectType: input.connectorMapping.objectType,
    path: input.externalLocator,
    rawSourceText: input.rawSourceText,
  })
  const frontmatterRecord = metadata.metadata && typeof metadata.metadata.frontmatter === "object"
    ? metadata.metadata.frontmatter as Record<string, unknown>
    : null
  const hasFrontmatter = frontmatterRecord && Object.keys(frontmatterRecord).length > 0
  const projectionRawSource = hasFrontmatter
    ? parseMarkdownFrontmatter(input.rawSourceText).body
    : input.rawSourceText
  const projection = deriveProjection({
    objectType: input.connectorMapping.objectType,
    value: {
      metadata: metadata.metadata,
      normalizedPayloadJson: metadata.normalizedPayloadJson,
      rawSourceText: projectionRawSource,
    },
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

async function ensureDiscoveryPlugin(input: { context: PluginArchActorContext; description: string | null; name: string }) {
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
    return serializePlugin(existing[0], 0)
  }

  return createPlugin({
    context: input.context,
    description: input.description,
    name: input.name,
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

export async function createGithubConnectorAccount(input: { accountLogin: string; accountType: "Organization" | "User"; context: PluginArchActorContext; displayName: string; installationId: number }) {
  return createConnectorAccount({
    connectorType: "github",
    context: input.context,
    displayName: input.displayName,
    metadata: {
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      repositories: [],
      repositorySelection: "all",
      settingsUrl: null,
    },
    remoteId: String(input.installationId),
  })
}

async function upsertGithubConnectorAccountFromInstallation(input: { context: PluginArchActorContext; installationId: number }) {
  let installation: Awaited<ReturnType<typeof getGithubInstallationSummary>>
  try {
    installation = await getGithubInstallationSummary({
      config: githubConnectorAppConfig(),
      installationId: input.installationId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
  const organizationId = input.context.organizationContext.organization.id
  const existingRows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(
      eq(ConnectorAccountTable.organizationId, organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.remoteId, String(input.installationId)),
    ))
    .limit(1)

  const metadata = {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositories: [],
    repositorySelection: installation.repositorySelection,
    settingsUrl: installation.settingsUrl,
  }

  if (!existingRows[0]) {
    return createConnectorAccount({
      connectorType: "github",
      context: input.context,
      displayName: installation.displayName,
      externalAccountRef: installation.accountLogin,
      metadata,
      remoteId: String(input.installationId),
    })
  }

  await db.update(ConnectorAccountTable).set({
    displayName: installation.displayName,
    externalAccountRef: installation.accountLogin,
    metadataJson: {
      ...(existingRows[0].metadataJson ?? {}),
      ...metadata,
    },
    status: "active",
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, existingRows[0].id))

  return getConnectorAccountDetail(input.context, existingRows[0].id)
}

export async function startGithubConnectorInstall(input: { context: PluginArchActorContext; returnPath: string }) {
  const returnPath = input.returnPath.trim()
  if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
    throw new PluginArchRouteFailure(400, "invalid_return_path", "GitHub install return path must be a safe relative path.")
  }

  let app: Awaited<ReturnType<typeof getGithubAppSummary>>
  try {
    app = await getGithubAppSummary({ config: githubConnectorAppConfig() })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
  const state = createGithubInstallStateToken({
    orgId: input.context.organizationContext.organization.id,
    returnPath,
    secret: env.betterAuthSecret,
    userId: input.context.organizationContext.currentMember.userId,
  })

  return {
    redirectUrl: buildGithubAppInstallUrl({ app, state }),
    state,
  }
}

export async function completeGithubConnectorInstall(input: { context: PluginArchActorContext; installationId: number; state: string }) {
  const parsedState = consumeGithubInstallState(input.state)
  if (parsedState.orgId !== input.context.organizationContext.organization.id) {
    throw new PluginArchRouteFailure(409, "github_install_org_mismatch", "GitHub install state does not match the current organization.")
  }
  if (parsedState.userId !== input.context.organizationContext.currentMember.userId) {
    throw new PluginArchRouteFailure(409, "github_install_user_mismatch", "GitHub install state does not match the current user.")
  }

  const connectorAccount = await upsertGithubConnectorAccountFromInstallation({
    context: input.context,
    installationId: input.installationId,
  })

  return {
    connectorAccount,
    // Keep install completion fast. The connected-account screen loads repositories next.
    repositories: [],
  }
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

export async function listGithubRepositories(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; cursor?: string; limit?: number; q?: string }) {
  const account = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!account) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  if (account.connectorType !== "github") {
    throw new PluginArchRouteFailure(409, "github_connector_account_required", "Connector account is not a GitHub account.")
  }

  const installationId = Number(account.remoteId)
  if (!Number.isFinite(installationId) || installationId <= 0) {
    throw new PluginArchRouteFailure(409, "invalid_github_installation_id", "Connector account does not have a valid GitHub installation id.")
  }

  let repositories: RepositorySummary[]
  let installationSummary: Awaited<ReturnType<typeof getGithubInstallationSummary>>
  try {
    repositories = await listGithubInstallationRepositories({
      config: githubConnectorAppConfig(),
      installationId,
    })
    installationSummary = await getGithubInstallationSummary({
      config: githubConnectorAppConfig(),
      installationId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }

  const existingMetadata = account.metadataJson && typeof account.metadataJson === "object"
    ? account.metadataJson as Record<string, unknown>
    : {}
  await db.update(ConnectorAccountTable).set({
    metadataJson: {
      ...existingMetadata,
      repositories: repositories.map((repository) => ({
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        hasPluginManifest: repository.hasPluginManifest ?? false,
        id: repository.id,
        manifestKind: repository.manifestKind ?? null,
        marketplacePluginCount: repository.marketplacePluginCount ?? null,
        private: repository.private,
      })),
      repositorySelection: installationSummary.repositorySelection,
      settingsUrl: installationSummary.settingsUrl,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, account.id))

  const filtered = repositories
    .filter((repository) => !input.q || `${repository.fullName}\n${repository.defaultBranch ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((repository) => ({ ...repository, id: String(repository.id) }))
  const page = pageItems(filtered, input.cursor, input.limit)
  return {
    items: page.items.map((repository) => ({
      defaultBranch: repository.defaultBranch,
      fullName: repository.fullName,
      hasPluginManifest: Boolean(repository.hasPluginManifest),
      id: Number(repository.id),
      manifestKind: repository.manifestKind ?? null,
      marketplacePluginCount: repository.marketplacePluginCount ?? null,
      private: repository.private,
    })),
    nextCursor: page.nextCursor,
  }
}

export async function validateGithubTarget(input: {
  branch: string
  config?: ReturnType<typeof githubConnectorAppConfig>
  installationId: number
  ref: string
  repositoryFullName: string
  repositoryId: number
  token?: string
}) {
  try {
    return await validateGithubInstallationTarget({
      branch: input.branch,
      config: input.config ?? githubConnectorAppConfig(),
      installationId: input.installationId,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
      token: input.token,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
}

export async function githubSetup(input: {
  branch: string
  connectorAccountId?: ConnectorAccountId
  connectorInstanceName: string
  context: PluginArchActorContext
  installationId: number
  mappings: Array<{ autoAddToPlugin: boolean; config?: Record<string, unknown>; mappingKind: ConnectorMappingRow["mappingKind"]; objectType: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector: string }>
  ref: string
  repositoryFullName: string
  repositoryId: number
}) {
  const githubConfig = githubConnectorAppConfig()
  const installationToken = await getGithubInstallationAccessToken({
    config: githubConfig,
    installationId: input.installationId,
  })
  const validation = await validateGithubTarget({
    branch: input.branch,
    config: githubConfig,
    installationId: input.installationId,
    ref: input.ref,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    token: installationToken,
  })
  if (!validation.repositoryAccessible) {
    throw new PluginArchRouteFailure(409, "github_repository_not_accessible", "GitHub repository is not accessible for this installation.")
  }
  if (!validation.branchExists) {
    throw new PluginArchRouteFailure(409, "github_branch_not_found", "GitHub branch/ref could not be validated for this repository.")
  }

  const discovery = await computeGithubDiscoverySnapshot({
    branch: input.branch,
    installationId: input.installationId,
    ref: input.ref,
    repositoryFullName: input.repositoryFullName,
    token: installationToken,
  })

  let connectorAccountId = input.connectorAccountId as ConnectorAccountId | undefined
  let connectorAccountDetail = connectorAccountId ? await getConnectorAccountDetail(input.context, connectorAccountId) : null
  if (!connectorAccountId || !connectorAccountDetail) {
    connectorAccountDetail = await createGithubConnectorAccount({
      accountLogin: input.repositoryFullName.split("/")[0] ?? input.repositoryFullName,
      accountType: "Organization",
      context: input.context,
      displayName: input.repositoryFullName,
      installationId: input.installationId,
    })
    connectorAccountId = connectorAccountDetail.id
  }

  const connectorInstance = await createConnectorInstance({
    connectorAccountId,
    connectorType: "github",
    config: {
      autoImportNewPlugins: true,
      installationId: input.installationId,
    },
    context: input.context,
    name: input.connectorInstanceName,
    remoteId: input.repositoryFullName,
  })

  const connectorTarget = await createConnectorTarget({
    config: withGithubDiscoveryCache({
      branch: input.branch,
      defaultBranch: validation.defaultBranch,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
    }, {
      branch: discovery.branch,
      classification: discovery.classification,
      discoveredPlugins: discovery.discoveredPlugins,
      importPlansByPluginKey: discovery.importPlansByPluginKey,
      marketplace: discovery.marketplace,
      ref: discovery.ref,
      repositoryFullName: discovery.repositoryFullName,
      sourceRevisionRef: discovery.sourceRevisionRef,
      treeSummary: discovery.treeSummary,
      warnings: discovery.warnings,
    }),
    connectorInstanceId: connectorInstance.id,
    connectorType: "github",
    context: input.context,
    externalTargetRef: input.branch,
    remoteId: input.repositoryFullName,
    targetKind: "repository_branch",
  })

  for (const mapping of input.mappings) {
    await createConnectorMapping({
      autoAddToPlugin: mapping.autoAddToPlugin,
      config: mapping.config,
      connectorTargetId: connectorTarget.id,
      context: input.context,
      mappingKind: mapping.mappingKind,
      objectType: mapping.objectType,
      pluginId: mapping.pluginId,
      selector: mapping.selector,
    })
  }

  return {
    connectorAccount: connectorAccountDetail,
    connectorInstance,
    connectorTarget,
  }
}

export async function enqueueGithubWebhookSync(input: {
  deliveryId: string
  event: "installation" | "installation_repositories" | "push" | "repository"
  headSha?: string
  installationId?: number
  payload: Record<string, unknown>
  ref?: string
  repositoryFullName?: string
  repositoryId?: number
}) {
  if (!input.installationId) {
    return { accepted: false as const, reason: "missing installation id" }
  }

  const accounts = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(eq(ConnectorAccountTable.connectorType, "github"), eq(ConnectorAccountTable.remoteId, String(input.installationId))))

  if (input.event !== "push") {
    if (input.event === "installation") {
      const action = typeof input.payload.action === "string" ? input.payload.action : null
      if (action === "deleted") {
        for (const account of accounts) {
          await db.update(ConnectorAccountTable).set({ status: "disconnected", updatedAt: new Date() }).where(eq(ConnectorAccountTable.id, account.id))
        }
        return { accepted: true as const, queued: false as const }
      }
    }
    return { accepted: false as const, reason: "event ignored" }
  }

  if (!input.repositoryFullName || !input.ref || !input.headSha || !input.repositoryId) {
    return { accepted: false as const, reason: "missing push metadata" }
  }

  const instances = await db
    .select({ instance: ConnectorInstanceTable, target: ConnectorTargetTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .innerJoin(ConnectorAccountTable, eq(ConnectorInstanceTable.connectorAccountId, ConnectorAccountTable.id))
    .where(and(
      eq(ConnectorTargetTable.connectorType, "github"),
      eq(ConnectorTargetTable.remoteId, input.repositoryFullName),
      eq(ConnectorTargetTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.remoteId, String(input.installationId)),
      eq(ConnectorAccountTable.status, "active"),
      eq(ConnectorInstanceTable.status, "active"),
    ))

  const queuedIds: string[] = []
  for (const row of instances) {
    const targetConfig = row.target.targetConfigJson ?? {}
    const targetRef = typeof targetConfig.ref === "string" ? targetConfig.ref : null
    if (targetRef && targetRef !== input.ref) {
      continue
    }

    const existing = await db
      .select({ id: ConnectorSyncEventTable.id })
      .from(ConnectorSyncEventTable)
      .where(and(
        eq(ConnectorSyncEventTable.connectorTargetId, row.target.id),
        eq(ConnectorSyncEventTable.eventType, "push"),
        eq(ConnectorSyncEventTable.sourceRevisionRef, input.headSha),
      ))
      .limit(1)

    // Generate the sync event id up front so config object versions created during auto-import
    // can be linked back to the triggering sync event.
    const id = existing[0]?.id ?? createDenTypeId("connectorSyncEvent")

    type AutoImportSummary = Awaited<ReturnType<typeof maybeAutoImportGithubConnectorInstance>>
    const startedAt = new Date()
    let autoImportSummary: AutoImportSummary | null = null
    let autoImportError: string | null = null
    try {
      autoImportSummary = await maybeAutoImportGithubConnectorInstance({
        connectorInstance: row.instance,
        connectorSyncEventId: id,
        connectorTarget: row.target,
      })
    } catch (error) {
      autoImportError = error instanceof Error ? error.message : String(error)
      // Surface the failure instead of swallowing it silently so a sync that records an event
      // but never creates a version is diagnosable.
      logger.error("github connector auto-import failed", {
        connector_target_id: row.target.id,
        delivery_id: input.deliveryId,
        error: autoImportError,
      })
    }

    const completedAt = new Date()
    const eventStatus = autoImportError
      ? "failed" as const
      : !autoImportSummary
        ? "queued" as const
        : !autoImportSummary.autoImported
          ? "ignored" as const
          : autoImportSummary.materializedConfigObjectCount > 0
            ? "completed" as const
            : "partial" as const

    const summaryJson = {
      // Inputs
      deliveryId: input.deliveryId,
      headSha: input.headSha,
      installationId: input.installationId,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
      // Outcome
      outcome: eventStatus,
      error: autoImportError,
      autoImportApplied: autoImportSummary?.autoImported ?? false,
      autoImportNewPlugins: autoImportSummary?.autoImportNewPlugins ?? null,
      classification: autoImportSummary?.classification ?? null,
      resolvedSourceRevisionRef: autoImportSummary?.sourceRevisionRef ?? null,
      discoveredPluginCount: autoImportSummary?.discoveredPluginCount ?? 0,
      createdMarketplace: autoImportSummary?.createdMarketplace ?? null,
      createdPluginCount: autoImportSummary?.createdPluginCount ?? 0,
      createdPlugins: autoImportSummary?.createdPlugins ?? [],
      materializedConfigObjectCount: autoImportSummary?.materializedConfigObjectCount ?? 0,
      materializedConfigObjects: autoImportSummary?.materializedConfigObjects ?? [],
      // Timing
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    }

    if (existing[0]) {
      await db.update(ConnectorSyncEventTable).set({
        completedAt,
        externalEventRef: input.deliveryId,
        startedAt,
        status: eventStatus,
        summaryJson,
      }).where(eq(ConnectorSyncEventTable.id, id))
    } else {
      await db.insert(ConnectorSyncEventTable).values({
        completedAt,
        connectorInstanceId: row.instance.id,
        connectorTargetId: row.target.id,
        connectorType: "github",
        eventType: "push",
        externalEventRef: input.deliveryId,
        id,
        organizationId: row.instance.organizationId,
        remoteId: input.repositoryFullName,
        sourceRevisionRef: input.headSha,
        startedAt,
        status: eventStatus,
        summaryJson,
      })
    }
    queuedIds.push(id)
  }

  return queuedIds.length > 0
    ? { accepted: true as const, queued: true as const, syncEventIds: queuedIds }
    : { accepted: false as const, reason: "event ignored" }
}
