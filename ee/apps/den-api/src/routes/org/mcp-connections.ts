import { createHash } from "node:crypto"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { RequestIdVariables } from "hono/request-id"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  discoverConnectionRequirements,
  EnterpriseMcpOAuthContractError,
  selectRecoverableAuthorizationServerIssuer,
  validateMcpAuthorizationResponseIssuer,
} from "@openwork/enterprise-mcp-client"
import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MemberTable,
  PluginConfigObjectTable,
  PluginTable,
  type ExternalMcpOAuthConfiguration,
  type ExternalMcpToolPolicy,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { appLogger } from "../../observability/logger.js"
import { ORGANIZATION_SUPER_ADMIN_ROLE, organizationRoleValueSatisfies } from "../../organization-role-hierarchy.js"
import {
  jsonValidator,
  orgMemberRoute,
  orgRoleRoute,
  paramValidator,
  publicRoute,
  queryValidator,
  resolveMemberTeamsMiddleware,
  verifyOrgRole,
} from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { createOAuthStateToken, verifyOAuthStateToken } from "../../capability-sources/generic-oauth.js"
import { matchesLegacyExternalMcpOAuthStateIdentityBinding } from "../../capability-sources/external-mcp-oauth-state-identity.js"
import {
  abandonLegacyExternalMcpAuth,
  abandonExternalMcpAuth,
  completeLegacyExternalMcpAuth,
  connectExternalMcp,
  completeExternalMcpAuth,
  inspectExternalMcpToolCall,
  listExternalMcpTools,
} from "../../capability-sources/external-mcp-client-runtime.js"
import {
  confirmExternalMcpIssuerReview,
  createExternalMcpConnection,
  deleteExternalMcpConnection,
  disconnectExternalMcpConnection,
  disconnectExternalMcpMemberAccount,
  externalMcpIdentityBinding,
  getExternalMcpConnection,
  listActiveExternalMcpConnectionBindings,
  listDirectExternalMcpConnectionAccess,
  listExternalMcpConnections,
  listVisibleExternalMcpConnections,
  markExternalMcpConnectionConnected,
  markExternalMcpOAuthIssuerReviewRequired,
  memberCanUseExternalMcpConnection,
  normalizeExternalMcpIdentityUrl,
  repairExternalMcpIssuerConfiguration,
  replaceExternalMcpConnectionAccess,
  setExternalMcpConnectionToolPolicy,
  updateExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../../capability-sources/external-mcp-connections.js"
import { evaluateToolPolicy } from "../../capability-sources/external-mcp-tool-policy.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { externalMcpAppResourceUri } from "../../mcp/external-capabilities.js"
import { EXECUTE_CAPABILITY_TOOL_NAME, SEARCH_CAPABILITIES_TOOL_NAME } from "../../mcp/search.js"
import { listNativeProviderUsableEntries } from "../../capability-sources/native-provider-connections.js"
import { getNativeOAuthProvider } from "../../capability-sources/provider-registry.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { getConnectedAccount, getOrgOAuthClient, upsertOrgOAuthClient } from "../../capability-sources/oauth-credentials.js"
import { assertPublicUrl, createGuardedFetch, createRealmSafeFetch } from "../../capability-sources/url-guard.js"
import {
  externalMcpCallbackUrl,
  externalMcpCompatibleCallbackUrl,
  externalMcpClientMetadataUrl,
  externalMcpSharedCallbackUrl,
} from "../../capability-sources/external-mcp-oauth-contract.js"
import type { MemberTeamSummary } from "../../orgs.js"
import {
  EXTERNAL_MCP_PRESETS,
  externalMcpPresetListResponseSchema,
  externalMcpPresetResponseSchema,
} from "../../capability-sources/external-mcp-presets.js"
import {
  MAX_RESOLVE_QUERY_LENGTH,
  classifyResolveQuery,
  discoveryQualifiesAsMcp,
  matchPresetForQuery,
  resolveCandidateUrls,
  suggestConnectionName,
} from "../../capability-sources/external-mcp-resolve.js"
import {
  externalMcpOAuthConfigurationDefaults,
  pluginMcpRequiresPreRegisteredOAuthClient,
  requiredPluginMcpAuthType,
} from "../../capability-sources/external-mcp-auth-policy.js"
import {
  EXTERNAL_MCP_DIAGNOSTIC_PHASES,
  externalMcpDiagnosticForLog,
  externalMcpDiagnosticForResponse,
  externalMcpOAuthCallbackError,
  safeExternalMcpEndpointForLog,
} from "../../capability-sources/external-mcp-diagnostics.js"
import {
  diagnoseExternalMcpToolCall,
  externalMcpToolCallInspectionForError,
} from "../../capability-sources/external-mcp-tool-inspection.js"
import { resolvePluginArchResourceRole, type PluginArchActorContext } from "./plugin-system/access.js"
import {
  ensureOrganizationAdmin,
  ensureOrganizationAdminRole,
  getFreshPrivilegedSessionRequiredResponse,
  hasFreshPrivilegedSession,
  idParamSchema,
  orgAccessFailureStatus,
} from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"
import { beginNativeProviderConnect } from "./oauth-providers.js"

const connectionParamsSchema = idParamSchema("connectionId", "externalMcpConnection")
const logger = appLogger.child({ component: "mcp_connections" })

// The App-host gateway never exposes its bounded search/execute tools as apps.
const PROXY_GATEWAY_TOOL_NAMES = new Set([SEARCH_CAPABILITIES_TOOL_NAME, EXECUTE_CAPABILITY_TOOL_NAME])

/**
 * Mirrors the Desktop private App-host naming so Dashboard elements carry the
 * same reference shape desktop entries use (`connectMcpAppHostName` in
 * `apps/server/src/connect-mcp-server-catalog.ts` and `projectedMcpToolName`
 * in `apps/server/src/mcp-app-host.ts`). Connect launches resolve by
 * connection reference, so these names are display and reference data only;
 * drift cannot break a launch.
 */
const CONNECT_MCP_APP_HOST_NAME_PREFIX = "openwork-app-host-connect-"

export function connectMcpAppHostServerName(connectionId: string): string {
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 12)
  return `${CONNECT_MCP_APP_HOST_NAME_PREFIX}${digest}`
}

export function projectedMcpToolName(serverName: string, toolName: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `${sanitize(serverName)}_${sanitize(toolName)}`
}

/** Mirrors the App-host proxy's app-audience visibility rule. */
export function mcpToolVisibleToApp(tool: { _meta?: unknown }): boolean {
  const meta = isRecord(tool._meta) ? tool._meta : {}
  const ui = isRecord(meta.ui) ? meta.ui : {}
  if (ui.visibility === undefined) return true
  return Array.isArray(ui.visibility)
    && ui.visibility.every((entry) => entry === "model" || entry === "app")
    && ui.visibility.includes("app")
}

/** True when the launch tool declares required input, so a tile cannot start it with empty arguments. */
export function mcpToolRequiresInput(tool: { inputSchema?: unknown }): boolean {
  const schema: unknown = tool.inputSchema
  if (!isRecord(schema)) return false
  return Array.isArray(schema.required) && schema.required.length > 0
}
const MANUAL_MCP_TOOL_REQUEST_MAX_BYTES = 1024 * 1024
const externalMcpDiscoveryFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()

// Smart-resolve probes several candidate endpoints concurrently, so each one
// gets a tighter deadline than a single-URL discovery.
const MCP_RESOLVE_PROBE_TIMEOUT_MS = 8_000

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

const discoverConnectionBodySchema = z.object({
  url: externalMcpUrlSchema,
}).meta({ ref: "ExternalMcpRequirementsDiscoveryInput" })

const requirementsDiscoveryResponseSchema = z.object({
  status: z.enum(["ready", "manual_action_required", "unsupported", "unreachable"]),
  server: z.object({
    url: z.string(),
    protocolVersion: z.string().optional(),
    initialize: z.enum(["succeeded", "authentication_required", "failed"]),
  }),
  authentication: z.object({
    kind: z.enum(["none", "oauth", "manual_bearer", "unknown"]),
    resource: z.string().optional(),
    protectedResourceMetadataUrl: z.string().optional(),
    authorizationServers: z.array(z.object({
      issuer: z.string(),
      authorizationEndpoint: z.string().optional(),
      tokenEndpoint: z.string().optional(),
      registrationEndpoint: z.string().optional(),
      clientIdMetadataDocumentSupported: z.boolean(),
      scopesSupported: z.array(z.string()).optional(),
      grantTypesSupported: z.array(z.string()).optional(),
      codeChallengeMethodsSupported: z.array(z.string()).optional(),
      tokenEndpointAuthMethodsSupported: z.array(z.string()).optional(),
    })),
    requiredScopes: z.array(z.string()),
    recommendedScopes: z.array(z.string()),
    refreshSupport: z.enum(["supported", "not_advertised", "unknown"]),
    availableRegistrationMethods: z.array(z.enum(["pre_registered", "client_metadata", "dynamic"])),
    recommendedRegistrationMethod: z.enum(["client_metadata", "dynamic", "pre_registered"]),
  }),
  tools: z.object({
    visibility: z.enum(["available_without_auth", "requires_auth", "unavailable"]),
    count: z.number().int().nonnegative().optional(),
    items: z.array(z.object({
      name: z.string(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })).optional(),
  }),
  manualRequirements: z.array(z.object({
    code: z.string(),
    label: z.string(),
    reason: z.string(),
    required: z.boolean(),
  })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
}).meta({ ref: "ExternalMcpRequirementsDiscovery" })

const requirementsDiscoveryFailedSchema = z.object({
  error: z.literal("requirements_discovery_failed"),
  message: z.string(),
}).meta({ ref: "ExternalMcpRequirementsDiscoveryFailedError" })

const issuerReviewBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview") }),
  z.object({
    action: z.literal("confirm"),
    expectedUpdatedAt: z.string().datetime(),
    authorizationServerIssuer: z.string().trim().url(),
  }),
]).meta({ ref: "ExternalMcpIssuerReviewInput" })

const issuerReviewResponseSchema = z.object({
  currentIssuer: z.string().nullable(),
  advertisedIssuers: z.array(z.string()),
  reviewRequired: z.boolean(),
  issuerChanged: z.boolean().optional(),
  reconnectionRequired: z.boolean().optional(),
  updatedAt: z.string().datetime().optional(),
}).meta({ ref: "ExternalMcpIssuerReviewResponse" })

const clientMetadataResponseSchema = z.object({
  client_id: z.string(),
  client_name: z.literal("OpenWork"),
  application_type: z.literal("web"),
  redirect_uris: z.array(z.string()).length(1),
  grant_types: z.tuple([z.literal("authorization_code"), z.literal("refresh_token")]),
  response_types: z.tuple([z.literal("code")]),
  token_endpoint_auth_method: z.literal("none"),
}).meta({ ref: "ExternalMcpClientMetadata" })

