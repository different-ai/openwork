import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { RequestIdVariables } from "hono/request-id"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  discoverConnectionRequirements,
  EnterpriseMcpOAuthContractError,
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
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { appLogger } from "../../observability/logger.js"
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
  isolateExternalMcpOAuthCallback,
  listActiveExternalMcpConnectionBindings,
  listDirectExternalMcpConnectionAccess,
  listExternalMcpConnections,
  listVisibleExternalMcpConnections,
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
import { assertPublicUrl, createGuardedFetch, createRealmSafeFetch } from "../../capability-sources/url-guard.js"
import {
  externalMcpCallbackUrl,
  externalMcpClientMetadataUrl,
  externalMcpSharedCallbackUrl,
} from "../../capability-sources/external-mcp-oauth-contract.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { EXTERNAL_MCP_PRESETS } from "../../capability-sources/external-mcp-presets.js"
import {
  MAX_RESOLVE_QUERY_LENGTH,
  classifyResolveQuery,
  discoveryQualifiesAsMcp,
  matchPresetForQuery,
  resolveCandidateUrls,
  suggestConnectionName,
} from "../../capability-sources/external-mcp-resolve.js"
import {
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
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, idParamSchema, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const connectionParamsSchema = idParamSchema("connectionId", "externalMcpConnection")
const logger = appLogger.child({ component: "mcp_connections" })
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
  authorizationServerIssuer: z.string().trim().url().max(2048).nullable().optional(),
  requestedScopes: z.array(z.string().trim().min(1).max(255)).max(100).optional().default([]),
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

const connectionToolListResponseSchema = z.object({
  tools: z.array(connectionToolSchema),
}).meta({ ref: "ExternalMcpConnectionToolListResponse" })

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
    oauthCallback: callbackRedirectUri(connection),
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
  preset: presetResponseSchema.optional(),
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

function requiresIsolatedOAuthCallback(connection: ExternalMcpConnectionRow): boolean {
  const metadata = oauthAuthorizationServerMetadata(connection)
  return connection.oauthConfiguration?.callbackMode === "shared-v1"
    && metadata !== undefined
    && metadata.authorization_response_iss_parameter_supported !== true
}

function assertIsolatedOAuthCallbackSafety(connection: ExternalMcpConnectionRow): void {
  const methods = oauthAuthorizationServerMetadata(connection)?.code_challenge_methods_supported
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_CONFIGURATION_REQUIRED",
      "This authorization server omits response issuers and cannot use the isolated callback because it does not advertise PKCE S256.",
    )
  }
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

function resolveCreatorName(context: PluginArchActorContext["organizationContext"], memberId: string): string | null {
  const member = context.members.find((entry) => entry.id === memberId)
  return member?.user.name.trim() || member?.user.email || null
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
  if (row.credentialMode === "per_member") {
    const account = await getConnectedAccount({
      organizationId: row.organizationId,
      orgMembershipId: options.callerOrgMembershipId,
      providerId: row.id,
    })
    connectedForMe = Boolean(account?.accessToken)
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
  const presetRequiredAuthType = requiredPluginMcpAuthType({ declaredAuthType: null, url: row.url })
  if (requiredAuthTypes.length === 0 && presetRequiredAuthType) requiredAuthTypes.push(presetRequiredAuthType)
  const authPolicyConfirmed = options.identityManagedBy.length === 0 || requiredAuthTypes.length > 0
  const authTypeMismatch = requiredAuthTypes.some((requiredAuthType) => requiredAuthType !== row.authType)
  const oauthClientRequired = row.authType === "oauth" && pluginMcpRequiresPreRegisteredOAuthClient(row.url)
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
        ? externalMcpCallbackUrl({ connectionId: row.id, callbackMode: callbackMode ?? "legacy-v1" })
        : null,
      oauthSharedCallbackUrl: row.authType === "oauth" ? externalMcpSharedCallbackUrl() : null,
      oauthClientMetadataUrl: row.authType === "oauth" ? externalMcpClientMetadataUrl() : null,
      oauthCallbackMode: callbackMode,
      oauthRegistrationSource,
      authorizationServerIssuer: row.oauthConfiguration?.authorizationServerIssuer ?? null,
      requestedScopes: row.oauthConfiguration?.requestedScopes ?? [],
      grantedScopes,
    } : {}),
  }
}

