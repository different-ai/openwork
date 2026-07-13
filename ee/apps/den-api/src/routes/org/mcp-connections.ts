import type { Hono } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import type { RequestIdVariables } from "hono/request-id"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
  queryValidator,
  resolveMemberTeamsMiddleware,
  verifyOrgRole,
} from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { createOAuthStateToken, resolvePublicOrigin, verifyOAuthStateToken } from "../../capability-sources/generic-oauth.js"
import {
  connectExternalMcp,
  completeExternalMcpAuth,
  diagnoseExternalMcp,
  diagnosticEvidenceFromError,
  diagnosticPhaseFromError,
  postAuthorizationResourceValidationError,
  type ExternalMcpDiagnosticObserver,
} from "../../capability-sources/external-mcp-client.js"
import {
  appendMcpDiagnosticEvent,
  claimMcpDiagnosticAuthorizationCallback,
  claimMcpDiagnosticExecutionLease,
  createMcpDiagnosticAttempt,
  failMcpDiagnosticAttempt,
  getMcpDiagnosticAdminActorUserId,
  getMcpDiagnosticAttemptForCallback,
  getMcpDiagnosticSnapshot,
  isMcpDiagnosticAttemptClosedError,
  McpDiagnosticStartLimitError,
  MCP_DIAGNOSTIC_AUTHORIZATION_LEASE_MS,
  recordMcpDiagnosticCompletionAuditOnce,
  recoverAbandonedMcpDiagnosticAttempt,
  releaseMcpDiagnosticExecutionLease,
  safeMcpDiagnosticEvidence,
} from "../../capability-sources/external-mcp-diagnostic-store.js"
import {
  getExternalMcpDiagnosticExecution,
  startExternalMcpDiagnosticExecution,
} from "../../capability-sources/external-mcp-diagnostic-runner.js"
import {
  createExternalMcpConnection,
  deleteExternalMcpOAuthPendingGrant,
  deleteExternalMcpConnection,
  disconnectExternalMcpConnection,
  getExternalMcpConnection,
  getExternalMcpConnectionById,
  listExternalMcpConnectionAccess,
  listExternalMcpConnections,
  listUsableExternalMcpConnections,
  memberCanUseExternalMcpConnection,
  replaceExternalMcpConnectionAccess,
  type ExternalMcpConnectionRow,
} from "../../capability-sources/external-mcp-connections.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { listNativeProviderUsableEntries } from "../../capability-sources/native-provider-connections.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { getConnectedAccount, upsertOrgOAuthClient } from "../../capability-sources/oauth-credentials.js"
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
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, idParamSchema, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import {
  MCP_DIAGNOSTIC_ACTION_OWNERS,
  type McpDiagnosticAttempt,
  type McpDiagnosticAttemptStatus,
  type McpDiagnosticEvent,
  type McpDiagnosticHealthLevel,
  type McpDiagnosticPhase,
  type McpDiagnosticSnapshot,
} from "@openwork/types/den/mcp-diagnostics"

const connectionParamsSchema = idParamSchema("connectionId", "externalMcpConnection")
const diagnosticParamsSchema = connectionParamsSchema.extend({
  attemptId: denTypeIdSchema("mcpDiagnosticAttempt"),
})
const MCP_DIAGNOSTIC_POLL_MS = 750
const MCP_DIAGNOSTIC_HEARTBEAT_MS = 15_000

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

const replaceAccessBodySchema = z.object({
  access: accessInputSchema,
})