const createExternalConnectionBodySchema = z.object({
  kind: z.literal("external_mcp").optional(),
  name: z.string().trim().min(1).max(255),
  url: externalMcpUrlSchema,
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]).optional().default("shared"),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  oauthClient: z.object({
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
  }).optional(),
  authorizationServerIssuer: z.string().trim().url().max(2048).nullable().optional(),
  requestedScopes: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
  /** Who can USE the connection. Defaults to org-wide so the naive quick-add path matches expectations, but it's an explicit, editable choice. */
  access: accessInputSchema.optional().default({ orgWide: true, memberIds: [], teamIds: [] }),
})

const createNativeProviderConnectionBodySchema = z.object({
  kind: z.literal("native_provider"),
  nativeProviderKey: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  oauthClient: z.object({
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
    features: z.array(z.string().trim().min(1).max(128)).optional(),
  }),
})

const createConnectionBodySchema = z.union([
  createNativeProviderConnectionBodySchema,
  createExternalConnectionBodySchema,
])

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
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
  }).optional(),
  authorizationServerIssuer: z.string().trim().url().max(2048).nullable().optional(),
  requestedScopes: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
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
  /** Safe creator display label for admin/manageable rows. */
  createdByName: z.string().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
  /** For per_member connections: whether the CALLING member has connected their own account. Always true for connected shared connections. */
  connectedForMe: z.boolean(),
  /** Present on native provider rows when the member's saved grant is missing currently selected scopes. */
  needsReconnect: z.boolean().optional(),
  credentialHealth: z.enum(["unknown", "ready", "reconnect_required"]).optional(),
  credentialHealthReason: z.enum([
    "authorization_rejected",
    "credential_expired",
    "post_authorization_validation_failed",
  ]).nullable().optional(),
  credentialHealthCheckedAt: z.string().datetime().nullable().optional(),
  issuerReviewRequired: z.boolean().optional(),
  reconnectActionOwner: z.enum(["member", "organization_admin"]).nullable().optional(),
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
  /** Server-owned marketplace authentication policy; safe in both usable and manageable scopes. */
  requiredAuthType: z.enum(["oauth", "apikey", "none"]).nullable().optional(),
  authPolicyConfirmed: z.boolean().optional(),
  authTypeMismatch: z.boolean().optional(),
  oauthClientConfigured: z.boolean().optional(),
  oauthClientRequired: z.boolean().optional(),
  setupRequired: z.boolean().optional(),
  /** Present only for scope=manageable (admin) listings. */
  access: accessSummarySchema.nullable(),
  /** Public OAuth client id only. Client secrets and all other credentials are never returned. */
  oauthClientId: z.string().nullable().optional(),
  oauthCallbackUrl: z.string().nullable().optional(),
  oauthSharedCallbackUrl: z.string().nullable().optional(),
  oauthClientMetadataUrl: z.string().nullable().optional(),
  oauthCallbackMode: z.enum(["shared-v1", "isolated-v1", "legacy-v1"]).nullable().optional(),
  oauthRegistrationSource: z.enum(["pre-registered", "client-metadata", "dynamic"]).nullable().optional(),
  authorizationServerIssuer: z.string().nullable().optional(),
  requestedScopes: z.array(z.string()).optional(),
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

const connectionToolPolicySchema = z.object({
  allDisabled: z.boolean(),
  disabledTools: z.array(z.string()),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
}).meta({ ref: "ExternalMcpConnectionToolPolicy" })

const connectionToolPolicyInputSchema = z.object({
  allDisabled: z.boolean(),
  disabledTools: z.array(z.string().trim().min(1).max(255)).max(500),
}).meta({ ref: "ExternalMcpConnectionToolPolicyInput" })

const connectionToolPolicyResponseSchema = z.object({
  policy: connectionToolPolicySchema,
}).meta({ ref: "ExternalMcpConnectionToolPolicyResponse" })

const connectionToolListResponseSchema = z.object({
  tools: z.array(connectionToolSchema),
  policy: connectionToolPolicySchema,
}).meta({ ref: "ExternalMcpConnectionToolListResponse" })

const connectionMcpAppSchema = z.object({
  serverName: z.string(),
  connectionId: z.string(),
  toolName: z.string(),
  projectedToolName: z.string(),
  resourceUri: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  requiresInput: z.boolean(),
  requiresApproval: z.boolean(),
}).meta({ ref: "ExternalMcpConnectionMcpApp" })

const connectionMcpAppListResponseSchema = z.object({
  apps: z.array(connectionMcpAppSchema),
}).meta({ ref: "ExternalMcpConnectionMcpAppListResponse" })

const runConnectionToolBodySchema = z.object({
  toolName: z.string().trim().min(1).max(255),
  arguments: z.record(z.string(), z.unknown()),
}).meta({ ref: "ExternalMcpConnectionToolRunInput" })

const connectionToolInspectionHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
  redacted: z.boolean(),
}).meta({ ref: "ExternalMcpConnectionToolInspectionHeader" })

const connectionToolInspectionBodySchema = z.object({
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  unavailable: z.boolean().optional(),
}).meta({ ref: "ExternalMcpConnectionToolInspectionBody" })

const connectionToolInspectionRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  startedAt: z.string().datetime(),
  headers: z.array(connectionToolInspectionHeaderSchema),
  body: connectionToolInspectionBodySchema,
}).meta({ ref: "ExternalMcpConnectionToolInspectionRequest" })

const connectionToolInspectionResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string(),
  durationMs: z.number().nonnegative(),
  headers: z.array(connectionToolInspectionHeaderSchema),
  body: connectionToolInspectionBodySchema,
}).meta({ ref: "ExternalMcpConnectionToolInspectionResponse" })

const connectionToolInspectionDiagnosisSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  layer: z.enum(["openwork", "network", "mcp_connection", "remote_http", "mcp_tool"]),
  summary: z.string(),
}).meta({ ref: "ExternalMcpConnectionToolInspectionDiagnosis" })

const connectionToolInspectionSchema = z.object({
  request: connectionToolInspectionRequestSchema.optional(),
  response: connectionToolInspectionResponseSchema.optional(),
  diagnosis: connectionToolInspectionDiagnosisSchema,
}).meta({ ref: "ExternalMcpConnectionToolInspection" })

const connectionToolRunResponseSchema = z.object({
  referenceId: z.string(),
  durationMs: z.number().nonnegative(),
  result: z.unknown(),
  inspection: connectionToolInspectionSchema,
}).meta({ ref: "ExternalMcpConnectionToolRunResponse" })

