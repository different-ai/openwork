import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectTable,
  ConfigObjectVersionTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { appLogger } from "../../observability/logger.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
  queryValidator,
  resolveMemberTeamsMiddleware,
  verifyOrgRole,
} from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { createOAuthStateToken, resolvePublicOrigin, verifyOAuthStateToken } from "../../capability-sources/generic-oauth.js"
import {
  abandonExternalMcpAuth,
  connectExternalMcp,
  completeExternalMcpAuth,
  listExternalMcpTools,
} from "../../capability-sources/external-mcp-client-runtime.js"
import {
  createExternalMcpConnection,
  deleteExternalMcpConnection,
  disconnectExternalMcpConnection,
  externalMcpIdentityBinding,
  getExternalMcpConnection,
  listActiveExternalMcpConnectionBindings,
  listDirectExternalMcpConnectionAccess,
  listExternalMcpConnections,
  listUsableExternalMcpConnections,
  markExternalMcpConnectionConnected,
  memberCanUseExternalMcpConnection,
  normalizeExternalMcpIdentityUrl,
  replaceExternalMcpConnectionAccess,
  updateExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../../capability-sources/external-mcp-connections.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { listNativeProviderUsableEntries } from "../../capability-sources/native-provider-connections.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { getConnectedAccount, getOrgOAuthClient, upsertOrgOAuthClient } from "../../capability-sources/oauth-credentials.js"
import { assertPublicUrl } from "../../capability-sources/url-guard.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { EXTERNAL_MCP_PRESETS } from "../../capability-sources/external-mcp-presets.js"
import {
  EXTERNAL_MCP_DIAGNOSTIC_PHASES,
  externalMcpDiagnosticForLog,
  externalMcpDiagnosticForResponse,
  externalMcpOAuthCallbackError,
  safeExternalMcpEndpointForLog,
} from "../../capability-sources/external-mcp-diagnostics.js"
import { resolvePluginArchResourceRole, type PluginArchActorContext } from "./plugin-system/access.js"
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, idParamSchema, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const connectionParamsSchema = idParamSchema("connectionId", "externalMcpConnection")
const logger = appLogger.child({ component: "mcp_connections" })

const accessInputSchema = z.object({
  orgWide: z.boolean().optional().default(false),
  memberIds: z.array(z.string().trim().min(1)).max(200).optional().default([]),
  teamIds: z.array(z.string().trim().min(1)).max(200).optional().default([]),
}).meta({ ref: "ExternalMcpConnectionAccessInput" })

const externalMcpUrlSchema = z.string().trim().url().max(2048).superRefine((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // The preceding URL refinement owns the user-facing parse error. Zod 4
    // still executes superRefine after that failure, so never throw here.
    return
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    context.addIssue({ code: "custom", message: "MCP URLs must use HTTP or HTTPS." })
  }
  if (url.protocol === "http:" && !env.allowPrivateMcpUrls) {
    context.addIssue({ code: "custom", message: "Hosted MCP connections must use HTTPS." })
  }
  if (url.hash) {
    context.addIssue({ code: "custom", message: "MCP URLs must not contain a fragment." })
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "MCP URLs must not contain embedded credentials." })
  }
  const sensitiveParameters = new Set([
    "access_token",
    "api_key",
    "client_secret",
    "token",
    "refresh_token",
    "id_token",
    "code_verifier",
  ])
  for (const parameter of url.searchParams.keys()) {
    if (sensitiveParameters.has(parameter.toLowerCase())) {
      context.addIssue({ code: "custom", message: `MCP URL query parameter "${parameter}" must not contain credentials.` })
    }
  }
})

const createConnectionBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: externalMcpUrlSchema,
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]).optional().default("shared"),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  oauthClient: z.object({
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
  }).optional(),
  /** Who can USE the connection. Defaults to org-wide so the naive quick-add path matches expectations, but it's an explicit, editable choice. */
  access: accessInputSchema.optional().default({ orgWide: true, memberIds: [], teamIds: [] }),
})

const updateConnectionBodySchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  name: z.string().trim().min(1).max(255),
  url: externalMcpUrlSchema,
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  /** Omitted means preserve only when the connection identity is unchanged. Never returned by any read route. */
  apiKey: z.string().trim().min(1).max(4096).optional(),
  oauthClient: z.object({
    clientId: z.string().trim().min(1).max(512),
    /** Omitted preserves the secret only when both identity and client id are unchanged. */
    clientSecret: z.string().trim().min(1).max(4096).optional(),
  }).optional(),
  access: accessInputSchema,
})

const replaceAccessBodySchema = z.object({
  access: accessInputSchema,
})