const connectionNotFoundSchema = z.object({
  error: z.literal("connection_not_found"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionNotFoundError" })

const accessSummarySchema = z.object({
  orgWide: z.boolean(),
  memberIds: z.array(z.string()),
  teamIds: z.array(z.string()),
}).meta({ ref: "ExternalMcpConnectionAccessSummary" })

const connectionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  connected: z.boolean(),
  connectedAt: z.string().nullable(),
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
  /** Present only for scope=manageable (admin) listings. */
  access: accessSummarySchema.nullable(),
}).meta({ ref: "ExternalMcpConnectionResponse" })

const connectionListResponseSchema = z.object({
  connections: z.array(connectionResponseSchema),
}).meta({ ref: "ExternalMcpConnectionListResponse" })

const connectionCreatedResponseSchema = connectionResponseSchema.extend({
  links: z.object({
    /** Where members connect their own account for per_member connections. Share this with the team. */
    yourConnections: z.string(),
    /** The exact OAuth redirect URL to whitelist in pre-registered provider apps. */
    oauthCallback: z.string(),
  }),
}).meta({ ref: "ExternalMcpConnectionCreatedResponse" })

/**
 * The classical member handoff: after an admin (or their agent) publishes a
 * connection, members connect their own account in the den-web dashboard.
 * betterAuthUrl is the den-web public origin in every deployment layout.
 */
function memberConnectLinks(request: Request, connectionId: string) {
  return {
    yourConnections: `${env.betterAuthUrl}/dashboard/your-connections`,
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

const diagnosticNotFoundSchema = z.object({
  error: z.literal("diagnostic_not_found"),
  message: z.string(),
}).meta({ ref: "McpDiagnosticNotFoundError" })

const diagnosticStartLimitedSchema = z.object({
  error: z.literal("diagnostic_start_limited"),
  message: z.string(),
  kind: z.enum(["concurrency", "rate"]),
  scope: z.enum(["member", "organization"]),
  retryAfterSeconds: z.number().int().positive(),
}).meta({ ref: "McpDiagnosticStartLimitedError" })

const diagnosticSnapshotSchema = z.object({
  attempt: z.object({
    id: z.string(),
    connectionId: z.string(),
    status: z.string(),
    highestHealthLevel: z.string(),
    firstFailedPhase: z.string().nullable(),
    firstFailureCategory: z.string().nullable(),
    firstFailureMessage: z.string().nullable(),
    actionOwner: z.enum(MCP_DIAGNOSTIC_ACTION_OWNERS).nullable(),
    operatorAction: z.string().nullable(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    expiresAt: z.string(),
  }),
  events: z.array(z.object({
    id: z.string(),
    attemptId: z.string(),
    sequence: z.number().int(),
    occurredAt: z.string(),
    phase: z.string(),
    outcome: z.string(),
    elapsedMs: z.number().int(),
    phaseDurationMs: z.number().int().nullable(),
    healthLevel: z.string(),
    messageSafe: z.string(),
    category: z.string().nullable(),
    retryable: z.boolean().nullable(),
    actionOwner: z.enum(MCP_DIAGNOSTIC_ACTION_OWNERS).nullable(),
    operatorAction: z.string().nullable(),
    evidence: z.record(z.string(), z.unknown()),
  })),
}).meta({ ref: "McpDiagnosticSnapshot" })

function isTerminalDiagnostic(snapshot: McpDiagnosticSnapshot): boolean {
  return snapshot.attempt.status === "succeeded"
    || snapshot.attempt.status === "failed"
    || snapshot.attempt.status === "expired"
}

class McpDiagnosticStreamClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The MCP diagnostic stream closed.", options)
    this.name = "McpDiagnosticStreamClosedError"
  }
}

async function writeDiagnosticSse(
  stream: SSEStreamingApi,
  value: Parameters<SSEStreamingApi["writeSSE"]>[0],
): Promise<void> {
  try {
    await stream.writeSSE(value)
  } catch (error) {
    throw new McpDiagnosticStreamClosedError({ cause: error })
  }
}

async function writeDiagnosticEvent(
  stream: SSEStreamingApi,
  event: McpDiagnosticEvent,
  attempt: McpDiagnosticAttempt,
) {
  await writeDiagnosticSse(stream, {
    event: "diagnostic",
    id: String(event.sequence),
    data: JSON.stringify({ type: "event", event, attempt }),
  })
}

function persistentDiagnosticObserver(input: {
  organizationId: DenTypeId<"organization">
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
}): ExternalMcpDiagnosticObserver {
  return async (signal) => {
    await appendMcpDiagnosticEvent({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      phase: signal.phase,
      outcome: signal.outcome,
      healthLevel: signal.healthLevel,
      messageSafe: signal.messageSafe,
      phaseDurationMs: signal.phaseDurationMs,
      category: signal.category,
      retryable: signal.retryable,
      actionOwner: signal.actionOwner,
      operatorAction: signal.operatorAction,
      evidence: signal.evidence,
      attemptStatus: signal.attemptStatus,
    })
  }
}

async function tailMcpDiagnosticStream(input: {
  stream: SSEStreamingApi
  organizationId: DenTypeId<"organization">
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  resumeAfterSequence?: number
}): Promise<void> {
  await recoverAbandonedMcpDiagnosticAttempt({
    organizationId: input.organizationId,
    attemptId: input.attemptId,
  })
  const initial = await getMcpDiagnosticSnapshot({
    organizationId: input.organizationId,
    attemptId: input.attemptId,
  })
  if (!initial) return

  const initialLastSequence = initial.events.at(-1)?.sequence ?? 0
  let lastSequence = Math.min(input.resumeAfterSequence ?? 0, initialLastSequence)
  let authorizationUrlSent: string | null = null
  let lastHeartbeatAt = Date.now()
  try {
    await writeDiagnosticSse(input.stream, {
      event: "snapshot",
      ...(initialLastSequence > 0 ? { id: String(initialLastSequence) } : {}),
      data: JSON.stringify({ type: "snapshot", snapshot: initial }),
      retry: 1_000,
    })
    // A full persisted snapshot is authoritative after reconnect. Advance the
    // tail cursor to its final sequence so Last-Event-ID never causes replayed
    // event rows or suppresses future rows when a client sent a stale cursor.
    lastSequence = initialLastSequence

    if (isTerminalDiagnostic(initial)) {
      await writeDiagnosticSse(input.stream, {
        event: "complete",
        ...(initialLastSequence > 0 ? { id: String(initialLastSequence) } : {}),
        data: JSON.stringify({ type: "complete", snapshot: initial }),
      })
      return
    }

    while (!input.stream.aborted) {
      const execution = getExternalMcpDiagnosticExecution(input.attemptId)
      if (execution?.authorizationUrl && execution.authorizationUrl !== authorizationUrlSent) {
        authorizationUrlSent = execution.authorizationUrl
        await writeDiagnosticSse(input.stream, {
          event: "authorization_required",
          data: JSON.stringify({
            type: "authorization_required",
            authorizeUrl: execution.authorizationUrl,
          }),
        })
      }

      await recoverAbandonedMcpDiagnosticAttempt({
        organizationId: input.organizationId,
        attemptId: input.attemptId,
      })
      const snapshot = await getMcpDiagnosticSnapshot({
        organizationId: input.organizationId,
        attemptId: input.attemptId,
      })
      if (!snapshot) return
      for (const event of snapshot.events) {
        if (event.sequence <= lastSequence) continue
        await writeDiagnosticEvent(input.stream, event, snapshot.attempt)
        lastSequence = event.sequence
      }
      if (isTerminalDiagnostic(snapshot)) {
        await writeDiagnosticSse(input.stream, {
          event: "complete",
          ...(lastSequence > 0 ? { id: String(lastSequence) } : {}),
          data: JSON.stringify({ type: "complete", snapshot }),
        })
        return
      }

      if (Date.now() - lastHeartbeatAt >= MCP_DIAGNOSTIC_HEARTBEAT_MS) {
        try {
          await input.stream.write(": keepalive\n\n")
        } catch (error) {
          throw new McpDiagnosticStreamClosedError({ cause: error })
        }
        lastHeartbeatAt = Date.now()
      }
      await input.stream.sleep(MCP_DIAGNOSTIC_POLL_MS)
    }
  } catch (error) {
    // Delivery is a best-effort tail of persisted state. A client disconnect
    // must never cancel or fail the independently running diagnostic.
    if (input.stream.aborted || error instanceof McpDiagnosticStreamClosedError) return
    throw error
  }
}

function diagnosticResumeSequence(request: Request): number {
  const value = request.headers.get("last-event-id")?.trim()
  if (!value || !/^\d{1,15}$/.test(value)) return 0
  const sequence = Number(value)
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0
}

async function recordDiagnosticCompletionAudit(input: {
  organizationId: DenTypeId<"organization">
  actorUserId: DenTypeId<"user">
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  connectionId: DenTypeId<"externalMcpConnection">
  status: McpDiagnosticAttemptStatus
  highestHealthLevel: McpDiagnosticHealthLevel
  firstFailedPhase: McpDiagnosticPhase | null
}) {
  try {
    await recordMcpDiagnosticCompletionAuditOnce({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      attemptId: input.attemptId,
      connectionId: input.connectionId,
      status: input.status,
      highestHealthLevel: input.highestHealthLevel,
      firstFailedPhase: input.firstFailedPhase,
    })
  } catch (error) {
    console.error("mcp_diagnostic_audit_write_failed", {
      action: ORGANIZATION_AUDIT_ACTIONS.mcpDiagnosticCompleted,
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    })
  }
}

async function recordDiagnosticStartedAudit(input: {
  organizationId: DenTypeId<"organization">
  actorUserId: DenTypeId<"user">
  attemptId: string
  connectionId: string
}) {
  try {
    await recordOrganizationAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: ORGANIZATION_AUDIT_ACTIONS.mcpDiagnosticStarted,
      payload: { attemptId: input.attemptId, connectionId: input.connectionId },
    })
  } catch (error) {
    console.error("mcp_diagnostic_audit_write_failed", {
      action: ORGANIZATION_AUDIT_ACTIONS.mcpDiagnosticStarted,
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    })
  }
}