const connectionNotReadySchema = z.object({
  error: z.literal("connection_not_ready"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionNotReadyError" })

const connectionToolPolicyBlockedSchema = z.object({
  error: z.literal("policy_blocked"),
  message: z.string(),
  disabledBy: z.string().nullable(),
  disabledAt: z.string().datetime().nullable(),
}).meta({ ref: "ExternalMcpConnectionToolPolicyBlockedError" })

const connectionToolRunForbiddenSchema = z.union([
  forbiddenSchema,
  connectionToolPolicyBlockedSchema,
]).meta({ ref: "ExternalMcpConnectionToolRunForbiddenError" })

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
function memberConnectLinks(connection: ExternalMcpConnectionRow) {
  const yourConnections = new URL("/dashboard/your-connections", env.betterAuthUrl)
  yourConnections.searchParams.set("connectionId", connection.id)
  return {
    yourConnections: yourConnections.toString(),
    oauthCallback: connection.kind === "native_provider" && connection.nativeProviderKey
      ? nativeProviderCallbackUrl(connection.nativeProviderKey)
      : callbackRedirectUriWithClient(connection, null),
  }
}

function nativeProviderCallbackUrl(nativeProviderKey: string) {
  const baseUrl = env.apiPublicUrl ?? env.betterAuthUrl
  return new URL(`/v1/oauth-providers/${encodeURIComponent(nativeProviderKey)}/connect/callback`, baseUrl).toString()
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

const resolveConnectionBodySchema = z.object({
  /** Free-form: a full URL, a bare host, or a product name like "vercel". */
  query: z.string().min(1).max(MAX_RESOLVE_QUERY_LENGTH),
}).meta({ ref: "ExternalMcpResolveInput" })

const resolveConnectionResponseSchema = z.object({
  resolution: z.enum(["preset", "discovered", "not_found"]),
  /** Candidate endpoint URLs that were probed, in preference order. */
  attempted: z.array(z.string()),
  /** Why the query produced no candidates (only for not_found). */
  reason: z.string().optional(),
  preset: externalMcpPresetResponseSchema.optional(),
  match: z.object({
    url: z.string(),
    suggestedName: z.string(),
    discovery: requirementsDiscoveryResponseSchema,
  }).optional(),
}).meta({ ref: "ExternalMcpResolveResult" })

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
  providerStatus: z.number().int().optional(),
  providerCode: z.string().optional(),
  payloadBytes: z.number().int().optional(),
  jsonRpcCode: z.number().int().optional(),
  connectUrl: z.string().url().optional(),
}).meta({ ref: "ExternalMcpDiagnostic" })

const connectionToolListFailedSchema = z.object({
  error: z.literal("tool_catalog_failed"),
  message: z.string(),
  diagnostic: externalMcpDiagnosticSchema,
}).meta({ ref: "ExternalMcpConnectionToolListFailedError" })

const connectionToolRunFailedSchema = z.object({
  error: z.literal("tool_execution_failed"),
  message: z.string(),
  diagnostic: externalMcpDiagnosticSchema,
  inspection: connectionToolInspectionSchema,
}).meta({ ref: "ExternalMcpConnectionToolRunFailedError" })

const connectionToolRequestTooLargeSchema = z.object({
  error: z.literal("payload_too_large"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionToolRequestTooLargeError" })

const connectStartFailedSchema = z.object({
  error: z.literal("oauth_handshake_failed"),
  message: z.string(),
  diagnostic: externalMcpDiagnosticSchema,
}).meta({ ref: "ExternalMcpConnectStartFailedError" })

const oauthConfigurationRequiredSchema = z.object({
  error: z.literal("mcp_oauth_configuration_required"),
  message: z.string(),
  callbackUrl: z.string(),
  clientMetadataUrl: z.string(),
  manualRequirements: z.array(z.string()),
}).meta({ ref: "ExternalMcpOAuthConfigurationRequiredError" })

const oauthIssuerMismatchSchema = z.object({
  error: z.literal("mcp_oauth_issuer_mismatch"),
  message: z.string(),
}).meta({ ref: "ExternalMcpOAuthIssuerMismatchError" })

const connectStartConflictSchema = z.union([
  oauthConfigurationRequiredSchema,
  oauthIssuerMismatchSchema,
]).meta({ ref: "ExternalMcpConnectStartConflictError" })

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

async function connectedAccountStateForConnection(input: {
  organizationId: DenTypeId<"organization">
  providerId: DenTypeId<"externalMcpConnection">
}): Promise<{ connected: boolean; connectedAt: Date | null }> {
  const rows = await db
    .select({ accessToken: ConnectedAccountTable.accessToken, connectedAt: ConnectedAccountTable.connectedAt })
    .from(ConnectedAccountTable)
    .where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, input.providerId),
    ))
  const connectedRows = rows.filter((row) => Boolean(row.accessToken))
  const connectedAt = connectedRows
    .map((row) => row.connectedAt)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null
  return { connected: connectedRows.length > 0, connectedAt }
}

type ExternalMcpToolCredentialContext =
  | { ok: true; member?: { orgMembershipId: DenTypeId<"member"> } }
  | { ok: false; message: string }

async function resolveExternalMcpToolCredential(
  connection: ExternalMcpConnectionRow,
  orgMembershipId: DenTypeId<"member">,
): Promise<ExternalMcpToolCredentialContext> {
  if (connection.oauthIssuerReviewRequiredAt) {
    return {
      ok: false,
      message: "A workspace admin must review this MCP connection's changed OAuth issuer before its tools can be used.",
    }
  }
  if (connection.credentialMode === "per_member") {
    const account = await getConnectedAccount({
      organizationId: connection.organizationId,
      orgMembershipId,
      providerId: connection.id,
    })
    return account?.accessToken
      ? { ok: true, member: { orgMembershipId } }
      : { ok: false, message: "Connect your account before using this MCP's tools." }
  }

  return isConnectionConnected(connection)
    ? { ok: true }
    : { ok: false, message: "Connect this MCP before using its tools." }
}

type ConnectionRequiredBy = {
  pluginId: string
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function oauthAuthorizationServerMetadata(connection: ExternalMcpConnectionRow): Record<string, unknown> | undefined {
  const discovery = connection.oauthConfiguration?.discovery
  if (!isRecord(discovery) || !isRecord(discovery.authorizationServerMetadata)) return undefined
  return discovery.authorizationServerMetadata
}

function usesPinnedSharedOAuthCallback(connection: ExternalMcpConnectionRow): boolean {
  const metadata = oauthAuthorizationServerMetadata(connection)
  return connection.oauthConfiguration?.callbackMode === "shared-v1"
    && metadata !== undefined
    && metadata.authorization_response_iss_parameter_supported !== true
}

function authorizationResponseIssuerRequired(connection: ExternalMcpConnectionRow): boolean | undefined {
  const metadata = oauthAuthorizationServerMetadata(connection)
  return metadata === undefined
    ? undefined
    : metadata.authorization_response_iss_parameter_supported === true
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

function tokenEndpointAuthMethod(value: unknown): "client_secret_basic" | "client_secret_post" | undefined {
  return value === "client_secret_basic" || value === "client_secret_post" ? value : undefined
}

function resolveCreatorName(context: PluginArchActorContext["organizationContext"], memberId: string): string | null {
  const member = context.members.find((entry) => entry.id === memberId)
  return member?.user.name.trim() || member?.user.email || null
}

/**
 * Display names only — never an email fallback: this label reaches non-admin
 * members through the tools endpoint and agent policy_blocked errors.
 */
function resolvePolicyEditorLabel(context: PluginArchActorContext["organizationContext"], memberId: string): string | null {
  const member = context.members.find((entry) => entry.id === memberId)
  return member?.user.name.trim() || null
}

function toToolPolicyResponse(
  policy: ExternalMcpToolPolicy | null | undefined,
  options: { includeAttribution: boolean },
) {
  return {
    allDisabled: policy?.allDisabled ?? false,
    disabledTools: policy?.disabledTools ?? [],
    updatedBy: options.includeAttribution ? policy?.updatedByName ?? null : null,
    updatedAt: policy?.updatedAt ?? null,
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
  requiredAuthTypes: Map<string, Set<"apikey" | "none" | "oauth">>
}> {
  const connectionIds = input.rows.map((row) => row.id)
  if (connectionIds.length === 0) return { requiredBy: new Map(), identityManagedBy: new Map(), requiredAuthTypes: new Map() }

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
  const requiredAuthTypes = new Map<string, Set<"apikey" | "none" | "oauth">>()
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
    if (row.requiredAuthType) {
      const values = requiredAuthTypes.get(row.connectionId) ?? new Set()
      values.add(row.requiredAuthType)
      requiredAuthTypes.set(row.connectionId, values)
    }
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
  return { requiredBy: result, identityManagedBy: identityManagedResult, requiredAuthTypes }
}

function oauthRegistrationSourceForClient(
  oauthClient: Awaited<ReturnType<typeof getOrgOAuthClient>>,
): "pre-registered" | "client-metadata" | "dynamic" | null {
  const registrationSource = oauthClient?.extra?.enterpriseMcpRegistrationSource
  if (registrationSource === "dynamic" || registrationSource === "client-metadata" || registrationSource === "pre-registered") {
    return registrationSource
  }
  if (registrationSource === undefined && isRecord(oauthClient?.extra?.clientInformation)) {
    return "dynamic"
  }
  return oauthClient ? "pre-registered" : null
}

function registeredRedirectUriForClient(oauthClient: Awaited<ReturnType<typeof getOrgOAuthClient>>): string | null {
  const registeredRedirectUri = oauthClient?.extra?.registeredRedirectUri
  return typeof registeredRedirectUri === "string" ? registeredRedirectUri : null
}

function callbackRedirectUriWithClient(
  connection: ExternalMcpConnectionRow,
  oauthClient: Awaited<ReturnType<typeof getOrgOAuthClient>>,
) {
  if (connection.authType !== "oauth") return "http://127.0.0.1/unused-mcp-oauth-callback"
  return externalMcpCompatibleCallbackUrl({
    connectionId: connection.id,
    callbackMode: connection.oauthConfiguration?.callbackMode ?? "legacy-v1",
    createdAt: connection.createdAt,
    registeredRedirectUri: registeredRedirectUriForClient(oauthClient),
  })
}

async function callbackRedirectUri(connection: ExternalMcpConnectionRow) {
  const oauthClient = connection.authType === "oauth"
    ? await getOrgOAuthClient(connection.organizationId, connection.id)
    : null
  return callbackRedirectUriWithClient(connection, oauthClient)
}

async function toConnectionResponse(
  row: ExternalMcpConnectionRow,
  options: {
    callerOrgMembershipId: DenTypeId<"member">
    createdByName?: string | null
    includeAccess: boolean
    identityManagedBy: ConnectionRequiredBy[]
    requiredBy: ConnectionRequiredBy[]
    requiredAuthTypes: Set<"apikey" | "none" | "oauth">
  },
) {
  let connected = isConnectionConnected(row)
  let connectedAt = row.connectedAt
  let connectedForMe = connected && row.credentialMode === "shared"
  let grantedScopes = row.scope?.split(/\s+/).filter(Boolean) ?? []
  let callerCredentialHealth = row.credentialHealth
  let callerExternalAccountId: string | null = null
  if (row.credentialMode === "per_member") {
    const account = await getConnectedAccount({
      organizationId: row.organizationId,
      orgMembershipId: options.callerOrgMembershipId,
      providerId: row.id,
    })
    connectedForMe = Boolean(account?.accessToken)
    callerExternalAccountId = account?.accessToken ? account.externalAccountId : null
    callerCredentialHealth = account?.credentialHealth ?? null
    grantedScopes = account?.scopes ?? []
    if (options.includeAccess) {
      const accountState = await connectedAccountStateForConnection({
        organizationId: row.organizationId,
        providerId: row.id,
      })
      connected = accountState.connected
      connectedAt = accountState.connectedAt
    } else {
      connected = connectedForMe
      connectedAt = account?.accessToken ? account.connectedAt : null
    }
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
  const oauthClient = row.authType === "oauth" || options.includeAccess
    ? await getOrgOAuthClient(row.organizationId, row.id)
    : null
  const oauthRegistrationSource = oauthRegistrationSourceForClient(oauthClient)
  const callbackMode = row.oauthConfiguration?.callbackMode ?? null
  const requiredAuthTypes = [...options.requiredAuthTypes]
  const presetRequiredAuthType = row.kind === "external_mcp"
    ? requiredPluginMcpAuthType({ declaredAuthType: null, url: row.url })
    : null
  if (requiredAuthTypes.length === 0 && presetRequiredAuthType) requiredAuthTypes.push(presetRequiredAuthType)
  const authPolicyConfirmed = options.identityManagedBy.length === 0 || requiredAuthTypes.length > 0
  const authTypeMismatch = requiredAuthTypes.some((requiredAuthType) => requiredAuthType !== row.authType)
  const oauthClientRequired = row.kind === "external_mcp" && row.authType === "oauth" && pluginMcpRequiresPreRegisteredOAuthClient(row.url)
  const oauthClientConfigured = Boolean(oauthClient)
  const setupRequired = options.identityManagedBy.length > 0 && (
    !authPolicyConfirmed
    || authTypeMismatch
    || (oauthClientRequired && !oauthClientConfigured)
    || (!connected && (row.authType === "apikey" || row.authType === "none"))
  )
  const issuerReviewRequired = row.oauthIssuerReviewRequiredAt !== null
  const credentialReconnectRequired = callerCredentialHealth?.status === "reconnect_required"
  const needsReconnect = issuerReviewRequired || credentialReconnectRequired
  const reconnectActionOwner = issuerReviewRequired || (credentialReconnectRequired && row.credentialMode === "shared")
    ? "organization_admin"
    : credentialReconnectRequired
      ? "member"
      : null

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.authType,
    credentialMode: row.credentialMode,
    // Which service a native connector fronts ("google-workspace"), so a
    // member's card can say what they would be signing in to. Null for
    // external MCP rows, whose url already names the service.
    nativeProviderKey: row.kind === "native_provider" ? row.nativeProviderKey : null,
    // The caller's own connected identity (their email for Google), so the
    // card can say WHICH account is signed in — the whole point of holding
    // more than one connector for the same service.
    externalAccountId: callerExternalAccountId,
    connected,
    connectedAt: connectedAt ? connectedAt.toISOString() : null,
    ...(options.includeAccess ? { createdByName: options.createdByName ?? null } : {}),
    updatedAt: row.updatedAt.toISOString(),
    connectedForMe,
    needsReconnect,
    credentialHealth: callerCredentialHealth?.status ?? "unknown",
    credentialHealthReason: callerCredentialHealth?.reason ?? null,
    credentialHealthCheckedAt: callerCredentialHealth?.checkedAt ?? null,
    issuerReviewRequired,
    reconnectActionOwner,
    requiredBy: options.requiredBy,
    identityManagedBy: options.identityManagedBy,
    requiredAuthType: requiredAuthTypes.length === 1 ? requiredAuthTypes[0] : null,
    authPolicyConfirmed,
    authTypeMismatch,
    oauthClientConfigured,
    oauthClientRequired,
    setupRequired,
    access,
    ...(options.includeAccess ? {
      oauthClientId: oauthClient?.clientId ?? null,
      oauthCallbackUrl: row.authType === "oauth"
        ? row.kind === "native_provider" && row.nativeProviderKey
          ? nativeProviderCallbackUrl(row.nativeProviderKey)
          : callbackRedirectUriWithClient(row, oauthClient)
        : null,
      oauthSharedCallbackUrl: row.kind === "external_mcp" && row.authType === "oauth" ? externalMcpSharedCallbackUrl() : null,
      oauthClientMetadataUrl: row.kind === "external_mcp" && row.authType === "oauth" ? externalMcpClientMetadataUrl() : null,
      oauthCallbackMode: callbackMode,
      oauthRegistrationSource,
      authorizationServerIssuer: row.oauthConfiguration?.authorizationServerIssuer ?? null,
      requestedScopes: row.oauthConfiguration?.requestedScopes ?? [],
      grantedScopes,
    } : {}),
  }
}

export type MemberUsableConnectionFacts = {
  id: string
  name: string
  url: string
  nativeProviderKey: string | null
  credentialMode: "shared" | "per_member"
  connected: boolean
  connectedAt: string | null
  connectedForMe: boolean
  needsReconnect: boolean
  authPolicyConfirmed?: boolean
  authTypeMismatch?: boolean
  oauthClientConfigured?: boolean
  oauthClientRequired?: boolean
  setupRequired?: boolean
  issuerReviewRequired?: boolean
  reconnectActionOwner?: string | null
}

export async function listMemberUsableConnectionFacts(input: {
  context: PluginArchActorContext
}): Promise<MemberUsableConnectionFacts[]> {
  const organization = input.context.organizationContext.organization
  if (!memberFacingMcpConnectionsEnabled(organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })) {
    return []
  }

  const member = input.context.organizationContext.currentMember
  const teamIds = input.context.memberTeams.map((team) => team.id)
  const rows = await listVisibleExternalMcpConnections({
    organizationId: organization.id,
    orgMembershipId: member.id,
    teamIds,
  })
  const provenance = await requiredByForConnections({ context: input.context, includeAllPluginNames: false, rows })
  const connections = await Promise.all(rows.map((row) =>
    toConnectionResponse(row, {
      callerOrgMembershipId: member.id,
      createdByName: resolveCreatorName(input.context.organizationContext, row.createdByOrgMembershipId),
      includeAccess: false,
      requiredBy: provenance.requiredBy.get(row.id) ?? [],
      identityManagedBy: provenance.identityManagedBy.get(row.id) ?? [],
      requiredAuthTypes: provenance.requiredAuthTypes.get(row.id) ?? new Set(),
    })))
  const nativeEntries = await listNativeProviderUsableEntries({
    organizationId: organization.id,
    orgMembershipId: member.id,
    teamIds,
  })
  return [...nativeEntries, ...connections]
}

function invalidMcpOAuthCallback(message: string): Response {
  return Response.json({ error: "invalid_request", message }, { status: 400 })
}

function mcpOAuthCallbackHtml(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  })
}

async function handleExternalMcpOAuthCallback(input: {
  request: Request
  requestId: string
  scopedConnectionId?: string
}): Promise<Response> {
  const url = new URL(input.request.url)
  const state = url.searchParams.get("state")
  if (!state) {
    return invalidMcpOAuthCallback("Missing state.")
  }

  const statePayload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
  if (!statePayload) {
    return invalidMcpOAuthCallback("Invalid or expired state.")
  }

  const isScopedRoute = input.scopedConnectionId !== undefined
  const callbackMode = statePayload.version === 2 ? statePayload.callbackMode : "legacy-v1"
  // Version-two transactions can use either callback, but the route and the
  // signed callback mode must agree. Version-one transactions remain bound to
  // the legacy runtime and per-connection compatibility route.
  if (!isScopedRoute && (statePayload.version !== 2 || callbackMode !== "shared-v1")) {
    return invalidMcpOAuthCallback("This authorization callback must use the shared callback selected when authorization started.")
  }
  if (isScopedRoute && (
    statePayload.providerId !== input.scopedConnectionId
    || (statePayload.version === 2 && callbackMode !== "isolated-v1" && callbackMode !== "legacy-v1")
  )) {
    return invalidMcpOAuthCallback("Invalid or expired state.")
  }

  let connectionId: DenTypeId<"externalMcpConnection">
  try {
    connectionId = normalizeDenTypeId("externalMcpConnection", statePayload.providerId)
  } catch {
    return invalidMcpOAuthCallback("Invalid or expired state.")
  }
  const [connection, members] = await Promise.all([
    getExternalMcpConnection({
      organizationId: statePayload.organizationId,
      connectionId,
    }),
    db.select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.id, statePayload.orgMembershipId),
        eq(MemberTable.organizationId, statePayload.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .limit(1),
  ])
  if (!connection || !members[0]) {
    return invalidMcpOAuthCallback("Unknown authorization transaction.")
  }
  if (connection.kind !== "external_mcp") {
    return invalidMcpOAuthCallback("Native provider connectors do not use the external MCP OAuth callback.")
  }
  const configuredIssuer = connection.oauthConfiguration?.authorizationServerIssuer ?? null
  const discovery = connection.oauthConfiguration?.discovery
  const currentResponseIssuerRequired = authorizationResponseIssuerRequired(connection)
  const autoSelectedIssuer = statePayload.version === 2
    && statePayload.authorizationServerIssuer === undefined
    && configuredIssuer !== null
    && isRecord(discovery)
    && discovery.authorizationServerUrl === configuredIssuer
    && (!isRecord(discovery.resourceMetadata)
      || !Array.isArray(discovery.resourceMetadata.authorization_servers)
      || discovery.resourceMetadata.authorization_servers.length <= 1)
  if (
    (statePayload.binding === undefined
      || (statePayload.binding !== externalMcpIdentityBinding(connection)
        && !matchesLegacyExternalMcpOAuthStateIdentityBinding(connection, statePayload.binding)))
    || callbackMode !== (connection.oauthConfiguration?.callbackMode ?? "legacy-v1")
    || (statePayload.version === 2
      && (statePayload.authorizationServerIssuer ?? null)
        !== configuredIssuer
      && !autoSelectedIssuer)
    || (statePayload.version === 2
      && statePayload.authorizationResponseIssuerRequired !== undefined
      && statePayload.authorizationResponseIssuerRequired !== currentResponseIssuerRequired)
  ) {
    return invalidMcpOAuthCallback("This connection changed after authorization started. Start the connection flow again.")
  }

  const member = connection.credentialMode === "per_member"
    ? { orgMembershipId: statePayload.orgMembershipId }
    : undefined
  const abandonAuthorization = statePayload.version === 2
    ? abandonExternalMcpAuth
    : abandonLegacyExternalMcpAuth
  const completeAuthorization = statePayload.version === 2
    ? completeExternalMcpAuth
    : completeLegacyExternalMcpAuth
  if (statePayload.version === 2) {
    const responseIssuer = url.searchParams.has("iss")
      ? (url.searchParams.get("iss") ?? "")
      : undefined
    try {
      const usesPinnedSharedCallback = statePayload.authorizationResponseIssuerRequired === false
        && usesPinnedSharedOAuthCallback(connection)
      const validation = validateMcpAuthorizationResponseIssuer({
        expectedIssuer: configuredIssuer,
        discoveryState: connection.oauthConfiguration?.discovery,
        responseIssuer,
        mixUpDefense: callbackMode === "isolated-v1"
          ? "distinct-redirect-uri"
          : callbackMode === "legacy-v1"
            ? "legacy"
            : usesPinnedSharedCallback
              ? "pinned-transaction"
              : "response-issuer",
      })
      if (validation.ignoredResponseIssuer !== undefined) {
        logger.warn("external_mcp_connect_callback_untrusted_issuer_ignored", {
          connection_id: connection.id,
          organization_id: statePayload.organizationId,
          mix_up_defense: validation.defense,
        })
      }
    } catch (error) {
      try {
        await abandonAuthorization(connection, state, member, input.requestId)
      } catch (cleanupError) {
        logger.error("external_mcp_connect_callback_issuer_cleanup_failed", {
          connection_id: connection.id,
          organization_id: statePayload.organizationId,
          ...externalMcpDiagnosticForLog(cleanupError, input.requestId, "AUTH_ISSUER_DISCOVERY"),
        })
      }
      const diagnostic = externalMcpDiagnosticForResponse(error, input.requestId, "AUTH_ISSUER_DISCOVERY")
      logger.error("external_mcp_connect_callback_issuer_validation_failed", {
        connection_id: connection.id,
        organization_id: statePayload.organizationId,
        ...externalMcpDiagnosticForLog(error, input.requestId, "AUTH_ISSUER_DISCOVERY"),
      })
      return mcpOAuthCallbackHtml(connectCallbackPage({
        ok: false,
        name: connection.name,
        message: diagnostic.message,
        referenceId: diagnostic.referenceId,
      }), 400)
    }
  }
  const providerErrorCode = url.searchParams.get("error")
  if (providerErrorCode) {
    const callbackError = externalMcpOAuthCallbackError(input.requestId, providerErrorCode)
    try {
      await abandonAuthorization(connection, state, member, input.requestId)
    } catch (error) {
      logger.error("external_mcp_connect_callback_authorization_cleanup_failed", {
        connection_id: connection.id,
        organization_id: statePayload.organizationId,
        ...externalMcpDiagnosticForLog(error, input.requestId, "AUTH_USER_OR_WORKLOAD"),
      })
    }
    logger.error("external_mcp_connect_callback_authorization_denied", {
      connection_id: connection.id,
      organization_id: statePayload.organizationId,
      ...externalMcpDiagnosticForLog(callbackError, input.requestId, "AUTH_USER_OR_WORKLOAD"),
    })
    return mcpOAuthCallbackHtml(connectCallbackPage({
      ok: false,
      name: connection.name,
      message: callbackError.diagnostic.message,
      referenceId: callbackError.diagnostic.referenceId,
    }), 400)
  }

  const code = url.searchParams.get("code")
  if (!code) {
    try {
      await abandonAuthorization(connection, state, member, input.requestId)
    } catch (error) {
      logger.error("external_mcp_connect_callback_missing_code_cleanup_failed", {
        connection_id: connection.id,
        organization_id: statePayload.organizationId,
        ...externalMcpDiagnosticForLog(error, input.requestId, "AUTH_USER_OR_WORKLOAD"),
      })
    }
    return invalidMcpOAuthCallback("Missing authorization code.")
  }
  try {
    await completeAuthorization(
      connection,
      code,
      await callbackRedirectUri(connection),
      member,
      input.requestId,
      state,
    )
  } catch (error) {
    try {
      await abandonAuthorization(connection, state, member, input.requestId)
    } catch (cleanupError) {
      logger.error("external_mcp_connect_callback_token_cleanup_failed", {
        connection_id: connection.id,
        organization_id: statePayload.organizationId,
        ...externalMcpDiagnosticForLog(cleanupError, input.requestId, "AUTH_TOKEN_ACQUISITION"),
      })
    }
    const diagnostic = externalMcpDiagnosticForResponse(error, input.requestId, "AUTH_TOKEN_ACQUISITION")
    logger.error("external_mcp_connect_callback_token_exchange_failed", {
      connection_id: connection.id,
      organization_id: statePayload.organizationId,
      ...externalMcpDiagnosticForLog(error, input.requestId, "AUTH_TOKEN_ACQUISITION"),
    })
    return mcpOAuthCallbackHtml(connectCallbackPage({
      ok: false,
      name: connection.name,
      message: diagnostic.message,
      referenceId: diagnostic.referenceId,
    }), 400)
  }
  return mcpOAuthCallbackHtml(connectCallbackPage({ ok: true, name: connection.name }))
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
    "/oauth/client-metadata.json",
    describeRoute({
      tags: ["Authentication"],
      summary: "OpenWork external MCP OAuth client metadata",
      description: "Public client metadata document for URL-based OAuth client registration. It contains no deployment secrets.",
      responses: {
        200: jsonResponse("Client metadata.", clientMetadataResponseSchema),
      },
    }),
    publicRoute,
    (c) => {
      c.header("Cache-Control", "public, max-age=300")
      const clientId = externalMcpClientMetadataUrl()
      return c.json({
        client_id: clientId,
        client_name: "OpenWork" as const,
        application_type: "web" as const,
        redirect_uris: [externalMcpSharedCallbackUrl()],
        grant_types: ["authorization_code", "refresh_token"] as const,
        response_types: ["code"] as const,
        token_endpoint_auth_method: "none" as const,
      })
    },
  )

  app.post(
    "/v1/mcp-connections/discover",
    describeRoute({
      tags: ["Authentication"],
      summary: "Discover external MCP connection requirements",
      description: "Admin-only, side-effect-free requirements discovery. It performs no client registration, credential write, or connection creation.",
      responses: {
        200: jsonResponse("Requirements discovery result.", requirementsDiscoveryResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can discover MCP requirements.", forbiddenSchema),
        502: jsonResponse("Requirements discovery failed.", requirementsDiscoveryFailedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(discoverConnectionBodySchema),
    async (c) => {
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can discover MCP requirements.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const { url } = c.req.valid("json")
      try {
        const result = await discoverConnectionRequirements({
          serverUrl: url,
          fetch: externalMcpDiscoveryFetch,
        })
        return c.json(result)
      } catch (error) {
        return c.json({
          error: "requirements_discovery_failed" as const,
          message: error instanceof Error ? error.message : "MCP requirements discovery failed.",
        }, 502)
      }
    },
  )

  app.post(
    "/v1/mcp-connections/:connectionId/oauth/issuer-review",
    describeRoute({
      tags: ["Authentication"],
      summary: "Review a changed External MCP OAuth issuer",
      description: "Organization-admin-only. Repeats live OAuth discovery and either previews the issuers currently advertised by the MCP resource or explicitly confirms one. Confirmation never trusts an unadvertised issuer. Changing issuers invalidates issuer-bound OAuth clients and credentials so members reconnect cleanly.",
      responses: {
        200: jsonResponse("Issuer review result.", issuerReviewResponseSchema),
        400: jsonResponse("Invalid issuer review request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can review OAuth issuers.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        409: jsonResponse("The connection changed or the requested issuer is not currently advertised.", connectionConflictSchema),
        502: jsonResponse("Live OAuth discovery failed.", requirementsDiscoveryFailedSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    jsonValidator(issuerReviewBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can review OAuth issuers.")
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
      if (connection.authType !== "oauth") {
        return c.json({ error: "invalid_request", message: "Issuer review is only available for OAuth MCP connections." }, 400)
      }

      let advertisedIssuers: string[]
      try {
        const discovery = await discoverConnectionRequirements({
          serverUrl: connection.url,
          fetch: externalMcpDiscoveryFetch,
        })
        advertisedIssuers = [...new Set(
          discovery.authentication.authorizationServers.map((server) => server.issuer),
        )]
      } catch (error) {
        return c.json({
          error: "requirements_discovery_failed" as const,
          message: error instanceof Error ? error.message : "MCP requirements discovery failed.",
        }, 502)
      }
      if (advertisedIssuers.length === 0) {
        return c.json({
          error: "connection_conflict" as const,
          message: "The MCP resource does not currently advertise an OAuth authorization server.",
        }, 409)
      }

      const body = c.req.valid("json")
      const currentIssuer = connection.oauthConfiguration?.authorizationServerIssuer ?? null
      if (body.action === "preview") {
        return c.json({
          currentIssuer,
          advertisedIssuers,
          reviewRequired: connection.oauthIssuerReviewRequiredAt !== null,
        })
      }
      if (!advertisedIssuers.includes(body.authorizationServerIssuer)) {
        return c.json({
          error: "connection_conflict" as const,
          message: "The selected issuer is not currently advertised by this MCP resource. Refresh the review before confirming.",
        }, 409)
      }

      const result = await confirmExternalMcpIssuerReview({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
        expectedUpdatedAt: new Date(body.expectedUpdatedAt),
        authorizationServerIssuer: body.authorizationServerIssuer,
      })
      if (result.status === "not_found") {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      if (result.status === "conflict") {
        return c.json({
          error: "connection_conflict" as const,
          message: "This connection changed while the issuer was being reviewed. Reload and review the current provider metadata again.",
        }, 409)
      }
      return c.json({
        currentIssuer: result.connection.oauthConfiguration?.authorizationServerIssuer ?? null,
        advertisedIssuers,
        reviewRequired: false,
        issuerChanged: result.issuerChanged,
        reconnectionRequired: result.reconnectionRequired,
        updatedAt: result.connection.updatedAt.toISOString(),
      })
    },
  )

  app.get(
    "/v1/mcp-connections/presets",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List predefined External MCP Connection presets",
      description: "Common third-party MCP servers (Notion, Linear, Stripe, Slack, ...) an admin can add with one click, prefilled with a real name and URL.",
      responses: {
        200: jsonResponse("Presets.", externalMcpPresetListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      return c.json({ presets: EXTERNAL_MCP_PRESETS })
    },
  )

  app.post(
    "/v1/mcp-connections/resolve",
    describeRoute({
      tags: ["Authentication"],
      summary: "Resolve a free-form query to an MCP server",
      description: "Admin-only, side-effect-free smart resolution for the add-connection flow. Accepts a URL, a bare host, or a product name (\"vercel\"), matches curated presets, probes bounded well-known endpoint candidates through the SSRF-guarded discovery fetch, and returns the winning URL with its requirements discovery. It performs no client registration, credential write, or connection creation.",
      responses: {
        200: jsonResponse("Resolution result (not_found is a successful outcome).", resolveConnectionResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can resolve MCP servers.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(resolveConnectionBodySchema),
    async (c) => {
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can resolve MCP servers.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const { query } = c.req.valid("json")

      const classification = classifyResolveQuery(query)
      if (classification.kind === "invalid") {
        return c.json({ resolution: "not_found" as const, attempted: [], reason: classification.reason })
      }

      const preset = matchPresetForQuery(query, EXTERNAL_MCP_PRESETS)
      const candidates = preset ? [preset.url] : resolveCandidateUrls(classification)
      const guessed = !preset && classification.kind === "name"
      const probes = await Promise.all(candidates.map(async (candidateUrl) => {
        try {
          const discovery = await discoverConnectionRequirements({
            serverUrl: candidateUrl,
            fetch: externalMcpDiscoveryFetch,
            timeoutMs: MCP_RESOLVE_PROBE_TIMEOUT_MS,
          })
          return { url: candidateUrl, discovery }
        } catch {
          // A candidate that cannot even be fetched (guard rejection, bad
          // URL) simply loses to the other candidates.
          return null
        }
      }))
      const match = probes.find((probe) => probe !== null && discoveryQualifiesAsMcp(probe.discovery, { guessed })) ?? null

      if (preset) {
        return c.json({
          resolution: "preset" as const,
          attempted: candidates,
          preset,
          ...(match ? { match: { url: match.url, suggestedName: preset.displayName, discovery: match.discovery } } : {}),
        })
      }
      if (!match) {
        return c.json({ resolution: "not_found" as const, attempted: candidates })
      }
      return c.json({
        resolution: "discovered" as const,
        attempted: candidates,
        match: { url: match.url, suggestedName: suggestConnectionName(match.url), discovery: match.discovery },
      })
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
            createdByName: resolveCreatorName(payload, row.createdByOrgMembershipId),
            includeAccess: true,
            requiredBy: provenance.requiredBy.get(row.id) ?? [],
            identityManagedBy: provenance.identityManagedBy.get(row.id) ?? [],
            requiredAuthTypes: provenance.requiredAuthTypes.get(row.id) ?? new Set(),
          })))
        return c.json({ connections })
      }

      return c.json({ connections: await listMemberUsableConnectionFacts({ context }) })
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/tool-policy",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Get the tool policy for an External MCP Connection",
      responses: {
        200: jsonResponse("External MCP tool policy.", connectionToolPolicyResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be a workspace owner or admin.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: normalizeDenTypeId("externalMcpConnection", connectionId),
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      return c.json({ policy: toToolPolicyResponse(connection.toolPolicy, { includeAttribution: true }) })
    },
  )

  app.put(
    "/v1/mcp-connections/:connectionId/tool-policy",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Update the tool policy for an External MCP Connection",
      responses: {
        200: jsonResponse("External MCP tool policy updated.", connectionToolPolicyResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be a workspace owner or admin.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(connectionParamsSchema),
    jsonValidator(connectionToolPolicyInputSchema),
    async (c) => {
      const payload = c.get("organizationContext")
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
      const updatedByName = resolvePolicyEditorLabel(payload, payload.currentMember.id)
      const policy: ExternalMcpToolPolicy = {
        version: 1,
        allDisabled: body.allDisabled,
        disabledTools: [...new Set(body.disabledTools)],
        updatedByOrgMembershipId: payload.currentMember.id,
        ...(updatedByName ? { updatedByName } : {}),
        updatedAt: new Date().toISOString(),
      }
      await setExternalMcpConnectionToolPolicy(
        connection.id,
        payload.organization.id,
        policy,
      )
      return c.json({ policy: toToolPolicyResponse(policy, { includeAttribution: true }) })
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/tools",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List tools exposed by an External MCP Connection",
      description: "Uses the Den-managed credential available to the calling member to read the live MCP tools/list catalog. Granted members can inspect connections available under Your Connections; workspace owners and admins can also inspect connections they manage. Credentials and tool calls are never returned.",
      responses: {
        200: jsonResponse("External MCP tool catalog.", connectionToolListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller has not been granted access to this connection.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        409: jsonResponse("The connection has no usable credential for this member.", connectionNotReadySchema),
        502: jsonResponse("The upstream MCP tool catalog could not be read.", connectionToolListFailedSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      if (connection.kind !== "external_mcp") {
        return c.json({ error: "invalid_request", message: "Native provider connectors do not expose an MCP tool catalog." }, 400)
      }

      const isAdmin = verifyOrgRole({ roles: ["admin"], userContext: payload.currentMember })
      if (!isAdmin) {
        const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
        const canUse = memberFacingMcpConnectionsEnabled(payload.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })
          && await memberCanUseExternalMcpConnection({
            connectionId: connection.id,
            orgMembershipId: payload.currentMember.id,
            teamIds: memberTeams.map((team) => team.id),
          })
        if (!canUse) {
          return c.json({ error: "forbidden", message: `You have not been granted access to "${connection.name}".` }, 403)
        }
      }

      const credential = await resolveExternalMcpToolCredential(connection, payload.currentMember.id)
      if (!credential.ok) {
        return c.json({
          error: "connection_not_ready",
          message: credential.message,
        }, 409)
      }

      try {
        const tools = await listExternalMcpTools(
          connection,
          await callbackRedirectUri(connection),
          credential.member,
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
          policy: toToolPolicyResponse(connection.toolPolicy, { includeAttribution: isAdmin }),
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

  app.get(
    "/v1/mcp-connections/:connectionId/mcp-apps",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List MCP Apps exposed by an External MCP Connection",
      description: "Enumerates the connection's app-visible MCP App launch tools in the exact reference shape desktop dashboard tiles use, so organization Dashboards can add them as elements. Admin-only.",
      responses: {
        200: jsonResponse("MCP Apps available from this connection.", connectionMcpAppListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can list connection MCP Apps.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        409: jsonResponse("The connection has no usable credential for this member.", connectionNotReadySchema),
        502: jsonResponse("The upstream MCP tool catalog could not be read.", connectionToolListFailedSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      if (connection.kind !== "external_mcp") {
        return c.json({ error: "invalid_request", message: "Native provider connectors do not expose MCP Apps." }, 400)
      }

      const credential = await resolveExternalMcpToolCredential(connection, payload.currentMember.id)
      if (!credential.ok) {
        return c.json({
          error: "connection_not_ready",
          message: credential.message,
        }, 409)
      }

      try {
        const tools = await listExternalMcpTools(
          connection,
          await callbackRedirectUri(connection),
          credential.member,
          c.get("requestId"),
        )
        const serverName = connectMcpAppHostServerName(connection.id)
        const apps = tools.flatMap((tool) => {
          if (PROXY_GATEWAY_TOOL_NAMES.has(tool.name)) return []
          if (evaluateToolPolicy(connection.toolPolicy, tool.name).blocked) return []
          const resourceUri = externalMcpAppResourceUri(tool)
          if (!resourceUri || !mcpToolVisibleToApp(tool)) return []
          return [{
            serverName,
            connectionId: connection.id,
            toolName: tool.name,
            projectedToolName: projectedMcpToolName(serverName, tool.name),
            resourceUri,
            title: typeof tool.title === "string" && tool.title.trim() ? tool.title : tool.annotations?.title ?? null,
            description: typeof tool.description === "string" ? tool.description : null,
            requiresInput: mcpToolRequiresInput(tool),
            requiresApproval: tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true,
          }]
        })
        return c.json({ apps })
      } catch (error) {
        const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "MCP_TOOL_DISCOVERY")
        logger.error("external_mcp_app_list_failed", {
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
    "/v1/mcp-connections/:connectionId/tools/call",
    describeRoute({
      tags: ["Authentication"],
      summary: "Manually run a tool from an External MCP Connection",
      description: "Workspace owner/admin diagnostic runner. Executes one named MCP tool with caller-supplied JSON arguments using the Den-managed shared credential or the calling admin's connected credential. Returns an ephemeral inspection of the actual tools/call HTTP request and response with credential and session headers redacted. The caller must already be granted access to the connection. Credentials, arguments, results, and inspection payloads are never written to logs.",
      responses: {
        200: jsonResponse("The MCP tool completed.", connectionToolRunResponseSchema),
        400: jsonResponse("Invalid tool name or arguments.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be a workspace owner/admin, have access, and be allowed by tool policy.", connectionToolRunForbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        409: jsonResponse("The connection has no usable credential for this member.", connectionNotReadySchema),
        413: jsonResponse("The tool arguments exceeded the request size limit.", connectionToolRequestTooLargeSchema),
        502: jsonResponse("The upstream MCP tool call failed.", connectionToolRunFailedSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    resolveMemberTeamsMiddleware,
    bodyLimit({
      maxSize: MANUAL_MCP_TOOL_REQUEST_MAX_BYTES,
      onError: (c) => c.json({
        error: "payload_too_large",
        message: "Tool arguments must fit within 1 MB.",
      }, 413),
    }),
    paramValidator(connectionParamsSchema),
    jsonValidator(runConnectionToolBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const { toolName, arguments: toolArguments } = c.req.valid("json")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      if (connection.kind !== "external_mcp") {
        return c.json({ error: "invalid_request", message: "Native provider connectors do not expose MCP tools." }, 400)
      }

      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const canUse = memberFacingMcpConnectionsEnabled(payload.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })
        && await memberCanUseExternalMcpConnection({
          connectionId: connection.id,
          orgMembershipId: payload.currentMember.id,
          teamIds: memberTeams.map((team) => team.id),
        })
      if (!canUse) {
        return c.json({ error: "forbidden", message: `You have not been granted access to "${connection.name}".` }, 403)
      }

      const credential = await resolveExternalMcpToolCredential(connection, payload.currentMember.id)
      if (!credential.ok) {
        return c.json({
          error: "connection_not_ready",
          message: credential.message,
        }, 409)
      }

      const policyDecision = evaluateToolPolicy(connection.toolPolicy, toolName)
      if (policyDecision.blocked) {
        return c.json({
          error: "policy_blocked",
          message: `${toolName} is disabled for your organization.`,
          disabledBy: policyDecision.disabledBy ?? null,
          disabledAt: policyDecision.disabledAt ?? null,
        }, 403)
      }

      const startedAt = Date.now()
      try {
        const inspected = await inspectExternalMcpToolCall({
          connection,
          redirectUri: await callbackRedirectUri(connection),
          toolName,
          args: toolArguments,
          member: credential.member,
          diagnosticReferenceId: c.get("requestId"),
        })
        const durationMs = Date.now() - startedAt
        logger.info("external_mcp_manual_tool_succeeded", {
          connection_id: connection.id,
          organization_id: payload.organization.id,
          org_membership_id: payload.currentMember.id,
          duration_ms: durationMs,
          diagnostic_reference_id: c.get("requestId"),
        })
        return c.json({
          referenceId: c.get("requestId"),
          durationMs,
          result: inspected.result,
          inspection: {
            ...inspected.inspection,
            diagnosis: diagnoseExternalMcpToolCall({ inspection: inspected.inspection, succeeded: true }),
          },
        })
      } catch (error) {
        const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "MCP_TOOL_EXECUTION")
        const wireInspection = externalMcpToolCallInspectionForError(error)
        logger.error("external_mcp_manual_tool_failed", {
          connection_id: connection.id,
          organization_id: payload.organization.id,
          org_membership_id: payload.currentMember.id,
          connection_endpoint: safeExternalMcpEndpointForLog(connection.url),
          ...externalMcpDiagnosticForLog(error, c.get("requestId"), "MCP_TOOL_EXECUTION"),
        })
        return c.json({
          error: "tool_execution_failed",
          message: `Could not run "${toolName}" on "${connection.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
          diagnostic,
          inspection: {
            ...wireInspection,
            diagnosis: diagnoseExternalMcpToolCall({ inspection: wireInspection, succeeded: false, diagnostic }),
          },
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
      if (body.kind === "native_provider") {
        if (isAgentOAuthClientConnection({ oauthClient: body.oauthClient, sessionId })) {
          return c.json({ error: "invalid_request", message: "OAuth client credentials cannot be set from the agent. Add them in the OpenWork Cloud dashboard under Extensions." }, 400)
        }
        const provider = getNativeOAuthProvider(body.nativeProviderKey)
        if (!provider) {
          return c.json({ error: "invalid_request", message: `"${body.nativeProviderKey}" is not a known native OAuth provider.` }, 400)
        }
        const unknownFeatures = (body.oauthClient.features ?? []).filter((feature) => !Object.hasOwn(provider.optionalFeatures ?? {}, feature))
        if (unknownFeatures.length > 0) {
          return c.json({ error: "invalid_request", message: `Unknown optional feature(s): ${unknownFeatures.join(", ")}.` }, 400)
        }
        const created = await createExternalMcpConnection({
          organizationId: payload.organization.id,
          name: body.name,
          url: provider.websiteUrl,
          authType: "oauth",
          kind: "native_provider",
          nativeProviderKey: provider.providerId,
          credentialMode: "per_member",
          createdByOrgMembershipId: payload.currentMember.id,
          access: { orgWide: true, memberIds: [], teamIds: [] },
        })
        await upsertOrgOAuthClient({
          organizationId: payload.organization.id,
          providerId: created.id,
          clientId: body.oauthClient.clientId,
          clientSecret: body.oauthClient.clientSecret ?? null,
          ...(body.oauthClient.features ? { extra: { features: body.oauthClient.features } } : {}),
          createdByOrgMembershipId: payload.currentMember.id,
        })
        const response = await toConnectionResponse(created, {
          callerOrgMembershipId: payload.currentMember.id,
          createdByName: resolveCreatorName(payload, created.createdByOrgMembershipId),
          includeAccess: true,
          requiredBy: [],
          identityManagedBy: [],
          requiredAuthTypes: new Set(),
        })
        return c.json({ ...response, links: memberConnectLinks(created) })
      }
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
      if (body.authType !== "oauth" && (body.authorizationServerIssuer !== undefined || (body.requestedScopes?.length ?? 0) > 0)) {
        return c.json({ error: "invalid_request", message: "OAuth issuer and scopes are only allowed when authType is oauth." }, 400)
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

      const oauthConfiguration = externalMcpOAuthConfigurationDefaults({
        url: body.url,
        authorizationServerIssuer: body.authorizationServerIssuer,
        requestedScopes: body.requestedScopes,
      })
      const created = await createExternalMcpConnection({
        organizationId: payload.organization.id,
        name: body.name,
        url: body.url,
        authType: body.authType,
        credentialMode: body.credentialMode,
        apiKey: body.apiKey ?? null,
        oauthConfiguration: body.authType === "oauth" ? {
          version: 1,
          ...oauthConfiguration,
        } : null,
        createdByOrgMembershipId: payload.currentMember.id,
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
      })

      if (body.oauthClient) {
        const callbackMode = created.oauthConfiguration?.callbackMode ?? "legacy-v1"
        await upsertOrgOAuthClient({
          organizationId: payload.organization.id,
          providerId: created.id,
          clientId: body.oauthClient.clientId,
          clientSecret: body.oauthClient.clientSecret ?? null,
          extra: {
            enterpriseMcpRegistrationSource: "pre-registered",
            registrationContractVersion: 2,
            registeredRedirectUri: externalMcpCallbackUrl({ connectionId: created.id, callbackMode }),
            authorizationServerIssuer: oauthConfiguration.authorizationServerIssuer ?? undefined,
            tokenEndpointAuthMethod: body.oauthClient.tokenEndpointAuthMethod,
          },
          createdByOrgMembershipId: payload.currentMember.id,
        })
      }

      if (body.authType !== "oauth") {
        // No OAuth dance needed — validate the server is real and reachable now.
        try {
          await connectExternalMcp(created, await callbackRedirectUri(created), undefined, undefined, c.get("requestId"))
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
        createdByName: resolveCreatorName(payload, (refreshed ?? created).createdByOrgMembershipId),
        includeAccess: true,
        requiredBy: [],
        identityManagedBy: [],
        requiredAuthTypes: new Set(),
      })
      // The classical handoff: whoever created this (human or agent) gets
      // the link where members connect their own account, ready to share.
      return c.json({ ...response, links: memberConnectLinks(refreshed ?? created) })
    },
  )

  app.put(
    "/v1/mcp-connections/:connectionId",
    describeRoute({
      tags: ["Authentication"],
      summary: "Edit an External MCP Connection",
      description: "Workspace owners and super-admins can edit any connection. Other org members can edit only connections they created. Name and direct access changes preserve credentials. URL, authentication type, or credential-mode changes invalidate the old identity atomically. Secret fields are write-only optional replacements and are never returned. expectedUpdatedAt prevents stale edits.",
      responses: {
        200: jsonResponse("Connection updated.", connectionUpdatedResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners, super-admins, or the connection creator can edit MCP connections.", forbiddenSchema),
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
      if (!c.get("apiKey") && !hasFreshPrivilegedSession({ session: c.get("session") })) {
        return c.json(getFreshPrivilegedSessionRequiredResponse(), 403)
      }

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
      })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const canUpdateAnyConnection = organizationRoleValueSatisfies({
        roleValue: payload.currentMember.role,
        requiredRole: ORGANIZATION_SUPER_ADMIN_ROLE,
        isOwner: payload.currentMember.isOwner,
      })
      if (!canUpdateAnyConnection && connection.createdByOrgMembershipId !== payload.currentMember.id) {
        return c.json({
          error: "forbidden",
          message: "Only workspace owners, super-admins, or the connection creator can edit this MCP connection.",
        }, 403)
      }

      const body = c.req.valid("json")
      const identityChanged = normalizeExternalMcpIdentityUrl(connection.url) !== normalizeExternalMcpIdentityUrl(body.url)
        || connection.authType !== body.authType
        || connection.credentialMode !== body.credentialMode
      const oauthConfigurationDefaults = externalMcpOAuthConfigurationDefaults({
        url: body.url,
        authorizationServerIssuer: body.authorizationServerIssuer !== undefined
          ? body.authorizationServerIssuer
          : !identityChanged && connection.authType === "oauth"
            ? connection.oauthConfiguration?.authorizationServerIssuer ?? undefined
            : undefined,
        requestedScopes: body.requestedScopes
          ?? (!identityChanged && connection.authType === "oauth"
            && connection.oauthConfiguration?.requestedScopes.length
            ? connection.oauthConfiguration.requestedScopes
            : undefined),
      })
      const shouldWriteOAuthConfiguration = body.authType !== "oauth"
        || connection.authType !== "oauth"
        || connection.oauthConfiguration !== null
        || body.authorizationServerIssuer !== undefined
        || body.requestedScopes !== undefined
      const oauthConfiguration: ExternalMcpOAuthConfiguration | null | undefined = !shouldWriteOAuthConfiguration
        ? undefined
        : body.authType === "oauth"
          ? {
              version: 1,
              authorizationServerIssuer: oauthConfigurationDefaults.authorizationServerIssuer,
              requestedScopes: oauthConfigurationDefaults.requestedScopes,
              ...(connection.authType === "oauth" && connection.oauthConfiguration?.discovery
                ? { discovery: connection.oauthConfiguration.discovery }
                : {}),
              callbackMode: (connection.authType === "oauth" ? connection.oauthConfiguration?.callbackMode : undefined)
                ?? (connection.authType === "oauth" ? "legacy-v1" : "shared-v1"),
            }
          : null
      const marketplaceOwnedFieldsChanged = connection.url !== body.url
        || connection.authType !== body.authType
        || connection.credentialMode !== body.credentialMode
        || body.apiKey !== undefined
        || body.authorizationServerIssuer !== undefined
        || body.requestedScopes !== undefined
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
      const existingOAuthClient = body.oauthClient
        ? await getOrgOAuthClient(payload.organization.id, externalMcpConnectionId)
        : null
      const preservedTokenEndpointAuthMethod = body.oauthClient
        && existingOAuthClient?.clientId === body.oauthClient.clientId
        ? tokenEndpointAuthMethod(existingOAuthClient.extra?.tokenEndpointAuthMethod)
        : undefined
      if (body.authType !== "oauth" && (
        body.authorizationServerIssuer !== undefined
        || body.requestedScopes !== undefined
      )) {
        return c.json({ error: "invalid_request", message: "OAuth issuer and scopes are only allowed when authType is oauth." }, 400)
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
          oauthConfiguration: oauthConfiguration ?? connection.oauthConfiguration,
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
            await callbackRedirectUri(proposedConnection),
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
        ...(body.oauthClient ? {
          oauthClient: {
            ...body.oauthClient,
            extra: {
              enterpriseMcpRegistrationSource: "pre-registered",
              registrationContractVersion: 2,
              registeredRedirectUri: externalMcpCallbackUrl({
                connectionId: connection.id,
                callbackMode: oauthConfiguration?.callbackMode
                  ?? connection.oauthConfiguration?.callbackMode
                  ?? (connection.authType === "oauth" ? "legacy-v1" : "shared-v1"),
              }),
              authorizationServerIssuer: oauthConfiguration?.authorizationServerIssuer ?? undefined,
              tokenEndpointAuthMethod: body.oauthClient.tokenEndpointAuthMethod ?? preservedTokenEndpointAuthMethod,
            },
          },
        } : {}),
        ...(oauthConfiguration !== undefined ? { oauthConfiguration } : {}),
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
        updatedByOrgMembershipId: payload.currentMember.id,
        ...(canUpdateAnyConnection ? {} : { createdByOrgMembershipId: payload.currentMember.id }),
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
        createdByName: resolveCreatorName(payload, result.connection.createdByOrgMembershipId),
        includeAccess: true,
        requiredBy: provenance.requiredBy.get(result.connection.id) ?? [],
        identityManagedBy: provenance.identityManagedBy.get(result.connection.id) ?? [],
        requiredAuthTypes: provenance.requiredAuthTypes.get(result.connection.id) ?? new Set(),
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
        createdByName: resolveCreatorName(payload, connection.createdByOrgMembershipId),
        includeAccess: true,
        requiredBy: provenance.requiredBy.get(connection.id) ?? [],
        identityManagedBy: provenance.identityManagedBy.get(connection.id) ?? [],
        requiredAuthTypes: provenance.requiredAuthTypes.get(connection.id) ?? new Set(),
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
        403: jsonResponse("Only workspace owners, super-admins, or the connection creator can remove MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!c.get("apiKey") && !hasFreshPrivilegedSession({ session: c.get("session") })) {
        return c.json(getFreshPrivilegedSessionRequiredResponse(), 403)
      }

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const canDeleteAnyConnection = organizationRoleValueSatisfies({
        roleValue: payload.currentMember.role,
        requiredRole: ORGANIZATION_SUPER_ADMIN_ROLE,
        isOwner: payload.currentMember.isOwner,
      })
      if (!canDeleteAnyConnection && connection.createdByOrgMembershipId !== payload.currentMember.id) {
        return c.json({
          error: "forbidden",
          message: "Only workspace owners, super-admins, or the connection creator can remove this MCP connection.",
        }, 403)
      }

      const removed = canDeleteAnyConnection
        ? await deleteExternalMcpConnection({
            organizationId: payload.organization.id,
            connectionId: externalMcpConnectionId,
          })
        : await deleteExternalMcpConnection({
            organizationId: payload.organization.id,
            connectionId: externalMcpConnectionId,
            createdByOrgMembershipId: payload.currentMember.id,
          })
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
      description: "Admin-only. Signs out every shared or per-member account stored for this connection, while preserving the connection row, access grants, OAuth client configuration, and plugin bindings.",
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

  app.post(
    "/v1/mcp-connections/:connectionId/disconnect-my-account",
    describeRoute({
      tags: ["Authentication"],
      summary: "Disconnect the calling member's account for a per-member External MCP Connection",
      description: "Removes only the caller's connected account for this MCP connection. The org-level connection, access grants, OAuth client configuration, and other members' accounts are preserved.",
      responses: {
        200: emptyResponse("Disconnected."),
        400: jsonResponse("This connection does not use per-member credentials.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Unknown connection or nothing was connected.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const result = await disconnectExternalMcpMemberAccount({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
        orgMembershipId: payload.currentMember.id,
      })
      if (result.status === "not_found") {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      if (result.status === "not_per_member") {
        return c.json({ error: "invalid_request", message: "Only per-member MCP connections can be disconnected from Your Connections." }, 400)
      }
      if (result.status === "not_connected") {
        return c.json({ error: "connection_not_found", message: "Nothing was connected." }, 404)
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
        409: jsonResponse("The OAuth connection requires provider or issuer configuration before connecting.", connectStartConflictSchema),
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
      let connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const callerIsAdmin = verifyOrgRole({ roles: ["admin"], userContext: payload.currentMember })
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      if (connection.credentialMode === "shared") {
        // Connecting a shared credential IS the org-level integration setup —
        // admin-only, like creating the connection itself.
        const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can connect an org-account connection.")
        if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      } else {
        // Per-member: any member GRANTED the connection may connect their own
        // account (that is the whole point); admins may too.
        const canUse = await memberCanUseExternalMcpConnection({
          connectionId: externalMcpConnectionId,
          orgMembershipId: payload.currentMember.id,
          teamIds: memberTeams.map((team) => team.id),
        })
        if (!canUse && !callerIsAdmin) {
          return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
        }
      }

      if (connection.kind === "native_provider") {
        if (!connection.nativeProviderKey) {
          return c.json({ error: "invalid_request", message: "Native provider connector configuration is incomplete." }, 409)
        }
        const provider = getNativeOAuthProvider(connection.nativeProviderKey)
        if (!provider) {
          return c.json({ error: "invalid_request", message: "Native provider connector configuration is not supported." }, 409)
        }
        const started = await beginNativeProviderConnect({
          provider,
          credentialProviderId: connection.id,
          organizationId: payload.organization.id,
          orgMembershipId: payload.currentMember.id,
          request: c.req.raw,
          teamIds: memberTeams.map((team) => team.id),
        })
        if ("error" in started) {
          if (started.error === "forbidden") {
            return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
          }
          if (started.error === "client_configuration_invalid") {
            return c.json({ error: "invalid_request", message: started.message ?? "OAuth client configuration is incomplete." }, 400)
          }
          return c.json({ error: "connection_not_found", message: "This connector does not have an OAuth client configured." }, 404)
        }
        return c.json({ status: "needs_auth", authorizeUrl: started.authorizeUrl })
      }

      let issuerRepairRequiresAdmin = false
      try {
        // Our own signed state token identifies which connection AND which
        // member this is for once the external server redirects back. It MUST
        // travel as the standard OAuth `state` param — a custom param would
        // simply be dropped, since only `state` is guaranteed to round-trip on
        // any spec-compliant authorization server (see ExternalMcpOAuthProvider.state()).
        // New rows store shared-v1. Existing rows keep legacy-v1 so reconnects
        // continue using the callback already registered with the provider.
        const member = connection.credentialMode === "per_member"
          ? { orgMembershipId: payload.currentMember.id }
          : undefined
        const beginAuthorization = async (target: ExternalMcpConnectionRow) => {
          const callbackMode = target.oauthConfiguration?.callbackMode ?? "legacy-v1"
          const responseIssuerRequired = authorizationResponseIssuerRequired(target)
          const signedState = createOAuthStateToken({
            organizationId: payload.organization.id,
            orgMembershipId: payload.currentMember.id,
            providerId: connectionId,
            binding: externalMcpIdentityBinding(target),
            version: 2,
            callbackMode,
            authorizationServerIssuer: target.oauthConfiguration?.authorizationServerIssuer ?? undefined,
            authorizationResponseIssuerRequired: responseIssuerRequired,
            secret: env.betterAuthSecret,
          })
          const result = await connectExternalMcp(
            target,
            await callbackRedirectUri(target),
            signedState,
            member,
            c.get("requestId"),
          )
          return {
            result,
            signedState,
            authorizationServerIssuer: target.oauthConfiguration?.authorizationServerIssuer,
            authorizationResponseIssuerRequired: responseIssuerRequired,
          }
        }

        const beginAuthorizationWithConfigurationRefresh = async (target: ExternalMcpConnectionRow) => {
          try {
            const started = await beginAuthorization(target)
            connection = target
            return started
          } catch (error) {
            const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "AUTH_CLIENT_REGISTRATION")
            if (diagnostic.code !== "MCP_OAUTH_CONFIGURATION_CHANGED") throw error
            const refreshed = await getExternalMcpConnection({
              organizationId: payload.organization.id,
              connectionId: externalMcpConnectionId,
            })
            if (!refreshed || externalMcpIdentityBinding(refreshed) !== externalMcpIdentityBinding(target)) {
              throw error
            }
            connection = refreshed
            logger.info("external_mcp_oauth_configuration_change_retried", {
              connection_id: refreshed.id,
              organization_id: payload.organization.id,
            })
            return beginAuthorization(refreshed)
          }
        }

        let started: Awaited<ReturnType<typeof beginAuthorization>>
        try {
          started = await beginAuthorizationWithConfigurationRefresh(connection)
        } catch (error) {
          const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "AUTH_RESOURCE_DISCOVERY")
          const configuredIssuer = connection.oauthConfiguration?.authorizationServerIssuer
          if (diagnostic.code !== "MCP_OAUTH_ISSUER_MISMATCH" || !configuredIssuer) throw error

          let requirements: Awaited<ReturnType<typeof discoverConnectionRequirements>>
          try {
            requirements = await discoverConnectionRequirements({
              serverUrl: connection.url,
              fetch: externalMcpDiscoveryFetch,
            })
          } catch (discoveryError) {
            logger.warn("external_mcp_oauth_issuer_recovery_discovery_failed", {
              connection_id: connection.id,
              organization_id: payload.organization.id,
              ...externalMcpDiagnosticForLog(discoveryError, c.get("requestId"), "AUTH_RESOURCE_DISCOVERY"),
            })
            throw error
          }

          const replacementIssuer = selectRecoverableAuthorizationServerIssuer({
            selectedIssuer: configuredIssuer,
            requirements,
          })
          if (!replacementIssuer) {
            await markExternalMcpOAuthIssuerReviewRequired({
              organizationId: payload.organization.id,
              connectionId: externalMcpConnectionId,
              expectedIdentityBinding: externalMcpIdentityBinding(connection),
              expectedIssuer: configuredIssuer,
            })
            throw error
          }
          const repair = await repairExternalMcpIssuerConfiguration({
            organizationId: payload.organization.id,
            connectionId: externalMcpConnectionId,
            expectedIdentityBinding: externalMcpIdentityBinding(connection),
            expectedIssuer: configuredIssuer,
            replacementIssuer,
            allowCredentialInvalidation: callerIsAdmin,
          })
          if (repair.status === "credentials_present") {
            issuerRepairRequiresAdmin = true
            throw error
          }
          if (repair.status === "repaired" || repair.status === "unchanged") {
            connection = repair.connection
          } else {
            const refreshed = await getExternalMcpConnection({
              organizationId: payload.organization.id,
              connectionId: externalMcpConnectionId,
            })
            if (refreshed?.oauthConfiguration?.authorizationServerIssuer !== replacementIssuer) throw error
            connection = refreshed
          }
          logger.info("external_mcp_oauth_issuer_recovered", {
            connection_id: connection.id,
            organization_id: payload.organization.id,
            previous_authorization_server_issuer: configuredIssuer,
            authorization_server_issuer: replacementIssuer,
          })
          started = await beginAuthorizationWithConfigurationRefresh(connection)
        }
        if (started.result.status === "needs_auth" && connection.oauthConfiguration?.callbackMode === "shared-v1") {
          const discovered = await getExternalMcpConnection({
            organizationId: payload.organization.id,
            connectionId: externalMcpConnectionId,
          })
          if (discovered) {
            const discoveredResponseIssuerRequired = authorizationResponseIssuerRequired(discovered)
            const signedBindingChanged = started.authorizationServerIssuer
              !== discovered.oauthConfiguration?.authorizationServerIssuer
              || started.authorizationResponseIssuerRequired !== discoveredResponseIssuerRequired
            if (signedBindingChanged) {
              await abandonExternalMcpAuth(discovered, started.signedState, member, c.get("requestId"))
              started = await beginAuthorizationWithConfigurationRefresh(discovered)
            } else {
              connection = discovered
            }
            if (usesPinnedSharedOAuthCallback(connection)) {
              logger.info("external_mcp_oauth_pinned_shared_callback_selected", {
                connection_id: connection.id,
                organization_id: payload.organization.id,
                authorization_server_issuer: connection.oauthConfiguration?.authorizationServerIssuer,
              })
            }
          }
        }

        const { result } = started
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
        if (diagnostic.code === "MCP_OAUTH_CONFIGURATION_REQUIRED") {
          return c.json({
            error: "mcp_oauth_configuration_required",
            message: "This authorization server requires a pre-registered OAuth client before OpenWork can connect.",
            callbackUrl: await callbackRedirectUri(connection),
            clientMetadataUrl: externalMcpClientMetadataUrl(),
            manualRequirements: [
              "Create an OAuth application in the external provider.",
              "Allowlist the callback URL shown by OpenWork.",
              "Save the client ID and optional client secret in OpenWork.",
            ],
          }, 409)
        }
        if (diagnostic.code === "MCP_OAUTH_ISSUER_MISMATCH") {
          return c.json({
            error: "mcp_oauth_issuer_mismatch",
            message: issuerRepairRequiresAdmin
              ? "This connection's OAuth issuer changed and existing credentials must be cleared. Ask a workspace admin to reconnect it."
              : "OpenWork could not safely verify the authorization server selected for this MCP connection. Ask a workspace admin to review its OAuth setup.",
          }, 409)
        }
        return c.json({
          error: "oauth_handshake_failed",
          message: `Could not connect "${connection.name}": ${diagnostic.message} Reference: ${diagnostic.referenceId}.`,
          diagnostic,
        }, 502)
      }
    },
  )

  app.get(
    "/v1/mcp-connections/oauth/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "Shared OAuth callback for External MCP Connections",
      description: "Deployment-wide callback. Organization, member, and connection routing are derived exclusively from signed state.",
      responses: {
        200: htmlResponse("Connected — a static success page."),
        400: jsonResponse("Missing or invalid code/state.", invalidRequestSchema),
      },
    }),
    publicRoute,
    async (c) => handleExternalMcpOAuthCallback({
      request: c.req.raw,
      requestId: c.get("requestId"),
    }),
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
    async (c) => handleExternalMcpOAuthCallback({
      request: c.req.raw,
      requestId: c.get("requestId"),
      scopedConnectionId: c.req.valid("param").connectionId,
    }),
  )
}
