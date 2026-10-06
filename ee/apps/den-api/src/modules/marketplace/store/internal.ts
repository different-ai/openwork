import { and, desc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
  ExternalMcpConnectionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { type PluginArchActorContext, type PluginArchRole, requirePluginArchResourceRole } from "../../../routes/org/plugin-system/access.js"
import { AGENT_PLUGIN_V1_VERSION } from "../../../routes/org/plugin-system/agent-plugin-v1.js"
import { db } from "../../../db.js"
import { redactWorkflowNormalizedPayloadAuthoringDetails } from "../../../workflow-projections.js"
import type { PluginMcpRequirementBindingRow } from "../../../mcp/plugin-mcp-requirement-bindings.js"
import { PluginArchRouteFailure } from "./route-failure.js"
import { authoredMcpAppVersionReadView } from "./object-types/app.js"

export type OrganizationId = PluginArchActorContext["organizationContext"]["organization"]["id"]

export type MemberId = PluginArchActorContext["organizationContext"]["currentMember"]["id"]
export type TeamId = PluginArchActorContext["memberTeams"][number]["id"]
export type ConfigObjectRow = typeof ConfigObjectTable.$inferSelect
export type ConfigObjectVersionRow = typeof ConfigObjectVersionTable.$inferSelect
export type MarketplaceRow = typeof MarketplaceTable.$inferSelect
export type MarketplaceMembershipRow = typeof MarketplacePluginTable.$inferSelect
export type PluginRow = typeof PluginTable.$inferSelect
export type PluginMembershipRow = typeof PluginConfigObjectTable.$inferSelect
export type ConfigObjectId = ConfigObjectRow["id"]
export type ConfigObjectVersionId = ConfigObjectVersionRow["id"]
export type MarketplaceId = MarketplaceRow["id"]
export type MarketplaceMembershipId = MarketplaceMembershipRow["id"]
export type PluginId = PluginRow["id"]
type PluginMembershipId = PluginMembershipRow["id"]
type AccessGrantRow =
  | typeof ConfigObjectAccessGrantTable.$inferSelect
  | typeof MarketplaceAccessGrantTable.$inferSelect
  | typeof PluginAccessGrantTable.$inferSelect
  | typeof ConnectorInstanceAccessGrantTable.$inferSelect
type ConfigObjectAccessGrantId = typeof ConfigObjectAccessGrantTable.$inferSelect.id
type MarketplaceAccessGrantId = typeof MarketplaceAccessGrantTable.$inferSelect.id
export type PluginAccessGrantId = typeof PluginAccessGrantTable.$inferSelect.id
type ConnectorInstanceAccessGrantId = typeof ConnectorInstanceAccessGrantTable.$inferSelect.id
export type ConnectorAccountRow = typeof ConnectorAccountTable.$inferSelect
export type ConnectorInstanceRow = typeof ConnectorInstanceTable.$inferSelect
export type ConnectorTargetRow = typeof ConnectorTargetTable.$inferSelect
export type ConnectorMappingRow = typeof ConnectorMappingTable.$inferSelect
export type ConnectorSyncEventRow = typeof ConnectorSyncEventTable.$inferSelect
export type ConnectorAccountId = ConnectorAccountRow["id"]
export type ConnectorInstanceId = ConnectorInstanceRow["id"]
export type ConnectorTargetId = ConnectorTargetRow["id"]
export type ConnectorMappingId = ConnectorMappingRow["id"]
export type ConnectorSyncEventId = ConnectorSyncEventRow["id"]
type MemberRow = typeof MemberTable.$inferSelect
export type OrganizationRow = typeof OrganizationTable.$inferSelect
export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
export type PluginMcpRequirementBindingId = PluginMcpRequirementBindingRow["id"]
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type CursorPage<TItem extends { id: string }> = {
  items: TItem[]
  nextCursor: string | null
}

export type ConfigObjectInput = {
  metadata?: Record<string, unknown>
  normalizedPayloadJson?: Record<string, unknown>
  parserMode?: string
  rawSourceText?: string
  schemaVersion?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export type AccessGrantWrite = {
  orgMembershipId?: MemberId
  orgWide?: boolean
  role: PluginArchRole
  teamId?: TeamId
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

export type ResourceTarget =
  | ConfigObjectResourceTarget
  | MarketplaceResourceTarget
  | PluginResourceTarget
  | ConnectorInstanceResourceTarget

type ConfigObjectGrantTarget = ConfigObjectResourceTarget & { grantId: ConfigObjectAccessGrantId }
type MarketplaceGrantTarget = MarketplaceResourceTarget & { grantId: MarketplaceAccessGrantId }
type PluginGrantTarget = PluginResourceTarget & { grantId: PluginAccessGrantId }
type ConnectorInstanceGrantTarget = ConnectorInstanceResourceTarget & { grantId: ConnectorInstanceAccessGrantId }
export type GrantTarget = ConfigObjectGrantTarget | MarketplaceGrantTarget | PluginGrantTarget | ConnectorInstanceGrantTarget

export function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function firstTextLine(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? ""
}

export function stripLineDecorators(value: string) {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim()
}

export function pageItems<TItem extends { id: string }>(items: TItem[], cursor: string | undefined, limit: number | undefined): CursorPage<TItem> {
  const ordered = [...items]
  const pageSize = limit ?? 50
  const startIndex = cursor ? Math.max(ordered.findIndex((item) => item.id === cursor) + 1, 0) : 0
  const sliced = ordered.slice(startIndex, startIndex + pageSize)
  const nextCursor = ordered.length > startIndex + pageSize ? sliced[sliced.length - 1]?.id ?? null : null
  return { items: sliced, nextCursor }
}

export async function getLatestVersions(configObjectIds: ConfigObjectId[]) {
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

export function serializeVersion(row: ConfigObjectVersionRow) {
  // Workflow authoring data belongs to the role-aware Workflow management API.
  // Generic config-object reads must not bypass that boundary for viewers.
  const isCodemodeWorkflowVersion = row.schemaVersion === "codemode-script-v1"
  const authoredApp = authoredMcpAppVersionReadView(row)
  return {
    configObjectId: row.configObjectId,
    connectorSyncEventId: row.connectorSyncEventId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdVia: row.createdVia,
    id: row.id,
    isDeletedVersion: row.isDeletedVersion,
    normalizedPayloadJson: authoredApp
      ? authoredApp.normalizedPayloadJson
      : isCodemodeWorkflowVersion
        ? redactWorkflowNormalizedPayloadAuthoringDetails(row.normalizedPayloadJson)
        : row.normalizedPayloadJson,
    rawSourceText: isCodemodeWorkflowVersion || authoredApp ? null : row.rawSourceText,
    schemaVersion: row.schemaVersion,
    sourceRevisionRef: row.sourceRevisionRef,
  }
}

export function serializeConfigObject(row: ConfigObjectRow, latestVersion: ConfigObjectVersionRow | null) {
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

export type PluginMarketplaceSummary = {
  id: string
  name: string
}

export const DEFAULT_OPENWORK_EXTENSION_MANIFESTS = [
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

// Render historical seeded records without re-seeding them or reviving local setup.
const RETIRED_GOOGLE_WORKSPACE_MANIFEST = {
  schemaVersion: 1,
  id: "google-workspace",
  name: "Google Workspace",
  description: "Let OpenWork help with meetings, selected Drive files, and Gmail drafts.",
  source: { format: "openwork-builtin", origin: "builtin", trusted: true },
  icon: { simpleIconSlug: "google" },
  setup: { instructions: "Google Workspace is available through OpenWork Cloud only. Sign in to OpenWork Cloud, then use Settings > Library > Connections to set up your Google Workspace connection. This retired local extension does not connect your account or indicate Cloud connection readiness." },
  resources: [],
  contributions: [
    { type: "setup-instructions", ref: "openwork.googleWorkspace.setup", location: "settings-detail" },
  ],
} as const

export function defaultOpenWorkManifestForPlugin(row: PluginRow) {
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

function serializedPluginSourceFormat(row: PluginRow) {
  switch (row.sourceFormat) {
    case "agent-plugin":
    case "claude-plugin":
    case "manual":
    case "mcp-directory":
    case "opencode-plugin":
    case "openwork-extension-manifest":
      return row.sourceFormat
    default:
      return "claude-plugin" as const
  }
}

function serializePluginExtension(row: PluginRow, componentCounts: Record<string, number>) {
  const builtInManifest = row.name === RETIRED_GOOGLE_WORKSPACE_MANIFEST.name && row.description === RETIRED_GOOGLE_WORKSPACE_MANIFEST.description
    ? RETIRED_GOOGLE_WORKSPACE_MANIFEST
    : defaultOpenWorkManifestForPlugin(row)
  if (builtInManifest) {
    return {
      description: builtInManifest.description,
      id: builtInManifest.id,
      manifest: builtInManifest,
      name: builtInManifest.name,
      sourceFormat: "openwork-builtin",
    }
  }

  const sourceFormat = serializedPluginSourceFormat(row)
  const agentPlugin = sourceFormat === "agent-plugin"
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
        ref: agentPlugin ? "den.agentPlugin.setup" : "den.claudePlugin.setup",
        label: agentPlugin ? "Agent Plugin import" : "Claude-compatible plugin import",
        location: "settings-detail",
      }],
      setup: {
        instructions: agentPlugin
          ? `Imported from Agent Plugins ${row.sourceSchemaVersion ?? AGENT_PLUGIN_V1_VERSION}. OpenWork installs supported skills and remote MCP resources into this workspace.`
          : "Imported from a Claude-compatible plugin. OpenWork installs its resources into this workspace as extension components.",
      },
      lifecycle: {
        detection: Object.keys(componentCounts).map((objectType) => `${objectType}:${row.id}`),
      },
    },
    name: row.name,
    sourceFormat,
  }
}

export function serializePlugin(row: PluginRow, memberCount?: number, marketplaces: PluginMarketplaceSummary[] = [], componentCounts: Record<string, number> = {}) {
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
    sourceRepositoryUrl: row.sourceRepositoryUrl,
    sourceFormat: row.sourceFormat ?? null,
    sourceSchemaVersion: row.sourceSchemaVersion ?? null,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeMarketplace(row: MarketplaceRow, pluginCount?: number) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    externalKey: row.externalKey,
    logoUrl: row.logoUrl,
    name: row.name,
    organizationId: row.organizationId,
    pluginCount,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeMembership(row: PluginMembershipRow, configObject?: ReturnType<typeof serializeConfigObject>) {
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

export function serializeMarketplaceMembership(row: MarketplaceMembershipRow, plugin?: ReturnType<typeof serializePlugin>) {
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

export function serializeAccessGrant(row: AccessGrantRow) {
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

export async function getConfigObjectRow(organizationId: OrganizationId, configObjectId: ConfigObjectId) {
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

export async function findMarketplaceByExternalKey(context: PluginArchActorContext, externalKey: string) {
  const [row] = await db.select().from(MarketplaceTable).where(and(
    eq(MarketplaceTable.organizationId, context.organizationContext.organization.id),
    eq(MarketplaceTable.externalKey, externalKey),
  )).limit(1)
  return row
}

async function getMarketplaceRow(organizationId: OrganizationId, marketplaceId: MarketplaceId) {
  const rows = await db
    .select()
    .from(MarketplaceTable)
    .where(and(eq(MarketplaceTable.organizationId, organizationId), eq(MarketplaceTable.id, marketplaceId)))
    .limit(1)

  return rows[0] ?? null
}

export async function getConnectorInstanceRow(organizationId: OrganizationId, connectorInstanceId: ConnectorInstanceId) {
  const rows = await db
    .select()
    .from(ConnectorInstanceTable)
    .where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.id, connectorInstanceId)))
    .limit(1)

  return rows[0] ?? null
}

// Verifies the target resource exists AND belongs to the caller's active
// organization, returning 404 otherwise. This must run before any role check on
// access-grant endpoints: resolvePluginArchResourceRole short-circuits to
// "manager" for org admins without binding the resource to the org, so without
// this guard an admin in org A could read/add/revoke grants on org B resources
// by supplying a foreign resourceId.
export async function ensureResourceInOrganization(context: PluginArchActorContext, target: ResourceTarget) {
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
export async function ensureGrantTargetsInOrganization(context: PluginArchActorContext, value: AccessGrantWrite) {
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

export async function ensureVisibleConfigObject(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const row = await getConfigObjectRow(context.organizationContext.organization.id, configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "config_object", role: "viewer" })
  return row
}

export async function ensureEditablePlugin(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await getPluginRow(context.organizationContext.organization.id, pluginId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
  }
  await requirePluginArchResourceRole({
    context,
    resourceId: row.id,
    resourceKind: "plugin",
    role: "editor",
  })
  return row
}

export async function ensureEditableMarketplace(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await getMarketplaceRow(context.organizationContext.organization.id, marketplaceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "marketplace", role: "editor" })
  return row
}

export async function ensureVisibleMarketplace(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await getMarketplaceRow(context.organizationContext.organization.id, marketplaceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "marketplace", role: "viewer" })
  return row
}

export async function ensureVisiblePlugin(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await getPluginRow(context.organizationContext.organization.id, pluginId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "plugin", role: "viewer" })
  return row
}

export async function upsertGrant(input: ResourceTarget & {
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

export async function removeGrant(input: GrantTarget & { context: PluginArchActorContext }) {
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