async function deletePendingOAuthGrantBestEffort(input: {
  organizationId: DenTypeId<"organization">
  connectionId: DenTypeId<"externalMcpConnection">
  orgMembershipId: DenTypeId<"member"> | null
  signedState: string
}): Promise<void> {
  try {
    await deleteExternalMcpOAuthPendingGrant(input)
  } catch (error) {
    console.error("external_mcp_pending_oauth_grant_cleanup_failed", {
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    })
  }
}

function isConnectionConnected(row: ExternalMcpConnectionRow): boolean {
  if (row.credentialMode === "per_member") {
    // A per_member connection is "published" once created; individual
    // members connect their own accounts (connectedForMe).
    return true
  }
  return Boolean(row.accessToken || row.apiKey || (row.authType === "none" && row.connectedAt))
}

async function toConnectionResponse(
  row: ExternalMcpConnectionRow,
  options: {
    callerOrgMembershipId: DenTypeId<"member">
    includeAccess: boolean
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
    const grants = await listExternalMcpConnectionAccess(row.id)
    access = {
      orgWide: grants.some((grant) => grant.orgWide),
      memberIds: grants.flatMap((grant) => (grant.orgMembershipId ? [grant.orgMembershipId] : [])),
      teamIds: grants.flatMap((grant) => (grant.teamId ? [grant.teamId] : [])),
    }
  }

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.authType,
    credentialMode: row.credentialMode,
    connected: isConnectionConnected(row),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    connectedForMe,
    access,
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

      if (scope === "manageable") {
        if (!verifyOrgRole({ roles: ["admin"], userContext: payload.currentMember })) {
          return c.json({ error: "forbidden", message: "Only workspace owners and admins can list all MCP connections." }, 403)
        }
        const rows = await listExternalMcpConnections(payload.organization.id)
        const connections = await Promise.all(rows.map((row) =>
          toConnectionResponse(row, { callerOrgMembershipId: payload.currentMember.id, includeAccess: true })))
        return c.json({ connections })
      }

      // Staged rollout: gated deployments return an empty list for
      // non-opted-in orgs — indistinguishable from "nothing published", on
      // every desktop version in the field (see external-mcp-rollout.ts).
      if (!memberFacingMcpConnectionsEnabled(payload.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })) {
        return c.json({ connections: [] })
      }

      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const rows = await listUsableExternalMcpConnections({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        teamIds: memberTeams.map((team) => team.id),
      })
      const connections = await Promise.all(rows.map((row) =>
        toConnectionResponse(row, { callerOrgMembershipId: payload.currentMember.id, includeAccess: false })))
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
        } catch (error) {
          const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "MCP_INITIALIZE")
          console.error("external_mcp_connection_validation_failed", {
            connectionId: created.id,
            organizationId: payload.organization.id,
            connectionEndpoint: safeExternalMcpEndpointForLog(created.url),
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
      const response = await toConnectionResponse(refreshed ?? created, { callerOrgMembershipId: payload.currentMember.id, includeAccess: true })
      // The classical handoff: whoever created this (human or agent) gets
      // the link where members connect their own account, ready to share.
      return c.json({ ...response, links: memberConnectLinks(c.req.raw, created.id) })
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
      return c.json(await toConnectionResponse(connection, { callerOrgMembershipId: payload.currentMember.id, includeAccess: true }))
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

  app.post(
    "/v1/mcp-connections/:connectionId/diagnostics/stream",
    describeRoute({
      tags: ["Authentication"],
      summary: "Run a live, metadata-only diagnostic for an External MCP Connection",
      description: "Admin-only. Streams persisted, redacted phase events from the Den-managed MCP connection attempt. Authorization URLs are control messages and are never retained in diagnostic evidence.",
      responses: {
        200: { description: "Server-sent diagnostic events." },
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can diagnose MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
        429: jsonResponse("Too many diagnostic attempts.", diagnosticStartLimitedSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can diagnose MCP connections.")
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

      let attempt: McpDiagnosticAttempt
      try {
        attempt = await createMcpDiagnosticAttempt({
          organizationId: payload.organization.id,
          connectionId: externalMcpConnectionId,
          createdByOrgMembershipId: payload.currentMember.id,
        })
      } catch (error) {
        if (!(error instanceof McpDiagnosticStartLimitError)) throw error
        c.header("Retry-After", String(error.retryAfterSeconds))
        return c.json({
          error: "diagnostic_start_limited",
          message: error.message,
          kind: error.kind,
          scope: error.scope,
          retryAfterSeconds: error.retryAfterSeconds,
        }, 429)
      }
      const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
      await recordDiagnosticStartedAudit({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        attemptId,
        connectionId: externalMcpConnectionId,
      })

      const request = c.req.raw
      const redirectUri = callbackRedirectUri(request, connectionId)
      startExternalMcpDiagnosticExecution({
        organizationId: payload.organization.id,
        attemptId,
        connection,
        orgMembershipId: payload.currentMember.id,
        redirectUri,
        onComplete: async (snapshot) => {
          await recordDiagnosticCompletionAudit({
            organizationId: payload.organization.id,
            actorUserId: payload.currentMember.userId,
            attemptId,
            connectionId: externalMcpConnectionId,
            status: snapshot.attempt.status,
            highestHealthLevel: snapshot.attempt.highestHealthLevel,
            firstFailedPhase: snapshot.attempt.firstFailedPhase,
          })
        },
      })
      c.header("X-OpenWork-MCP-Diagnostic-Attempt-Id", attemptId)
      return streamSSE(c, (stream) => tailMcpDiagnosticStream({
        stream,
        organizationId: payload.organization.id,
        attemptId,
        resumeAfterSequence: diagnosticResumeSequence(c.req.raw),
      }))
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/diagnostics/:attemptId/stream",
    describeRoute({
      tags: ["Authentication"],
      summary: "Reconnect to the persisted event tail for an External MCP diagnostic",
      description: "Admin-only. Replays the current persisted snapshot, then tails new events. Disconnecting this stream never cancels the diagnostic execution.",
      responses: {
        200: { description: "Server-sent diagnostic events." },
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can read MCP diagnostics.", forbiddenSchema),
        404: jsonResponse("Unknown diagnostic attempt.", diagnosticNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(diagnosticParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can read MCP diagnostics.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const { connectionId, attemptId } = c.req.valid("param")
      const normalizedAttemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attemptId)
      const snapshot = await getMcpDiagnosticSnapshot({
        organizationId: payload.organization.id,
        attemptId: normalizedAttemptId,
      })
      if (!snapshot || snapshot.attempt.connectionId !== connectionId) {
        return c.json({ error: "diagnostic_not_found", message: "Unknown diagnostic attempt." }, 404)
      }
      return streamSSE(c, (stream) => tailMcpDiagnosticStream({
        stream,
        organizationId: payload.organization.id,
        attemptId: normalizedAttemptId,
        resumeAfterSequence: diagnosticResumeSequence(c.req.raw),
      }))
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/diagnostics/:attemptId",
    describeRoute({
      tags: ["Authentication"],
      summary: "Read a redacted External MCP diagnostic attempt",
      responses: {
        200: jsonResponse("Diagnostic snapshot.", diagnosticSnapshotSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can read MCP diagnostics.", forbiddenSchema),
        404: jsonResponse("Unknown diagnostic attempt.", diagnosticNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(diagnosticParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can read MCP diagnostics.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const { connectionId, attemptId } = c.req.valid("param")
      const normalizedAttemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attemptId)
      const snapshot = await getMcpDiagnosticSnapshot({
        organizationId: payload.organization.id,
        attemptId: normalizedAttemptId,
      })
      if (!snapshot || snapshot.attempt.connectionId !== connectionId) {
        return c.json({ error: "diagnostic_not_found", message: "Unknown diagnostic attempt." }, 404)
      }
      return c.json(snapshot)
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
        console.error("external_mcp_connect_start_oauth_handshake_failed", {
          connectionId: connection.id,
          organizationId: payload.organization.id,
          connectionEndpoint: safeExternalMcpEndpointForLog(connection.url),
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
      const oauthError = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      if (!state) {
        return c.json({ error: "invalid_request", message: "Missing state." }, 400)
      }

      const statePayload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
      if (!statePayload || statePayload.providerId !== connectionId) {
        return c.json({ error: "invalid_request", message: "Invalid or expired state." }, 400)
      }

      const connection = await getExternalMcpConnectionById(externalMcpConnectionId)
      if (!connection || connection.organizationId !== statePayload.organizationId) {
        return c.json({ error: "invalid_request", message: "Unknown connection." }, 400)
      }

      const diagnosticAttemptId = statePayload.diagnosticAttemptId
      const diagnosticAttemptGeneration = statePayload.diagnosticAttemptGeneration
      let diagnosticActorUserId: DenTypeId<"user"> | null = null
      if (diagnosticAttemptId) {
        const diagnosticAttempt = await getMcpDiagnosticAttemptForCallback(diagnosticAttemptId)
        const validAttempt = diagnosticAttempt
          && diagnosticAttempt.organizationId === statePayload.organizationId
          && diagnosticAttempt.externalMcpConnectionId === externalMcpConnectionId
          && diagnosticAttempt.createdByOrgMembershipId === statePayload.orgMembershipId
          && diagnosticAttempt.expiresAt.getTime() >= Date.now()
          && (diagnosticAttempt.status === "running" || diagnosticAttempt.status === "waiting_for_authorization")
        if (!validAttempt) {
          return c.json({ error: "invalid_request", message: "Invalid or expired diagnostic attempt." }, 400)
        }
        diagnosticActorUserId = await getMcpDiagnosticAdminActorUserId({
          organizationId: statePayload.organizationId,
          memberId: statePayload.orgMembershipId,
        })
        if (!diagnosticActorUserId) {
          return c.json({ error: "invalid_request", message: "The diagnostic initiator no longer has organization-admin access." }, 400)
        }
      }

      const diagnosticLease = diagnosticAttemptId && diagnosticAttemptGeneration
        ? await claimMcpDiagnosticAuthorizationCallback({
            organizationId: statePayload.organizationId,
            connectionId: externalMcpConnectionId,
            attemptId: diagnosticAttemptId,
            createdByOrgMembershipId: statePayload.orgMembershipId,
            generation: diagnosticAttemptGeneration,
          })
        : null
      if (diagnosticAttemptId && !diagnosticLease) {
        return c.json({ error: "invalid_request", message: "This diagnostic authorization callback lost its active attempt lease." }, 400)
      }

      if (oauthError) {
        await deletePendingOAuthGrantBestEffort({
          organizationId: statePayload.organizationId,
          connectionId: externalMcpConnectionId,
          orgMembershipId: connection.credentialMode === "per_member" ? statePayload.orgMembershipId : null,
          signedState: state,
        })
        const denied = oauthError === "access_denied"
        const messageSafe = denied
          ? "The provider authorization was denied or cancelled."
          : "The provider returned an authorization error before issuing a code."
        if (diagnosticAttemptId && diagnosticActorUserId) {
          let recorded = false
          try {
            await appendMcpDiagnosticEvent({
              organizationId: statePayload.organizationId,
              attemptId: diagnosticAttemptId,
              phase: "AUTH_USER_OR_WORKLOAD",
              outcome: "failed",
              healthLevel: "reachable",
              messageSafe,
              category: denied ? "oauth_authorization_denied" : "oauth_authorization_error",
              retryable: true,
              actionOwner: denied ? "member" : "provider_admin",
              operatorAction: denied ? "review_provider_consent_and_assignment" : "restart_provider_authorization",
              evidence: safeMcpDiagnosticEvidence({ errorCode: oauthError }),
              attemptStatus: "failed",
            })
            recorded = true
          } catch (error) {
            if (!isMcpDiagnosticAttemptClosedError(error)) throw error
          }
          const snapshot = await getMcpDiagnosticSnapshot({ organizationId: statePayload.organizationId, attemptId: diagnosticAttemptId })
          if (recorded && snapshot) {
            await recordDiagnosticCompletionAudit({
              organizationId: statePayload.organizationId,
              actorUserId: diagnosticActorUserId,
              attemptId: diagnosticAttemptId,
              connectionId: externalMcpConnectionId,
              status: snapshot.attempt.status,
              highestHealthLevel: snapshot.attempt.highestHealthLevel,
              firstFailedPhase: snapshot.attempt.firstFailedPhase,
            })
          }
          return c.html(connectCallbackPage({ ok: false, name: connection.name, message: snapshot?.attempt.firstFailureMessage ?? messageSafe }), 400)
        }
        const callbackError = externalMcpOAuthCallbackError(c.get("requestId"), oauthError)
        console.error("external_mcp_connect_callback_authorization_denied", {
          connectionId: connection.id,
          organizationId: statePayload.organizationId,
          ...externalMcpDiagnosticForLog(callbackError, c.get("requestId"), "AUTH_USER_OR_WORKLOAD"),
        })
        return c.html(connectCallbackPage({
          ok: false,
          name: connection.name,
          message: callbackError.diagnostic.message,
          referenceId: callbackError.diagnostic.referenceId,
        }), 400)
      }

      if (!code) {
        if (diagnosticAttemptId) {
          await deletePendingOAuthGrantBestEffort({
            organizationId: statePayload.organizationId,
            connectionId: externalMcpConnectionId,
            orgMembershipId: connection.credentialMode === "per_member" ? statePayload.orgMembershipId : null,
            signedState: state,
          })
          try {
            await appendMcpDiagnosticEvent({
              organizationId: statePayload.organizationId,
              attemptId: diagnosticAttemptId,
              phase: "AUTH_TOKEN_ACQUISITION",
              outcome: "failed",
              healthLevel: "reachable",
              messageSafe: "The provider callback did not include an authorization code.",
              category: "oauth_callback_missing_code",
              retryable: true,
              actionOwner: "provider_admin",
              operatorAction: "restart_provider_authorization",
              attemptStatus: "failed",
            })
          } catch (error) {
            if (!isMcpDiagnosticAttemptClosedError(error)) throw error
          }
          const snapshot = await getMcpDiagnosticSnapshot({
            organizationId: statePayload.organizationId,
            attemptId: diagnosticAttemptId,
          })
          return c.html(connectCallbackPage({
            ok: false,
            name: connection.name,
            message: snapshot?.attempt.firstFailureMessage ?? "The provider callback did not include an authorization code.",
          }), 400)
        }
        return c.json({ error: "invalid_request", message: "Missing authorization code." }, 400)
      }

      const callbackExecutionLease = diagnosticAttemptId
        ? await claimMcpDiagnosticExecutionLease({
            organizationId: statePayload.organizationId,
            attemptId: diagnosticAttemptId,
            leaseMs: MCP_DIAGNOSTIC_AUTHORIZATION_LEASE_MS,
          })
        : null
      try {
        // For per-member connections, the signed state token (minted at
        // connect/start for the member who initiated) decides whose account
        // the exchanged tokens are saved against.
        const member = connection.credentialMode === "per_member"
          ? { orgMembershipId: statePayload.orgMembershipId }
          : undefined
        const observer = diagnosticAttemptId
          ? persistentDiagnosticObserver({ organizationId: statePayload.organizationId, attemptId: diagnosticAttemptId })
          : undefined
        await completeExternalMcpAuth(
          connection,
          code,
          callbackRedirectUri(c.req.raw, connectionId),
          state,
          diagnosticAttemptId && diagnosticAttemptGeneration && diagnosticLease
            ? { attemptId: diagnosticAttemptId, generation: diagnosticAttemptGeneration, leaseId: diagnosticLease.leaseId }
            : undefined,
          member,
          observer,
        )
        if (observer) {
          const refreshedConnection = await getExternalMcpConnectionById(externalMcpConnectionId)
          if (!refreshedConnection || refreshedConnection.organizationId !== statePayload.organizationId) {
            throw new Error("The MCP connection disappeared after authorization.")
          }
          const diagnosticResult = await diagnoseExternalMcp({
            connection: refreshedConnection,
            redirectUri: callbackRedirectUri(c.req.raw, connectionId),
            signedState: state,
            member,
            ...(diagnosticAttemptId && diagnosticAttemptGeneration
              ? { diagnosticAuthorization: { attemptId: diagnosticAttemptId, generation: diagnosticAttemptGeneration } }
              : {}),
            observe: observer,
          })
          if (diagnosticResult.status !== "connected") {
            throw postAuthorizationResourceValidationError(connection.url)
          }
        }
      } catch (error) {
        if (diagnosticAttemptId) {
          if (isMcpDiagnosticAttemptClosedError(error)) {
            const snapshot = await getMcpDiagnosticSnapshot({ organizationId: statePayload.organizationId, attemptId: diagnosticAttemptId })
            return c.html(connectCallbackPage({
              ok: false,
              name: connection.name,
              message: snapshot?.attempt.firstFailureMessage ?? "This diagnostic attempt already completed.",
            }), 400)
          }
          const phase = diagnosticPhaseFromError(error)
          await failMcpDiagnosticAttempt({
            organizationId: statePayload.organizationId,
            attemptId: diagnosticAttemptId,
            phase,
            healthLevel: phase.startsWith("MCP_") ? "authorized" : "reachable",
            error,
            url: connection.url,
            evidence: diagnosticEvidenceFromError(error),
          })
          const snapshot = await getMcpDiagnosticSnapshot({ organizationId: statePayload.organizationId, attemptId: diagnosticAttemptId })
          if (snapshot && diagnosticActorUserId) {
            await recordDiagnosticCompletionAudit({
              organizationId: statePayload.organizationId,
              actorUserId: diagnosticActorUserId,
              attemptId: diagnosticAttemptId,
              connectionId: externalMcpConnectionId,
              status: snapshot.attempt.status,
              highestHealthLevel: snapshot.attempt.highestHealthLevel,
              firstFailedPhase: snapshot.attempt.firstFailedPhase,
            })
          }
          return c.html(connectCallbackPage({
            ok: false,
            name: connection.name,
            message: snapshot?.attempt.firstFailureMessage ?? "The diagnostic connection attempt failed.",
          }), 400)
        }
        const diagnostic = externalMcpDiagnosticForResponse(error, c.get("requestId"), "AUTH_TOKEN_ACQUISITION")
        console.error("external_mcp_connect_callback_token_exchange_failed", {
          connectionId: connection.id,
          organizationId: statePayload.organizationId,
          ...externalMcpDiagnosticForLog(error, c.get("requestId"), "AUTH_TOKEN_ACQUISITION"),
        })
        return c.html(connectCallbackPage({
          ok: false,
          name: connection.name,
          message: diagnostic.message,
          referenceId: diagnostic.referenceId,
        }), 400)
      } finally {
        if (diagnosticAttemptId && callbackExecutionLease) {
          await releaseMcpDiagnosticExecutionLease({
            organizationId: statePayload.organizationId,
            attemptId: diagnosticAttemptId,
            leaseId: callbackExecutionLease.leaseId,
          })
        }
      }
      if (diagnosticAttemptId && diagnosticActorUserId) {
        const snapshot = await getMcpDiagnosticSnapshot({ organizationId: statePayload.organizationId, attemptId: diagnosticAttemptId })
        if (snapshot) {
          await recordDiagnosticCompletionAudit({
            organizationId: statePayload.organizationId,
            actorUserId: diagnosticActorUserId,
            attemptId: diagnosticAttemptId,
            connectionId: externalMcpConnectionId,
            status: snapshot.attempt.status,
            highestHealthLevel: snapshot.attempt.highestHealthLevel,
            firstFailedPhase: snapshot.attempt.firstFailedPhase,
          })
        }
      }
      return c.html(connectCallbackPage({ ok: true, name: connection.name }))
    },
  )
}