function callbackRedirectUri(connection: ExternalMcpConnectionRow) {
  if (connection.authType !== "oauth") return "http://127.0.0.1/unused-mcp-oauth-callback"
  return externalMcpCallbackUrl({
    connectionId: connection.id,
    callbackMode: connection.oauthConfiguration?.callbackMode ?? "legacy-v1",
  })
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
  const configuredIssuer = connection.oauthConfiguration?.authorizationServerIssuer ?? null
  const discovery = connection.oauthConfiguration?.discovery
  const autoSelectedIssuer = statePayload.version === 2
    && statePayload.authorizationServerIssuer === undefined
    && configuredIssuer !== null
    && isRecord(discovery)
    && discovery.authorizationServerUrl === configuredIssuer
    && (!isRecord(discovery.resourceMetadata)
      || !Array.isArray(discovery.resourceMetadata.authorization_servers)
      || discovery.resourceMetadata.authorization_servers.length <= 1)
  if (
    statePayload.binding !== externalMcpIdentityBinding(connection)
    || callbackMode !== (connection.oauthConfiguration?.callbackMode ?? "legacy-v1")
    || (statePayload.version === 2
      && (statePayload.authorizationServerIssuer ?? null)
        !== configuredIssuer
      && !autoSelectedIssuer)
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
      const validation = validateMcpAuthorizationResponseIssuer({
        expectedIssuer: configuredIssuer,
        discoveryState: connection.oauthConfiguration?.discovery,
        responseIssuer,
        mixUpDefense: callbackMode === "isolated-v1"
          ? "distinct-redirect-uri"
          : callbackMode === "legacy-v1"
            ? "legacy"
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
    return invalidMcpOAuthCallback("Missing authorization code.")
  }
  try {
    await completeAuthorization(
      connection,
      code,
      externalMcpCallbackUrl({ connectionId: connection.id, callbackMode }),
      member,
      input.requestId,
      state,
    )
  } catch (error) {
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
        200: jsonResponse("Presets.", presetListResponseSchema),
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

      // Org-level kill switch: explicitly opted-out orgs return an empty list —
      // indistinguishable from "nothing published", on every desktop version in
      // the field (see external-mcp-rollout.ts).
      if (!memberFacingMcpConnectionsEnabled(payload.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })) {
        return c.json({ connections: [] })
      }

      const rows = await listVisibleExternalMcpConnections({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        teamIds: memberTeams.map((team) => team.id),
      })
      const provenance = await requiredByForConnections({ context, includeAllPluginNames: false, rows })
      const connections = await Promise.all(rows.map((row) =>
        toConnectionResponse(row, {
          callerOrgMembershipId: payload.currentMember.id,
          createdByName: resolveCreatorName(payload, row.createdByOrgMembershipId),
          includeAccess: false,
          requiredBy: provenance.requiredBy.get(row.id) ?? [],
          identityManagedBy: provenance.identityManagedBy.get(row.id) ?? [],
          requiredAuthTypes: provenance.requiredAuthTypes.get(row.id) ?? new Set(),
        })))
      // Native providers (e.g. google-workspace) join the same list once the
      // org saved an OAuth client for them — same card, same connect flow,
      // same org kill switch (this sits after the check on purpose).
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
          callbackRedirectUri(connection),
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
    "/v1/mcp-connections/:connectionId/tools/call",
    describeRoute({
      tags: ["Authentication"],
      summary: "Manually run a tool from an External MCP Connection",
      description: "Workspace owner/admin diagnostic runner. Executes one named MCP tool with caller-supplied JSON arguments using the Den-managed shared credential or the calling admin's connected credential. Returns an ephemeral inspection of the actual tools/call HTTP request and response with credential and session headers redacted. The caller must already be granted access to the connection. Credentials, arguments, results, and inspection payloads are never written to logs.",
      responses: {
        200: jsonResponse("The MCP tool completed.", connectionToolRunResponseSchema),
        400: jsonResponse("Invalid tool name or arguments.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be a workspace owner/admin and have access to this connection.", forbiddenSchema),
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

      const startedAt = Date.now()
      try {
        const inspected = await inspectExternalMcpToolCall({
          connection,
          redirectUri: callbackRedirectUri(connection),
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
      if (body.authType !== "oauth" && (body.authorizationServerIssuer !== undefined || body.requestedScopes.length > 0)) {
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

      const created = await createExternalMcpConnection({
        organizationId: payload.organization.id,
        name: body.name,
        url: body.url,
        authType: body.authType,
        credentialMode: body.credentialMode,
        apiKey: body.apiKey ?? null,
        oauthConfiguration: body.authType === "oauth" ? {
          version: 1,
          authorizationServerIssuer: body.authorizationServerIssuer ?? null,
          requestedScopes: [...new Set(body.requestedScopes)],
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
            authorizationServerIssuer: body.authorizationServerIssuer ?? undefined,
          },
          createdByOrgMembershipId: payload.currentMember.id,
        })
      }

      if (body.authType !== "oauth") {
        // No OAuth dance needed — validate the server is real and reachable now.
        try {
          await connectExternalMcp(created, callbackRedirectUri(created), undefined, undefined, c.get("requestId"))
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
              authorizationServerIssuer: body.authorizationServerIssuer !== undefined
                ? body.authorizationServerIssuer
                : connection.authType === "oauth"
                  ? connection.oauthConfiguration?.authorizationServerIssuer ?? null
                  : null,
              requestedScopes: [...new Set(body.requestedScopes ?? connection.oauthConfiguration?.requestedScopes ?? [])],
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
        || body.oauthClient !== undefined
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
            callbackRedirectUri(proposedConnection),
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
      if (connection.credentialMode === "shared") {
        // Connecting a shared credential IS the org-level integration setup —
        // admin-only, like creating the connection itself.
        const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can connect an org-account connection.")
        if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      } else {
        // Per-member: any member GRANTED the connection may connect their own
        // account (that is the whole point); admins may too.
        const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
        const canUse = await memberCanUseExternalMcpConnection({
          connectionId: externalMcpConnectionId,
          orgMembershipId: payload.currentMember.id,
          teamIds: memberTeams.map((team) => team.id),
        })
        if (!canUse && !callerIsAdmin) {
          return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
        }
      }

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
          const signedState = createOAuthStateToken({
            organizationId: payload.organization.id,
            orgMembershipId: payload.currentMember.id,
            providerId: connectionId,
            binding: externalMcpIdentityBinding(target),
            version: 2,
            callbackMode,
            authorizationServerIssuer: target.oauthConfiguration?.authorizationServerIssuer ?? undefined,
            secret: env.betterAuthSecret,
          })
          const result = await connectExternalMcp(
            target,
            callbackRedirectUri(target),
            signedState,
            member,
            c.get("requestId"),
          )
          return { result, signedState }
        }

        let started = await beginAuthorization(connection)
        if (started.result.status === "needs_auth" && connection.oauthConfiguration?.callbackMode === "shared-v1") {
          const discovered = await getExternalMcpConnection({
            organizationId: payload.organization.id,
            connectionId: externalMcpConnectionId,
          })
          if (discovered && requiresIsolatedOAuthCallback(discovered)) {
            assertIsolatedOAuthCallbackSafety(discovered)
            await abandonExternalMcpAuth(discovered, started.signedState, member, c.get("requestId"))
            connection = await isolateExternalMcpOAuthCallback({
              organizationId: payload.organization.id,
              connectionId: externalMcpConnectionId,
            })
            logger.info("external_mcp_oauth_isolated_callback_selected", {
              connection_id: connection.id,
              organization_id: payload.organization.id,
              authorization_server_issuer: connection.oauthConfiguration?.authorizationServerIssuer,
            })
            started = await beginAuthorization(connection)
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
            callbackUrl: callbackRedirectUri(connection),
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
            message: "The authorization server no longer matches the issuer selected for this MCP connection. Discover requirements again before reconnecting.",
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