const connectionNotFoundSchema = z.object({
  error: z.literal("connection_not_found"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionNotFoundError" })

const connectionConflictSchema = z.object({
  error: z.literal("connection_conflict"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionConflictError" })

const marketplaceManagedSchema = z.object({
  error: z.literal("marketplace_managed"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionMarketplaceManagedError" })

const connectionUpdateConflictSchema = z.union([
  connectionConflictSchema,
  marketplaceManagedSchema,
]).meta({ ref: "ExternalMcpConnectionUpdateConflictError" })

const accessSummarySchema = z.object({
  orgWide: z.boolean(),
  memberIds: z.array(z.string()),
  teamIds: z.array(z.string()),
}).meta({ ref: "ExternalMcpConnectionAccessSummary" })

const requiredBySchema = z.object({
  pluginId: z.string(),
  name: z.string(),
}).meta({ ref: "ExternalMcpConnectionRequiredBy" })

const connectionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  connected: z.boolean(),
  connectedAt: z.string().nullable(),
  updatedAt: z.string().datetime().optional(),
  /** For per_member connections: whether the CALLING member has connected their own account. Always true for connected shared connections. */
  connectedForMe: z.boolean(),
  /** Present on native provider rows when the member's saved grant is missing currently selected scopes. */
  needsReconnect: z.boolean().optional(),
  /** Native provider feature ids whose scopes are missing from the member's saved grant. */
  missingFeatures: z.array(z.string()).optional(),
  /** Native provider account label when the provider supplied one. Never a token. */
  externalAccountId: z.string().nullable().optional(),
  /** Delegated scopes the calling member granted to a native provider. */
  grantedScopes: z.array(z.string()).optional(),
  /** Tenant selected by the admin for tenant-scoped native providers. */
  tenantId: z.string().nullable().optional(),
  /** Marketplace plugins whose declared MCP requirement is bound to this connection. Filtered to the caller's visible plugin names for scope=usable. */
  requiredBy: z.array(requiredBySchema),
  /** Active plugin requirement bindings that own server/authentication identity. Derived server-side. */
  identityManagedBy: z.array(requiredBySchema).optional(),
  /** Present only for scope=manageable (admin) listings. */
  access: accessSummarySchema.nullable(),
  /** Public OAuth client id only. Client secrets and all other credentials are never returned. */
  oauthClientId: z.string().nullable().optional(),
}).meta({ ref: "ExternalMcpConnectionResponse" })

const connectionListResponseSchema = z.object({
  connections: z.array(connectionResponseSchema),
}).meta({ ref: "ExternalMcpConnectionListResponse" })

const connectionToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
}).meta({ ref: "ExternalMcpConnectionToolAnnotations" })

const connectionToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: connectionToolAnnotationsSchema.optional(),
}).meta({ ref: "ExternalMcpConnectionTool" })

const connectionToolListResponseSchema = z.object({
  tools: z.array(connectionToolSchema),
}).meta({ ref: "ExternalMcpConnectionToolListResponse" })

const connectionNotReadySchema = z.object({
  error: z.literal("connection_not_ready"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionNotReadyError" })

const connectionCreatedResponseSchema = connectionResponseSchema.extend({
  links: z.object({
    /** Where members connect their own account for per_member connections. Share this with the team. */
    yourConnections: z.string(),
    /** The exact OAuth redirect URL to whitelist in pre-registered provider apps. */
    oauthCallback: z.string(),
  }),
}).meta({ ref: "ExternalMcpConnectionCreatedResponse" })

const connectionUpdatedResponseSchema = connectionResponseSchema.extend({
  updatedAt: z.string().datetime(),
  identityManagedBy: z.array(requiredBySchema),
  identityChanged: z.boolean(),
  reconnectionRequired: z.boolean(),
}).meta({ ref: "ExternalMcpConnectionUpdatedResponse" })

/**
 * The classical member handoff: after an admin (or their agent) publishes a
 * connection, members connect their own account in the den-web dashboard.
 * betterAuthUrl is the den-web public origin in every deployment layout.
 */
function memberConnectLinks(request: Request, connectionId: string) {
  const yourConnections = new URL("/dashboard/your-connections", env.betterAuthUrl)
  yourConnections.searchParams.set("connectionId", connectionId)
  return {
    yourConnections: yourConnections.toString(),
    oauthCallback: callbackRedirectUri(request, connectionId),
  }
}

export function isAgentApiKeyConnection(input: { authType: string; sessionId?: string | null }) {
  return input.authType === "apikey" && input.sessionId === "mcp_internal"
}

export function isAgentOAuthClientConnection(input: { oauthClient?: unknown; sessionId?: string | null }) {
  return Boolean(input.oauthClient) && input.sessionId === "mcp_internal"
}

const listConnectionsQuerySchema = z.object({
  /** usable (default): connections the calling member has been granted. manageable: every org connection, admin-only. */
  scope: z.enum(["usable", "manageable"]).optional().default("usable"),
})

const presetResponseSchema = z.object({
  presetId: z.string(),
  displayName: z.string(),
  description: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  requiresOAuthClient: z.boolean().optional(),
}).meta({ ref: "ExternalMcpPresetResponse" })

const presetListResponseSchema = z.object({
  presets: z.array(presetResponseSchema),
}).meta({ ref: "ExternalMcpPresetListResponse" })

const connectStartResponseSchema = z.object({
  status: z.enum(["connected", "needs_auth"]),
  authorizeUrl: z.string().nullable(),
}).meta({ ref: "ExternalMcpConnectStartResponse" })

const externalMcpDiagnosticSchema = z.object({
  referenceId: z.string(),
  phase: z.enum(EXTERNAL_MCP_DIAGNOSTIC_PHASES),
  category: z.string(),
  code: z.string(),
  highestPassed: z.enum(["configured", "reachable", "authorized", "protocol_ready", "catalog_ready", "operation_ready"]),
  retryable: z.boolean(),
  actionOwner: z.enum(["openwork", "network_admin", "provider_admin", "organization_admin", "member"]),
  operatorAction: z.string(),
  message: z.string(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  operationPhase: z.enum(EXTERNAL_MCP_DIAGNOSTIC_PHASES).optional(),
  outbound: z.object({
    origin: z.string(),
    pathHash: z.string(),
  }).optional(),
  providerRequestId: z.string().optional(),
  jsonRpcCode: z.number().int().optional(),
}).meta({ ref: "ExternalMcpDiagnostic" })

const connectionToolListFailedSchema = z.object({
  error: z.literal("tool_catalog_failed"),
  message: z.string(),
  diagnostic: externalMcpDiagnosticSchema,
}).meta({ ref: "ExternalMcpConnectionToolListFailedError" })

const connectStartFailedSchema = z.object({
  error: z.literal("oauth_handshake_failed"),
  message: z.string(),
  diagnostic: externalMcpDiagnosticSchema,
}).meta({ ref: "ExternalMcpConnectStartFailedError" })

const connectionValidationFailedSchema = z.object({
  error: z.literal("connection_validation_failed"),
  message: z.string(),
  diagnostic: externalMcpDiagnosticSchema,
}).meta({ ref: "ExternalMcpConnectionValidationFailedError" })

function isConnectionConnected(row: ExternalMcpConnectionRow): boolean {
  if (row.credentialMode === "per_member") {
    // A per_member connection is "published" once created; individual
    // members connect their own accounts (connectedForMe).
    return true
  }
  return Boolean(row.accessToken || row.apiKey || (row.authType === "none" && row.connectedAt))
}

type ConnectionRequiredBy = {
  pluginId: string
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function legacyExternalMcpConnectionIdsFromPayload(payload: Record<string, unknown> | null): string[] {
  const ids = new Set<string>()
  const collect = (value: unknown) => {
    if (!isRecord(value)) return
    if (value.openworkManaged !== "den_external_mcp") return
    if (typeof value.externalMcpConnectionId === "string" && value.externalMcpConnectionId.trim()) {
      ids.add(value.externalMcpConnectionId.trim())
    }
  }

  collect(payload)
  if (payload) {
    for (const key of ["mcpServers", "mcp"]) {
      const container = payload[key]
      if (!isRecord(container)) continue
      for (const value of Object.values(container)) collect(value)
    }
  }
  return [...ids]
}

async function latestMcpVersions(input: {
  configObjectIds: Array<DenTypeId<"configObject">>
  organizationId: DenTypeId<"organization">
}) {
  if (input.configObjectIds.length === 0) return new Map<string, typeof ConfigObjectVersionTable.$inferSelect>()
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.organizationId, input.organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, input.configObjectIds),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const versions = new Map<string, typeof ConfigObjectVersionTable.$inferSelect>()
  for (const row of rows) {
    if (!versions.has(row.configObjectId)) versions.set(row.configObjectId, row)
  }
  return versions
}

async function legacyRequiredByForConnections(input: {
  connectionIds: string[]
  organizationId: DenTypeId<"organization">
}) {
  if (input.connectionIds.length === 0) return []
  const connectionIdSet = new Set(input.connectionIds)
  const rows = await db
    .select({
      configObjectId: ConfigObjectTable.id,
      pluginId: PluginTable.id,
      pluginName: PluginTable.name,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id))
    .innerJoin(PluginTable, eq(PluginConfigObjectTable.pluginId, PluginTable.id))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.objectType, "mcp"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
  const versions = await latestMcpVersions({
    configObjectIds: rows.map((row) => row.configObjectId),
    organizationId: input.organizationId,
  })
  const requiredBy: Array<{ connectionId: string; pluginId: DenTypeId<"plugin">; pluginName: string }> = []
  for (const row of rows) {
    const version = versions.get(row.configObjectId)
    const payload = version?.normalizedPayloadJson ?? parseJsonObject(version?.rawSourceText ?? null)
    for (const connectionId of legacyExternalMcpConnectionIdsFromPayload(payload)) {
      if (connectionIdSet.has(connectionId)) {
        requiredBy.push({ connectionId, pluginId: row.pluginId, pluginName: row.pluginName })
      }
    }
  }
  return requiredBy
}

async function requiredByForConnections(input: {
  context: PluginArchActorContext
  includeAllPluginNames: boolean
  rows: ExternalMcpConnectionRow[]
}): Promise<{
  requiredBy: Map<string, ConnectionRequiredBy[]>
  identityManagedBy: Map<string, ConnectionRequiredBy[]>
}> {
  const connectionIds = input.rows.map((row) => row.id)
  if (connectionIds.length === 0) return { requiredBy: new Map(), identityManagedBy: new Map() }

  const organizationId = input.context.organizationContext.organization.id
  const bindingRows = await listActiveExternalMcpConnectionBindings({ organizationId, connectionIds })
  const legacyRows = await legacyRequiredByForConnections({ connectionIds, organizationId })
  const candidatePluginIds = new Set<DenTypeId<"plugin">>([
    ...bindingRows.map((row) => row.pluginId),
    ...legacyRows.map((row) => row.pluginId),
  ])

  const visiblePluginIds = new Set<string>()
  if (input.includeAllPluginNames) {
    for (const pluginId of candidatePluginIds) visiblePluginIds.add(pluginId)
  } else {
    for (const pluginId of candidatePluginIds) {
      const role = await resolvePluginArchResourceRole({
        context: input.context,
        resourceId: pluginId,
        resourceKind: "plugin",
      })
      if (role) visiblePluginIds.add(pluginId)
    }
  }

  const grouped = new Map<string, Map<string, string>>()
  const identityManaged = new Map<string, Map<string, string>>()
  for (const row of bindingRows) {
    if (!visiblePluginIds.has(row.pluginId)) continue
    let plugins = grouped.get(row.connectionId)
    if (!plugins) {
      plugins = new Map()
      grouped.set(row.connectionId, plugins)
    }
    plugins.set(row.pluginId, row.pluginName)
    let identityPlugins = identityManaged.get(row.connectionId)
    if (!identityPlugins) {
      identityPlugins = new Map()
      identityManaged.set(row.connectionId, identityPlugins)
    }
    identityPlugins.set(row.pluginId, row.pluginName)
  }
  for (const row of legacyRows) {
    if (!visiblePluginIds.has(row.pluginId)) continue
    let plugins = grouped.get(row.connectionId)
    if (!plugins) {
      plugins = new Map()
      grouped.set(row.connectionId, plugins)
    }
    plugins.set(row.pluginId, row.pluginName)
  }

  const result = new Map<string, ConnectionRequiredBy[]>()
  for (const [connectionId, plugins] of grouped) {
    result.set(connectionId, [...plugins].map(([pluginId, name]) => ({ pluginId, name })).sort((left, right) => left.name.localeCompare(right.name)))
  }
  const identityManagedResult = new Map<string, ConnectionRequiredBy[]>()
  for (const [connectionId, plugins] of identityManaged) {
    identityManagedResult.set(connectionId, [...plugins].map(([pluginId, name]) => ({ pluginId, name })).sort((left, right) => left.name.localeCompare(right.name)))
  }
  return { requiredBy: result, identityManagedBy: identityManagedResult }
}

async function toConnectionResponse(
  row: ExternalMcpConnectionRow,
  options: {
    callerOrgMembershipId: DenTypeId<"member">
    includeAccess: boolean
    identityManagedBy: ConnectionRequiredBy[]
    requiredBy: ConnectionRequiredBy[]
  },
) {
  let connectedForMe = isConnectionConnected(row) && row.credentialMode === "shared"
  if (row.credentialMode === "per_member") {
    const account = await getConnectedAccount({
      organizationId: row.organizationId,
      orgMembershipId: options.callerOrgMembershipId,
      providerId: row.id,
    })
    connectedForMe = Boolean(account?.accessToken)
  }

  let access: { orgWide: boolean; memberIds: string[]; teamIds: string[] } | null = null
  if (options.includeAccess) {
    const grants = await listDirectExternalMcpConnectionAccess({
      organizationId: row.organizationId,
      connectionId: row.id,
    })
    access = {
      orgWide: grants.some((grant) => grant.orgWide),
      memberIds: grants.flatMap((grant) => (grant.orgMembershipId ? [grant.orgMembershipId] : [])),
      teamIds: grants.flatMap((grant) => (grant.teamId ? [grant.teamId] : [])),
    }
  }
  const oauthClient = options.includeAccess
    ? await getOrgOAuthClient(row.organizationId, row.id)
    : null

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.authType,
    credentialMode: row.credentialMode,
    connected: isConnectionConnected(row),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    connectedForMe,
    requiredBy: options.requiredBy,
    identityManagedBy: options.identityManagedBy,
    access,
    ...(options.includeAccess ? { oauthClientId: oauthClient?.clientId ?? null } : {}),
  }
}

function callbackRedirectUri(request: Request, connectionId: string) {
  const origin = resolvePublicOrigin(request, env.apiPublicUrl)
  return `${origin}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
}

/**
 * "Add any MCP server" — org-level External MCP Connections. Unlike
 * oauth-providers.ts (one registry entry per native provider we implement
 * ourselves), any org admin can register a connection here by URL; the real
 * OAuth dance (RFC 9728 discovery + dynamic client registration + PKCE) is
 * driven by the MCP SDK itself (capability-sources/external-mcp-client.ts),
 * not a fixed registry entry, since third-party MCP servers don't have a
 * pre-shared client id the way Google Workspace does.
 *
 * Mutation and connect/OAuth routes are tagged Authentication (already
 * blocked from the agent-facing MCP surface, same treatment as
 * oauth-providers.ts) — an agent should never create, delete, or drive the
 * OAuth handshake for a connection itself. Read-only list/status/presets are
 * tagged Capability Sources so a harness can at least see what's connected.
 */
export function registerMcpConnectionRoutes<T extends { Variables: OrgRouteVariables & RequestIdVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-connections/presets",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List predefined External MCP Connection presets",
      description: "Common third-party MCP servers (Notion, Linear, Stripe, Slack, ...) an admin can add with one click, prefilled with a real name and URL.",
      responses: {
        200: jsonResponse("Presets.", presetListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      return c.json({ presets: EXTERNAL_MCP_PRESETS })
    },
  )

  app.get(
    "/v1/mcp-connections",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List External MCP Connections",
      description: "scope=usable (default): connections the calling member has been granted (org-wide, direct, or via a team), with per-member connection status. scope=manageable: every org connection with access summaries — workspace owners and admins only.",
      responses: {
        200: jsonResponse("Connections.", connectionListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("scope=manageable requires a workspace owner or admin.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    queryValidator(listConnectionsQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { scope } = c.req.valid("query")
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const context = { memberTeams, organizationContext: payload, session: c.get("session") } satisfies PluginArchActorContext

      if (scope === "manageable") {
        if (!verifyOrgRole({ roles: ["admin"], userContext: payload.currentMember })) {
          return c.json({ error: "forbidden", message: "Only workspace owners and admins can list all MCP connections." }, 403)
        }
        const rows = await listExternalMcpConnections(payload.organization.id)
        const provenance = await requiredByForConnections({ context, includeAllPluginNames: true, rows })
        const connections = await Promise.all(rows.map((row) =>
          toConnectionResponse(row, {
            callerOrgMembershipId: payload.currentMember.id,
            includeAccess: true,
            requiredBy: provenance.requiredBy.get(row.id) ?? [],
            identityManagedBy: provenance.identityManagedBy.get(row.id) ?? [],
          })))
        return c.json({ connections })
      }

      // Staged rollout: gated deployments return an empty list for
      // non-opted-in orgs — indistinguishable from "nothing published", on
      // every desktop version in the field (see external-mcp-rollout.ts).
      if (!memberFacingMcpConnectionsEnabled(payload.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })) {
        return c.json({ connections: [] })
      }

      const rows = await listUsableExternalMcpConnections({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        teamIds: memberTeams.map((team) => team.id),
      })
      const provenance = await requiredByForConnections({ context, includeAllPluginNames: false, rows })
      const connections = await Promise.all(rows.map((row) =>
        toConnectionResponse(row, {
          callerOrgMembershipId: payload.currentMember.id,
          includeAccess: false,
          requiredBy: provenance.requiredBy.get(row.id) ?? [],
          identityManagedBy: provenance.identityManagedBy.get(row.id) ?? [],
        })))
      // Native providers (e.g. google-workspace) join the same list once the
      // org saved an OAuth client for them — same card, same connect flow,
      // same rollout gate (this sits after the gate check on purpose).
      const nativeEntries = await listNativeProviderUsableEntries({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      return c.json({ connections: [...nativeEntries, ...connections] })
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/tools",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List tools exposed by an External MCP Connection",
      description: "Admin-only. Uses the connection credential owned by Den to read its live MCP tools/list catalog. Credentials and tool calls are never returned.",
      responses: {
        200: jsonResponse("External MCP tool catalog.", connectionToolListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can inspect MCP tools.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        409: jsonResponse("The connection has no usable credential for this member.", connectionNotReadySchema),
        502: jsonResponse("The upstream MCP tool catalog could not be read.", connectionToolListFailedSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can inspect MCP tools.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const member = connection.credentialMode === "per_member"
        ? { orgMembershipId: payload.currentMember.id }
        : undefined
      if (connection.credentialMode === "per_member") {
        const account = await getConnectedAccount({
          organizationId: payload.organization.id,
          orgMembershipId: payload.currentMember.id,
          providerId: connection.id,
        })
        if (!account?.accessToken) {
          return c.json({
            error: "connection_not_ready",
            message: "Connect your account before inspecting this MCP's tools.",
          }, 409)
        }
      } else if (!isConnectionConnected(connection)) {
        return c.json({
          error: "connection_not_ready",
          message: "Connect this MCP before inspecting its tools.",
        }, 409)
      }

      try {
        const tools = await listExternalMcpTools(
          connection,
          callbackRedirectUri(c.req.raw, connectionId),
          member,
          c.get("requestId"),
        )
        return c.json({
          tools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? {
              annotations: {
                ...(tool.annotations.title ? { title: tool.annotations.title } : {}),
                ...(tool.annotations.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
                ...(tool.annotations.destructiveHint !== undefined ? { destructiveHint: tool.annotations.destructiveHint } : {}),
                ...(tool.annotations.idempotentHint !== undefined ? { idempotentHint: tool.annotations.idempotentHint } : {}),
                ...(tool.annotations.openWorldHint !== undefined ? { openWorldHint: tool.annotations.openWorldHint } : {}),
              },
            } : {}),
          })),
        })
      } catch (error) {
        const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "MCP_TOOL_DISCOVERY")
        logger.error("external_mcp_tool_catalog_failed", {
          connection_id: connection.id,
          organization_id: payload.organization.id,
          connection_endpoint: safeExternalMcpEndpointForLog(connection.url),
          ...externalMcpDiagnosticForLog(error, c.get("requestId"), "MCP_TOOL_DISCOVERY"),
        })
        return c.json({
          error: "tool_catalog_failed",
          message: `Could not inspect "${connection.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
          diagnostic,
        }, 502)
      }
    },
  )

  app.post(
    "/v1/mcp-connections",
    describeRoute({
      // Tagged Capability Sources (not Authentication) on purpose: this is
      // plain admin CRUD with no secrets for oauth/none connections, so an
      // org admin can publish connections from chat. The OAuth plumbing
      // (connect/start, callbacks, client secrets) stays agent-blocked.
      tags: ["Capability Sources"],
      summary: "Register a new External MCP Connection for the org",
      description: "Admin-only. Registers a third-party MCP server by name + URL and grants access (org-wide, teams, or members). Use GET /v1/mcp-connections/presets for known server URLs (Notion, Linear, Stripe, Sentry, Slack, Context7). For credentialMode per_member, each member connects their own account afterwards — share links.yourConnections from the response so teammates know where to sign in. For servers with pre-registered OAuth apps, whitelist links.oauthCallback. API-key and OAuth-client credentials cannot be created through the agent surface; use the dashboard.",
      responses: {
        200: jsonResponse("Connection created.", connectionCreatedResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can add MCP connections.", forbiddenSchema),
        502: jsonResponse("The upstream MCP server could not be reached.", connectionValidationFailedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createConnectionBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can add MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const body = c.req.valid("json")
      const sessionId = c.get("session")?.id
      // Secrets must not travel through chat transcripts: when the caller is
      // the agent (internal MCP principal), refuse API-key connections.
      if (isAgentOAuthClientConnection({ oauthClient: body.oauthClient, sessionId })) {
        return c.json({ error: "invalid_request", message: "OAuth client credentials cannot be set from the agent. Add them in the OpenWork Cloud dashboard under Extensions." }, 400)
      }
      if (isAgentApiKeyConnection({ authType: body.authType, sessionId })) {
        return c.json({ error: "invalid_request", message: "API-key connections cannot be created from the agent. Add them in the OpenWork Cloud dashboard under Extensions." }, 400)
      }
      if (body.oauthClient && body.authType !== "oauth") {
        return c.json({ error: "invalid_request", message: "oauthClient is only allowed when authType is oauth." }, 400)
      }
      if (body.authType === "apikey" && !body.apiKey) {
        return c.json({ error: "invalid_request", message: "apiKey is required when authType is apikey." }, 400)
      }
      if (body.credentialMode === "per_member" && body.authType !== "oauth") {
        return c.json({ error: "invalid_request", message: "credentialMode per_member requires authType oauth — API keys and no-auth servers have no per-person identity to connect." }, 400)
      }
      if (!env.allowPrivateMcpUrls) {
        // Fail fast with a clear message; the guarded fetch inside the MCP
        // client re-checks at request time anyway (DNS can change later).
        try {
          await assertPublicUrl(body.url)
        } catch (error) {
          return c.json({ error: "invalid_request", message: error instanceof Error ? error.message : "URL not allowed." }, 400)
        }
      }

      const created = await createExternalMcpConnection({
        organizationId: payload.organization.id,
        name: body.name,
        url: body.url,
        authType: body.authType,
        credentialMode: body.credentialMode,
        apiKey: body.apiKey ?? null,
        createdByOrgMembershipId: payload.currentMember.id,
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
      })

      if (body.oauthClient) {
        await upsertOrgOAuthClient({
          organizationId: payload.organization.id,
          providerId: created.id,
          clientId: body.oauthClient.clientId,
          clientSecret: body.oauthClient.clientSecret ?? null,
          createdByOrgMembershipId: payload.currentMember.id,
        })
      }

      if (body.authType !== "oauth") {
        // No OAuth dance needed — validate the server is real and reachable now.
        try {
          await connectExternalMcp(created, callbackRedirectUri(c.req.raw, created.id), undefined, undefined, c.get("requestId"))
          // OAuth records a successful connection while persisting tokens.
          // A no-auth server has no token write, so retain the successful
          // initialize probe explicitly for readiness and catalog discovery.
          if (body.authType === "none") {
            await markExternalMcpConnectionConnected(created.id)
          }
        } catch (error) {
          const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "MCP_INITIALIZE")
          logger.error("external_mcp_connection_validation_failed", {
            connection_id: created.id,
            organization_id: payload.organization.id,
            connection_endpoint: safeExternalMcpEndpointForLog(created.url),
            ...externalMcpDiagnosticForLog(error, c.get("requestId"), "MCP_INITIALIZE"),
          })
          return c.json({
            error: "connection_validation_failed",
            message: `Could not validate "${created.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
            diagnostic,
          }, 502)
        }
      }

      const refreshed = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: created.id })
      const response = await toConnectionResponse(refreshed ?? created, {
        callerOrgMembershipId: payload.currentMember.id,
        includeAccess: true,
        requiredBy: [],
        identityManagedBy: [],
      })
      // The classical handoff: whoever created this (human or agent) gets
      // the link where members connect their own account, ready to share.
      return c.json({ ...response, links: memberConnectLinks(c.req.raw, created.id) })
    },
  )

  app.put(
    "/v1/mcp-connections/:connectionId",
    describeRoute({
      tags: ["Authentication"],
      summary: "Edit an External MCP Connection",
      description: "Organization-admin-only. Name and direct access changes preserve credentials. URL, authentication type, or credential-mode changes invalidate the old identity atomically. Secret fields are write-only optional replacements and are never returned. expectedUpdatedAt prevents stale edits.",
      responses: {
        200: jsonResponse("Connection updated.", connectionUpdatedResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can edit MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        409: jsonResponse("The edit is stale or changes marketplace-owned identity fields.", connectionUpdateConflictSchema),
        502: jsonResponse("The proposed API-key or no-auth configuration could not be validated.", connectionValidationFailedSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    jsonValidator(updateConnectionBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can edit MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const body = c.req.valid("json")
      const identityChanged = normalizeExternalMcpIdentityUrl(connection.url) !== normalizeExternalMcpIdentityUrl(body.url)
        || connection.authType !== body.authType
        || connection.credentialMode !== body.credentialMode
      const marketplaceOwnedFieldsChanged = connection.url !== body.url
        || connection.authType !== body.authType
        || connection.credentialMode !== body.credentialMode
        || body.apiKey !== undefined
        || body.oauthClient !== undefined
      const activeBindings = await listActiveExternalMcpConnectionBindings({
        organizationId: payload.organization.id,
        connectionIds: [externalMcpConnectionId],
      })
      if (activeBindings.length > 0 && marketplaceOwnedFieldsChanged) {
        const owners = [...new Set(activeBindings.map((binding) => binding.pluginName))].join(", ")
        return c.json({
          error: "marketplace_managed",
          message: `${owners || "A marketplace plugin"} owns this connection's server and authentication settings. Edit those values in the marketplace definition.`,
        }, 409)
      }

      const sessionId = c.get("session")?.id
      if (sessionId === "mcp_internal" && (body.apiKey !== undefined || body.oauthClient !== undefined)) {
        return c.json({
          error: "invalid_request",
          message: "Connection credentials cannot be edited from the agent. Use the OpenWork Cloud dashboard under Connections.",
        }, 400)
      }
      if (body.apiKey !== undefined && body.authType !== "apikey") {
        return c.json({ error: "invalid_request", message: "apiKey is only allowed when authType is apikey." }, 400)
      }
      if (body.oauthClient && body.authType !== "oauth") {
        return c.json({ error: "invalid_request", message: "oauthClient is only allowed when authType is oauth." }, 400)
      }
      if (body.credentialMode === "per_member" && body.authType !== "oauth") {
        return c.json({ error: "invalid_request", message: "credentialMode per_member requires authType oauth — API keys and no-auth servers have no per-person identity to connect." }, 400)
      }

      const apiKey = body.authType === "apikey"
        ? body.apiKey ?? (!identityChanged && connection.authType === "apikey" ? connection.apiKey : null)
        : null
      if (body.authType === "apikey" && !apiKey) {
        return c.json({
          error: "invalid_request",
          message: identityChanged
            ? "A replacement apiKey is required when changing an API-key connection's identity."
            : "This API-key connection has no saved key; provide a replacement apiKey.",
        }, 400)
      }

      if (!env.allowPrivateMcpUrls) {
        try {
          await assertPublicUrl(body.url)
        } catch (error) {
          return c.json({ error: "invalid_request", message: error instanceof Error ? error.message : "URL not allowed." }, 400)
        }
      }

      const shouldValidate = body.authType !== "oauth"
        && (identityChanged || connection.url !== body.url || body.apiKey !== undefined)
      let validatedAt: Date | undefined
      if (shouldValidate) {
        const proposedConnection: ExternalMcpConnectionRow = {
          ...connection,
          name: body.name,
          url: body.url,
          authType: body.authType,
          credentialMode: body.credentialMode,
          apiKey,
          accessToken: identityChanged ? null : connection.accessToken,
          refreshToken: identityChanged ? null : connection.refreshToken,
          tokenType: identityChanged ? null : connection.tokenType,
          scope: identityChanged ? null : connection.scope,
          expiresAt: identityChanged ? null : connection.expiresAt,
          pendingCodeVerifier: identityChanged ? null : connection.pendingCodeVerifier,
          connectedAt: identityChanged ? null : connection.connectedAt,
        }
        try {
          await connectExternalMcp(
            proposedConnection,
            callbackRedirectUri(c.req.raw, connectionId),
            undefined,
            undefined,
            c.get("requestId"),
          )
          validatedAt = new Date()
        } catch (error) {
          const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "MCP_INITIALIZE")
          logger.error("external_mcp_connection_update_validation_failed", {
            connection_id: connection.id,
            organization_id: payload.organization.id,
            connection_endpoint: safeExternalMcpEndpointForLog(body.url),
            ...externalMcpDiagnosticForLog(error, c.get("requestId"), "MCP_INITIALIZE"),
          })
          return c.json({
            error: "connection_validation_failed",
            message: `Could not validate "${body.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
            diagnostic,
          }, 502)
        }
      }

      const result = await updateExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
        expectedUpdatedAt: new Date(body.expectedUpdatedAt),
        name: body.name,
        url: body.url,
        authType: body.authType,
        credentialMode: body.credentialMode,
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        ...(body.oauthClient ? { oauthClient: body.oauthClient } : {}),
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
        updatedByOrgMembershipId: payload.currentMember.id,
        ...(validatedAt ? { validatedAt } : {}),
      })
      if (result.status === "not_found") {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      if (result.status === "conflict") {
        return c.json({
          error: "connection_conflict",
          message: "This connection changed after you opened it. Close the dialog, review the latest settings, and try again.",
        }, 409)
      }
      if (result.status === "marketplace_managed") {
        return c.json({
          error: "marketplace_managed",
          message: "A marketplace plugin now owns this connection's server and authentication settings. Reload before editing.",
        }, 409)
      }

      const context = { memberTeams: [], organizationContext: payload, session: c.get("session") } satisfies PluginArchActorContext
      const provenance = await requiredByForConnections({
        context,
        includeAllPluginNames: true,
        rows: [result.connection],
      })
      const response = await toConnectionResponse(result.connection, {
        callerOrgMembershipId: payload.currentMember.id,
        includeAccess: true,
        requiredBy: provenance.requiredBy.get(result.connection.id) ?? [],
        identityManagedBy: provenance.identityManagedBy.get(result.connection.id) ?? [],
      })
      return c.json({
        ...response,
        identityChanged: result.identityChanged,
        reconnectionRequired: result.reconnectionRequired,
      })
    },
  )

  app.put(
    "/v1/mcp-connections/:connectionId/access",
    describeRoute({
      // Capability Sources (not Authentication): pure grant management, no
      // credentials involved — lets an admin reshape access from chat.
      tags: ["Capability Sources"],
      summary: "Replace who can use an External MCP Connection",
      description: "Admin-only. Full-replace semantics: send the complete desired access set (orgWide, or memberIds + teamIds). Team and member ids come from GET /v1/org.",
      responses: {
        200: jsonResponse("Access updated.", connectionResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can change connection access.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    jsonValidator(replaceAccessBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can change connection access.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const body = c.req.valid("json")
      await replaceExternalMcpConnectionAccess({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
        createdByOrgMembershipId: payload.currentMember.id,
      })
      const provenance = await requiredByForConnections({
        context: { memberTeams: [], organizationContext: payload, session: c.get("session") },
        includeAllPluginNames: true,
        rows: [connection],
      })
      return c.json(await toConnectionResponse(connection, {
        callerOrgMembershipId: payload.currentMember.id,
        includeAccess: true,
        requiredBy: provenance.requiredBy.get(connection.id) ?? [],
        identityManagedBy: provenance.identityManagedBy.get(connection.id) ?? [],
      }))
    },
  )

  app.delete(
    "/v1/mcp-connections/:connectionId",
    describeRoute({
      tags: ["Authentication"],
      summary: "Remove an External MCP Connection",
      responses: {
        200: emptyResponse("Removed."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can remove MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can remove MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const removed = await deleteExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!removed) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      return c.json({ ok: true })
    },
  )

  app.post(
    "/v1/mcp-connections/:connectionId/disconnect",
    describeRoute({
      tags: ["Authentication"],
      summary: "Disconnect (clear credentials for) an External MCP Connection without removing it",
      responses: {
        200: emptyResponse("Disconnected."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can disconnect MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can disconnect MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const removed = await disconnectExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!removed) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      return c.json({ ok: true })
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/connect/start",
    describeRoute({
      tags: ["Authentication"],
      summary: "Begin the OAuth handshake for an External MCP Connection",
      description: "Runs RFC 9728 discovery, dynamic client registration if needed, and returns an authorize URL to redirect the admin's browser to.",
      responses: {
        200: jsonResponse("Authorize URL, or already connected.", connectStartResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        502: jsonResponse("OAuth handshake failed.", connectStartFailedSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      if (connection.credentialMode === "shared") {
        // Connecting a shared credential IS the org-level integration setup —
        // admin-only, like creating the connection itself.
        const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can connect an org-account connection.")
        if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      } else {
        // Per-member: any member GRANTED the connection may connect their own
        // account (that is the whole point); admins may too.
        const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
        const isAdmin = verifyOrgRole({ roles: ["admin"], userContext: payload.currentMember })
        const canUse = await memberCanUseExternalMcpConnection({
          connectionId: externalMcpConnectionId,
          orgMembershipId: payload.currentMember.id,
          teamIds: memberTeams.map((team) => team.id),
        })
        if (!canUse && !isAdmin) {
          return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
        }
      }

      try {
        // Our own signed state token identifies which connection AND which
        // member this is for once the external server redirects back. It MUST
        // travel as the standard OAuth `state` param — a custom param would
        // simply be dropped, since only `state` is guaranteed to round-trip on
        // any spec-compliant authorization server (see ExternalMcpOAuthProvider.state()).
        const signedState = createOAuthStateToken({
          organizationId: payload.organization.id,
          orgMembershipId: payload.currentMember.id,
          providerId: connectionId,
          binding: externalMcpIdentityBinding(connection),
          secret: env.betterAuthSecret,
        })
        const redirectUri = callbackRedirectUri(c.req.raw, connectionId)
        const member = connection.credentialMode === "per_member"
          ? { orgMembershipId: payload.currentMember.id }
          : undefined
        const result = await connectExternalMcp(connection, redirectUri, signedState, member, c.get("requestId"))
        if (result.status === "connected") {
          return c.json({ status: "connected" as const, authorizeUrl: null })
        }
        return c.json({ status: "needs_auth" as const, authorizeUrl: result.authorizeUrl })
      } catch (error) {
        const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "AUTH_RESOURCE_DISCOVERY")
        logger.error("external_mcp_connect_start_oauth_handshake_failed", {
          connection_id: connection.id,
          organization_id: payload.organization.id,
          connection_endpoint: safeExternalMcpEndpointForLog(connection.url),
          ...externalMcpDiagnosticForLog(error, c.get("requestId"), "AUTH_RESOURCE_DISCOVERY"),
        })
        return c.json({
          error: "oauth_handshake_failed",
          message: `Could not connect "${connection.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
          diagnostic,
        }, 502)
      }
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/connect/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "OAuth callback for an External MCP Connection",
      description: "The external MCP server redirects here with code+state after the admin consents. Serves a small static HTML page — the admin's Den tab in the background polls connection status and never needs this response body.",
      responses: {
        200: htmlResponse("Connected — a static success page."),
        400: jsonResponse("Missing or invalid code/state.", invalidRequestSchema),
      },
    }),
    publicRoute,
    paramValidator(connectionParamsSchema),
    async (c) => {
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const url = new URL(c.req.url)
      const state = url.searchParams.get("state")
      if (!state) {
        return c.json({ error: "invalid_request", message: "Missing state." }, 400)
      }

      const statePayload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
      if (!statePayload || statePayload.providerId !== connectionId) {
        return c.json({ error: "invalid_request", message: "Invalid or expired state." }, 400)
      }

      const connection = await getExternalMcpConnection({
        organizationId: statePayload.organizationId,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "invalid_request", message: "Unknown connection." }, 400)
      }
      if (statePayload.binding !== externalMcpIdentityBinding(connection)) {
        return c.json({
          error: "invalid_request",
          message: "This connection changed after authorization started. Start the connection flow again.",
        }, 400)
      }

      const providerErrorCode = url.searchParams.get("error")
      if (providerErrorCode) {
        const callbackError = externalMcpOAuthCallbackError(c.get("requestId"), providerErrorCode)
        const member = connection.credentialMode === "per_member"
          ? { orgMembershipId: statePayload.orgMembershipId }
          : undefined
        try {
          await abandonExternalMcpAuth(connection, state, member, c.get("requestId"))
        } catch (error) {
          logger.error("external_mcp_connect_callback_authorization_cleanup_failed", {
            connection_id: connection.id,
            organization_id: statePayload.organizationId,
            ...externalMcpDiagnosticForLog(error, c.get("requestId"), "AUTH_USER_OR_WORKLOAD"),
          })
        }
        logger.error("external_mcp_connect_callback_authorization_denied", {
          connection_id: connection.id,
          organization_id: statePayload.organizationId,
          ...externalMcpDiagnosticForLog(callbackError, c.get("requestId"), "AUTH_USER_OR_WORKLOAD"),
        })
        return c.html(connectCallbackPage({
          ok: false,
          name: connection.name,
          message: callbackError.diagnostic.message,
          referenceId: callbackError.diagnostic.referenceId,
        }), 400)
      }

      const code = url.searchParams.get("code")
      if (!code) {
        return c.json({ error: "invalid_request", message: "Missing authorization code." }, 400)
      }

      try {
        // For per-member connections, the signed state token (minted at
        // connect/start for the member who initiated) decides whose account
        // the exchanged tokens are saved against.
        const member = connection.credentialMode === "per_member"
          ? { orgMembershipId: statePayload.orgMembershipId }
          : undefined
        await completeExternalMcpAuth(
          connection,
          code,
          callbackRedirectUri(c.req.raw, connectionId),
          member,
          c.get("requestId"),
          state,
        )
      } catch (error) {
        const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "AUTH_TOKEN_ACQUISITION")
        logger.error("external_mcp_connect_callback_token_exchange_failed", {
          connection_id: connection.id,
          organization_id: statePayload.organizationId,
          ...externalMcpDiagnosticForLog(error, c.get("requestId"), "AUTH_TOKEN_ACQUISITION"),
        })
        return c.html(connectCallbackPage({
          ok: false,
          name: connection.name,
          message: diagnostic.message,
          referenceId: diagnostic.referenceId,
        }), 400)
      }
      return c.html(connectCallbackPage({ ok: true, name: connection.name }))
    },
  )
}
